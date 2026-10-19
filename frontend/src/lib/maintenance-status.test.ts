import { describe, expect, it } from 'vitest'
import type { NodeStorageHealth } from '@/api'
import {
  decideMaintenanceStatus,
  scrubCorruptionCard,
  summarizeScrubCorruptions,
  type MaintenanceInputs,
} from './maintenance-status'

const ok: MaintenanceInputs = {
  health: { state: 'success', status: 'healthy' },
  blockErrors: { state: 'success', count: 0, nodeErrorCount: 0 },
  metrics: { state: 'success', nodeErrorCount: 0 },
}

describe('decideMaintenanceStatus', () => {
  it('is ok only when everything was observed and is clean', () => {
    const s = decideMaintenanceStatus(ok)
    expect(s.kind).toBe('ok')
    expect(s.value).toBe('異常なし')
    expect(s.tone).toBe('neutral')
  })

  it('reports block errors', () => {
    const s = decideMaintenanceStatus({ ...ok, blockErrors: { state: 'success', count: 2, nodeErrorCount: 0 } })
    expect(s.kind).toBe('block-errors')
    expect(s.tone).toBe('danger')
  })

  it('reports a non-healthy cluster before block errors', () => {
    const s = decideMaintenanceStatus({
      ...ok,
      health: { state: 'success', status: 'degraded' },
      blockErrors: { state: 'success', count: 2, nodeErrorCount: 0 },
    })
    expect(s.kind).toBe('cluster-unhealthy')
    expect(s.hint).toContain('degraded')
    expect(s.tone).toBe('danger')
  })

  it('is unknown when health could not be fetched, even with zero block errors', () => {
    const s = decideMaintenanceStatus({ ...ok, health: { state: 'error' } })
    expect(s.kind).toBe('unknown')
    expect(s.value).toBe('判定不可')
    expect(s.hint).toContain('ヘルスステータスを取得できませんでした')
  })

  it('is unknown when block errors could not be fetched', () => {
    const s = decideMaintenanceStatus({ ...ok, blockErrors: { state: 'error', count: 0, nodeErrorCount: 0 } })
    expect(s.kind).toBe('unknown')
    expect(s.hint).toContain('ブロックエラーを取得できませんでした')
  })

  it('is unknown when some nodes did not report block errors, and says so', () => {
    const s = decideMaintenanceStatus({ ...ok, blockErrors: { state: 'success', count: 0, nodeErrorCount: 2 } })
    expect(s.kind).toBe('unknown')
    expect(s.value).toBe('判定不可 (一部未確認)')
    expect(s.hint).toContain('2 ノードで未確認')
    expect(s.tone).toBe('warning')
  })

  it('is unknown when metrics failed or are partial', () => {
    expect(decideMaintenanceStatus({ ...ok, metrics: { state: 'error', nodeErrorCount: 0 } }).kind).toBe('unknown')
    expect(decideMaintenanceStatus({ ...ok, metrics: { state: 'success', nodeErrorCount: 1 } }).kind).toBe('unknown')
  })

  it('puts unknown above a cluster problem and block errors', () => {
    const s = decideMaintenanceStatus({
      health: { state: 'success', status: 'unavailable' },
      blockErrors: { state: 'success', count: 5, nodeErrorCount: 1 },
      metrics: { state: 'success', nodeErrorCount: 0 },
    })
    expect(s.kind).toBe('unknown')
  })

  it('shows 確認中 while still loading, never 異常なし', () => {
    const s = decideMaintenanceStatus({ ...ok, metrics: { state: 'pending', nodeErrorCount: 0 } })
    expect(s.kind).toBe('unknown')
    expect(s.value).toBe('確認中')
  })

  it('treats a missing health status as not healthy', () => {
    expect(decideMaintenanceStatus({ ...ok, health: { state: 'success' } }).kind).toBe('cluster-unhealthy')
  })
})

const node = (scrubCorruptions: number | null, error?: string): NodeStorageHealth => ({
  resyncQueueLen: 0,
  resyncErrors: 0,
  scrubCorruptions,
  scrubLastCompleted: null,
  scrub: null,
  ...(error ? { error } : {}),
})

describe('summarizeScrubCorruptions', () => {
  it('sums per-node lifetime counters with a labelled breakdown', () => {
    const names = new Map([
      ['id0', 'garage-0'],
      ['id1', 'garage-1'],
      ['id2', 'garage-2'],
    ])
    const s = summarizeScrubCorruptions({ nodes: { id2: node(64), id0: node(15), id1: node(19) } }, names)
    expect(s.total).toBe(98)
    expect(s.perNode.map((n) => `${n.label}=${n.value}`)).toEqual(['garage-0=15', 'garage-1=19', 'garage-2=64'])
    expect(s.missing).toEqual([])
    const card = scrubCorruptionCard(s)
    expect(card.value).toBe('98')
    expect(card.tone).toBe('neutral')
    expect(card.hint).toContain('scrub-corruptions_detected')
    expect(card.hint).toContain('garage-0: 15 / garage-1: 19 / garage-2: 64')
  })

  it('lists nodes without a value and flags the card', () => {
    const s = summarizeScrubCorruptions({ nodes: { aaaaaaaaaaaa: node(3), bbbbbbbbbbbb: node(null, 'ノードが応答しませんでした') } })
    expect(s.total).toBe(3)
    expect(s.missing).toEqual([{ nodeId: 'bbbbbbbbbbbb', label: 'bbbbbbbb', reason: 'ノードが応答しませんでした' }])
    const card = scrubCorruptionCard(s)
    expect(card.tone).toBe('warning')
    expect(card.hint).toContain('未取得 1 ノード: bbbbbbbb (ノードが応答しませんでした)')
  })

  it('falls back to the fan-out error, and is unknown when no node reported', () => {
    const s = summarizeScrubCorruptions({ nodes: { a: node(null) }, varsError: 'worker 変数の取得に失敗しました' })
    expect(s.total).toBeNull()
    expect(s.missing[0].reason).toBe('worker 変数の取得に失敗しました')
    expect(scrubCorruptionCard(s).value).toBe('取得失敗')
  })
})
