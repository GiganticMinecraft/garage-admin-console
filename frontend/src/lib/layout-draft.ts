import type { ClusterNode, LayoutNodeRole, NodeRoleChange } from '@/api'
import { GIB } from '@/lib/format'
import { nodeDisplayName } from '@/lib/nodes'

/** The editable fields of a row, as strings so "unchanged" can be detected exactly. */
export interface RoleFields {
  zone: string
  capacityGiB: string
  tags: string
}

/**
 * One row of the edit form. Capacity is edited in GiB; empty means gateway.
 * `effective` is what the next layout version would contain for this node
 * (a staged change wins over the applied role), `original` is the form state
 * derived from it so a row only counts as changed when the operator edited it.
 */
export interface RoleDraft extends RoleFields {
  id: string
  hostname: string | null
  isUp: boolean
  /** Role in the applied layout, if any. */
  applied: LayoutNodeRole | null
  /** Role after staged changes: null when unassigned or staged for removal. */
  effective: { zone: string; tags: string[]; capacity?: number | null } | null
  original: RoleFields
  /**
   * Capacity in bytes of the role the form was filled from (null: gateway or
   * no role). Reused as-is when the capacity field is left untouched, since
   * the GiB string is rounded and cannot reproduce the exact byte count.
   */
  originalCapacity: number | null
  remove: boolean
}

export function capacityToGiB(capacity: number | null): string {
  return capacity != null ? String(Math.round((capacity / GIB) * 100) / 100) : ''
}

export function draftFromNode(
  node: Pick<ClusterNode, 'id' | 'hostname' | 'isUp'>,
  applied: LayoutNodeRole | undefined,
  staged: NodeRoleChange | undefined,
): RoleDraft {
  const stagedRemove = staged != null && 'remove' in staged
  const effective = stagedRemove ? null : (staged ?? applied ?? null)
  // Take every field from a single role. In Garage's NodeAssignedRole /
  // LayoutNodeRole a null (or absent) capacity is a valid value meaning
  // "gateway", so it must not fall through to the applied capacity. Rows
  // staged for removal show the applied role so unchecking "remove" restores
  // it; nodes without any role get a blank form.
  const source = effective ?? applied ?? null
  const originalCapacity = source?.capacity ?? null
  const fields: RoleFields = source
    ? {
        zone: source.zone,
        capacityGiB: capacityToGiB(originalCapacity),
        tags: (source.tags ?? []).join(', '),
      }
    : { zone: '', capacityGiB: '', tags: '' }
  return {
    id: node.id,
    hostname: node.hostname,
    isUp: node.isUp,
    applied: applied ?? null,
    effective,
    original: fields,
    originalCapacity,
    ...fields,
    remove: stagedRemove,
  }
}

export function parseTags(s: string): string[] {
  return s.split(',').map((t) => t.trim()).filter(Boolean)
}

/**
 * Convert a draft to the change Garage expects, or null when the operator did
 * not touch the row. Comparison is on the form strings, not on bytes
 * re-derived from a rounded GiB value, so untouched rows never re-stage.
 */
export function draftToChange(d: RoleDraft): NodeRoleChange | null | Error {
  const name = nodeDisplayName(d)
  const wasRemoved = d.effective == null && d.applied != null
  if (d.remove) {
    if (wasRemoved) return null // already staged for removal
    return d.applied ? { id: d.id, remove: true } : null
  }
  const untouched =
    d.zone === d.original.zone && d.capacityGiB === d.original.capacityGiB && d.tags === d.original.tags
  if (untouched && !wasRemoved) return null
  if (untouched && wasRemoved && !d.zone.trim()) return null

  const zone = d.zone.trim()
  const tags = parseTags(d.tags)
  let capacity: number | null = null
  if (d.capacityGiB === d.original.capacityGiB && d.originalCapacity != null) {
    // Untouched capacity: keep the exact bytes instead of re-deriving them
    // from the rounded GiB string (which can drift, or round tiny values to 0).
    capacity = d.originalCapacity
  } else if (d.capacityGiB.trim() !== '') {
    const n = Number(d.capacityGiB)
    if (!Number.isFinite(n) || n <= 0) {
      return new Error(`${name}: 容量は正の数 (GiB) で入力してください`)
    }
    capacity = Math.round(n * GIB)
  }
  if (!zone) {
    // Node that has no role and was left blank: nothing to stage.
    if (!d.effective && !d.applied) return null
    return new Error(`${name}: ゾーンは必須です`)
  }
  return { id: d.id, zone, tags, capacity }
}
