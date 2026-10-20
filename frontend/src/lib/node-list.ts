import type { ClusterNode, ConnectNodeResult } from '@/api'
import { formatSecsAgo } from '@/lib/workers'

// ---------------------------------------------------------------------------
// Roles

/**
 * What a node does in the current layout. `draining` is a node removed from
 * the layout that still holds data (Garage only reports it with role null);
 * `unassigned` has no role and holds nothing.
 */
export type NodeRoleKind = 'storage' | 'gateway' | 'draining' | 'unassigned'

export const ROLE_LABELS: Record<NodeRoleKind, string> = {
  storage: 'ストレージ',
  gateway: 'ゲートウェイ',
  draining: 'draining',
  unassigned: '未割り当て',
}

export function nodeRoleKind(node: Pick<ClusterNode, 'role' | 'draining'>): NodeRoleKind {
  if (node.role) return node.role.capacity != null ? 'storage' : 'gateway'
  return node.draining ? 'draining' : 'unassigned'
}

// ---------------------------------------------------------------------------
// Grouping and sorting

export type NodeGroupBy = 'zone' | 'connectivity' | 'role'

export const GROUP_BY_OPTIONS: { value: NodeGroupBy; label: string }[] = [
  { value: 'zone', label: 'ゾーン' },
  { value: 'connectivity', label: '接続状態' },
  { value: 'role', label: 'ロール' },
]

export const DEFAULT_GROUP_BY: NodeGroupBy = 'zone'

export interface NodeGroup {
  /** Stable React key. */
  key: string
  label: string
  nodes: ClusterNode[]
}

/** Label of the zone group for nodes without a role; always listed last. */
export const NO_ZONE_LABEL = 'ゾーン未割り当て'

const ROLE_ORDER: NodeRoleKind[] = ['storage', 'gateway', 'draining', 'unassigned']

/** Sort key of a node inside a group: hostname when known, else the full ID. */
function nodeSortName(node: ClusterNode): string {
  return node.hostname || node.id
}

/** Orders nodes by hostname (natural order, so garage-2 < garage-10), then ID. */
export function compareNodes(a: ClusterNode, b: ClusterNode): number {
  return (
    nodeSortName(a).localeCompare(nodeSortName(b), 'ja', { numeric: true }) ||
    a.id.localeCompare(b.id)
  )
}

/**
 * Splits nodes into display groups. Zones are sorted by name with the nodes
 * that have no zone last; connectivity lists 接続中 before 切断中; roles go
 * storage, gateway, draining, then 未割り当て. Empty groups are omitted and
 * nodes inside a group are sorted with compareNodes.
 */
export function groupNodes(nodes: readonly ClusterNode[], groupBy: NodeGroupBy): NodeGroup[] {
  const buckets = new Map<string, NodeGroup & { rank: number }>()
  const add = (key: string, label: string, rank: number, node: ClusterNode) => {
    let g = buckets.get(key)
    if (!g) {
      g = { key, label, rank, nodes: [] }
      buckets.set(key, g)
    }
    g.nodes.push(node)
  }
  for (const node of nodes) {
    if (groupBy === 'zone') {
      if (node.role) add(`zone:${node.role.zone}`, node.role.zone, 0, node)
      else add('zone-none', NO_ZONE_LABEL, 1, node)
    } else if (groupBy === 'connectivity') {
      if (node.isUp) add('up', '接続中', 0, node)
      else add('down', '切断中', 1, node)
    } else {
      const kind = nodeRoleKind(node)
      add(`role:${kind}`, ROLE_LABELS[kind], ROLE_ORDER.indexOf(kind), node)
    }
  }
  return [...buckets.values()]
    .sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label, 'ja', { numeric: true }))
    .map(({ key, label, nodes }) => ({ key, label, nodes: [...nodes].sort(compareNodes) }))
}

// ---------------------------------------------------------------------------
// Last seen

/**
 * 「最終確認 N 分前」 for a disconnected node, or null for a connected one.
 * Garage reports lastSeenSecsAgo null when it has not reached the node since
 * it restarted; that is shown as such rather than hidden.
 */
export function lastSeenLabel(node: Pick<ClusterNode, 'isUp' | 'lastSeenSecsAgo'>): string | null {
  if (node.isUp) return null
  if (node.lastSeenSecsAgo == null) return 'Garage の再起動後に接続実績なし'
  return `最終確認 ${formatSecsAgo(node.lastSeenSecsAgo)}`
}

// ---------------------------------------------------------------------------
// Connect input

/** Upper bound of peers per request; the backend enforces the same limit. */
export const MAX_CONNECT_NODES = 10

/** `<64-hex node id>@<host>:<port>`, as printed by `garage node id`. Same pattern as the backend. */
export const CONNECT_PEER_PATTERN = /^[0-9a-f]{64}@[^\s@]+:[0-9]+$/

export interface ConnectLineError {
  /** 1-based line number in the textarea. */
  line: number
  message: string
}

export interface ParsedConnectInput {
  /** Valid peers in input order (blank lines dropped). */
  peers: string[]
  errors: ConnectLineError[]
}

/**
 * Parses the connect textarea: one `<id>@<addr:port>` per line, surrounding
 * whitespace and blank lines ignored. Malformed and duplicate lines are
 * reported with their line number; more than MAX_CONNECT_NODES peers is an
 * error on the first line past the limit. The input may be sent only when
 * `errors` is empty and `peers` is not.
 */
export function parseConnectInput(text: string): ParsedConnectInput {
  const peers: string[] = []
  const errors: ConnectLineError[] = []
  const seen = new Set<string>()
  let count = 0
  text.split(/\r?\n/).forEach((raw, i) => {
    const value = raw.trim()
    if (!value) return
    const line = i + 1
    count++
    if (count === MAX_CONNECT_NODES + 1) {
      errors.push({ line, message: `一度に接続できるのは ${MAX_CONNECT_NODES} ノードまでです` })
    }
    if (!value.includes('@')) {
      errors.push({ line, message: '<ノード ID>@<アドレス>:<ポート> の形式で入力してください' })
    } else if (!/^[0-9a-f]{64}@/.test(value)) {
      errors.push({ line, message: 'ノード ID は 64 桁の 16 進数 (小文字) です' })
    } else if (!CONNECT_PEER_PATTERN.test(value)) {
      errors.push({ line, message: 'アドレスは <ホスト>:<ポート> の形式です (空白は含められません)' })
    } else if (seen.has(value)) {
      errors.push({ line, message: '同じノードが重複しています' })
    } else {
      seen.add(value)
      peers.push(value)
    }
  })
  return { peers, errors }
}

// ---------------------------------------------------------------------------
// Connect results

export interface ConnectResultRow {
  peer: string
  success: boolean
  /** Garage's error message for a failed peer (null when it gave none). */
  error: string | null
}

export type ConnectOutcome = 'all' | 'partial' | 'none'

/**
 * Pairs each requested peer with Garage's answer at the same position. A
 * missing answer counts as a failure instead of being dropped.
 */
export function pairConnectResults(peers: readonly string[], results: readonly ConnectNodeResult[]): ConnectResultRow[] {
  return peers.map((peer, i) => {
    const r = results[i]
    if (!r) return { peer, success: false, error: '応答に結果が含まれていません' }
    return { peer, success: r.success, error: r.success ? null : (r.error ?? null) }
  })
}

export function connectOutcome(rows: readonly ConnectResultRow[]): ConnectOutcome {
  const ok = rows.filter((r) => r.success).length
  if (ok === 0) return 'none'
  return ok === rows.length ? 'all' : 'partial'
}
