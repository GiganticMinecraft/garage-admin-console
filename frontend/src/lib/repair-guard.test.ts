import { describe, expect, it } from 'vitest'
import type { ClusterHealth, ClusterStatus, WorkersResponse } from '@/api'
import {
  DESTRUCTIVE_REPAIRS,
  assertRepairAllowed,
  evaluateRepairGuard,
  guardInputsFrom,
  isDestructiveRepair,
  repairGuardHint,
  type GuardInputs,
} from './repair-guard'

const healthy: ClusterHealth = {
  status: 'healthy',
  knownNodes: 3,
  connectedNodes: 3,
  storageNodes: 3,
  storageNodesUp: 3,
  partitions: 256,
  partitionsQuorum: 256,
  partitionsAllOk: 256,
}
const nodes = ['aaa', 'bbb', 'ccc']
const names = new Map([['aaa', 'garage-0'], ['bbb', 'garage-1'], ['ccc', 'garage-2']])
// Merkle / insert-queue workers busy under write load must not matter.
const idle = (nodeId: string) => [
  { nodeId, name: 'object sync', state: 'idle' },
  { nodeId, name: 'version sync', state: 'idle' },
  { nodeId, name: 'block_ref sync', state: 'idle' },
  { nodeId, name: 'multipart_upload sync', state: 'idle' },
  { nodeId, name: 'block_ref Merkle', state: 'busy' },
  { nodeId, name: 'version queue', state: 'busy' },
  { nodeId, name: 'Block scrub worker', state: 'busy' },
  { nodeId, name: 'block_ref GC', state: 'idle' },
]
const ok: GuardInputs = {
  health: { state: 'success', data: healthy },
  workers: { state: 'success', data: { workers: nodes.flatMap(idle), errors: {} } },
  storageNodeIds: nodes,
  nodeNames: names,
}

describe('isDestructiveRepair', () => {
  it('gates the repairs that mark metadata deleted or delete blocks', () => {
    for (const t of ['versions', 'blockRefs', 'blockRc', 'multipartUploads'] as const) {
      expect(isDestructiveRepair(t)).toBe(true)
      expect(DESTRUCTIVE_REPAIRS.has(t)).toBe(true)
    }
  })

  it('leaves the sync-only / read-only / resync-only repairs and scrub alone', () => {
    for (const t of ['tables', 'blocks', 'rebalance', 'aliases', 'clearResyncQueue'] as const) {
      expect(isDestructiveRepair(t)).toBe(false)
    }
    expect(isDestructiveRepair({ scrub: 'start' })).toBe(false)
  })
})

describe('evaluateRepairGuard', () => {
  it('allows a destructive repair on a connected, replicated, idle cluster', () => {
    expect(evaluateRepairGuard('blockRefs', ok)).toEqual({ allowed: true })
  })

  it('always allows a non-destructive repair, even without data', () => {
    const none: GuardInputs = { health: { state: 'error' }, workers: { state: 'error' } }
    expect(evaluateRepairGuard('tables', none)).toEqual({ allowed: true })
    expect(evaluateRepairGuard({ scrub: 'start' }, none)).toEqual({ allowed: true })
  })

  it('blocks while anything is loading, failed or empty, without telling the operator to repair', () => {
    for (const inputs of [
      { ...ok, health: { state: 'pending' as const } },
      { ...ok, workers: { state: 'pending' as const } },
      { ...ok, health: { state: 'error' as const } },
      { ...ok, health: { state: 'success' as const } },
      { ...ok, workers: { state: 'error' as const } },
      { ...ok, storageNodeIds: undefined },
    ]) {
      const g = evaluateRepairGuard('versions', inputs)
      expect(g.allowed).toBe(false)
      if (!g.allowed) {
        expect(g.advice).toBe('')
        expect(repairGuardHint(g)).not.toContain('テーブル修復')
      }
    }
  })

  it('blocks, not allows, when a counter is missing from the answer', () => {
    // `undefined < n` is false, so a missing field must not slip through as healthy.
    const partial = { ...healthy } as Partial<ClusterHealth>
    delete partial.partitionsAllOk
    expect(evaluateRepairGuard('blockRc', { ...ok, health: { state: 'success', data: partial as ClusterHealth } }).allowed).toBe(false)
  })

  it('blocks with every applicable reason when a storage node is down', () => {
    // garage-1 down on 2026-10-19: 2 / 3 storage nodes, no partition fully replicated, no worker answer.
    const degraded: ClusterHealth = { ...healthy, status: 'degraded', connectedNodes: 2, storageNodesUp: 2, partitionsAllOk: 0 }
    const g = evaluateRepairGuard('blockRefs', {
      ...ok,
      health: { state: 'success', data: degraded },
      workers: { state: 'success', data: { workers: [...idle('aaa'), ...idle('ccc')], errors: { bbb: 'Not connected: bbb' } } },
    })
    expect(g).toEqual({
      allowed: false,
      reasons: [
        'ストレージノードが停止中です (稼働 2 / 3)',
        '全レプリカが揃っているパーティションが 0 / 256 しかありません',
        'garage-1 のワーカー状態を取得できません (Not connected: bbb)',
      ],
      advice: 'ストレージノードの復旧を待ち、その後「テーブル修復」で同期を終えてから実行してください。',
    })
    expect(repairGuardHint(g)).toContain('テーブル修復')
  })

  it('blocks while a table sync worker is busy even though health is back to healthy', () => {
    const workers = [...idle('aaa'), ...idle('ccc'), ...idle('bbb').map((w) => (w.name === 'object sync' ? { ...w, state: 'busy' } : w))]
    const g = evaluateRepairGuard('blockRefs', { ...ok, workers: { state: 'success', data: { workers, errors: {} } } })
    expect(g).toEqual({
      allowed: false,
      reasons: ['テーブルの同期が進行中です (garage-1: object sync が実行中)'],
      advice: '同期が終わる (各テーブルの sync ワーカーが idle になる) まで待ってから実行してください。',
    })
  })

  it('blocks while the multipart_upload table is syncing (versions follows its backlinks)', () => {
    const workers = [...idle('aaa'), ...idle('bbb'), ...idle('ccc').map((w) => (w.name === 'multipart_upload sync' ? { ...w, state: 'busy' } : w))]
    const g = evaluateRepairGuard('versions', { ...ok, workers: { state: 'success', data: { workers, errors: {} } } })
    expect(g.allowed).toBe(false)
    if (!g.allowed) expect(g.reasons).toEqual(['テーブルの同期が進行中です (garage-2: multipart_upload sync が実行中)'])
  })

  it('does not block on a gateway or a decommissioned peer', () => {
    // knownNodes lists every peer seen; only storage nodes hold metadata, and
    // a gateway that does not answer ListWorkers is just as irrelevant.
    const gatewayDown: ClusterHealth = { ...healthy, knownNodes: 4, connectedNodes: 3 }
    const g = evaluateRepairGuard('blockRc', {
      ...ok,
      health: { state: 'success', data: gatewayDown },
      workers: { state: 'success', data: { workers: nodes.flatMap(idle), errors: { ggg: 'Not connected: ggg' } } },
    })
    expect(g).toEqual({ allowed: true })
  })

  it('blocks on a partially replicated partition even when every node is connected', () => {
    const partial: ClusterHealth = { ...healthy, status: 'degraded', partitionsAllOk: 250 }
    const g = evaluateRepairGuard('blockRc', { ...ok, health: { state: 'success', data: partial } })
    expect(g.allowed).toBe(false)
    if (!g.allowed) expect(g.reasons).toEqual(['全レプリカが揃っているパーティションが 250 / 256 しかありません'])
  })

  it('returns an empty hint when allowed', () => {
    expect(repairGuardHint({ allowed: true })).toBe('')
  })
})

describe('assertRepairAllowed', () => {
  it('refetches and throws the hint for a blocked destructive repair', async () => {
    let calls = 0
    const refetch = async () => {
      calls++
      return { ...ok, health: { state: 'success' as const, data: { ...healthy, storageNodesUp: 2 } } }
    }
    await expect(assertRepairAllowed('blockRefs', refetch)).rejects.toThrow('ストレージノードが停止中です (稼働 2 / 3)')
    expect(calls).toBe(1)
  })

  it('does not refetch for a non-destructive repair', async () => {
    let calls = 0
    await assertRepairAllowed('tables', async () => {
      calls++
      return ok
    })
    expect(calls).toBe(0)
  })
})

describe('guardInputsFrom', () => {
  it('maps the three queries, keeps only storage nodes and names them like the rest of the UI', () => {
    const status: ClusterStatus = {
      nodes: [
        { id: 'aaa', hostname: 'garage-0', role: { zone: 'dc1', capacity: 1, tags: [] }, draining: false, isUp: true },
        { id: 'ggg', hostname: 'gateway', role: { zone: 'dc1', capacity: null, tags: [] }, draining: false, isUp: true },
        { id: 'ddd0000000000000dddd', hostname: null, role: null, draining: true, isUp: true },
      ],
    } as unknown as ClusterStatus
    const workersData: WorkersResponse = { workers: [], errors: {} }
    const inputs = guardInputsFrom(
      { isPending: false, isError: false, data: healthy },
      { isPending: false, isError: true, data: workersData },
      { isPending: false, isError: false, data: status },
    )
    expect(inputs.health).toEqual({ state: 'success', data: healthy })
    expect(inputs.workers.state).toBe('error')
    expect(inputs.storageNodeIds).toEqual(['aaa', 'ddd0000000000000dddd'])
    expect(inputs.nodeNames?.get('aaa')).toBe('garage-0')
    expect(inputs.nodeNames?.get('ddd0000000000000dddd')).toBe('ddd0000000000000…')
  })

  it('leaves storage nodes unknown while the status has not loaded', () => {
    expect(guardInputsFrom({ isPending: true, isError: false }, { isPending: true, isError: false }, { isPending: true, isError: false }).storageNodeIds).toBeUndefined()
  })
})
