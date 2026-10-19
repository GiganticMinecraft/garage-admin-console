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
  it('detects the disabled freeform line', () => {
    expect(isDisabledWorker(disabledResync)).toBe(true)
    expect(isDisabledWorker(worker())).toBe(false)
  })
})

describe('isNoteworthyWorker', () => {
  it('is false for a plain idle or disabled worker', () => {
    expect(isNoteworthyWorker(worker())).toBe(false)
    expect(isNoteworthyWorker(disabledResync)).toBe(false)
  })

  it.each<[string, Partial<Worker>]>([
    ['past errors', { errors: 1 }],
    ['a last error', { lastError: { message: 'x', secsAgo: 1 } }],
    ['persistent errors', { persistentErrors: 3 }],
    ['busy', { state: 'busy' }],
    ['throttled', { state: { throttled: { durationSecs: 2 } } }],
    ['a queue', { queueLength: 5 }],
    ['progress', { progress: '42.00%' }],
  ])('is true with %s', (_, o) => {
    expect(isNoteworthyWorker(worker(o))).toBe(true)
  })

  it('ignores an empty queue, zero persistent errors and done', () => {
    expect(isNoteworthyWorker(worker({ queueLength: 0, persistentErrors: 0, state: 'done' }))).toBe(false)
  })
})

describe('matchesWorkerSearch', () => {
  it('matches name, exact worker ID, node ID prefix and last error, case-insensitively', () => {
    expect(matchesWorkerSearch(scrubWithErrors, 'SCRUB')).toBe(true)
    expect(matchesWorkerSearch(scrubWithErrors, '30')).toBe(true)
    expect(matchesWorkerSearch(scrubWithErrors, '3')).toBe(false)
    expect(matchesWorkerSearch(scrubWithErrors, 'AAAA')).toBe(true)
    expect(matchesWorkerSearch(scrubWithErrors, 'not found')).toBe(true)
    expect(matchesWorkerSearch(scrubWithErrors, 'merkle')).toBe(false)
    expect(matchesWorkerSearch(scrubWithErrors, '  ')).toBe(true)
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
    expect(rows).toEqual([otherNode, scrubWithErrors])
  })

  it('restricts to one node', () => {
    expect(filterAndSortWorkers(all, { ...DEFAULT_WORKER_FILTER, nodeId: 'bbbb2222' })).toEqual([otherNode])
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
  it('orders busy > throttled > idle > done > unknown, then errors desc, then name', () => {
    const rows = [
      worker({ name: 'z unknown', state: 'weird' }),
      worker({ name: 'done', state: 'done' }),
      worker({ name: 'b idle' }),
      worker({ name: 'a idle' }),
      worker({ name: 'c idle errors', errors: 7 }),
      worker({ name: 'throttled', state: { throttled: { durationSecs: 1 } } }),
      worker({ name: 'busy', state: 'busy' }),
    ]
    expect(rows.sort(compareWorkersByState).map((w) => w.name)).toEqual([
      'busy',
      'throttled',
      'c idle errors',
      'a idle',
      'b idle',
      'done',
      'z unknown',
    ])
  })
})
