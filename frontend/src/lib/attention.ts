import type {
  AdminToken,
  BucketListItem,
  ClusterHealth,
  ClusterLayout,
  ClusterNode,
  ClusterStatus,
  KeyListItem,
  ListResult,
  S3Connection,
  StorageHealth,
} from '@/api'
import { bucketDisplayLabel, bucketDisplayName } from '@/lib/bucket-name'
import { formatCount } from '@/lib/format'
import { isStorageNode, nodeDisplayName } from '@/lib/nodes'
import { formatSecsAgo } from '@/lib/workers'

/**
 * The part of a useQuery result the attention panel reads, so query results
 * can be passed as they are. A source with isError is "unknown" even when it
 * still holds data from an earlier fetch: a stale answer must not hide a
 * problem that appeared since.
 */
export interface AttentionSource<T> {
  data?: T
  isError: boolean
}

export interface AttentionInputs {
  /** Date.now(); expirations are compared against it. */
  now: number
  health: AttentionSource<ClusterHealth>
  status: AttentionSource<ClusterStatus>
  storageHealth: AttentionSource<StorageHealth>
  /** Corruption counter rises seen since the page was loaded, by node ID. */
  corruptionIncreases?: Record<string, { delta: number }>
  layout: AttentionSource<ClusterLayout>
  keys: AttentionSource<ListResult<KeyListItem>>
  adminTokens: AttentionSource<AdminToken[]>
  buckets: AttentionSource<ListResult<BucketListItem>>
  s3Connection: AttentionSource<S3Connection>
}

export type AttentionSeverity = 'danger' | 'warning'

/** Where an item links to: a detail page (with its ID) or a list page. */
export type AttentionLink =
  | { to: '/nodes/$id' | '/keys/$id' | '/admin-tokens/$id' | '/buckets/$id'; id: string }
  | { to: '/blocks' | '/layout' | '/admin-tokens' | '/buckets' }

export interface AttentionItem {
  /** Stable React key. */
  id: string
  severity: AttentionSeverity
  message: string
  /** Secondary detail, e.g. the first few affected names. */
  hint?: string
  link?: AttentionLink
}

export interface AttentionResult {
  /** danger first, then warning; otherwise in the order of the checks. */
  items: AttentionItem[]
  /** Sources (or parts of them) that could not be judged. */
  unknown: string[]
  /** Some source has neither data nor an error yet (first load). */
  pending: boolean
}

/** Expirations within this window are flagged before they hit. */
export const EXPIRY_WARNING_MS = 7 * 24 * 60 * 60 * 1000
/** Buckets with at least this many unfinished multipart uploads are flagged. */
export const MULTIPART_WARNING_COUNT = 10

const DAY_MS = 24 * 60 * 60 * 1000

/** Expired → danger; expiring within EXPIRY_WARNING_MS → warning; else null. */
export function expiryAttention(
  expiration: string | null,
  expired: boolean,
  now: number,
): { severity: AttentionSeverity; text: string } | null {
  const t = expiration ? Date.parse(expiration) : NaN
  if (expired || (!Number.isNaN(t) && t <= now)) return { severity: 'danger', text: '有効期限が切れています' }
  if (Number.isNaN(t) || t - now > EXPIRY_WARNING_MS) return null
  const left = t - now
  return {
    severity: 'warning',
    text: left < DAY_MS ? '24 時間以内に有効期限が切れます' : `あと ${Math.ceil(left / DAY_MS)} 日で有効期限が切れます`,
  }
}

/** Buckets named in the hint of the aggregated console-key item. */
const CONSOLE_KEY_HINT_COUNT = 5

function nodeLink(node: Pick<ClusterNode, 'id' | 'role'> | undefined, id: string, fallback: AttentionLink): AttentionLink {
  // Garage resolves node=<id> against the layout, so role-less nodes have no detail page.
  return node && !node.role ? fallback : { to: '/nodes/$id', id }
}

/**
 * Collects everything on the cluster that needs an operator's attention, from
 * data the dashboard already has. Sources that failed are reported in
 * `unknown` rather than treated as fine.
 */
export function collectAttentionItems(inputs: AttentionInputs): AttentionResult {
  const items: AttentionItem[] = []
  const unknown: string[] = []
  const { now } = inputs
  let pending = false

  /** The data of a source, or undefined (noting failure / first load). */
  const take = <T>(src: AttentionSource<T>, label: string): T | undefined => {
    if (src.isError) {
      unknown.push(label)
      return undefined
    }
    if (src.data === undefined) pending = true
    return src.data
  }

  // 9. Cluster health.
  const health = take(inputs.health, 'クラスタの状態')
  if (health && health.status !== 'healthy') {
    items.push({
      id: 'health',
      severity: health.status === 'unavailable' ? 'danger' : 'warning',
      message: `クラスタの状態が ${health.status} です(ストレージノード ${health.storageNodesUp} / ${health.storageNodes} 稼働中、quorum を満たすパーティション ${health.partitionsQuorum} / ${health.partitions})`,
    })
  }

  // 1. Disconnected / draining storage nodes.
  const status = take(inputs.status, 'ノード一覧')
  const nodes = status?.nodes ?? []
  const nodeById = new Map(nodes.map((n) => [n.id, n]))
  const nameOf = (id: string) => {
    const n = nodeById.get(id)
    return n ? nodeDisplayName(n) : nodeDisplayName({ id, hostname: null })
  }
  for (const n of nodes.filter(isStorageNode)) {
    const link = nodeLink(n, n.id, { to: '/layout' })
    if (!n.isUp) {
      const notes = [
        n.draining && 'draining',
        n.lastSeenSecsAgo != null && `最終確認 ${formatSecsAgo(n.lastSeenSecsAgo)}`,
      ].filter(Boolean)
      items.push({
        id: `node-down:${n.id}`,
        severity: 'danger',
        message: `ストレージノード ${nodeDisplayName(n)} が切断中です${notes.length > 0 ? `(${notes.join('、')})` : ''}`,
        link,
      })
    } else if (n.draining) {
      items.push({
        id: `node-draining:${n.id}`,
        severity: 'warning',
        message: `ストレージノード ${nodeDisplayName(n)} は draining 中です(レイアウトから外されましたが、まだデータを保持しています)`,
        link,
      })
    }
  }

  // 2 / 3. Resync errors and corruption counter rises.
  const sh = take(inputs.storageHealth, 'Storage health')
  if (sh) {
    for (const [id, h] of Object.entries(sh.nodes)) {
      if ((h.resyncErrors ?? 0) > 0) {
        items.push({
          id: `resync:${id}`,
          severity: 'danger',
          message: `${nameOf(id)} で Resync エラーが ${formatCount(h.resyncErrors)} 件あります`,
          link: { to: '/blocks' },
        })
      }
      const inc = inputs.corruptionIncreases?.[id]
      if (inc && inc.delta > 0) {
        items.push({
          id: `corruption:${id}`,
          severity: 'warning',
          message: `${nameOf(id)} で Scrub 破損検出数がページ表示後に ${formatCount(inc.delta)} 件増えました`,
          link: nodeLink(nodeById.get(id), id, { to: '/blocks' }),
        })
      }
    }
    // Unchecked = the storage-health answer's own fan-out errors. Cluster
    // status and storage health poll independently, so a node present in only
    // one of them (just added or back) is ignored rather than flashing as
    // unknown; nodes known to be down or not to store data are flagged above
    // or irrelevant.
    const relevant = (id: string) => {
      const n = nodeById.get(id)
      return !status || !n || (isStorageNode(n) && n.isUp)
    }
    const silent =
      Boolean(sh.statsError || sh.varsError) ||
      Object.entries(sh.nodes).some(([id, h]) => relevant(id) && Boolean(h.error))
    if (silent) unknown.push('Storage health(一部のノード)')
  }

  // 4. Layout: staged changes. An update in flight is shown by the layout
  // update tracker right below the panel, so it is not repeated here.
  const layout = take(inputs.layout, 'レイアウト')
  if (layout) {
    const changes = layout.stagedRoleChanges.length
    if (changes > 0 || layout.stagedParameters) {
      const parts = [changes > 0 && `ノード ${changes} 件`, layout.stagedParameters && 'パラメータ'].filter(Boolean)
      items.push({
        id: 'layout-staged',
        severity: 'warning',
        message: `レイアウトに未適用の変更があります(${parts.join('、')})`,
        link: { to: '/layout' },
      })
    }
  }

  // 5. Access keys.
  const keys = take(inputs.keys, 'アクセスキー')
  if (keys) {
    if (keys.truncated) unknown.push('アクセスキー(一覧が上限で打ち切られています)')
    for (const k of keys.items) {
      const e = expiryAttention(k.expiration, k.expired, now)
      if (e) {
        items.push({
          id: `key:${k.id}`,
          severity: e.severity,
          message: `アクセスキー ${k.name || k.id}: ${e.text}`,
          link: { to: '/keys/$id', id: k.id },
        })
      }
    }
  }

  // 6. Admin tokens.
  const tokens = take(inputs.adminTokens, '管理トークン')
  for (const [i, t] of (tokens ?? []).entries()) {
    const e = expiryAttention(t.expiration, t.expired, now)
    if (e) {
      items.push({
        id: `token:${t.id ?? `config-${i}`}`,
        severity: e.severity,
        message: `管理トークン ${t.name || t.id || '(設定ファイル)'}: ${e.text}`,
        // Tokens from the daemon configuration have no ID (no detail page).
        link: t.id ? { to: '/admin-tokens/$id', id: t.id } : { to: '/admin-tokens' },
      })
    }
  }

  // 7 / 8. Buckets: unfinished multipart uploads, console key permissions.
  const buckets = take(inputs.buckets, 'バケット')
  const conn = take(inputs.s3Connection, 'コンソールの S3 キー')
  if (buckets) {
    if (buckets.truncated) unknown.push('バケット(一覧が上限で打ち切られています)')
    // An empty ID means the console has no S3 key configured: nothing to check.
    const consoleKey = conn?.accessKeyId || undefined
    let partial = false
    // Aggregated into one line: buckets may be left ungranted on purpose.
    const noConsoleAccess: string[] = []
    for (const b of buckets.items) {
      const name = bucketDisplayLabel(bucketDisplayName(b.id, b.globalAliases, b.localAliases.map((a) => a.alias)))
      const link: AttentionLink = { to: '/buckets/$id', id: b.id }
      if (b.unfinishedMultipartUploads == null) partial = true
      else if (b.unfinishedMultipartUploads >= MULTIPART_WARNING_COUNT) {
        items.push({
          id: `multipart:${b.id}`,
          severity: 'warning',
          message: `バケット ${name} に未完了のマルチパートアップロードが ${formatCount(b.unfinishedMultipartUploads)} 件あります`,
          link,
        })
      }
      if (!consoleKey) continue
      if (b.keys == null) {
        partial = true
        continue
      }
      const perm = b.keys.find((k) => k.accessKeyId === consoleKey)
      if (!perm?.read || !perm.write) noConsoleAccess.push(name)
    }
    if (noConsoleAccess.length > 0) {
      const head = noConsoleAccess.slice(0, CONSOLE_KEY_HINT_COUNT).join('、')
      const rest = noConsoleAccess.length - CONSOLE_KEY_HINT_COUNT
      items.push({
        id: 'console-key',
        severity: 'warning',
        message: `コンソールの S3 キーに read / write 権限のないバケットが ${formatCount(noConsoleAccess.length)} 件あります(オブジェクトブラウザで閲覧・操作できません)`,
        hint: rest > 0 ? `${head} ほか ${formatCount(rest)} 件` : head,
        link: { to: '/buckets' },
      })
    }
    if (partial) unknown.push('バケット(一部の詳細)')
  }

  const rank = (s: AttentionSeverity) => (s === 'danger' ? 0 : 1)
  items.sort((a, b) => rank(a.severity) - rank(b.severity))
  return { items, unknown, pending }
}
