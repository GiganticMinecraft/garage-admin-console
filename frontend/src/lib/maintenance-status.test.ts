import { describe, expect, it } from 'vitest'
import type { NodeStorageHealth, StorageHealth } from '@/api'
import {
  blockErrorsCard,
  blockErrorsCoverage,
  decideMaintenanceStatus,
  nodeStatsInput,
  resyncErrorsCard,
  resyncQueueCard,
  scrubCorruptionCard,
  staleCard,
  summarizeNodeMetric,
  type MaintenanceInputs,
} from './maintenance-status'

const ok: MaintenanceInputs = {
  health: { state: 'success', status: 'healthy' },
  blockErrors: { state: 'success', count: 0, checkedNodeCount: 3, nodeErrorCount: 0 },
  nodeStats: { state: 'success', checkedNodeCount: 3, nodeErrorCount: 0 },
}

// One node down: health degraded and both fan-outs miss that node.
const oneNodeDown: MaintenanceInputs = {
  health: { state: 'success', status: 'degraded' },
  blockErrors: { state: 'success', count: 0, checkedNodeCount: 2, nodeErrorCount: 1 },
  nodeStats: { state: 'success', checkedNodeCount: 2, nodeErrorCount: 1 },
}

describe('decideMaintenanceStatus', () => {
  it('is ok only when everything was observed and is clean', () => {
    const s = decideMaintenanceStatus(ok)
    expect(s).toMatchObject({ kind: 'ok', value: '異常なし', tone: 'neutral' })
  })

  it('reports block errors', () => {
    const s = decideMaintenanceStatus({ ...ok, blockErrors: { ...ok.blockErrors, count: 2 } })
    expect(s).toMatchObject({ kind: 'block-errors', tone: 'danger' })
  })

  it('reports a non-healthy cluster before block errors', () => {
    const s = decideMaintenanceStatus({
      ...ok,
      health: { state: 'success', status: 'degraded' },
      blockErrors: { ...ok.blockErrors, count: 2 },
    })
    expect(s.kind).toBe('cluster-unhealthy')
    expect(s.hint).toContain('degraded')
    expect(s.tone).toBe('danger')
  })

  it('reports a node going down as a cluster problem, listing the unchecked nodes', () => {
    const s = decideMaintenanceStatus(oneNodeDown)
    expect(s.kind).toBe('cluster-unhealthy')
    expect(s.hint).toContain('ブロックエラーは 1 ノードで未確認です。')
    expect(s.hint).toContain('リシンク統計は 1 ノードで未確認です。')
  })

  it('puts confirmed block errors above missing data, listing the gaps', () => {
    const s = decideMaintenanceStatus({
      ...ok,
      blockErrors: { state: 'success', count: 4, checkedNodeCount: 2, nodeErrorCount: 1 },
      nodeStats: { state: 'error', checkedNodeCount: 0, nodeErrorCount: 0 },
    })
    expect(s.kind).toBe('block-errors')
    expect(s.hint).toContain('ブロックエラーは 1 ノードで未確認です。')
    expect(s.hint).toContain('リシンク統計を取得できませんでした。')
  })

  it('is unknown when health could not be fetched, even with zero block errors', () => {
    const s = decideMaintenanceStatus({ ...ok, health: { state: 'error' } })
    expect(s).toMatchObject({ kind: 'unknown', value: '判定不可', tone: 'warning' })
    expect(s.hint).toContain('ヘルスステータスを取得できませんでした')
  })

  it('is unknown when block errors could not be fetched', () => {
    const s = decideMaintenanceStatus({ ...ok, blockErrors: { ...ok.blockErrors, state: 'error' } })
    expect(s.kind).toBe('unknown')
    expect(s.hint).toContain('ブロックエラーを取得できませんでした')
  })

  it('is unknown when some nodes did not report block errors, and says so', () => {
    const s = decideMaintenanceStatus({ ...ok, blockErrors: { ...ok.blockErrors, checkedNodeCount: 1, nodeErrorCount: 2 } })
    expect(s).toMatchObject({ kind: 'unknown', value: '判定不可 (一部未確認)', tone: 'warning' })
    expect(s.hint).toContain('2 ノードで未確認')
  })

  it('is unknown when an empty MultiResponse checked no node', () => {
    const s = decideMaintenanceStatus({ ...ok, blockErrors: { ...ok.blockErrors, checkedNodeCount: 0 } })
    expect(s).toMatchObject({ kind: 'unknown', value: '判定不可' })
    expect(s.hint).toContain('ブロックエラーを確認できたノードがありません')
    expect(
      decideMaintenanceStatus({ ...ok, nodeStats: { state: 'success', checkedNodeCount: 0, nodeErrorCount: 0 } }).kind,
    ).toBe('unknown')
  })

  it('is unknown when node stats failed or are partial', () => {
    expect(decideMaintenanceStatus({ ...ok, nodeStats: { ...ok.nodeStats, state: 'error' } }).kind).toBe('unknown')
    expect(decideMaintenanceStatus({ ...ok, nodeStats: { ...ok.nodeStats, nodeErrorCount: 1 } }).kind).toBe('unknown')
  })

  it('shows 確認中 while still loading, never 異常なし', () => {
    const s = decideMaintenanceStatus({ ...ok, nodeStats: { ...ok.nodeStats, state: 'pending' } })
    expect(s).toMatchObject({ kind: 'unknown', value: '確認中' })
  })

  it('treats a missing health status as not healthy', () => {
    expect(decideMaintenanceStatus({ ...ok, health: { state: 'success' } }).kind).toBe('cluster-unhealthy')
  })
})

const node = (over: Partial<NodeStorageHealth> = {}): NodeStorageHealth => ({
  resyncQueueLen: 0,
  resyncErrors: 0,
  scrubCorruptions: 0,
  scrubLastCompleted: null,
  scrub: null,
  ...over,
})

describe('nodeStatsInput', () => {
  it('counts nodes that reported resync stats', () => {
    const h: StorageHealth = { nodes: { a: node(), b: node({ resyncQueueLen: null, resyncErrors: null, error: 'x' }) } }
    expect(nodeStatsInput('success', h)).toEqual({ state: 'success', checkedNodeCount: 1, nodeErrorCount: 1 })
  })

  it('leaves gateway nodes out, so a gateway being down is not "unchecked"', () => {
    const h: StorageHealth = { nodes: { a: node(), gw: node({ resyncQueueLen: null, resyncErrors: null, error: 'x' }) } }
    expect(nodeStatsInput('success', h, new Set(['gw']))).toEqual({ state: 'success', checkedNodeCount: 1, nodeErrorCount: 0 })
  })

  it('treats a stats fan-out error as a failed fetch', () => {
    expect(nodeStatsInput('success', { nodes: {}, statsError: 'boom' }).state).toBe('error')
  })

  it('reports no checked node for an empty answer', () => {
    expect(nodeStatsInput('success', { nodes: {} })).toEqual({ state: 'success', checkedNodeCount: 0, nodeErrorCount: 0 })
  })

  it('passes pending and error through', () => {
    expect(nodeStatsInput('pending', undefined).state).toBe('pending')
    expect(nodeStatsInput('error', undefined).state).toBe('error')
  })
})

describe('blockErrorsCoverage', () => {
  const data = {
    items: [{ nodeId: 'a', blockHash: 'h', refcount: 1, errorCount: 1, lastTrySecsAgo: 0, nextTryInSecs: 0 }],
    checkedNodes: ['a', 'gw1'],
    nodeErrors: { gw2: 'Not connected', b: 'timeout' },
  }

  it('counts everything when no gateway is known', () => {
    expect(blockErrorsCoverage(data)).toEqual({
      count: 1,
      checkedNodeCount: 2,
      nodeErrors: [['b', 'timeout'], ['gw2', 'Not connected']],
    })
  })

  it('leaves gateways out of checked and unchecked nodes', () => {
    expect(blockErrorsCoverage(data, new Set(['gw1', 'gw2']))).toEqual({ count: 1, checkedNodeCount: 1, nodeErrors: [['b', 'timeout']] })
  })

  it('handles missing data', () => {
    expect(blockErrorsCoverage(undefined)).toEqual({ count: 0, checkedNodeCount: 0, nodeErrors: [] })
  })
})

const names = new Map([
  ['id0', 'garage-0'],
  ['id1', 'garage-1'],
  ['id2', 'garage-2'],
])

describe('scrub corruptions', () => {
  it('sums per-node lifetime counters with a labelled breakdown', () => {
    const h: StorageHealth = {
      nodes: { id2: node({ scrubCorruptions: 64 }), id0: node({ scrubCorruptions: 15 }), id1: node({ scrubCorruptions: 19 }) },
    }
    const s = summarizeNodeMetric(h, (n) => n.scrubCorruptions, 'vars', { names })
    expect(s.total).toBe(98)
    expect(s.perNode.map((n) => `${n.label}=${n.value}`)).toEqual(['garage-0=15', 'garage-1=19', 'garage-2=64'])
    const card = scrubCorruptionCard(s)
    expect(card).toMatchObject({ value: '98', tone: 'neutral' })
    expect(card.hint).toContain('scrub-corruptions_detected')
    expect(card.hint).toContain('garage-0: 15 / garage-1: 19 / garage-2: 64')
  })

  it('lists nodes without a value (unnamed ones by short ID) and flags the card', () => {
    const id = 'b'.repeat(64)
    const h: StorageHealth = {
      nodes: { id0: node({ scrubCorruptions: 3 }), [id]: node({ scrubCorruptions: null, varsError: 'ノードが応答しませんでした' }) },
    }
    const s = summarizeNodeMetric(h, (n) => n.scrubCorruptions, 'vars', { names })
    expect(s.total).toBe(3)
    expect(s.missing).toEqual([{ nodeId: id, label: `${'b'.repeat(16)}…`, reason: 'ノードが応答しませんでした' }])
    const card = scrubCorruptionCard(s)
    expect(card.tone).toBe('warning')
    expect(card.hint).toContain(`未取得 1 ノード: ${'b'.repeat(16)}… (ノードが応答しませんでした)`)
  })

  it('cites only the scrub variables reason, not unrelated fan-outs', () => {
    const h: StorageHealth = {
      nodes: {
        id0: node({
          scrubCorruptions: null,
          error: 'ノード統計: x; worker 変数: vars down; worker 一覧: y',
          statsError: 'x',
          varsError: 'vars down',
          workersError: 'y',
        }),
      },
      workersError: 'worker 一覧の取得に失敗しました',
    }
    const s = summarizeNodeMetric(h, (n) => n.scrubCorruptions, 'vars', { names })
    expect(s.missing[0].reason).toBe('vars down')
    expect(scrubCorruptionCard(s).hint).not.toContain('worker 一覧')
  })

  it('falls back to the combined error for a backend that does not split it', () => {
    const h: StorageHealth = { nodes: { id0: node({ scrubCorruptions: null, error: 'old style' }) } }
    expect(summarizeNodeMetric(h, (n) => n.scrubCorruptions, 'vars').missing[0].reason).toBe('old style')
  })

  it('falls back to the fan-out error for a node without one', () => {
    const h: StorageHealth = { nodes: { id0: node({ scrubCorruptions: null }) }, varsError: 'worker 変数の取得に失敗しました' }
    const s = summarizeNodeMetric(h, (n) => n.scrubCorruptions, 'vars', { names })
    expect(s.total).toBeNull()
    expect(s.missing[0].reason).toBe('worker 変数の取得に失敗しました')
    expect(scrubCorruptionCard(s).value).toBe('取得失敗')
  })

  it('keeps the relevant fan-out error when no node is listed at all', () => {
    const h: StorageHealth = {
      nodes: {},
      statsError: 'ノード統計の取得に失敗しました',
      varsError: 'worker 変数の取得に失敗しました: boom',
      workersError: 'worker 一覧の取得に失敗しました',
    }
    const card = scrubCorruptionCard(summarizeNodeMetric(h, (n) => n.scrubCorruptions, 'vars'))
    expect(card.value).toBe('取得失敗')
    expect(card.hint).toContain('worker 変数の取得に失敗しました: boom')
    expect(card.hint).not.toContain('ノード統計')
    expect(card.hint).not.toContain('worker 一覧')
  })

  it('says no node answered for an empty answer without errors', () => {
    const card = scrubCorruptionCard(summarizeNodeMetric({ nodes: {} }, (n) => n.scrubCorruptions, 'vars'))
    expect(card).toMatchObject({ value: '取得失敗', tone: 'warning' })
    expect(card.hint).toContain('応答したノードがありません')
  })

  it('skips gateway nodes', () => {
    const h: StorageHealth = { nodes: { id0: node({ scrubCorruptions: 4 }), gw: node({ scrubCorruptions: null, varsError: 'down' }) } }
    const s = summarizeNodeMetric(h, (n) => n.scrubCorruptions, 'vars', { skip: new Set(['gw']) })
    expect(s).toMatchObject({ total: 4, missing: [] })
  })
})

describe('resync cards', () => {
  const h: StorageHealth = {
    nodes: {
      id0: node({ resyncQueueLen: 5, resyncErrors: 1 }),
      id1: node({ resyncQueueLen: 2, resyncErrors: 0 }),
      id2: node({ resyncQueueLen: null, resyncErrors: null, statsError: 'Not connected', workersError: 'unrelated' }),
    },
  }

  it('sums the nodes that answered and lists the missing one with the stats reason only', () => {
    const errors = resyncErrorsCard(summarizeNodeMetric(h, (n) => n.resyncErrors, 'stats', { names }))
    expect(errors).toMatchObject({ value: '1', tone: 'danger' })
    expect(errors.hint).toContain('2 ノード分の合計')
    expect(errors.hint).toContain('garage-2 (Not connected)')
    expect(errors.hint).not.toContain('unrelated')
    const queue = resyncQueueCard(summarizeNodeMetric(h, (n) => n.resyncQueueLen, 'stats', { names }))
    expect(queue).toMatchObject({ value: '7', tone: 'warning' })
    expect(queue.hint).toContain('garage-0: 5 / garage-1: 2')
  })

  it('reports the stats fan-out error instead of 0, without the workers error', () => {
    const failed: StorageHealth = { nodes: {}, statsError: 'ノード統計の取得に失敗しました', workersError: 'worker 一覧の取得に失敗しました' }
    const card = resyncErrorsCard(summarizeNodeMetric(failed, (n) => n.resyncErrors, 'stats'))
    expect(card.value).toBe('取得失敗')
    expect(card.hint).toContain('ノード統計の取得に失敗しました')
    expect(card.hint).not.toContain('worker 一覧')
  })
})

describe('staleCard', () => {
  it('keeps the value but flags it and says how old it is', () => {
    const s = staleCard({ value: '98', hint: '説明', tone: 'neutral' }, 31.6)
    expect(s.value).toBe('98')
    expect(s.tone).toBe('warning')
    expect(s.hint).toContain('取得失敗')
    expect(s.hint).toContain('32 秒前')
    expect(s.hint).toContain('説明')
  })

  it('keeps danger as danger', () => {
    expect(staleCard({ value: '1', hint: '', tone: 'danger' }, 5).tone).toBe('danger')
  })
})

describe('blockErrorsCard', () => {
  it('distinguishes clean, partial, empty, pending and failed answers', () => {
    expect(blockErrorsCard({ state: 'success', count: 0, checkedNodeCount: 3, nodeErrorCount: 0 })).toMatchObject({ value: '0', tone: 'neutral' })
    expect(blockErrorsCard({ state: 'success', count: 0, checkedNodeCount: 2, nodeErrorCount: 1 })).toMatchObject({ value: '0', tone: 'warning' })
    expect(blockErrorsCard({ state: 'success', count: 0, checkedNodeCount: 0, nodeErrorCount: 0 })).toMatchObject({ value: '取得失敗' })
    expect(blockErrorsCard({ state: 'success', count: 2, checkedNodeCount: 2, nodeErrorCount: 1 })).toMatchObject({ value: '2', tone: 'danger' })
    expect(blockErrorsCard({ state: 'pending', count: 0, checkedNodeCount: 0, nodeErrorCount: 0 }).value).toBe('確認中')
    expect(blockErrorsCard({ state: 'error', count: 0, checkedNodeCount: 0, nodeErrorCount: 0 }).value).toBe('取得失敗')
  })
})
