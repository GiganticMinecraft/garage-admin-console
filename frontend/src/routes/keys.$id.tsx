import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { getKey } from '@/api'

export const Route = createFileRoute('/keys/$id')({
  component: KeyDetailPage,
})

function KeyDetailPage() {
  const { id } = Route.useParams()

  const key = useQuery({
    queryKey: ['key', id],
    queryFn: () => getKey(id),
  })

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Link to="/keys" className="hover:underline">Keys</Link>
        <span>/</span>
        <span>{id}</span>
      </div>

      <h1 className="text-2xl font-bold">Key Detail</h1>

      {key.isLoading ? (
        <p className="text-muted-foreground">Loading...</p>
      ) : key.isError ? (
        <p className="text-destructive">Failed to load key</p>
      ) : (
        <div className="rounded-lg border p-4">
          <pre className="overflow-auto text-sm">
            {JSON.stringify(key.data, null, 2)}
          </pre>
        </div>
      )}
    </div>
  )
}
