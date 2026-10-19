import type { MultiResponse } from '@/api'

/**
 * Outcome of a Garage MultiResponse:
 * - success: every node that answered succeeded (and at least one did)
 * - partial: some nodes succeeded, some failed
 * - failure: no node succeeded (including the degenerate "no node at all")
 */
export type MultiOutcome = 'success' | 'partial' | 'failure'

export interface NodeFailure {
  nodeId: string
  message: string
}

export interface MultiResponseSummary<T> {
  outcome: MultiOutcome
  /** Per-node results of the nodes that succeeded, sorted by node ID. */
  succeeded: { nodeId: string; result: T }[]
  /** Nodes that failed with Garage's message, sorted by node ID. */
  failed: NodeFailure[]
}

export function summarizeMultiResponse<T>(resp: MultiResponse<T>): MultiResponseSummary<T> {
  const succeeded = Object.entries(resp.success ?? {})
    .map(([nodeId, result]) => ({ nodeId, result }))
    .sort((a, b) => a.nodeId.localeCompare(b.nodeId))
  const failed = Object.entries(resp.error ?? {})
    .map(([nodeId, message]) => ({ nodeId, message }))
    .sort((a, b) => a.nodeId.localeCompare(b.nodeId))
  const outcome: MultiOutcome =
    succeeded.length === 0 ? 'failure' : failed.length > 0 ? 'partial' : 'success'
  return { outcome, succeeded, failed }
}

/** First 12 characters of a node ID, as the blocks / repair pages show it. */
export function shortNodeId(nodeId: string): string {
  return nodeId.length > 12 ? `${nodeId.slice(0, 12)}…` : nodeId
}

/**
 * "node1…: msg / node2…: msg" for a toast or banner. Lists at most `limit`
 * nodes and summarises the rest as "他 N ノード".
 */
export function formatNodeFailures(failed: NodeFailure[], limit = 3): string {
  const shown = failed.slice(0, limit).map((f) => `${shortNodeId(f.nodeId)}: ${f.message}`)
  const rest = failed.length - shown.length
  return rest > 0 ? `${shown.join(' / ')} / 他 ${rest} ノード` : shown.join(' / ')
}

export interface MultiResponseToast {
  level: 'success' | 'warning' | 'error'
  message: string
}

/**
 * Toast for a mutation answered with a MultiResponse. `action` names the
 * operation for the failure text ("パージ" → "パージに失敗しました");
 * `successMessage` builds the lead sentence from the succeeded results and
 * is only called when at least one node succeeded.
 */
export function multiResponseToast<T>(
  resp: MultiResponse<T>,
  opts: { action: string; successMessage: (succeeded: T[]) => string },
): MultiResponseToast & { outcome: MultiOutcome } {
  const s = summarizeMultiResponse(resp)
  if (s.outcome === 'failure') {
    const message =
      s.failed.length === 0
        ? `${opts.action}に失敗しました: 応答したノードがありません`
        : `${opts.action}に失敗しました (${s.failed.length}ノード): ${formatNodeFailures(s.failed)}`
    return { outcome: s.outcome, level: 'error', message }
  }
  const lead = opts.successMessage(s.succeeded.map((x) => x.result))
  if (s.outcome === 'partial') {
    return {
      outcome: s.outcome,
      level: 'warning',
      message: `${lead} (${s.succeeded.length}ノード成功、${s.failed.length}ノード失敗: ${formatNodeFailures(s.failed)})`,
    }
  }
  return { outcome: s.outcome, level: 'success', message: `${lead} (${s.succeeded.length}ノード)` }
}
