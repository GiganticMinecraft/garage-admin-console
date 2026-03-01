import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import {
  getClusterHealth,
  getClusterStatus,
  type ClusterHealth,
  type ClusterNode,
} from '@/api'
import { Badge } from '@/components/ui/badge'
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
        <h2 className="text-lg font-semibold">Cluster Health</h2>
        <Badge variant={isHealthy ? 'secondary' : 'destructive'}>
          {data.status}
        </Badge>
      </div>
      <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
        <div>
          <p className="text-muted-foreground">Nodes</p>
          <p className="font-medium">
            {data.connectedNodes} / {data.knownNodes} connected
          </p>
        </div>
        <div>
          <p className="text-muted-foreground">Storage Nodes</p>
          <p className="font-medium">
            {data.storageNodesUp} / {data.storageNodes} up
          </p>
        </div>
        <div>
          <p className="text-muted-foreground">Partitions</p>
          <p className="font-medium">{data.partitions}</p>
        </div>
        <div>
          <p className="text-muted-foreground">Partitions (quorum)</p>
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
        label="Data"
        used={dataUsed}
        total={node.dataPartition.total}
        color="bg-blue-500"
      />
      <ProgressBar
        label="Metadata"
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
          label="Data"
          used={dataUsed}
          total={node.dataPartition.total}
          color="bg-blue-500"
        />
      </TableCell>
      <TableCell className="min-w-[200px]">
        <ProgressBar
          label="Metadata"
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
      <h1 className="text-2xl font-bold">Dashboard</h1>

      {health.isLoading ? (
        <HealthSkeleton />
      ) : health.isError ? (
        <p className="text-destructive">Failed to load cluster health</p>
      ) : (
        <HealthCard data={health.data!} />
      )}

      <div className="space-y-3">
        <h2 className="text-lg font-semibold">Nodes</h2>
        {status.isLoading ? (
          <NodesSkeleton />
        ) : status.isError ? (
          <p className="text-destructive">Failed to load cluster status</p>
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
                    <TableHead>Hostname</TableHead>
                    <TableHead>Version</TableHead>
                    <TableHead>Zone</TableHead>
                    <TableHead>Data</TableHead>
                    <TableHead>Metadata</TableHead>
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
    </div>
  )
}
