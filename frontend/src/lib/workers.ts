import type { Worker, WorkerState } from '@/api'

/** Relative "N秒前 / 分前 / 時間前 / 日前" label for a duration in seconds. */
export function formatSecsAgo(secs: number): string {
  if (secs < 60) return `${Math.floor(secs)}秒前`
  if (secs < 3600) return `${Math.floor(secs / 60)}分前`
  if (secs < 86400) return `${Math.floor(secs / 3600)}時間前`
  return `${Math.floor(secs / 86400)}日前`
}

export type StateKind = 'idle' | 'busy' | 'throttled' | 'done' | 'other'

export function describeState(state: WorkerState): { label: string; kind: StateKind } {
  if (typeof state === 'object' && state !== null && 'throttled' in state) {
    const secs = state.throttled?.durationSecs
    const detail = typeof secs === 'number' ? ` (${secs.toFixed(1)}s)` : ''
    return { label: `throttled${detail}`, kind: 'throttled' }
  }
  if (state === 'idle') return { label: 'idle', kind: 'idle' }
  if (state === 'busy') return { label: 'busy', kind: 'busy' }
  if (state === 'done') return { label: 'done', kind: 'done' }
  return { label: typeof state === 'string' && state.length > 0 ? state : 'unknown', kind: 'other' }
}

/** Sort order for the state column: active workers first, unknown states last. */
export const STATE_RANK: Record<StateKind, number> = { busy: 0, throttled: 1, idle: 2, done: 3, other: 4 }

/**
 * Garage reports a worker that exists but is switched off (e.g. resync
 * workers beyond resync-worker-count) only through its freeform text:
 * "This worker is currently disabled".
 */
export function isDisabledWorker(w: Worker): boolean {
  return w.freeform.some((line) => line.toLowerCase().includes('disabled'))
}

/**
 * true when the worker shows something worth a look: errors (past, current
 * or persistent), an active state, a non-empty queue or reported progress.
 */
export function isNoteworthyWorker(w: Worker): boolean {
  const { kind } = describeState(w.state)
  return (
    w.errors > 0 ||
    w.lastError != null ||
    (w.persistentErrors != null && w.persistentErrors > 0) ||
    kind === 'busy' ||
    kind === 'throttled' ||
    (w.queueLength != null && w.queueLength > 0) ||
    (w.progress != null && w.progress !== '')
  )
}

export interface WorkerFilter {
  /** Free text matched against name, worker ID, node ID and last error message. */
  search: string
  /** Show only workers for which isNoteworthyWorker is true. */
  onlyNoteworthy: boolean
  /** Hide workers that Garage reports as disabled. */
  hideDisabled: boolean
  /** Node ID to restrict to; null for all nodes. */
  nodeId: string | null
}

export const DEFAULT_WORKER_FILTER: WorkerFilter = {
  search: '',
  onlyNoteworthy: false,
  hideDisabled: true,
  nodeId: null,
}

/**
 * Case-insensitive match on name, last error message and node ID prefix; a
 * query equal to the worker ID (worker IDs are small per-node counters, so
 * substring matching would hit almost everything) also matches.
 */
export function matchesWorkerSearch(w: Worker, search: string): boolean {
  const q = search.trim().toLowerCase()
  if (!q) return true
  return (
    w.name.toLowerCase().includes(q) ||
    String(w.id) === q ||
    w.nodeId.toLowerCase().startsWith(q) ||
    (w.lastError?.message.toLowerCase().includes(q) ?? false)
  )
}

export function matchesWorkerFilter(w: Worker, f: WorkerFilter): boolean {
  if (f.nodeId !== null && w.nodeId !== f.nodeId) return false
  if (f.hideDisabled && isDisabledWorker(w)) return false
  if (f.onlyNoteworthy && !isNoteworthyWorker(w)) return false
  return matchesWorkerSearch(w, f.search)
}

/** State first (busy > throttled > idle > done > unknown), then more errors first, then name. */
export function compareWorkersByState(a: Worker, b: Worker): number {
  return (
    STATE_RANK[describeState(a.state).kind] - STATE_RANK[describeState(b.state).kind] ||
    b.errors - a.errors ||
    a.name.localeCompare(b.name) ||
    a.id - b.id
  )
}

/** Filters and sorts a copy of `workers` for display. */
export function filterAndSortWorkers(workers: Worker[], f: WorkerFilter): Worker[] {
  return workers.filter((w) => matchesWorkerFilter(w, f)).sort(compareWorkersByState)
}
