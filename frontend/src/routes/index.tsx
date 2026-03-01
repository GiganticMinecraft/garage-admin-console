import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import {
  getClusterHealth,
  getClusterStatus,
  type ClusterHealth,
  type ClusterNode,
} from '@/api'

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

function HealthCard({ data }: { data: ClusterHealth }) {
  const isHealthy = data.status === 'healthy'
  return (
    <div className="rounded-lg border p-4 space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="text-lg font-semibold">Cluster Health</h2>
        <span
          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
            isHealthy
              ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
              : 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200'
          }`}
        >
          {data.status}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-3 text-sm">
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

function NodeRow({ node }: { node: ClusterNode }) {
  const dataUsed = node.dataPartition.total - node.dataPartition.available
  const dataPercent = (dataUsed / node.dataPartition.total) * 100
  const metaUsed =
    node.metadataPartition.total - node.metadataPartition.available
  const metaPercent = (metaUsed / node.metadataPartition.total) * 100

  return (
    <tr className="border-t">
      <td className="py-2 px-3">
        <div className="flex items-center gap-2">
          <span
            className={`inline-block h-2 w-2 rounded-full ${node.isUp ? 'bg-green-500' : 'bg-red-500'}`}
          />
          <span className="font-medium">{node.hostname}</span>
        </div>
      </td>
      <td className="py-2 px-3 text-muted-foreground">{node.garageVersion}</td>
      <td className="py-2 px-3 text-muted-foreground">{node.role.zone}</td>
      <td className="py-2 px-3">
        <div className="space-y-1">
          <div className="flex justify-between text-xs">
            <span>Data</span>
            <span>
              {formatBytes(dataUsed)} / {formatBytes(node.dataPartition.total)} ({dataPercent.toFixed(1)}%)
            </span>
          </div>
          <div className="h-1.5 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full rounded-full bg-blue-500"
              style={{ width: `${dataPercent}%` }}
            />
          </div>
        </div>
      </td>
      <td className="py-2 px-3">
        <div className="space-y-1">
          <div className="flex justify-between text-xs">
            <span>Metadata</span>
            <span>
              {formatBytes(metaUsed)} / {formatBytes(node.metadataPartition.total)} ({metaPercent.toFixed(1)}%)
            </span>
          </div>
          <div className="h-1.5 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full rounded-full bg-purple-500"
              style={{ width: `${metaPercent}%` }}
            />
          </div>
        </div>
      </td>
    </tr>
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
        <p className="text-muted-foreground">Loading...</p>
      ) : health.isError ? (
        <p className="text-destructive">Failed to load cluster health</p>
      ) : (
        <HealthCard data={health.data!} />
      )}

      <div className="rounded-lg border p-4 space-y-3">
        <h2 className="text-lg font-semibold">Nodes</h2>
        {status.isLoading ? (
          <p className="text-muted-foreground">Loading...</p>
        ) : status.isError ? (
          <p className="text-destructive">Failed to load cluster status</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-2 px-3 font-medium">Hostname</th>
                  <th className="py-2 px-3 font-medium">Version</th>
                  <th className="py-2 px-3 font-medium">Zone</th>
                  <th className="py-2 px-3 font-medium">Data</th>
                  <th className="py-2 px-3 font-medium">Metadata</th>
                </tr>
              </thead>
              <tbody>
                {status.data!.nodes.map((node) => (
                  <NodeRow key={node.id} node={node} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
