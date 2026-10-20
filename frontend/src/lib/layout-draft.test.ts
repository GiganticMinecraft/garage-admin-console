import { describe, expect, it } from 'vitest'
import type { LayoutNodeRole, NodeRoleChange } from '@/api'
import { GIB } from './format'
import {
  capacityToGiB,
  changeKind,
  draftFromNode,
  draftToChange,
  groupDrafts,
  layoutRoleRows,
  layoutTotals,
  parseTags,
  revertChangeFor,
} from './layout-draft'

const node = { id: 'a'.repeat(64), hostname: 'garage-0', isUp: true }

function appliedRole(patch: Partial<LayoutNodeRole> = {}): LayoutNodeRole {
  return {
    id: node.id,
    zone: 'dc1',
    tags: ['ssd'],
    capacity: 10 * GIB,
    storedPartitions: 256,
    usableCapacity: 10 * GIB,
    ...patch,
  }
}

// In Garage v2.4.1 (doc/api/garage-admin-v2.json) NodeAssignedRole and
// LayoutNodeRole define `capacity` as `integer | null`, "absent for gateway
// nodes": null is a real value (gateway), not "unset".
describe('draftFromNode', () => {
  it('keeps a staged gateway (capacity null) instead of the applied capacity', () => {
    const staged: NodeRoleChange = { id: node.id, zone: 'dc1', tags: ['ssd'], capacity: null }
    const d = draftFromNode(node, appliedRole(), staged)
    expect(d.effective).toBe(staged)
    expect(d.capacityGiB).toBe('')
    expect(d.original.capacityGiB).toBe('')
    expect(d.remove).toBe(false)
  })

  it('treats an absent staged capacity as gateway too', () => {
    const staged: NodeRoleChange = { id: node.id, zone: 'dc1', tags: [] }
    const d = draftFromNode(node, appliedRole(), staged)
    expect(d.capacityGiB).toBe('')
    expect(draftToChange({ ...d, tags: 'edge' })).toMatchObject({ capacity: null })
  })

  it('does not throw when a staged change from the API has no tags', () => {
    // Wire data is not validated, so simulate a response missing `tags`.
    const staged = JSON.parse(`{"id":"${node.id}","zone":"dc1","capacity":null}`) as NodeRoleChange
    const d = draftFromNode(node, appliedRole(), staged)
    expect(d).toMatchObject({ zone: 'dc1', capacityGiB: '', tags: '' })
  })

  it('shows the applied capacity when nothing is staged', () => {
    const applied = appliedRole()
    const d = draftFromNode(node, applied, undefined)
    expect(d.effective).toBe(applied)
    expect(d).toMatchObject({ zone: 'dc1', capacityGiB: '10', tags: 'ssd', remove: false })
  })

  it('shows an applied gateway as an empty capacity', () => {
    expect(draftFromNode(node, appliedRole({ capacity: null }), undefined).capacityGiB).toBe('')
  })

  it('takes every field from the staged role, not the applied one', () => {
    const staged: NodeRoleChange = { id: node.id, zone: 'dc2', tags: [], capacity: 5 * GIB }
    const d = draftFromNode(node, appliedRole(), staged)
    expect(d).toMatchObject({ zone: 'dc2', capacityGiB: '5', tags: '' })
  })

  it('marks a staged removal with no effective role, prefilled from the applied role', () => {
    const d = draftFromNode(node, appliedRole(), { id: node.id, remove: true })
    expect(d.effective).toBeNull()
    expect(d.remove).toBe(true)
    expect(d.applied).not.toBeNull()
    expect(d).toMatchObject({ zone: 'dc1', capacityGiB: '10', tags: 'ssd' })
  })

  it('gives an unassigned node an empty form', () => {
    const d = draftFromNode(node, undefined, undefined)
    expect(d.applied).toBeNull()
    expect(d.effective).toBeNull()
    expect(d.remove).toBe(false)
    expect(d).toMatchObject({ zone: '', capacityGiB: '', tags: '' })
    expect(d.original).toEqual({ zone: '', capacityGiB: '', tags: '' })
  })
})

describe('draftToChange', () => {
  it('keeps capacity null when only the tags of a staged gateway are edited', () => {
    const staged: NodeRoleChange = { id: node.id, zone: 'dc1', tags: ['ssd'], capacity: null }
    const d = draftFromNode(node, appliedRole(), staged)
    expect(draftToChange({ ...d, tags: 'ssd, edge' })).toEqual({
      id: node.id,
      zone: 'dc1',
      tags: ['ssd', 'edge'],
      capacity: null,
    })
  })

  it('returns null for an untouched row', () => {
    expect(draftToChange(draftFromNode(node, appliedRole(), undefined))).toBeNull()
    const staged: NodeRoleChange = { id: node.id, zone: 'dc1', tags: [], capacity: null }
    expect(draftToChange(draftFromNode(node, appliedRole(), staged))).toBeNull()
  })

  it('converts an edited capacity from GiB to bytes', () => {
    const d = draftFromNode(node, appliedRole(), undefined)
    expect(draftToChange({ ...d, capacityGiB: '20' })).toEqual({
      id: node.id,
      zone: 'dc1',
      tags: ['ssd'],
      capacity: 20 * GIB,
    })
  })

  it('keeps the exact bytes when the capacity field is untouched', () => {
    // 1e12 bytes = 931.3225... GiB, shown as '931.32'; re-deriving from that
    // string would stage 999_997_300_736 bytes.
    const d = draftFromNode(node, appliedRole({ capacity: 1_000_000_000_000 }), undefined)
    expect(d.capacityGiB).toBe('931.32')
    expect(draftToChange({ ...d, tags: 'ssd, edge' })).toMatchObject({ capacity: 1_000_000_000_000 })
  })

  it('keeps a tiny capacity that rounds to 0 GiB when only the zone changes', () => {
    // 1 byte is what backend/handler_cluster_test.go stages.
    const staged: NodeRoleChange = { id: node.id, zone: 'dc1', tags: [], capacity: 1 }
    const d = draftFromNode(node, undefined, staged)
    expect(d.capacityGiB).toBe('0')
    expect(draftToChange({ ...d, zone: 'dc2' })).toEqual({ id: node.id, zone: 'dc2', tags: [], capacity: 1 })
  })

  it('keeps the applied bytes when re-adding a node staged for removal', () => {
    const d = draftFromNode(node, appliedRole({ capacity: 1_000_000_000_000 }), { id: node.id, remove: true })
    expect(draftToChange({ ...d, remove: false })).toMatchObject({ capacity: 1_000_000_000_000 })
  })

  it('re-derives bytes when the capacity field is edited, or empties it to a gateway', () => {
    const d = draftFromNode(node, appliedRole({ capacity: 1_000_000_000_000 }), undefined)
    expect(draftToChange({ ...d, capacityGiB: '931.33' })).toMatchObject({ capacity: Math.round(931.33 * GIB) })
    expect(draftToChange({ ...d, capacityGiB: '' })).toMatchObject({ capacity: null })
  })

  it('stages a removal only for nodes with an applied role', () => {
    const d = draftFromNode(node, appliedRole(), undefined)
    expect(draftToChange({ ...d, remove: true })).toEqual({ id: node.id, remove: true })
    const already = draftFromNode(node, appliedRole(), { id: node.id, remove: true })
    expect(draftToChange(already)).toBeNull()
  })

  it('rejects a non-positive capacity and a missing zone', () => {
    const d = draftFromNode(node, appliedRole(), undefined)
    expect(draftToChange({ ...d, capacityGiB: '0' })).toBeInstanceOf(Error)
    expect(draftToChange({ ...d, zone: ' ' })).toBeInstanceOf(Error)
  })

  it('ignores an unassigned node left blank', () => {
    expect(draftToChange(draftFromNode(node, undefined, undefined))).toBeNull()
  })
})

describe('capacityToGiB / parseTags', () => {
  it('formats bytes as GiB with two decimals and null as empty', () => {
    expect(capacityToGiB(null)).toBe('')
    expect(capacityToGiB(1.5 * GIB)).toBe('1.5')
    expect(capacityToGiB(GIB / 3)).toBe('0.33')
  })

  it('splits on commas and drops empty tags', () => {
    expect(parseTags(' a, b ,,c ')).toEqual(['a', 'b', 'c'])
    expect(parseTags('')).toEqual([])
  })
})

// Garage v2.4.1 has no "unstage one node" API. GetClusterLayout drops staged
// roles equal to the applied one (src/api/admin/layout.rs), so reverting is
// re-staging the applied role, or a removal when there is none.
describe('revertChangeFor', () => {
  it('re-stages the applied role over a staged update', () => {
    const staged: NodeRoleChange = { id: node.id, zone: 'dc2', tags: [], capacity: 5 * GIB }
    expect(revertChangeFor(node, appliedRole(), staged)).toEqual({
      id: node.id,
      zone: 'dc1',
      tags: ['ssd'],
      capacity: 10 * GIB,
    })
  })

  it('re-stages the applied role over a staged removal', () => {
    expect(revertChangeFor(node, appliedRole(), { id: node.id, remove: true })).toEqual({
      id: node.id,
      zone: 'dc1',
      tags: ['ssd'],
      capacity: 10 * GIB,
    })
  })

  it('stages a removal when the node has no applied role', () => {
    const staged: NodeRoleChange = { id: node.id, zone: 'dc1', tags: [], capacity: GIB }
    expect(revertChangeFor(node, undefined, staged)).toEqual({ id: node.id, remove: true })
  })

  it('keeps an applied gateway as capacity null, not 0 or absent', () => {
    const staged: NodeRoleChange = { id: node.id, zone: 'dc1', tags: [], capacity: 5 * GIB }
    const c = revertChangeFor(node, appliedRole({ capacity: null }), staged)
    expect(c).toEqual({ id: node.id, zone: 'dc1', tags: ['ssd'], capacity: null })
    expect(c).toHaveProperty('capacity', null)
  })

  it('restores the applied tags (in order) when only tags were staged', () => {
    const applied = appliedRole({ tags: ['b', 'a'], capacity: 1_000_000_000_000 })
    const staged: NodeRoleChange = { id: node.id, zone: 'dc1', tags: ['b', 'a', 'edge'], capacity: 1_000_000_000_000 }
    expect(revertChangeFor(node, applied, staged)).toEqual({
      id: node.id,
      zone: 'dc1',
      tags: ['b', 'a'],
      capacity: 1_000_000_000_000,
    })
  })

  it('returns null when nothing is staged', () => {
    expect(revertChangeFor(node, appliedRole(), undefined)).toBeNull()
    expect(revertChangeFor(node, undefined, undefined)).toBeNull()
  })
})

describe('groupDrafts', () => {
  const mk = (id: string, hostname: string, applied?: LayoutNodeRole, staged?: NodeRoleChange) =>
    draftFromNode({ id, hostname, isUp: true }, applied, staged)
  const role = (id: string, zone: string, capacity: number | null): LayoutNodeRole => ({
    id,
    zone,
    tags: [],
    capacity,
    storedPartitions: null,
    usableCapacity: null,
  })
  const storB = mk('b', 'node-b', role('b', 'dc2', GIB))
  const storA = mk('a', 'node-a', role('a', 'dc2', GIB))
  const gw = mk('g', 'node-g', role('g', 'dc1', null))
  const removed = mk('r', 'node-r', role('r', 'dc1', GIB), { id: 'r', remove: true })
  const added = mk('n', 'node-n', undefined, { id: 'n', zone: 'dc3', tags: [], capacity: GIB })
  const moved = mk('m', 'node-m', role('m', 'dc1', GIB), { id: 'm', zone: 'dc3', tags: [], capacity: null })
  const unassigned = mk('u', 'node-u')
  const all = [unassigned, storB, gw, removed, added, storA, moved]
  const summarize = (gs: ReturnType<typeof groupDrafts>) => gs.map((g) => [g.label, g.rows.map((d) => d.id)])

  it('keeps the input order in a single group for "none"', () => {
    expect(summarize(groupDrafts(all, 'none'))).toEqual([['', ['u', 'b', 'g', 'r', 'n', 'a', 'm']]])
  })

  it('groups by zone sorted by name, rows by name, unassigned last', () => {
    expect(summarize(groupDrafts(all, 'zone'))).toEqual([
      ['dc1', ['g', 'r']],
      ['dc2', ['a', 'b']],
      ['dc3', ['m', 'n']],
      ['ゾーン未割り当て', ['u']],
    ])
  })

  it('groups by zone of the applied layout when asked', () => {
    expect(summarize(groupDrafts([moved, added], 'zone', 'applied'))).toEqual([
      ['dc1', ['m']],
      ['ゾーン未割り当て', ['n']],
    ])
  })

  it('groups by role in the order storage, gateway, unassigned', () => {
    expect(summarize(groupDrafts(all, 'role'))).toEqual([
      ['ストレージ', ['a', 'b', 'n', 'r']],
      ['ゲートウェイ', ['g', 'm']],
      ['未割り当て', ['u']],
    ])
    expect(summarize(groupDrafts([moved], 'role', 'applied'))).toEqual([['ストレージ', ['m']]])
  })

  it('groups by staged state: changed, removed, unchanged', () => {
    expect(summarize(groupDrafts(all, 'change'))).toEqual([
      ['変更あり', ['m', 'n']],
      ['削除', ['r']],
      ['変更なし', ['a', 'b', 'g', 'u']],
    ])
    expect(changeKind(added)).toBe('changed')
  })

  it('omits empty groups and handles no rows', () => {
    expect(groupDrafts([], 'zone')).toEqual([])
    expect(summarize(groupDrafts([gw], 'role'))).toEqual([['ゲートウェイ', ['g']]])
  })

  it('sorts node names and zone names in natural order (garage-2 before garage-10)', () => {
    const rows = [
      mk('x', 'garage-10', role('x', 'zone-10', GIB)),
      mk('y', 'garage-2', role('y', 'zone-2', GIB)),
      mk('z', 'garage-1', role('z', 'zone-10', GIB)),
    ]
    expect(summarize(groupDrafts(rows, 'zone'))).toEqual([
      ['zone-2', ['y']],
      ['zone-10', ['z', 'x']],
    ])
    expect(summarize(groupDrafts(rows, 'role'))).toEqual([['ストレージ', ['z', 'y', 'x']]])
  })

  it('groups read-only current-role rows built by layoutRoleRows', () => {
    const roles = [role('b', 'dc1', GIB), role('a', 'dc2', null), role('c', 'dc1', GIB)]
    const staged = new Map<string, NodeRoleChange>([
      ['b', { id: 'b', remove: true }],
      ['c', { id: 'c', zone: 'dc3', tags: [], capacity: null }],
    ])
    const rows = layoutRoleRows(roles, staged, (id) => `node-${id}`)
    expect(rows.map((r) => [r.id, r.hostname, r.staged != null, r.effective != null])).toEqual([
      ['b', 'node-b', true, false],
      ['a', 'node-a', false, true],
      ['c', 'node-c', true, true],
    ])
    expect(summarize(groupDrafts(rows, 'change'))).toEqual([
      ['変更あり', ['c']],
      ['削除', ['b']],
      ['変更なし', ['a']],
    ])
    // The current table groups by the applied role, not the staged one.
    expect(summarize(groupDrafts(rows, 'zone', 'applied'))).toEqual([
      ['dc1', ['b', 'c']],
      ['dc2', ['a']],
    ])
  })
})

describe('layoutTotals', () => {
  const role = (id: string, zone: string, capacity: number | null): LayoutNodeRole => ({
    id,
    zone,
    tags: [],
    capacity,
    storedPartitions: null,
    usableCapacity: null,
  })
  const roles = [role('a', 'dc1', 10 * GIB), role('b', 'dc2', 20 * GIB), role('g', 'dc2', null)]

  it('is the same before and after when nothing is staged', () => {
    const t = layoutTotals(roles, [])
    expect(t.before).toEqual({ assignedNodes: 3, zones: 2, capacity: 30 * GIB })
    expect(t.after).toEqual(t.before)
  })

  it('applies staged additions, updates and removals', () => {
    const t = layoutTotals(roles, [
      { id: 'a', remove: true },
      { id: 'b', zone: 'dc3', tags: [], capacity: 5 * GIB },
      { id: 'n', zone: 'dc4', tags: [], capacity: GIB },
    ])
    expect(t.before).toEqual({ assignedNodes: 3, zones: 2, capacity: 30 * GIB })
    expect(t.after).toEqual({ assignedNodes: 3, zones: 3, capacity: 6 * GIB })
  })

  it('counts a node turned into a gateway as assigned with no capacity', () => {
    const t = layoutTotals(roles, [{ id: 'b', zone: 'dc2', tags: [] }])
    expect(t.after).toEqual({ assignedNodes: 3, zones: 2, capacity: 10 * GIB })
  })
})
