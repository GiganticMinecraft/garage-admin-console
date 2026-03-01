import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { getKey } from '@/api'
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

export const Route = createFileRoute('/keys/$id')({
  component: KeyDetailPage,
})

interface KeyDetail {
  accessKeyId: string
  name: string
  created: string
  expiration: string | null
  expired: boolean
  permissions: { createBucket: boolean }
  buckets: {
    id: string
    globalAliases: string[]
    localAliases: string[]
    permissions: { read: boolean; write: boolean; owner: boolean }
  }[]
}

function KeyDetailPage() {
  const { id } = Route.useParams()

  const key = useQuery({
    queryKey: ['key', id],
    queryFn: () => getKey(id) as unknown as Promise<KeyDetail>,
  })

  const data = key.data

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Link to="/keys" className="hover:underline">Keys</Link>
        <span>/</span>
        <span>{data?.name || id}</span>
      </div>

      <h1 className="text-2xl font-bold">{data?.name || 'Key Detail'}</h1>

      {key.isLoading ? (
        <div className="rounded-lg border p-4 space-y-3">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="space-y-1">
                <Skeleton className="h-4 w-20" />
                <Skeleton className="h-5 w-28" />
              </div>
            ))}
          </div>
        </div>
      ) : key.isError ? (
        <p className="text-destructive">Failed to load key</p>
      ) : data ? (
        <>
          <div className="rounded-lg border p-4 space-y-3">
            <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
              <div>
                <p className="text-muted-foreground">Access Key ID</p>
                <p className="font-mono text-xs break-all">{data.accessKeyId}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Created</p>
                <p className="font-medium">{new Date(data.created).toLocaleString()}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Expiration</p>
                <p className="font-medium">
                  {data.expiration ? new Date(data.expiration).toLocaleString() : 'None'}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground">Permissions</p>
                <div className="flex gap-1">
                  {data.permissions.createBucket && (
                    <Badge variant="outline">createBucket</Badge>
                  )}
                  {!data.permissions.createBucket && (
                    <span className="text-muted-foreground">-</span>
                  )}
                </div>
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <h2 className="text-lg font-semibold">Buckets</h2>
            {data.buckets.length === 0 ? (
              <p className="text-muted-foreground text-sm">No buckets associated</p>
            ) : (
              <div className="rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Bucket</TableHead>
                      <TableHead>Permissions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.buckets.map((bucket) => (
                      <TableRow key={bucket.id}>
                        <TableCell>
                          <Link
                            to="/buckets/$id"
                            params={{ id: bucket.id }}
                            className="text-primary underline-offset-4 hover:underline"
                          >
                            {bucket.globalAliases?.[0] || bucket.id.slice(0, 16) + '...'}
                          </Link>
                        </TableCell>
                        <TableCell>
                          <div className="flex gap-1">
                            {bucket.permissions.read && <Badge variant="outline">read</Badge>}
                            {bucket.permissions.write && <Badge variant="outline">write</Badge>}
                            {bucket.permissions.owner && <Badge variant="outline">owner</Badge>}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        </>
      ) : null}
    </div>
  )
}
