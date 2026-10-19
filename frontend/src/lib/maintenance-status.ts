import type { StorageHealth } from '@/api'

/** react-query state of one input, reduced to what the decision needs. */
export type FetchState = 'pending' | 'error' | 'success'

export interface MaintenanceInputs {
  /** GET /api/cluster/health; status is Garage's ("healthy" / "degraded" / "unavailable"). */
  health: { state: FetchState; status?: string }
  /** GET /api/blocks/errors; nodeErrorCount = nodes that could not be checked. */
  blockErrors: { state: FetchState; count: number; nodeErrorCount: number }
  /** GET /api/metrics (resync stats); nodeErrorCount = nodes without stats. */
  metrics: { state: FetchState; nodeErrorCount: number }
}

export type MaintenanceKind = 'unknown' | 'cluster-unhealthy' | 'block-errors' | 'ok'
export type Tone = 'neutral' | 'warning' | 'danger'

export interface MaintenanceStatus {
  kind: MaintenanceKind
  value: string
  hint: string
  tone: Tone
}

/**
 * The "推奨アクション" card. Precedence: 判定不可 > クラスタ異常 > ブロック
 * エラー > 正常. Anything we could not observe (a failed fetch, a fetch still
 * in flight, or nodes that did not answer) makes the verdict unknown rather
 * than "no problem", because the missing part may be exactly where the
 * problem is.
 */
export function decideMaintenanceStatus(inp: MaintenanceInputs): MaintenanceStatus {
  const pending: string[] = []
  const failed: string[] = []
  const partial: string[] = []

  if (inp.health.state === 'pending') pending.push('ヘルスステータス')
  else if (inp.health.state === 'error') failed.push('ヘルスステータス')

  if (inp.blockErrors.state === 'pending') pending.push('ブロックエラー')
  else if (inp.blockErrors.state === 'error') failed.push('ブロックエラー')
  else if (inp.blockErrors.nodeErrorCount > 0) {
    partial.push(`ブロックエラーは ${inp.blockErrors.nodeErrorCount} ノードで未確認`)
  }

  if (inp.metrics.state === 'pending') pending.push('ブロック管理メトリクス')
  else if (inp.metrics.state === 'error') failed.push('ブロック管理メトリクス')
  else if (inp.metrics.nodeErrorCount > 0) {
    partial.push(`ブロック管理メトリクスは ${inp.metrics.nodeErrorCount} ノードで未確認`)
  }

  if (failed.length > 0 || partial.length > 0) {
    const parts: string[] = []
    if (failed.length > 0) parts.push(`${failed.join('・')}を取得できませんでした。`)
    if (partial.length > 0) parts.push(`${partial.join('、')}です。`)
    parts.push('確認できていない範囲に異常がある可能性があるため、正常とは判断できません。')
    return {
      kind: 'unknown',
      value: failed.length > 0 ? '判定不可' : '判定不可 (一部未確認)',
      hint: parts.join(''),
      tone: 'warning',
    }
  }
  if (pending.length > 0) {
    return {
      kind: 'unknown',
      value: '確認中',
      hint: `${pending.join('・')}を取得しています。`,
      tone: 'neutral',
    }
  }

  const status = inp.health.status ?? 'unknown'
  if (status !== 'healthy') {
    return {
      kind: 'cluster-unhealthy',
      value: 'クラスタ異常',
      hint: `ヘルスステータスが ${status} です。修復操作の前に、ノードの接続状態とレイアウトを確認してください。`,
      tone: 'danger',
    }
  }

  if (inp.blockErrors.count > 0) {
    return {
      kind: 'block-errors',
      value: 'エラー調査',
      hint: '操作を実行する前に、ブロックエラーページで失敗しているブロックを確認してください。',
      tone: 'danger',
    }
  }

  return {
    kind: 'ok',
    value: '異常なし',
    hint: '緊急の対応は不要です。定期的な Scrub を計画してください。',
    tone: 'neutral',
  }
}

export interface ScrubCorruptionSummary {
  /** Sum over the nodes that reported a value; null when none did. */
  total: number | null
  /** Nodes that reported scrub-corruptions_detected, sorted by label. */
  perNode: { nodeId: string; label: string; value: number }[]
  /** Nodes whose value is unknown, with the reason. */
  missing: { nodeId: string; label: string; reason: string }[]
}

/**
 * Sums each node's persisted scrub-corruptions_detected (the same value the
 * dashboard shows per node). `names` maps node ID to a display name
 * (hostname); unknown nodes fall back to the first 8 characters of the ID.
 */
export function summarizeScrubCorruptions(
  health: StorageHealth,
  names: ReadonlyMap<string, string> = new Map(),
): ScrubCorruptionSummary {
  const label = (id: string) => names.get(id) ?? id.slice(0, 8)
  const perNode: ScrubCorruptionSummary['perNode'] = []
  const missing: ScrubCorruptionSummary['missing'] = []
  for (const [nodeId, n] of Object.entries(health.nodes)) {
    if (n.scrubCorruptions != null) {
      perNode.push({ nodeId, label: label(nodeId), value: n.scrubCorruptions })
    } else {
      missing.push({
        nodeId,
        label: label(nodeId),
        reason: n.error ?? health.varsError ?? '値が報告されていません',
      })
    }
  }
  const byLabel = (a: { label: string }, b: { label: string }) => a.label.localeCompare(b.label)
  perNode.sort(byLabel)
  missing.sort(byLabel)
  const total = perNode.length > 0 ? perNode.reduce((s, n) => s + n.value, 0) : null
  return { total, perNode, missing }
}

/** Value / hint / tone for the "破損検出回数 (累積)" card. */
export function scrubCorruptionCard(s: ScrubCorruptionSummary): { value: string; hint: string; tone: Tone } {
  const about =
    'Scrub が検出した破損の累積回数(各ノードの worker 変数 scrub-corruptions_detected の合計)です。Garage が永続化しておりリセットされないため、増えていなければ新たな破損はありません。検出ブロックはレプリカから再取得されます。'
  const breakdown = s.perNode.length > 0 ? ` 内訳: ${s.perNode.map((n) => `${n.label}: ${n.value.toLocaleString('ja-JP')}`).join(' / ')}` : ''
  const missing = s.missing.length > 0
    ? ` 未取得 ${s.missing.length} ノード: ${s.missing.map((n) => `${n.label} (${n.reason})`).join(' / ')}`
    : ''
  if (s.total == null) {
    return { value: '取得失敗', hint: `どのノードからも取得できませんでした。${missing}`, tone: 'warning' }
  }
  return {
    value: s.total.toLocaleString('ja-JP'),
    hint: `${about}${breakdown}${missing}`,
    tone: s.missing.length > 0 ? 'warning' : 'neutral',
  }
}
