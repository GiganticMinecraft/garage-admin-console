import type { ClusterHealth, RepairType, ScrubCommand, Worker } from '@/api'
import type { FetchState } from '@/lib/maintenance-status'
import { describeState } from '@/lib/workers'

/**
 * Repairs that mark metadata as deleted or delete block files. They decide
 * "this version / block_ref has no parent" by looking the parent up on the
 * storage nodes that hold it; while one is disconnected, or still receiving
 * table entries after reconnecting, that lookup can be answered by a replica
 * that does not have the row yet and a live parent is reported as missing.
 * On 2026-10-19 a blockRefs repair ran while garage-1 was disconnected: 553
 * live block_refs were marked deleted (143 quorum errors), the blocks were
 * garbage-collected minutes later and about 70 objects became unreadable.
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

/** Workers whose activity means the metadata tables are still converging (same list as the backend). */
export const TABLE_SYNC_WORKERS: ReadonlySet<string> = new Set([
  'object sync',
  'version sync',
  'block_ref sync',
  'object Merkle',
  'version Merkle',
  'block_ref Merkle',
  'object queue',
  'version queue',
  'block_ref queue',
])

/** What the pages hold about the cluster: fetch state plus the data, if any. */
export interface GuardInputs {
  /** GET /api/cluster/health. */
  health: { state: FetchState; data?: Pick<ClusterHealth, 'storageNodes' | 'storageNodesUp' | 'partitions' | 'partitionsAllOk'> }
  /** GET /api/workers: every node's workers, and the nodes that did not answer. */
  workers: { state: FetchState; data?: { workers: readonly Pick<Worker, 'nodeId' | 'name' | 'state' | 'queueLength'>[]; errors: Readonly<Record<string, string>> } }
  /** IDs of the nodes holding metadata (storage / draining), from the cluster status; undefined while unknown. */
  storageNodeIds?: readonly string[]
  /** Hostnames for messages. */
  nodeNames?: ReadonlyMap<string, string>
}

export type RepairGuard = { allowed: true } | { allowed: false; reasons: string[]; advice: string }

const UNKNOWN = (what: string) => `${what}を取得できないため、安全に実行できるか判断できません`

/**
 * Whether `repairType` may be launched. Only the destructive repairs are
 * gated; everything else is always allowed. Unknown state (not loaded,
 * failed, or a counter missing from the answer) blocks a destructive repair:
 * waiting a refresh costs nothing, a wrong "not found" costs data. Only
 * storage nodes are considered: gateway nodes hold no metadata, and
 * `knownNodes` also lists decommissioned peers that never reconnect.
 */
export function evaluateRepairGuard(repairType: RepairType, inputs: GuardInputs): RepairGuard {
  if (!isDestructiveRepair(repairType)) return { allowed: true }
  const { health, workers, storageNodeIds, nodeNames } = inputs
  if (health.state === 'pending' || workers.state === 'pending') {
    return { allowed: false, reasons: ['クラスタの状態を取得中です'], advice: '' }
  }
  const h = health.data
  if (health.state === 'error' || h === undefined) return { allowed: false, reasons: [UNKNOWN('クラスタの状態')], advice: '' }
  const counters = [h.storageNodes, h.storageNodesUp, h.partitions, h.partitionsAllOk]
  if (!counters.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    return { allowed: false, reasons: [UNKNOWN('クラスタの状態')], advice: '' }
  }
  if (workers.state === 'error' || workers.data === undefined) {
    return { allowed: false, reasons: [UNKNOWN('ワーカーの状態')], advice: '' }
  }
  if (storageNodeIds === undefined) return { allowed: false, reasons: [UNKNOWN('ノードの役割')], advice: '' }

  const reasons: string[] = []
  if (h.storageNodesUp < h.storageNodes) {
    reasons.push(`ストレージノードが停止中です (稼働 ${h.storageNodesUp} / ${h.storageNodes})`)
  }
  if (h.partitionsAllOk < h.partitions) {
    reasons.push(`全レプリカが揃っていないパーティションがあります (${h.partitions - h.partitionsAllOk} / ${h.partitions})`)
  }
  const degraded = reasons.length > 0

  const name = (id: string) => nodeNames?.get(id) ?? `${id.slice(0, 16)}…`
  const syncing: string[] = []
  const answered = new Set(workers.data.workers.map((w) => w.nodeId))
  for (const id of [...storageNodeIds].sort()) {
    if (!answered.has(id)) {
      reasons.push(`${name(id)} のワーカー状態を取得できません (${workers.data.errors[id] ?? 'no answer'})`)
      continue
    }
    for (const w of workers.data.workers) {
      if (w.nodeId !== id || !TABLE_SYNC_WORKERS.has(w.name)) continue
      if (describeState(w.state).kind !== 'idle') syncing.push(`${name(id)}: ${w.name} が実行中`)
      else if (w.queueLength != null && w.queueLength > 0) syncing.push(`${name(id)}: ${w.name} にキュー ${w.queueLength} 件`)
    }
  }
  if (syncing.length > 0) reasons.push(`テーブルの同期が進行中です (${syncing.join('、')})`)
  if (reasons.length === 0) return { allowed: true }
  const advice = degraded
    ? 'ストレージノードの復旧を待ち、その後「テーブル修復」で同期を終えてから実行してください。'
    : '同期が終わる (sync / Merkle / queue ワーカーが idle になる) まで待ってから実行してください。'
  return { allowed: false, reasons, advice }
}

/** One line for the UI explaining why a destructive repair is held back. */
export function repairGuardHint(guard: RepairGuard): string {
  if (guard.allowed) return ''
  return `${guard.reasons.join('。')}。${guard.advice}`
}

/** Shared caution shown on every destructive operation card. */
export const DESTRUCTIVE_REPAIR_NOTE =
  'この操作は親が見つからないメタデータを削除扱いにします。全ストレージノードが稼働し、全パーティションのレプリカが揃い、テーブルの同期ワーカーが idle のときだけ実行できます (サーバー側でも同じ条件で拒否します)。'

/**
 * Re-evaluate against freshly fetched inputs right before launching: polling
 * pauses in a background tab, so the snapshot the button was enabled on may
 * be minutes old. Throws with the hint when the launch must not proceed, so a
 * caller can use it as the first step of a mutation and let the mutation's
 * pending state cover the check.
 */
export async function assertRepairAllowed(repairType: RepairType, refetch: () => Promise<GuardInputs>): Promise<void> {
  if (!isDestructiveRepair(repairType)) return
  const guard = evaluateRepairGuard(repairType, await refetch())
  if (!guard.allowed) throw new Error(repairGuardHint(guard))
}
