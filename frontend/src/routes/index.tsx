import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { getClusterHealth, getClusterStatus } from '@/api'

export const Route = createFileRoute('/')({
  component: DashboardPage,
})

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

      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-lg border p-4">
          <h2 className="mb-2 text-lg font-semibold">Cluster Health</h2>
          {health.isLoading ? (
            <p className="text-muted-foreground">Loading...</p>
          ) : health.isError ? (
            <p className="text-destructive">Failed to load</p>
          ) : (
            <pre className="overflow-auto rounded bg-muted p-2 text-sm">
              {JSON.stringify(health.data, null, 2)}
            </pre>
          )}
        </div>

        <div className="rounded-lg border p-4">
          <h2 className="mb-2 text-lg font-semibold">Cluster Status</h2>
          {status.isLoading ? (
            <p className="text-muted-foreground">Loading...</p>
          ) : status.isError ? (
            <p className="text-destructive">Failed to load</p>
          ) : (
            <pre className="overflow-auto rounded bg-muted p-2 text-sm">
              {JSON.stringify(status.data, null, 2)}
            </pre>
          )}
        </div>
      </div>
    </div>
  )
}
