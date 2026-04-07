import { useState, lazy, Suspense } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useMutation } from '@tanstack/react-query'
import {
  getClusterHealth,
  getClusterStatus,
  launchRepair,
  type ClusterHealth,
  type ClusterNode,
  type RepairType,
  type ScrubCommand,
} from '@/api'

const StorageCharts = lazy(() => import('@/components/storage-charts'))
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
import { ConfirmDialog } from '@/components/confirm-dialog'
import { toast } from 'sonner'

export const Route = createFileRoute('/')({
  component: DashboardPage,
})

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let value = bytes
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value.toFixed(1)} ${units[i]}`
}

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
  const percent = (used / total) * 100
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

function NodeCard({ node }: { node: ClusterNode }) {
  const dataUsed = node.dataPartition.total - node.dataPartition.available
  const metaUsed = node.metadataPartition.total - node.metadataPartition.available

  return (
    <div className="rounded-lg border p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span
            className={`inline-block h-2 w-2 rounded-full ${node.isUp ? 'bg-green-500' : 'bg-red-500'}`}
          />
          <span className="font-medium">{node.hostname}</span>
        </div>
        <div className="flex gap-2">
          <Badge variant="outline">{node.garageVersion}</Badge>
          <Badge variant="secondary">{node.role.zone}</Badge>
        </div>
      </div>
      <ProgressBar
        label="データ"
        used={dataUsed}
        total={node.dataPartition.total}
        color="bg-blue-500"
      />
      <ProgressBar
        label="メタデータ"
        used={metaUsed}
        total={node.metadataPartition.total}
        color="bg-purple-500"
      />
    </div>
  )
}

function NodeTableRow({ node }: { node: ClusterNode }) {
  const dataUsed = node.dataPartition.total - node.dataPartition.available
  const metaUsed = node.metadataPartition.total - node.metadataPartition.available

  return (
    <TableRow>
      <TableCell>
        <div className="flex items-center gap-2">
          <span
            className={`inline-block h-2 w-2 rounded-full ${node.isUp ? 'bg-green-500' : 'bg-red-500'}`}
          />
          <span className="font-medium">{node.hostname}</span>
        </div>
      </TableCell>
      <TableCell className="text-muted-foreground">{node.garageVersion}</TableCell>
      <TableCell className="text-muted-foreground">{node.role.zone}</TableCell>
      <TableCell className="min-w-[200px]">
        <ProgressBar
          label="データ"
          used={dataUsed}
          total={node.dataPartition.total}
          color="bg-blue-500"
        />
      </TableCell>
      <TableCell className="min-w-[200px]">
        <ProgressBar
          label="メタデータ"
          used={metaUsed}
          total={node.metadataPartition.total}
          color="bg-purple-500"
        />
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

const REPAIR_OPTIONS: { value: string; label: string }[] = [
  { value: 'tables', label: 'テーブル修復' },
  { value: 'blocks', label: 'ブロック整合性検証' },
  { value: 'versions', label: 'バージョン修復' },
  { value: 'multipartUploads', label: 'マルチパートアップロード修復' },
  { value: 'blockRefs', label: 'ブロック参照修復' },
  { value: 'blockRc', label: 'ブロック参照カウント修復' },
  { value: 'rebalance', label: 'リバランス' },
  { value: 'aliases', label: 'エイリアス修復' },
  { value: 'clearResyncQueue', label: 'リシンクキューのクリア' },
]

const SCRUB_COMMANDS: { value: ScrubCommand; label: string }[] = [
  { value: 'start', label: '開始' },
  { value: 'pause', label: '一時停止' },
  { value: 'resume', label: '再開' },
  { value: 'cancel', label: 'キャンセル' },
]

function RepairSection() {
  const [selectedRepair, setSelectedRepair] = useState(REPAIR_OPTIONS[0].value)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [pendingRepairType, setPendingRepairType] = useState<RepairType | null>(null)

  const mutation = useMutation({
    mutationFn: (repairType: RepairType) => launchRepair(repairType),
    onSuccess: (resp) => {
      const successCount = Object.keys(resp.success).length
      const errorCount = Object.keys(resp.error).length
      if (errorCount > 0) {
        const errors = Object.entries(resp.error).map(([n, m]) => `${n.slice(0, 12)}…: ${m}`).join(', ')
        toast.error(`${errorCount}ノードでエラー: ${errors}`)
      }
      if (successCount > 0) {
        toast.success(`${successCount}ノードで操作を実行しました`)
      }
    },
    onError: () => toast.error('修復操作に失敗しました'),
  })

  const requestRepair = (repairType: RepairType) => {
    setPendingRepairType(repairType)
    setConfirmOpen(true)
  }

  return (
    <div className="rounded-lg border p-4 space-y-4">
      <h2 className="text-lg font-semibold">メンテナンス操作</h2>

      <div className="space-y-3">
        <div className="flex items-end gap-3">
          <div className="space-y-1 flex-1">
            <label htmlFor="repair-type" className="text-sm text-muted-foreground">
              修復操作
            </label>
            <select
              id="repair-type"
              value={selectedRepair}
              onChange={(e) => setSelectedRepair(e.target.value)}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            >
              {REPAIR_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
          <Button
            size="sm"
            disabled={mutation.isPending}
            onClick={() => requestRepair(selectedRepair as RepairType)}
          >
            実行
          </Button>
        </div>

        <div className="space-y-1">
          <p className="text-sm text-muted-foreground">Scrub 操作</p>
          <div className="flex gap-2 flex-wrap">
            {SCRUB_COMMANDS.map((cmd) => (
              <Button
                key={cmd.value}
                variant="outline"
                size="sm"
                disabled={mutation.isPending}
                onClick={() => requestRepair({ scrub: cmd.value })}
              >
                Scrub {cmd.label}
              </Button>
            ))}
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="メンテナンス操作の実行"
        description="この操作を全ノードに対して実行します。よろしいですか？"
        onConfirm={() => {
          if (pendingRepairType) mutation.mutate(pendingRepairType)
        }}
        isPending={mutation.isPending}
        confirmLabel="実行"
        pendingLabel="実行中..."
        confirmVariant="default"
      />
    </div>
  )
}

function DashboardPage() {
  const health = useQuery({
    queryKey: ['cluster', 'health'],
    queryFn: getClusterHealth,
  })

  const status = useQuery({
    queryKey: ['cluster', 'status'],
    queryFn: getClusterStatus,
  })

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">ダッシュボード</h1>

      {health.isLoading ? (
        <HealthSkeleton />
      ) : health.isError ? (
        <p className="text-destructive">クラスタの状態を読み込めませんでした</p>
      ) : (
        <HealthCard data={health.data!} />
      )}

      <div className="space-y-3">
        <h2 className="text-lg font-semibold">ノード</h2>
        {status.isLoading ? (
          <NodesSkeleton />
        ) : status.isError ? (
          <p className="text-destructive">クラスタのステータスを読み込めませんでした</p>
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
          <StorageCharts nodes={status.data.nodes} />
        </Suspense>
      )}

      <RepairSection />
    </div>
  )
}

