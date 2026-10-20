import type { BlockErrorsResponse, NodeStorageHealth, StorageHealth } from '@/api'
import { formatCount } from '@/lib/format'
import { nodeDisplayName } from '@/lib/nodes'

/** react-query state of one input, reduced to what the decision needs. */
export type FetchState = 'pending' | 'error' | 'success'

/** react-query status → FetchState. */
export function fetchState(q: { isPending: boolean; isError: boolean }): FetchState {
  return q.isError ? 'error' : q.isPending ? 'pending' : 'success'
}

/** A per-node fan-out: how many nodes were read and how many were not. */
export interface FanOutInput {
  state: FetchState
  /** Nodes whose answer was read. 0 with state 'success' means nothing was observed. */
  checkedNodeCount: number
  /** Nodes that did not answer or answered something unreadable. */
  nodeErrorCount: number
}

export interface MaintenanceInputs {
  /** GET /api/cluster/health; status is Garage's ("healthy" / "degraded" / "unavailable"). */
  health: { state: FetchState; status?: string }
  /** GET /api/blocks/errors. */
  blockErrors: FanOutInput & { count: number }
  /** Resync stats per node from GET /api/cluster/storage-health (see nodeStatsInput). */
  nodeStats: FanOutInput
}

export type MaintenanceKind = 'unknown' | 'cluster-unhealthy' | 'block-errors' | 'ok'
export type Tone = 'neutral' | 'warning' | 'danger'

export interface MaintenanceStatus {
  kind: MaintenanceKind
  value: string
  hint: string
  tone: Tone
}

interface Gaps {
  /** Nothing observed: a failed fetch, or no node answered. */
  blind: string[]
  /** Observed, but some nodes are missing. */
  partial: string[]
  pending: string[]
}

function fanOutGaps(name: string, f: FanOutInput, gaps: Gaps) {
  if (f.state === 'pending') gaps.pending.push(name)
  else if (f.state === 'error') gaps.blind.push(`${name}を取得できませんでした。`)
  else if (f.checkedNodeCount === 0) gaps.blind.push(`${name}を確認できたノードがありません。`)
  else if (f.nodeErrorCount > 0) gaps.partial.push(`${name}は ${f.nodeErrorCount} ノードで未確認です。`)
}

function observationGaps(inp: MaintenanceInputs): Gaps {
  const gaps: Gaps = { blind: [], partial: [], pending: [] }
  if (inp.health.state === 'pending') gaps.pending.push('ヘルスステータス')
  else if (inp.health.state === 'error') gaps.blind.push('ヘルスステータスを取得できませんでした。')
  fanOutGaps('ブロックエラー', inp.blockErrors, gaps)
  fanOutGaps('リシンク統計', inp.nodeStats, gaps)
  return gaps
}

/**
 * The "推奨アクション" card. Precedence: クラスタ異常 > ブロックエラー >
 * 判定不可 > 正常. A confirmed problem wins over missing data (a node going
 * down makes the cluster degraded *and* leaves nodes unchecked, and the
 * former is the actionable fact), but the hint still lists what could not be
 * checked. Without a confirmed problem, anything not observed — a failed
 * fetch, no node answering, some nodes missing, or a fetch still in flight —
 * keeps the verdict away from "異常なし".
 */
export function decideMaintenanceStatus(inp: MaintenanceInputs): MaintenanceStatus {
  const gaps = observationGaps(inp)
  const gapText = [...gaps.blind, ...gaps.partial].join('')
  const withGaps = (hint: string) => (gapText ? `${hint} なお、${gapText}` : hint)

  if (inp.health.state === 'success' && inp.health.status !== 'healthy') {
    return {
      kind: 'cluster-unhealthy',
      value: 'クラスタ異常',
      hint: withGaps(
        `ヘルスステータスが ${inp.health.status ?? 'unknown'} です。修復操作の前に、ノードの接続状態とレイアウトを確認してください。`,
      ),
      tone: 'danger',
    }
  }

  if (inp.blockErrors.state === 'success' && inp.blockErrors.count > 0) {
    return {
      kind: 'block-errors',
      value: 'エラー調査',
      hint: withGaps('操作を実行する前に、ブロックエラーページで失敗しているブロックを確認してください。'),
      tone: 'danger',
    }
  }

  if (gapText) {
    return {
      kind: 'unknown',
      value: gaps.blind.length > 0 ? '判定不可' : '判定不可 (一部未確認)',
      hint: `${gapText}確認できていない範囲に異常がある可能性があるため、正常とは判断できません。`,
      tone: 'warning',
    }
  }
  if (gaps.pending.length > 0) {
    return {
      kind: 'unknown',
      value: '確認中',
      hint: `${gaps.pending.join('・')}を取得しています。`,
      tone: 'neutral',
    }
  }

  return {
    kind: 'ok',
    value: '異常なし',
    hint: '緊急の対応は不要です。定期的な Scrub を計画してください。',
    tone: 'neutral',
  }
}

/** Nodes to leave out of block-level coverage (see nonStorageNodeIds). */
export type SkipNodes = ReadonlySet<string>
const NO_SKIP: SkipNodes = new Set()

/**
 * Coverage of a GET /api/blocks/errors answer, ignoring nodes that hold no
 * blocks: a gateway that is down neither counts as unchecked nor shows in
 * the banner, and a gateway that answered does not count as checked.
 */
export function blockErrorsCoverage(
  data: BlockErrorsResponse | undefined,
  skip: SkipNodes = NO_SKIP,
): { count: number; checkedNodeCount: number; nodeErrors: [string, string][] } {
  return {
    count: data?.items.length ?? 0,
    checkedNodeCount: (data?.checkedNodes ?? []).filter((id) => !skip.has(id)).length,
    nodeErrors: Object.entries(data?.nodeErrors ?? {})
      .filter(([id]) => !skip.has(id))
      .sort(([a], [b]) => a.localeCompare(b)),
  }
}

/**
 * The decision's nodeStats input from the storage-health query: a storage
 * node is checked when it reported its resync stats.
 */
export function nodeStatsInput(state: FetchState, health: StorageHealth | undefined, skip: SkipNodes = NO_SKIP): FanOutInput {
  if (state !== 'success' || !health) return { state: state === 'success' ? 'error' : state, checkedNodeCount: 0, nodeErrorCount: 0 }
  if (health.statsError) return { state: 'error', checkedNodeCount: 0, nodeErrorCount: 0 }
  const nodes = Object.entries(health.nodes).filter(([id]) => !skip.has(id)).map(([, n]) => n)
  const checked = nodes.filter((n) => n.resyncQueueLen != null && n.resyncErrors != null).length
  return { state: 'success', checkedNodeCount: checked, nodeErrorCount: nodes.length - checked }
}

export interface NodeMetricSummary {
  /** Sum over the nodes that reported a value; null when none did. */
  total: number | null
  /** Nodes that reported the value, sorted by label. */
  perNode: { nodeId: string; label: string; value: number }[]
  /** Nodes whose value is unknown, with the reason. */
  missing: { nodeId: string; label: string; reason: string }[]
  /** Error of the fan-out that produces the metric, if it failed as a whole. */
  fanOutError?: string
}

/** Which storage-health fan-out a card's metric comes from. */
export type MetricSource = 'stats' | 'vars'

/**
 * Sums one per-node metric of storage-health over the storage nodes. Only
 * the reasons of the fan-out the metric comes from are cited (statsError for
 * resync, varsError for scrub), falling back to the combined `error` for a
 * backend that does not split them. `names` maps node ID to hostname.
 */
export function summarizeNodeMetric(
  health: StorageHealth,
  pick: (n: NodeStorageHealth) => number | null,
  source: MetricSource,
  opts: { names?: ReadonlyMap<string, string>; skip?: SkipNodes } = {},
): NodeMetricSummary {
  const names = opts.names ?? new Map<string, string>()
  const skip = opts.skip ?? NO_SKIP
  const fanOutError = source === 'stats' ? health.statsError : health.varsError
  const nodeError = (n: NodeStorageHealth) =>
    (source === 'stats' ? n.statsError : n.varsError) ??
    (n.statsError === undefined && n.varsError === undefined && n.workersError === undefined ? n.error : undefined)
  const label = (id: string) => nodeDisplayName({ id, hostname: names.get(id) ?? null })
  const perNode: NodeMetricSummary['perNode'] = []
  const missing: NodeMetricSummary['missing'] = []
  for (const [nodeId, n] of Object.entries(health.nodes)) {
    if (skip.has(nodeId)) continue
    const v = pick(n)
    if (v != null) perNode.push({ nodeId, label: label(nodeId), value: v })
    else missing.push({ nodeId, label: label(nodeId), reason: nodeError(n) || fanOutError || '値が報告されていません' })
  }
  const byLabel = (a: { label: string }, b: { label: string }) => a.label.localeCompare(b.label)
  perNode.sort(byLabel)
  missing.sort(byLabel)
  const total = perNode.length > 0 ? perNode.reduce((s, n) => s + n.value, 0) : null
  return { total, perNode, missing, fanOutError }
}

export interface CardSpec {
  value: string
  hint: string
  tone: Tone
}

function breakdown(s: NodeMetricSummary): string {
  return s.perNode.length > 1 ? ` 内訳: ${s.perNode.map((n) => `${n.label}: ${formatCount(n.value)}`).join(' / ')}` : ''
}

function missingText(s: NodeMetricSummary): string {
  return s.missing.length > 0
    ? ` 未取得 ${s.missing.length} ノード: ${s.missing.map((n) => `${n.label} (${n.reason})`).join(' / ')}`
    : ''
}

/** Card for a metric no node reported: says why, never shows 0. */
function unavailableCard(s: NodeMetricSummary): CardSpec {
  const why = s.missing.length > 0
    ? missingText(s).trim()
    : s.fanOutError ?? 'Garage から応答したノードがありません。'
  return { value: '取得失敗', hint: `どのノードからも取得できませんでした。${why}`, tone: 'warning' }
}

/** "破損検出回数 (累積)": the persisted per-node scrub-corruptions_detected. */
export function scrubCorruptionCard(s: NodeMetricSummary): CardSpec {
  if (s.total == null) return unavailableCard(s)
  const about =
    'Scrub が検出した破損の累積回数(各ノードの worker 変数 scrub-corruptions_detected の合計)です。Garage が永続化しておりリセットされないため、増えていなければ新たな破損はありません。検出ブロックはレプリカから再取得されます。'
  return {
    value: formatCount(s.total),
    hint: `${about}${breakdown(s)}${missingText(s)}`,
    tone: s.missing.length > 0 ? 'warning' : 'neutral',
  }
}

function scope(s: NodeMetricSummary): string {
  return ` ${s.perNode.length} ノード分の合計です。`
}

/** "リシンクエラー数" from each node's resyncErrors. */
export function resyncErrorsCard(s: NodeMetricSummary): CardSpec {
  if (s.total == null) return unavailableCard(s)
  return {
    value: formatCount(s.total),
    hint:
      (s.total > 0
        ? 'リシンクに失敗しているブロックがあります。ブロックエラーページで確認してください。'
        : '確認できたノードではリシンクエラーはありません。') +
      scope(s) + breakdown(s) + missingText(s),
    tone: s.total > 0 ? 'danger' : s.missing.length > 0 ? 'warning' : 'neutral',
  }
}

/** "リシンクキュー長" from each node's resyncQueueLen. */
export function resyncQueueCard(s: NodeMetricSummary): CardSpec {
  if (s.total == null) return unavailableCard(s)
  return {
    value: formatCount(s.total),
    hint:
      (s.total > 0
        ? 'リシンク待ちのブロックがあります。増減の推移は Grafana で確認してください。'
        : 'リシンク待ちはありません。') +
      scope(s) + breakdown(s) + missingText(s),
    tone: s.missing.length > 0 ? 'warning' : 'neutral',
  }
}

/**
 * A card whose latest refetch failed while older data is still cached: keep
 * the value, but flag it and say how old it was when the refetch failed.
 * `ageSecs` is errorUpdatedAt - dataUpdatedAt.
 */
export function staleCard(spec: CardSpec, ageSecs: number): CardSpec {
  const age = Math.max(0, Math.round(ageSecs))
  return {
    value: spec.value,
    hint: `取得失敗: 最新の取得に失敗したため、その ${formatCount(age)} 秒前に取得した値を表示しています。${spec.hint}`,
    tone: spec.tone === 'danger' ? 'danger' : 'warning',
  }
}

/** "ブロックエラー数" card on the repair page. */
export function blockErrorsCard(b: MaintenanceInputs['blockErrors']): CardSpec {
  if (b.state === 'error') return { value: '取得失敗', hint: 'ブロックエラーの取得に失敗しました。', tone: 'warning' }
  if (b.state === 'pending') return { value: '確認中', hint: 'ブロックエラーを取得しています。', tone: 'neutral' }
  if (b.checkedNodeCount === 0 && b.count === 0) {
    return {
      value: '取得失敗',
      hint: b.nodeErrorCount > 0
        ? `どのノードからもブロックエラーを取得できませんでした (${b.nodeErrorCount} ノード)。`
        : 'ブロックエラーを確認できたノードがありません。',
      tone: 'warning',
    }
  }
  const unchecked = b.nodeErrorCount > 0 ? ` ${b.nodeErrorCount} ノードから取得できていません。` : ''
  if (b.count > 0) {
    return { value: formatCount(b.count), hint: `エラーがあります。ブロックエラーページで内容を確認してください。${unchecked}`, tone: 'danger' }
  }
  return b.nodeErrorCount > 0
    ? { value: '0', hint: `確認できた範囲ではリシンクエラーはありません。${unchecked}`, tone: 'warning' }
    : { value: '0', hint: 'リシンクエラーはありません。', tone: 'neutral' }
}
