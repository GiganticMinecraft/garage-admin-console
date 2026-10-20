import { describe, expect, it } from 'vitest'
import type { Worker } from '@/api'
import {
  DEFAULT_WORKER_FILTER,
  compareWorkersByState,
  describeState,
  filterAndSortWorkers,
  isDisabledWorker,
  isNoteworthyWorker,
  matchesWorkerSearch,
  persistentErrorsLabel,
} from './workers'

function worker(overrides: Partial<Worker> = {}): Worker {
  return {
    nodeId: 'aaaa1111',
    id: 1,
    name: 'Merkle tree updater for objects',
    state: 'idle',
    errors: 0,
    consecutiveErrors: 0,
    lastError: null,
    tranquility: null,
    progress: null,
    queueLength: null,
    persistentErrors: null,
    freeform: [],
    ...overrides,
  }
}

// Shapes seen in production (Garage v2.4.1).
const disabledResync = worker({
  id: 20,
  name: 'Block resync worker #2',
  freeform: ['This worker is currently disabled'],
})
const scrubWithErrors = worker({
  id: 30,
  name: 'Block scrub worker',
  errors: 7,
  lastError: { message: 'block deadbeef not found on node', secsAgo: 3600 },
  persistentErrors: 15,
})

describe('describeState', () => {
  it('maps the WorkerStateResp variants', () => {
    expect(describeState('busy').kind).toBe('busy')
    expect(describeState('idle').kind).toBe('idle')
    expect(describeState('done').kind).toBe('done')
    expect(describeState({ throttled: { durationSecs: 1.25 } }).kind).toBe('throttled')
    expect(describeState('weird').kind).toBe('other')
  })
})

describe('isDisabledWorker', () => {
  it('detects the exact disabled freeform line', () => {
    expect(isDisabledWorker(disabledResync)).toBe(true)
    expect(isDisabledWorker(worker())).toBe(false)
  })

  it('does not hide workers whose other lines merely mention "disabled" (fail open)', () => {
    expect(isDisabledWorker(worker({ freeform: ['Scrub is disabled by tranquility'] }))).toBe(false)
    expect(isDisabledWorker(worker({ freeform: ['This worker is currently disabled for now'] }))).toBe(false)
  })
})

describe('isNoteworthyWorker', () => {
  it('is false for a plain idle or disabled worker', () => {
    expect(isNoteworthyWorker(worker())).toBe(false)
    expect(isNoteworthyWorker(disabledResync)).toBe(false)
  })

  it.each<[string, Partial<Worker>]>([
    ['consecutive errors', { errors: 2, consecutiveErrors: 2 }],
    ['busy', { state: 'busy' }],
    ['throttled', { state: { throttled: { durationSecs: 2 } } }],
    ['a queue', { queueLength: 5 }],
    ['progress', { progress: '42.00%' }],
  ])('is true with %s', (_, o) => {
    expect(isNoteworthyWorker(worker(o))).toBe(true)
  })

  it('ignores recovered (cumulative) errors, which Garage never resets', () => {
    const recovered = worker({ errors: 50, lastError: { message: 'old', secsAgo: 86400 } })
    expect(isNoteworthyWorker(recovered)).toBe(false)
  })

  it('ignores an idle scrub worker whose cumulative corruption count stays non-zero', () => {
    // Production shape after a scrub finished (garage-0 / garage-2): persistentErrors is
    // Garage's corruptions_detected, a persisted total that never resets.
    const finishedScrub = worker({
      name: 'Block scrub worker',
      state: 'idle',
      consecutiveErrors: 0,
      queueLength: 0,
      progress: null,
      persistentErrors: 19,
    })
    expect(isNoteworthyWorker(finishedScrub)).toBe(false)
  })

  it('still flags a running scrub worker by its state and progress', () => {
    expect(isNoteworthyWorker(worker({ name: 'Block scrub worker', state: 'busy', persistentErrors: 19 }))).toBe(true)
    expect(isNoteworthyWorker(worker({ name: 'Block scrub worker', progress: '12.34%', persistentErrors: 19 }))).toBe(
      true,
    )
  })

  it('ignores a finished (done) worker that still reports its final progress line', () => {
    // Production shape of a finished repair worker: Garage keeps the progress
    // text after completion, e.g. "705705 (553)" on the block_ref repair worker.
    const finishedRepair = worker({
      name: 'block_ref repair worker',
      state: 'done',
      consecutiveErrors: 0,
      progress: '705705 (553)',
    })
    expect(isNoteworthyWorker(finishedRepair)).toBe(false)
  })

  it('still flags a done worker that is failing', () => {
    expect(isNoteworthyWorker(worker({ state: 'done', errors: 1, consecutiveErrors: 1 }))).toBe(true)
  })

  it('ignores an empty queue, zero persistent errors, empty progress and done', () => {
    expect(
      isNoteworthyWorker(worker({ queueLength: 0, persistentErrors: 0, progress: '', state: 'done' })),
    ).toBe(false)
  })
})

describe('persistentErrorsLabel', () => {
  it('calls the scrub worker value the cumulative corruption count', () => {
    expect(persistentErrorsLabel(scrubWithErrors)).toBe('破損検出数 (累積)')
    expect(persistentErrorsLabel(worker({ name: 'block SCRUB worker' }))).toBe('破損検出数 (累積)')
  })

  it('keeps the generic label for other workers', () => {
    expect(persistentErrorsLabel(worker())).toBe('永続エラー')
    expect(persistentErrorsLabel(disabledResync)).toBe('永続エラー')
  })
})

describe('matchesWorkerSearch', () => {
  const hostnames = new Map([['aaaa1111', 'garage-1']])

  it('matches name, node ID prefix and last error, case-insensitively', () => {
    expect(matchesWorkerSearch(scrubWithErrors, 'SCRUB')).toBe(true)
    expect(matchesWorkerSearch(scrubWithErrors, 'AAAA')).toBe(true)
    expect(matchesWorkerSearch(scrubWithErrors, 'not found')).toBe(true)
    expect(matchesWorkerSearch(scrubWithErrors, 'merkle')).toBe(false)
    expect(matchesWorkerSearch(scrubWithErrors, '  ')).toBe(true)
  })

  it('matches the worker ID exactly, with or without the displayed "#"', () => {
    expect(matchesWorkerSearch(scrubWithErrors, '30')).toBe(true)
    expect(matchesWorkerSearch(scrubWithErrors, '#30')).toBe(true)
    expect(matchesWorkerSearch(scrubWithErrors, '3')).toBe(false)
    expect(matchesWorkerSearch(scrubWithErrors, '#3')).toBe(false)
  })

  it('matches the node hostname when known', () => {
    expect(matchesWorkerSearch(scrubWithErrors, 'Garage-1', hostnames)).toBe(true)
    expect(matchesWorkerSearch(scrubWithErrors, 'garage-2', hostnames)).toBe(false)
    expect(matchesWorkerSearch(scrubWithErrors, 'garage-1')).toBe(false)
  })
})

describe('filterAndSortWorkers', () => {
  const idle = worker({ id: 2 })
  const otherNode = worker({ id: 3, nodeId: 'bbbb2222', name: 'GC worker', state: 'busy' })
  const all = [idle, disabledResync, scrubWithErrors, otherNode]

  it('defaults to hiding disabled workers, all nodes, state sort', () => {
    expect(DEFAULT_WORKER_FILTER).toEqual({ search: '', onlyNoteworthy: false, hideDisabled: true, nodeId: null })
    expect(filterAndSortWorkers(all, DEFAULT_WORKER_FILTER)).toEqual([otherNode, scrubWithErrors, idle])
  })

  it('shows disabled workers when asked', () => {
    expect(filterAndSortWorkers(all, { ...DEFAULT_WORKER_FILTER, hideDisabled: false })).toHaveLength(4)
  })

  it('keeps only noteworthy workers', () => {
    const rows = filterAndSortWorkers(all, { ...DEFAULT_WORKER_FILTER, onlyNoteworthy: true })
    expect(rows).toEqual([otherNode])
  })

  it('restricts to one node', () => {
    expect(filterAndSortWorkers(all, { ...DEFAULT_WORKER_FILTER, nodeId: 'bbbb2222' })).toEqual([otherNode])
  })

  it('searches by hostname', () => {
    const hostnames = new Map([['bbbb2222', 'garage-2']])
    expect(filterAndSortWorkers(all, { ...DEFAULT_WORKER_FILTER, search: 'garage-2' }, hostnames)).toEqual([
      otherNode,
    ])
  })

  it('combines search with the other filters', () => {
    const f = { ...DEFAULT_WORKER_FILTER, search: 'resync' }
    expect(filterAndSortWorkers(all, f)).toEqual([])
    expect(filterAndSortWorkers(all, { ...f, hideDisabled: false })).toEqual([disabledResync])
  })

  it('does not mutate the input', () => {
    const copy = [...all]
    filterAndSortWorkers(all, DEFAULT_WORKER_FILTER)
    expect(all).toEqual(copy)
  })
})

describe('compareWorkersByState', () => {
  it('orders by state, then consecutive errors, then cumulative errors, then name', () => {
    const rows = [
      worker({ name: 'z unknown', state: 'weird' }),
      worker({ name: 'done', state: 'done' }),
      worker({ name: 'b idle' }),
      worker({ name: 'a idle' }),
      worker({ name: 'c idle recovered 50', errors: 50 }),
      worker({ name: 'd idle failing now', errors: 2, consecutiveErrors: 2 }),
      worker({ name: 'throttled', state: { throttled: { durationSecs: 1 } } }),
      worker({ name: 'busy', state: 'busy' }),
    ]
    expect(rows.sort(compareWorkersByState).map((w) => w.name)).toEqual([
      'busy',
      'throttled',
      'd idle failing now',
      'c idle recovered 50',
      'a idle',
      'b idle',
      'done',
      'z unknown',
    ])
  })
})
