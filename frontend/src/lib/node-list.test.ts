import { describe, expect, it } from 'vitest'
import type { ClusterNode } from '@/api'
import {
  MAX_CONNECT_NODES,
  NO_ZONE_LABEL,
  connectOutcome,
  groupNodes,
  lastSeenLabel,
  pairConnectResults,
  parseConnectInput,
} from './node-list'

const n = (id: string, over: Partial<ClusterNode> = {}): ClusterNode => ({
  id,
  garageVersion: 'v2.4.1',
  addr: null,
  hostname: id,
  isUp: true,
  lastSeenSecsAgo: null,
  role: { zone: 'dc1', tags: [], capacity: 100 },
  draining: false,
  ...over,
})

const gateway = { zone: 'dc1', tags: [], capacity: null }
const hex = (c: string) => c.repeat(64)

describe('groupNodes', () => {
  const nodes = [
    n('garage-10', { role: { zone: 'dc2', tags: [], capacity: 1 } }),
    n('garage-2', { role: { zone: 'dc2', tags: [], capacity: 1 }, isUp: false }),
    n('new', { role: null }),
    n('garage-1'),
    n('gw', { role: gateway }),
    n('old', { role: null, draining: true, isUp: false }),
  ]
  const shape = (groups: ReturnType<typeof groupNodes>) =>
    groups.map((g) => [g.label, g.nodes.map((x) => x.id)])

  it('groups by zone, sorted, with nodes without a zone last', () => {
    expect(shape(groupNodes(nodes, 'zone'))).toEqual([
      ['dc1', ['garage-1', 'gw']],
      ['dc2', ['garage-2', 'garage-10']],
      [NO_ZONE_LABEL, ['new', 'old']],
    ])
  })

  it('groups by connectivity, connected first', () => {
    expect(shape(groupNodes(nodes, 'connectivity'))).toEqual([
      ['接続中', ['garage-1', 'garage-10', 'gw', 'new']],
      ['切断中', ['garage-2', 'old']],
    ])
  })

  it('groups by role with unassigned last and omits empty groups', () => {
    expect(shape(groupNodes(nodes, 'role'))).toEqual([
      ['ストレージ', ['garage-1', 'garage-2', 'garage-10']],
      ['ゲートウェイ', ['gw']],
      ['draining', ['old']],
      ['未割り当て', ['new']],
    ])
    expect(shape(groupNodes([n('a')], 'role'))).toEqual([['ストレージ', ['a']]])
  })

  it('sorts by ID when the hostname is unknown', () => {
    const groups = groupNodes([n('bbbb', { hostname: null }), n('aaaa', { hostname: null })], 'zone')
    expect(groups[0].nodes.map((x) => x.id)).toEqual(['aaaa', 'bbbb'])
  })

  it('does not mutate the input', () => {
    const input = [n('b'), n('a')]
    groupNodes(input, 'zone')
    expect(input.map((x) => x.id)).toEqual(['b', 'a'])
  })
})

describe('lastSeenLabel', () => {
  it('is null for connected nodes', () => {
    expect(lastSeenLabel({ isUp: true, lastSeenSecsAgo: 30 })).toBeNull()
  })
  it('shows how long ago a disconnected node was seen', () => {
    expect(lastSeenLabel({ isUp: false, lastSeenSecsAgo: 300 })).toBe('最終確認 5分前')
    expect(lastSeenLabel({ isUp: false, lastSeenSecsAgo: 7200 })).toBe('最終確認 2時間前')
  })
  it('says so when the node was never reached since restart', () => {
    expect(lastSeenLabel({ isUp: false, lastSeenSecsAgo: null })).toBe('Garage の再起動後に接続実績なし')
  })
})

describe('parseConnectInput', () => {
  const a = `${hex('a')}@10.0.0.1:3901`
  const b = `${hex('b')}@[fd00::2]:3901`

  it('accepts one peer per line, trimming and skipping blank lines', () => {
    expect(parseConnectInput(`  ${a}  \n\n${b}\r\n`)).toEqual({ peers: [a, b], errors: [] })
  })

  it('reports each malformed line with its line number', () => {
    const r = parseConnectInput(
      [a, 'garage-2:3901', `${hex('A')}@h:1`, `${hex('c')}@host`, `${hex('d')}@ho st:1`, a].join('\n'),
    )
    expect(r.peers).toEqual([a])
    expect(r.errors.map((e) => e.line)).toEqual([2, 3, 4, 5, 6])
    expect(r.errors[0].message).toContain('<ノード ID>@<アドレス>:<ポート>')
    expect(r.errors[1].message).toContain('64 桁')
    expect(r.errors[2].message).toContain('<ホスト>:<ポート>')
    expect(r.errors[4].message).toContain('重複')
  })

  it('rejects more than the maximum number of peers', () => {
    const lines = Array.from({ length: MAX_CONNECT_NODES + 1 }, (_, i) => `${hex('e')}@10.0.0.${i}:3901`)
    const r = parseConnectInput(lines.join('\n'))
    expect(r.errors).toEqual([{ line: MAX_CONNECT_NODES + 1, message: expect.stringContaining('10 ノードまで') }])
    expect(parseConnectInput(lines.slice(0, MAX_CONNECT_NODES).join('\n')).errors).toEqual([])
  })

  it('returns nothing for empty input', () => {
    expect(parseConnectInput(' \n ')).toEqual({ peers: [], errors: [] })
  })
})

describe('connect results', () => {
  it('pairs answers with peers in order and classifies the outcome', () => {
    const rows = pairConnectResults(['p1', 'p2'], [
      { success: true, error: null },
      { success: false, error: 'Connection refused' },
    ])
    expect(rows).toEqual([
      { peer: 'p1', success: true, error: null },
      { peer: 'p2', success: false, error: 'Connection refused' },
    ])
    expect(connectOutcome(rows)).toBe('partial')
    expect(connectOutcome(rows.slice(0, 1))).toBe('all')
    expect(connectOutcome(rows.slice(1))).toBe('none')
  })

  it('treats a missing answer as a failure', () => {
    const rows = pairConnectResults(['p1', 'p2'], [{ success: true, error: null }])
    expect(rows[1]).toEqual({ peer: 'p2', success: false, error: '応答に結果が含まれていません' })
    expect(connectOutcome(rows)).toBe('partial')
  })
})
