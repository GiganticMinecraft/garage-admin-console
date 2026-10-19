import { describe, expect, it } from 'vitest'
import type { LayoutNodeRole, NodeRoleChange } from '@/api'
import { GIB } from './format'
import { capacityToGiB, draftFromNode, draftToChange, parseTags } from './layout-draft'

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
