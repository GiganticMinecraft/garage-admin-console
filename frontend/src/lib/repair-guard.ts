import type { ClusterHealth, RepairType, ScrubCommand } from '@/api'
import type { FetchState } from '@/lib/maintenance-status'

/**
 * Repairs that mark metadata as deleted or delete block files. They decide
 * "this version / block_ref has no parent" by looking the parent up on the
 * storage nodes that hold it; while one is disconnected the lookup cannot
 * reach a quorum and a live parent can be reported as missing. On 2026-10-19
 * a blockRefs repair ran while garage-1 was disconnected: 553 live block_refs
 * were marked deleted (143 quorum errors), the blocks were garbage-collected
 * minutes later and about 70 objects became unreadable.
 *
 * The backend refuses these with 409 (repair_guard.go) for every caller; this
 * mirror only exists so the UI can disable the button and explain up front.
 */
export const DESTRUCTIVE_REPAIRS: ReadonlySet<Exclude<RepairType, { scrub: ScrubCommand }>> = new Set([
  'versions',
  'blockRefs',
  'blockRc',
  'blocks',
  'multipartUploads',
] as const)

export function isDestructiveRepair(repairType: RepairType): boolean {
  return typeof repairType === 'string' && (DESTRUCTIVE_REPAIRS as ReadonlySet<string>).has(repairType)
}

/** GET /api/cluster/health as the page holds it: fetch state plus the data, if any. */
export interface HealthInput {
  state: FetchState
  data?: Pick<ClusterHealth, 'storageNodes' | 'storageNodesUp' | 'partitions' | 'partitionsAllOk'>
}

export type RepairGuard = { allowed: true } | { allowed: false; reasons: string[] }

const UNKNOWN_HEALTH = 'クラスタの状態を取得できないため、安全に実行できるか判断できません'

/**
 * Whether `repairType` may be launched given the cluster health. Only the
 * destructive repairs are gated; everything else is always allowed. Unknown
 * health (not loaded, failed, or a counter missing from the answer) blocks a
 * destructive repair: waiting a refresh costs nothing, a wrong "not found"
 * costs data. Only storage nodes are considered: gateway nodes hold no
 * metadata, so a disconnected gateway cannot cause a false "not found", and
 * `knownNodes` also lists decommissioned peers that never reconnect.
 */
export function evaluateRepairGuard(repairType: RepairType, health: HealthInput): RepairGuard {
  if (!isDestructiveRepair(repairType)) return { allowed: true }
  if (health.state === 'pending') return { allowed: false, reasons: ['クラスタの状態を取得中です'] }
  const h = health.data
  if (health.state === 'error' || h === undefined) return { allowed: false, reasons: [UNKNOWN_HEALTH] }
  const counters = [h.storageNodes, h.storageNodesUp, h.partitions, h.partitionsAllOk]
  if (!counters.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    return { allowed: false, reasons: [UNKNOWN_HEALTH] }
  }
  const reasons: string[] = []
  if (h.storageNodesUp < h.storageNodes) {
    reasons.push(`ストレージノードが停止中です (稼働 ${h.storageNodesUp} / ${h.storageNodes})`)
  }
  if (h.partitionsAllOk < h.partitions) {
    reasons.push(`全レプリカが揃っていないパーティションがあります (${h.partitions - h.partitionsAllOk} / ${h.partitions})`)
  }
  return reasons.length === 0 ? { allowed: true } : { allowed: false, reasons }
}

/** One line for the UI explaining why a destructive repair is held back. */
export function repairGuardHint(guard: RepairGuard): string {
  if (guard.allowed) return ''
  return `${guard.reasons.join('。')}。全ストレージノードが稼働し、全パーティションのレプリカが揃うまでこの操作は実行できません。先に「テーブル修復」で同期を終えてください。`
}
