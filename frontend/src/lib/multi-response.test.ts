import { describe, expect, it } from 'vitest'
import { formatNodeFailures, multiResponseToast, summarizeMultiResponse } from './multi-response'

const purge = (n: number) => ({ blocksPurged: n })
const opts = {
  action: 'パージ',
  successMessage: (r: { blocksPurged: number }[]) => `${r[0].blocksPurged}ブロックをパージしました`,
}

describe('summarizeMultiResponse', () => {
  it('classifies all-success, partial and failure', () => {
    expect(summarizeMultiResponse({ success: { a: 1, b: 2 }, error: {} }).outcome).toBe('success')
    expect(summarizeMultiResponse({ success: { a: 1 }, error: { b: 'x' } }).outcome).toBe('partial')
    expect(summarizeMultiResponse({ success: {}, error: { a: 'x', b: 'y' } }).outcome).toBe('failure')
  })

  it('treats a response with no node at all as failure', () => {
    expect(summarizeMultiResponse({ success: {}, error: {} }).outcome).toBe('failure')
  })

  it('sorts nodes by ID', () => {
    const s = summarizeMultiResponse({ success: { b: 2, a: 1 }, error: { d: 'y', c: 'x' } })
    expect(s.succeeded.map((x) => x.nodeId)).toEqual(['a', 'b'])
    expect(s.failed).toEqual([
      { nodeId: 'c', message: 'x' },
      { nodeId: 'd', message: 'y' },
    ])
  })
})

describe('formatNodeFailures', () => {
  it('shortens node IDs and truncates the list', () => {
    const failed = ['aaaaaaaaaaaaaaaa1', 'b', 'c', 'd'].map((nodeId) => ({ nodeId, message: 'Not connected' }))
    expect(formatNodeFailures(failed, 2)).toBe('aaaaaaaaaaaa…: Not connected / b: Not connected / 他 2 ノード')
    expect(formatNodeFailures(failed.slice(1, 2))).toBe('b: Not connected')
  })
})

describe('multiResponseToast', () => {
  it('reports full success', () => {
    const t = multiResponseToast({ success: { a: purge(3), b: purge(3) }, error: {} }, opts)
    expect(t).toEqual({ outcome: 'success', level: 'success', message: '3ブロックをパージしました (2ノード)' })
  })

  it('warns on partial success and lists the failed nodes', () => {
    const t = multiResponseToast({ success: { a: purge(3) }, error: { b: 'Not connected' } }, opts)
    expect(t.level).toBe('warning')
    expect(t.message).toBe('3ブロックをパージしました (1ノード成功、1ノード失敗: b: Not connected)')
  })

  it('errors when every node failed, with reasons', () => {
    const t = multiResponseToast({ success: {}, error: { a: 'Not connected', b: 'timeout' } }, opts)
    expect(t.level).toBe('error')
    expect(t.outcome).toBe('failure')
    expect(t.message).toBe('パージに失敗しました (2ノード): a: Not connected / b: timeout')
  })

  it('errors when no node answered at all', () => {
    const t = multiResponseToast({ success: {}, error: {} }, opts)
    expect(t.level).toBe('error')
    expect(t.message).toBe('パージに失敗しました: 応答したノードがありません')
  })
})
