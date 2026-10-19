import { describe, expect, it } from 'vitest'
import { normalizeBlockErrors } from './api'

describe('normalizeBlockErrors', () => {
  const entry = { nodeId: 'a', blockHash: 'h', refcount: 1, errorCount: 1, lastTrySecsAgo: 0, nextTryInSecs: 0 }

  it('passes the current shape through', () => {
    const r = { items: [entry], checkedNodes: ['a'], nodeErrors: { b: 'x' } }
    expect(normalizeBlockErrors(r)).toEqual(r)
  })

  it('accepts the old bare array from a backend not yet rolled out', () => {
    expect(normalizeBlockErrors([entry])).toEqual({ items: [entry], checkedNodes: [], nodeErrors: {} })
  })

  it('fills missing fields instead of crashing', () => {
    expect(normalizeBlockErrors({})).toEqual({ items: [], checkedNodes: [], nodeErrors: {} })
    expect(normalizeBlockErrors(null)).toEqual({ items: [], checkedNodes: [], nodeErrors: {} })
  })
})
