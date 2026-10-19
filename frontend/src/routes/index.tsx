import { lazy, Suspense, useEffect, useState } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import {
  getClusterHealth,
  getClusterStatistics,
  getClusterStatus,
  getStorageHealth,
  listKeys,
  type ClusterHealth,
  type ClusterNode,
  type ClusterStatistics,
  type KeyListItem,
  type ListResult,
  type PartitionUsage,
  type NodeStorageHealth,
  type StorageHealth,
} from '@/api'

const StorageCharts = lazy(() => import('@/components/storage-charts'))
import { LayoutUpdateTracker } from '@/components/layout-update-tracker'
import { formatBytes, formatCount, formatDateTime } from '@/lib/format'
import { nodeDisplayName } from '@/lib/nodes'
import { formatSecsAgo } from '@/lib/workers'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table'
import { Skeleton } from '@/components/ui/skeleton'

export const Route = createFileRoute('/')({
  component: DashboardPage,
})

/** Polling periods; polling pauses while the tab is hidden. */
const STATUS_REFETCH_MS = 15_000
const STATISTICS_REFETCH_MS = 30_000

function ProgressBar({
  label,
  used,
  total,
  color,
}: {
  label: string
  used: number
  total: number
  color: string
}) {
  const percent = total > 0 ? (used / total) * 100 : 0
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs">
        <span>{label}</span>
        <span>
          {formatBytes(used)} / {formatBytes(total)} ({percent.toFixed(1)}%)
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-muted overflow-hidden">
        <div
          className={`h-full rounded-full ${color}`}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  )
}

function HealthCard({ data }: { data: ClusterHealth }) {
  const isHealthy = data.status === 'healthy'
  return (
    <div className="rounded-lg border p-4 space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="text-lg font-semibold">クラスタの状態</h2>
        <Badge variant={isHealthy ? 'secondary' : 'destructive'}>
          {data.status}
        </Badge>
      </div>
      <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
        <div>
          <p className="text-muted-foreground">ノード</p>
          <p className="font-medium">
            {data.connectedNodes} / {data.knownNodes} 接続中
          </p>
        </div>
        <div>
          <p className="text-muted-foreground">ストレージノード</p>
          <p className="font-medium">
            {data.storageNodesUp} / {data.storageNodes} 稼働中
          </p>
        </div>
        <div>
          <p className="text-muted-foreground">パーティション</p>
          <p className="font-medium">{data.partitions}</p>
        </div>
        <div>
          <p className="text-muted-foreground">パーティション (quorum)</p>
          <p className="font-medium">
            {data.partitionsQuorum} / {data.partitions}
          </p>
        </div>
      </div>
    </div>
  )
}

/**
 * Usage bar for a data/metadata partition. Garage reports null for nodes
 * that are down or have no role yet, in which case we show a placeholder
 * instead of crashing on `.total`.
 */
function PartitionBar({
  label,
  partition,
  color,
}: {
  label: string
  partition: PartitionUsage | null | undefined
  color: string
}) {
  if (!partition) {
    return (
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>{label}</span>
        <span>情報なし</span>
      </div>
    )
  }
  return (
    <ProgressBar
      label={label}
      used={partition.total - partition.available}
      total={partition.total}
      color={color}
    />
  )
}

function NodeStatusDot({ node }: { node: ClusterNode }) {
  const title = node.isUp
    ? '接続中'
    : node.lastSeenSecsAgo != null
      ? `切断中 (最終確認 ${Math.floor(node.lastSeenSecsAgo / 60)} 分前)`
      : '切断中'
  return (
    <span
      title={title}
      className={`inline-block h-2 w-2 rounded-full ${node.isUp ? 'bg-green-500' : 'bg-red-500'}`}
    />
  )
}

/**
 * Zone of the node's current role. Garage sets `draining` only for nodes whose
 * role was removed in a newer layout version while they still hold data, so
 * that state is shown explicitly instead of as a plain "unassigned".
 */
function ZoneBadge({ node }: { node: ClusterNode }) {
  if (!node.role) {
    return node.draining ? (
      <Badge variant="destructive" title="レイアウトから外されましたが、まだデータを保持しています">
        draining
      </Badge>
    ) : (
      <Badge variant="outline">ロール未割当</Badge>
    )
  }
  return <Badge variant="secondary">{node.role.zone}</Badge>
}

/**
 * Node name, linked to the node detail page. Nodes without a layout role are
 * not linked: Garage resolves `node=<id>` against the layout, so every
 * per-node request for them fails.
 */
function NodeName({ node }: { node: ClusterNode }) {
  if (!node.role) return <span className="font-medium">{nodeDisplayName(node)}</span>
  return (
    <Link to="/nodes/$id" params={{ id: node.id }} className="font-medium hover:underline">
      {nodeDisplayName(node)}
    </Link>
  )
}

function NodeCard({ node }: { node: ClusterNode }) {
  return (
    <div className="rounded-lg border p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <NodeStatusDot node={node} />
          <NodeName node={node} />
        </div>
        <div className="flex gap-2">
          <Badge variant="outline">{node.garageVersion ?? '不明'}</Badge>
          <ZoneBadge node={node} />
        </div>
      </div>
      <PartitionBar label="データ" partition={node.dataPartition} color="bg-blue-500" />
      <PartitionBar label="メタデータ" partition={node.metadataPartition} color="bg-purple-500" />
    </div>
  )
}

function NodeTableRow({ node }: { node: ClusterNode }) {
  return (
    <TableRow>
      <TableCell>
        <div className="flex items-center gap-2">
          <NodeStatusDot node={node} />
          <NodeName node={node} />
        </div>
      </TableCell>
      <TableCell className="text-muted-foreground">{node.garageVersion ?? '不明'}</TableCell>
      <TableCell className="text-muted-foreground">
        <ZoneBadge node={node} />
      </TableCell>
      <TableCell className="min-w-[200px]">
        <PartitionBar label="データ" partition={node.dataPartition} color="bg-blue-500" />
      </TableCell>
      <TableCell className="min-w-[200px]">
        <PartitionBar label="メタデータ" partition={node.metadataPartition} color="bg-purple-500" />
      </TableCell>
    </TableRow>
  )
}

function HealthSkeleton() {
  return (
    <div className="rounded-lg border p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-5 w-16 rounded-full" />
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="space-y-1">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-5 w-24" />
          </div>
        ))}
      </div>
    </div>
  )
}

function NodesSkeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="rounded-lg border p-4 space-y-3">
          <div className="flex items-center justify-between">
            <Skeleton className="h-5 w-32" />
            <div className="flex gap-2">
              <Skeleton className="h-5 w-16 rounded-full" />
              <Skeleton className="h-5 w-12 rounded-full" />
            </div>
          </div>
          <Skeleton className="h-1.5 w-full rounded-full" />
          <Skeleton className="h-1.5 w-full rounded-full" />
        </div>
      ))}
    </div>
  )
}

/** One summary tile. `title` becomes a native tooltip. */
function SummaryCard({
  label,
  value,
  sub,
  title,
}: {
  label: string
  value: string
  sub?: string
  title?: string
}) {
  return (
    <div className="rounded-lg border p-4" title={title}>
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="text-xl font-semibold tabular-nums">{value}</p>
      {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
    </div>
  )
}

function SummaryCardSkeleton({ label }: { label: string }) {
  return (
    <div className="rounded-lg border p-4 space-y-2">
      <p className="text-sm text-muted-foreground">{label}</p>
      <Skeleton className="h-6 w-24" />
    </div>
  )
}

const INCOMPLETE_AVAIL_HINT =
  '一部のストレージノードが空き容量を報告していないため、実際の空き容量とは異なる可能性があります (incompleteAvailInfo)'

/** Free space, prefixed with "~" when Garage flags the value as incomplete. */
function availValue(bytes: number | null | undefined, incomplete: boolean): string {
  if (bytes == null) return '-'
  return `${incomplete ? '~' : ''}${formatBytes(bytes)}`
}

/** The subset of a useQuery result the presentational sections need. */
interface QueryView<T> {
  data?: T
  isLoading: boolean
  isError: boolean
  error: Error | null
}

const KEY_TILE_LABEL = 'キー数 (有効 / 総数)'

function KeyCountCard({ keys }: { keys: QueryView<ListResult<KeyListItem>> }) {
  if (keys.isLoading) return <SummaryCardSkeleton label={KEY_TILE_LABEL} />
  if (keys.isError || !keys.data) {
    return (
      <SummaryCard
        label={KEY_TILE_LABEL}
        value="-"
        sub={`取得失敗: ${keys.error?.message ?? '不明なエラー'}`}
      />
    )
  }
  const { items, truncated } = keys.data
  const valid = items.filter((k) => !k.expired).length
  return (
    <SummaryCard
      label={KEY_TILE_LABEL}
      value={`${formatCount(valid)} / ${formatCount(items.length)}${truncated ? '+' : ''}`}
      sub={truncated ? '一覧が上限で打ち切られています' : `期限切れ ${formatCount(items.length - valid)}`}
    />
  )
}

function SummaryCards({
  stats,
  keys,
}: {
  stats: QueryView<ClusterStatistics>
  keys: QueryView<ListResult<KeyListItem>>
}) {
  const s = stats.data
  const incomplete = s?.incompleteAvailInfo === true
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        {stats.isLoading
          ? ['データ空き', 'メタデータ空き', 'バケット数', '総オブジェクト'].map((label) => (
              <SummaryCardSkeleton key={label} label={label} />
            ))
          : s && (
              <>
                <SummaryCard
                  label="データ空き"
                  value={availValue(s.dataAvail, incomplete)}
                  sub={incomplete ? '不完全な値 (一部ノード未報告)' : 'クラスタ全体の推定値'}
                  title={incomplete ? INCOMPLETE_AVAIL_HINT : undefined}
                />
                <SummaryCard
                  label="メタデータ空き"
                  value={availValue(s.metadataAvail, incomplete)}
                  sub={incomplete ? '不完全な値 (一部ノード未報告)' : 'クラスタ全体の推定値'}
                  title={incomplete ? INCOMPLETE_AVAIL_HINT : undefined}
                />
                <SummaryCard label="バケット数" value={formatCount(s.bucketCount)} />
                {/* Garage omits the object totals for clusters with > 1000 buckets. */}
                {s.totalObjectCount != null && (
                  <SummaryCard
                    label="総オブジェクト"
                    value={formatCount(s.totalObjectCount)}
                    sub={s.totalObjectBytes != null ? formatBytes(s.totalObjectBytes) : undefined}
                  />
                )}
              </>
            )}
        <KeyCountCard keys={keys} />
      </div>
      {stats.isError && (
        <p className="text-sm text-destructive">
          クラスタ統計を読み込めませんでした: {stats.error?.message ?? '不明なエラー'}
        </p>
      )}
    </div>
  )
}

/** A count that turns destructive when > 0 (errors, corruptions). */
function HealthMetric({
  label,
  value,
  alertWhenPositive = false,
}: {
  label: string
  value: number | null
  alertWhenPositive?: boolean
}) {
  const alert = alertWhenPositive && value != null && value > 0
  return (
    <div className="flex justify-between gap-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className={`tabular-nums ${alert ? 'font-semibold text-destructive' : ''}`}>
        {formatCount(value)}
      </span>
    </div>
  )
}

/** Garage reports "never" or an RFC 3339 timestamp. */
function formatScrubLastCompleted(v: string | null): string {
  if (v == null) return '-'
  if (v === 'never') return '未実行'
  return formatDateTime(v)
}

const EMPTY_NODE_HEALTH: NodeStorageHealth = {
  resyncQueueLen: null,
  resyncErrors: null,
  scrubCorruptions: null,
  scrubLastCompleted: null,
}

/**
 * Nodes that hold blocks: a current role with capacity, or draining (role
 * removed in a newer layout but still holding data, which is exactly when
 * its resync queue matters).
 */
function isStorageNode(node: ClusterNode): boolean {
  return node.role ? node.role.capacity != null : node.draining
}

/** Error text for one node: its own error, else the failed fan-out(s), else "no answer". */
function nodeHealthError(health: StorageHealth, node: ClusterNode): string | undefined {
  const entry = health.nodes[node.id]
  const msgs = [entry?.error, health.statsError, health.varsError].filter(Boolean)
  if (msgs.length > 0) return msgs.join('; ')
  return entry ? undefined : 'ノードが応答しませんでした'
}

function StorageHealthCard({ node, health }: { node: ClusterNode; health: StorageHealth }) {
  const h = health.nodes[node.id] ?? EMPTY_NODE_HEALTH
  const error = nodeHealthError(health, node)
  const alert = (h.resyncErrors ?? 0) > 0 || (h.scrubCorruptions ?? 0) > 0
  const body = (
    <>
      <div className="flex items-center gap-2">
        <NodeStatusDot node={node} />
        <span className="font-medium">{nodeDisplayName(node)}</span>
        {!node.role && node.draining && (
          <Badge variant="destructive" title="レイアウトから外されましたが、まだデータを保持しています">
            draining
          </Badge>
        )}
      </div>
      <HealthMetric label="Resync キュー" value={h.resyncQueueLen} />
      <HealthMetric label="Resync エラー" value={h.resyncErrors} alertWhenPositive />
      <HealthMetric label="Scrub 破損検出数" value={h.scrubCorruptions} alertWhenPositive />
      <div className="flex justify-between gap-2 text-sm">
        <span className="text-muted-foreground">最終 Scrub</span>
        <span title={h.scrubLastCompleted ?? undefined}>
          {formatScrubLastCompleted(h.scrubLastCompleted)}
        </span>
      </div>
      {error && <p className="break-words text-xs text-destructive">{error}</p>}
    </>
  )
  const className = `block rounded-lg border p-4 space-y-2 ${alert ? 'border-destructive/60' : ''}`
  // Same rule as NodeName: role-less (draining) nodes have no detail page.
  if (!node.role) return <div className={className}>{body}</div>
  return (
    <Link
      to="/nodes/$id"
      params={{ id: node.id }}
      className={`${className} transition-colors hover:bg-muted/50`}
    >
      {body}
    </Link>
  )
}

function StorageHealthSection({
  status,
  query,
}: {
  status: QueryView<{ nodes: ClusterNode[] }>
  query: QueryView<StorageHealth>
}) {
  const nodes = status.data?.nodes.filter(isStorageNode) ?? []
  return (
    <div className="space-y-3">
      <h2 className="text-lg font-semibold">Storage health</h2>
      {query.isLoading || status.isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-36 w-full rounded-lg" />
          ))}
        </div>
      ) : query.isError || !query.data ? (
        <p className="text-destructive">
          Storage health を読み込めませんでした: {query.error?.message ?? '不明なエラー'}
        </p>
      ) : !status.data ? (
        // The node list comes from the cluster status, whose error is shown below.
        <p className="text-muted-foreground">ノード一覧が無いため表示できません</p>
      ) : nodes.length === 0 ? (
        <p className="text-muted-foreground">ストレージノードがありません</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {nodes.map((n) => (
            <StorageHealthCard key={n.id} node={n} health={query.data!} />
          ))}
        </div>
      )}
    </div>
  )
}

/** 「最終更新: N秒前」, re-rendered every second. */
function UpdatedAgo({ at }: { at: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  return (
    <span className="text-sm text-muted-foreground" title={new Date(at).toLocaleString('ja-JP')}>
      最終更新: {formatSecsAgo(Math.max(0, (now - at) / 1000))}
    </span>
  )
}

function DashboardPage() {
  const polling = { refetchInterval: STATUS_REFETCH_MS, refetchIntervalInBackground: false }

  const health = useQuery({
    queryKey: ['cluster', 'health'],
    queryFn: getClusterHealth,
    ...polling,
  })

  const status = useQuery({
    queryKey: ['cluster', 'status'],
    queryFn: getClusterStatus,
    ...polling,
  })

  const storageHealth = useQuery({
    queryKey: ['cluster', 'storage-health'],
    queryFn: getStorageHealth,
    ...polling,
  })

  const statistics = useQuery({
    queryKey: ['cluster', 'statistics'],
    queryFn: getClusterStatistics,
    refetchInterval: STATISTICS_REFETCH_MS,
    refetchIntervalInBackground: false,
  })

  // The key list fans out per key on the backend, so it is not polled; the
  // 更新 button refreshes it. Shares the cache with the keys page.
  const keys = useQuery({ queryKey: ['keys'], queryFn: listKeys })

  // Latest successful fetch of the 15 s group (health / status / storage
  // health); the slower statistics poll does not hold it back.
  const updatedAt = Math.max(health.dataUpdatedAt, status.dataUpdatedAt, storageHealth.dataUpdatedAt)

  // Manual refresh: everything under ['cluster'] (including the layout
  // history behind the tracker) plus the key list. The spinner reflects only
  // this, not background polling.
  const queryClient = useQueryClient()
  const [refreshing, setRefreshing] = useState(false)
  const refreshAll = async () => {
    setRefreshing(true)
    try {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['cluster'] }),
        queryClient.invalidateQueries({ queryKey: ['keys'] }),
      ])
    } finally {
      setRefreshing(false)
    }
  }

  // GetClusterStatus roles are the current layout's, which is all the
  // tracker needs (ID + whether the node stores data).
  const trackerRoles = (status.data?.nodes ?? []).flatMap((n) =>
    n.role ? [{ id: n.id, capacity: n.role.capacity }] : [],
  )

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">ダッシュボード</h1>
        <div className="flex items-center gap-3">
          {updatedAt > 0 && <UpdatedAgo at={updatedAt} />}
          <Button variant="outline" size="sm" onClick={refreshAll} disabled={refreshing}>
            <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} aria-hidden />
            更新
          </Button>
        </div>
      </div>

      {status.data && <LayoutUpdateTracker roles={trackerRoles} compact />}

      {health.isLoading ? (
        <HealthSkeleton />
      ) : health.isError ? (
        <p className="text-destructive">
          クラスタの状態を読み込めませんでした: {health.error.message}
        </p>
      ) : (
        <HealthCard data={health.data!} />
      )}

      <SummaryCards stats={statistics} keys={keys} />

      <StorageHealthSection status={status} query={storageHealth} />

      <div className="space-y-3">
        <h2 className="text-lg font-semibold">ノード</h2>
        {status.isLoading ? (
          <NodesSkeleton />
        ) : status.isError ? (
          <p className="text-destructive">
            クラスタのステータスを読み込めませんでした: {status.error.message}
          </p>
        ) : (
          <>
            {/* Mobile: card layout */}
            <div className="space-y-3 md:hidden">
              {status.data!.nodes.map((node) => (
                <NodeCard key={node.id} node={node} />
              ))}
            </div>

            {/* Desktop: table layout */}
            <div className="hidden md:block rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>ホスト名</TableHead>
                    <TableHead>バージョン</TableHead>
                    <TableHead>ゾーン</TableHead>
                    <TableHead>データ</TableHead>
                    <TableHead>メタデータ</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {status.data!.nodes.map((node) => (
                    <NodeTableRow key={node.id} node={node} />
                  ))}
                </TableBody>
              </Table>
            </div>
          </>
        )}
      </div>

      {status.data && (
        <Suspense fallback={<p className="text-muted-foreground">チャートを読み込み中...</p>}>
          <StorageCharts
            nodes={status.data.nodes}
            incompleteAvailInfo={statistics.data?.incompleteAvailInfo === true}
          />
        </Suspense>
      )}

    </div>
  )
}

