import type { WorkerState } from '@/api'

/** Relative "N秒前 / 分前 / 時間前 / 日前" label for a duration in seconds. */
export function formatSecsAgo(secs: number): string {
  if (secs < 60) return `${Math.floor(secs)}秒前`
  if (secs < 3600) return `${Math.floor(secs / 60)}分前`
  if (secs < 86400) return `${Math.floor(secs / 3600)}時間前`
  return `${Math.floor(secs / 86400)}日前`
}

export type StateKind = 'idle' | 'busy' | 'throttled' | 'other'

export function describeState(state: WorkerState): { label: string; kind: StateKind } {
  if (typeof state === 'object' && state !== null && 'throttled' in state) {
    const secs = state.throttled?.durationSecs
    const detail = typeof secs === 'number' ? ` (${secs.toFixed(1)}s)` : ''
    return { label: `throttled${detail}`, kind: 'throttled' }
  }
  if (state === 'idle') return { label: 'idle', kind: 'idle' }
  if (state === 'busy') return { label: 'busy', kind: 'busy' }
  return { label: typeof state === 'string' && state.length > 0 ? state : 'unknown', kind: 'other' }
}
