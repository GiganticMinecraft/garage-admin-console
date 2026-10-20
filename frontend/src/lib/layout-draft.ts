import type { ClusterNode, LayoutNodeRole, NodeRoleChange } from '@/api'
import { GIB } from '@/lib/format'
import { bucketize, roleBucket, zoneBucket, type Bucket } from '@/lib/node-list'
import { nodeDisplayName, type NodeRoleKind } from '@/lib/nodes'

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

/**
 * The change that cancels a node's staged change, or null when nothing is
 * staged for it. Garage has no API to drop part of the staged set, but
 * GetClusterLayout only reports staged roles that differ from the applied
 * layout (src/api/admin/layout.rs in v2.4.1), so re-staging the applied role
 * makes the node's entry disappear. With no applied role, staging a removal
 * does the same. The applied capacity is passed through unchanged, so a
 * gateway (capacity null) stays a gateway.
 */
export function revertChangeFor(
  node: Pick<ClusterNode, 'id'>,
  applied: LayoutNodeRole | undefined,
  staged: NodeRoleChange | undefined,
): NodeRoleChange | null {
  if (!staged) return null
  if (!applied) return { id: node.id, remove: true }
  return { id: node.id, zone: applied.zone, tags: [...applied.tags], capacity: applied.capacity ?? null }
}

export type LayoutGroupBy = 'none' | 'zone' | 'role' | 'change'

export const LAYOUT_GROUP_BY_OPTIONS: { value: LayoutGroupBy; label: string }[] = [
  { value: 'none', label: 'なし' },
  { value: 'zone', label: 'ゾーン' },
  { value: 'role', label: 'ロール' },
  { value: 'change', label: '変更の有無' },
]

type RoleShape = { zone: string; capacity?: number | null }

/**
 * The minimal shape groupDrafts needs: a node with its applied role and the
 * role after staged changes (null when unassigned or staged for removal).
 * RoleDraft and LayoutRoleRow both fit.
 */
export interface GroupableRow {
  id: string
  hostname: string | null
  applied: RoleShape | null
  effective: RoleShape | null
}

export interface RowGroup<T> {
  key: string
  /** Group heading; empty for LayoutGroupBy 'none'. */
  label: string
  rows: T[]
}

export type ChangeKind = 'changed' | 'removed' | 'unchanged'

const CHANGE_BUCKETS: Record<ChangeKind, Bucket> = {
  changed: { key: 'change:changed', label: '変更あり', rank: 0 },
  removed: { key: 'change:removed', label: '削除', rank: 1 },
  unchanged: { key: 'change:unchanged', label: '変更なし', rank: 2 },
}

/**
 * Which role a row is grouped by: 'effective' (the next layout, which the
 * edit form starts from) or 'applied' (the current layout). Grouping uses
 * these stable values rather than the form fields, so rows do not jump
 * between groups while the operator types.
 */
export type GroupBasis = 'effective' | 'applied'

function groupRole(r: GroupableRow, basis: GroupBasis): RoleShape | null {
  // A staged removal has no effective role; group it by the role being removed.
  return basis === 'applied' ? r.applied : (r.effective ?? r.applied)
}

function roleKindOf(role: RoleShape | null): NodeRoleKind {
  if (!role) return 'unassigned'
  return role.capacity != null ? 'storage' : 'gateway'
}

/** Staged state of a row: removal, add/update, or nothing staged. */
export function changeKind(r: Pick<GroupableRow, 'applied' | 'effective'>): ChangeKind {
  if (r.applied && !r.effective) return 'removed'
  if (r.effective && r.effective !== r.applied) return 'changed'
  return 'unchanged'
}

/**
 * Group rows for display, with the same labels and order as the node list:
 * zones by name (natural order) with ゾーン未割り当て last; roles storage,
 * gateway, then 未割り当て; changes 変更あり, 削除, 変更なし. Rows inside a
 * group are sorted by display name in natural order. 'none' keeps the input
 * order in a single group.
 */
export function groupDrafts<T extends GroupableRow>(
  rows: readonly T[],
  by: LayoutGroupBy,
  basis: GroupBasis = 'effective',
): RowGroup<T>[] {
  if (by === 'none') return [{ key: 'all', label: '', rows: [...rows] }]
  return bucketize(rows, (r) => {
    if (by === 'zone') return zoneBucket(groupRole(r, basis)?.zone ?? null)
    if (by === 'role') return roleBucket(roleKindOf(groupRole(r, basis)))
    return CHANGE_BUCKETS[changeKind(r)]
  }).map(({ key, label, items }) => ({ key, label, rows: items }))
}

/** A row of the read-only "current roles" table. */
export interface LayoutRoleRow extends GroupableRow {
  applied: LayoutNodeRole
  /** The node's staged change, if any. */
  staged: NodeRoleChange | null
}

/** Applied roles paired with their staged change, for the current-roles table. */
export function layoutRoleRows(
  roles: readonly LayoutNodeRole[],
  stagedById: ReadonlyMap<string, NodeRoleChange>,
  hostnameOf: (id: string) => string | null,
): LayoutRoleRow[] {
  return roles.map((r) => {
    const staged = stagedById.get(r.id) ?? null
    return {
      id: r.id,
      hostname: hostnameOf(r.id),
      applied: r,
      staged,
      effective: staged == null ? r : 'remove' in staged ? null : staged,
    }
  })
}

export interface LayoutTotals {
  /** Nodes with a role (storage or gateway). */
  assignedNodes: number
  /** Distinct zones among assigned nodes. */
  zones: number
  /** Sum of the capacity of storage roles, in bytes (gateways count as 0). */
  capacity: number
}

function totalsOf(roles: Iterable<{ zone: string; capacity?: number | null }>): LayoutTotals {
  let assignedNodes = 0
  let capacity = 0
  const zones = new Set<string>()
  for (const r of roles) {
    assignedNodes++
    zones.add(r.zone)
    capacity += r.capacity ?? 0
  }
  return { assignedNodes, zones: zones.size, capacity }
}

/**
 * Totals of the applied layout (`before`) and of the layout the staged role
 * changes would produce (`after`). Both are equal when nothing is staged.
 */
export function layoutTotals(
  roles: LayoutNodeRole[],
  staged: NodeRoleChange[],
): { before: LayoutTotals; after: LayoutTotals } {
  const next = new Map<string, { zone: string; capacity?: number | null }>(roles.map((r) => [r.id, r]))
  for (const c of staged) {
    if ('remove' in c) next.delete(c.id)
    else next.set(c.id, c)
  }
  return { before: totalsOf(roles), after: totalsOf(next.values()) }
}
