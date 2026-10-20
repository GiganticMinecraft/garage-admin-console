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

/** The freeform line Garage v2.4.1 uses for a switched-off worker (src/block/resync.rs). */
export const DISABLED_WORKER_MARKER = 'This worker is currently disabled'

/**
 * Garage reports a worker that exists but is switched off (resync workers
 * beyond resync-worker-count) only through its freeform text. Only that
 * exact line counts, so other lines mentioning "disabled" never hide a
 * worker (fail open).
 */
export function isDisabledWorker(w: Worker): boolean {
  return w.freeform.some((line) => line.trim() === DISABLED_WORKER_MARKER)
}

/**
 * true when the worker needs a look right now: failing (consecutive errors),
 * or still running (busy / throttled, a non-empty queue, or reported progress).
 * The cumulative `errors` / `lastError` are not counted: Garage never resets
 * them, so a worker that recovered long ago would stay listed forever.
 * `persistentErrors` is not counted either: in Garage v2.4.1 the block scrub
 * worker reports `corruptions_detected` there (src/block/repair.rs), a
 * persisted all-time total that is never reset, so an idle scrub worker would
 * stay listed forever after a single corruption was found.
 * A `done` worker is finished, so its leftover progress line (repair workers
 * keep e.g. "705705 (553)" after completion) or queue length does not count
 * as running either.
 */
export function isNoteworthyWorker(w: Worker): boolean {
  const { kind } = describeState(w.state)
  // A done worker is finished: in Garage v2.4.1 (src/util/background/worker.rs,
  // WorkerHandler::step) Done is only reached through an Ok result, which
  // resets consecutive_errors, and the progress / queue it keeps reporting is
  // its last snapshot, not activity.
  if (kind === 'done') return false
  return (
    w.consecutiveErrors > 0 ||
    kind === 'busy' ||
    kind === 'throttled' ||
    (w.queueLength != null && w.queueLength > 0) ||
    (w.progress != null && w.progress !== '')
  )
}

/**
 * Label for `persistentErrors`. For the block scrub worker Garage v2.4.1
 * reports `corruptions_detected` there (src/block/repair.rs), the all-time
 * count of corrupted blocks found by scrubs, so it gets the same wording as
 * the dashboard's Storage health. Any other worker keeps the generic label.
 */
/** What the 「稼働中 / エラー継続中のみ」 filter keeps; shown next to the checkbox. */
export const NOTEWORTHY_FILTER_HELP =
  'busy / throttled・キュー残あり・進捗ありのワーカーと、連続エラー中のワーカーだけを表示します。回復済みの過去のエラー、累積の破損検出数、完了済み (done) のワーカーは対象外です。'

export function persistentErrorsLabel(w: Pick<Worker, 'name'>): string {
  return w.name.toLowerCase().includes('scrub') ? '破損検出数 (累積)' : '永続エラー'
}

export interface WorkerFilter {
  /** Free text matched against name, worker ID, node ID / hostname and last error message. */
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

/** Node ID → hostname, for matching the node name shown in the headings. */
export type HostnameMap = ReadonlyMap<string, string>

/**
 * Case-insensitive match on name, last error message, node hostname and
 * node ID prefix. The worker ID (shown as "#12") matches exactly, with or
 * without the leading "#": IDs are small per-node counters, so substring
 * matching would hit almost everything.
 */
export function matchesWorkerSearch(w: Worker, search: string, hostnames?: HostnameMap): boolean {
  const q = search.trim().toLowerCase()
  if (!q) return true
  const hostname = hostnames?.get(w.nodeId)?.toLowerCase()
  return (
    w.name.toLowerCase().includes(q) ||
    String(w.id) === q.replace(/^#/, '') ||
    w.nodeId.toLowerCase().startsWith(q) ||
    (hostname?.includes(q) ?? false) ||
    (w.lastError?.message.toLowerCase().includes(q) ?? false)
  )
}

export function matchesWorkerFilter(w: Worker, f: WorkerFilter, hostnames?: HostnameMap): boolean {
  if (f.nodeId !== null && w.nodeId !== f.nodeId) return false
  if (f.hideDisabled && isDisabledWorker(w)) return false
  if (f.onlyNoteworthy && !isNoteworthyWorker(w)) return false
  return matchesWorkerSearch(w, f.search, hostnames)
}

/**
 * State first (busy > throttled > idle > done > unknown), then currently
 * failing (consecutive errors) first, then cumulative errors, then name.
 */
export function compareWorkersByState(a: Worker, b: Worker): number {
  return (
    STATE_RANK[describeState(a.state).kind] - STATE_RANK[describeState(b.state).kind] ||
    b.consecutiveErrors - a.consecutiveErrors ||
    b.errors - a.errors ||
    a.name.localeCompare(b.name) ||
    a.id - b.id
  )
}

/** Filters and sorts a copy of `workers` for display. */
export function filterAndSortWorkers(workers: Worker[], f: WorkerFilter, hostnames?: HostnameMap): Worker[] {
  return workers.filter((w) => matchesWorkerFilter(w, f, hostnames)).sort(compareWorkersByState)
}
