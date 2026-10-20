import { describe, expect, it } from 'vitest'
import type { ClusterHealth } from '@/api'
import { DESTRUCTIVE_REPAIRS, evaluateRepairGuard, isDestructiveRepair, repairGuardHint } from './repair-guard'

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
const ok = { state: 'success' as const, data: healthy }

describe('isDestructiveRepair', () => {
  it('gates the repairs that mark metadata deleted or delete blocks', () => {
    for (const t of ['versions', 'blockRefs', 'blockRc', 'blocks', 'multipartUploads'] as const) {
      expect(isDestructiveRepair(t)).toBe(true)
      expect(DESTRUCTIVE_REPAIRS.has(t)).toBe(true)
    }
  })

  it('leaves the sync-only / read-only repairs and scrub alone', () => {
    for (const t of ['tables', 'rebalance', 'aliases', 'clearResyncQueue'] as const) {
      expect(isDestructiveRepair(t)).toBe(false)
    }
    expect(isDestructiveRepair({ scrub: 'start' })).toBe(false)
  })
})

describe('evaluateRepairGuard', () => {
  it('allows a destructive repair on a fully connected, fully replicated cluster', () => {
    expect(evaluateRepairGuard('blockRefs', ok)).toEqual({ allowed: true })
  })

  it('always allows a non-destructive repair, even without health', () => {
    expect(evaluateRepairGuard('tables', { state: 'error' })).toEqual({ allowed: true })
    expect(evaluateRepairGuard({ scrub: 'start' }, { state: 'pending' })).toEqual({ allowed: true })
  })

  it('blocks while health is loading, failed or empty', () => {
    expect(evaluateRepairGuard('versions', { state: 'pending' }).allowed).toBe(false)
    expect(evaluateRepairGuard('versions', { state: 'error' }).allowed).toBe(false)
    expect(evaluateRepairGuard('versions', { state: 'success' }).allowed).toBe(false)
  })

  it('blocks, not allows, when a counter is missing from the answer', () => {
    // `undefined < n` is false, so a missing field must not slip through as healthy.
    const partial = { ...healthy } as Partial<ClusterHealth>
    delete partial.partitionsAllOk
    const g = evaluateRepairGuard('blockRc', { state: 'success', data: partial as ClusterHealth })
    expect(g.allowed).toBe(false)
  })

  it('blocks with every applicable reason when a storage node is down', () => {
    // garage-1 down on 2026-10-19: 2 / 3 storage nodes, no partition fully replicated.
    const degraded: ClusterHealth = { ...healthy, status: 'degraded', connectedNodes: 2, storageNodesUp: 2, partitionsAllOk: 0 }
    const g = evaluateRepairGuard('blockRefs', { state: 'success', data: degraded })
    expect(g).toEqual({
      allowed: false,
      reasons: ['ストレージノードが停止中です (稼働 2 / 3)', '全レプリカが揃っていないパーティションがあります (256 / 256)'],
    })
    expect(repairGuardHint(g)).toContain('テーブル修復')
  })

  it('does not block on a disconnected gateway or a decommissioned peer', () => {
    // knownNodes lists every peer seen, including gateways and removed nodes;
    // only storage nodes hold metadata.
    const gatewayDown: ClusterHealth = { ...healthy, knownNodes: 4, connectedNodes: 3 }
    expect(evaluateRepairGuard('blocks', { state: 'success', data: gatewayDown })).toEqual({ allowed: true })
  })

  it('blocks on a partially replicated partition even when every node is connected', () => {
    const partial: ClusterHealth = { ...healthy, status: 'degraded', partitionsAllOk: 250 }
    const g = evaluateRepairGuard('blocks', { state: 'success', data: partial })
    expect(g).toEqual({ allowed: false, reasons: ['全レプリカが揃っていないパーティションがあります (6 / 256)'] })
  })

  it('returns an empty hint when allowed', () => {
    expect(repairGuardHint({ allowed: true })).toBe('')
  })
})
