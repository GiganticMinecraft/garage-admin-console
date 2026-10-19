import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { getKey } from '@/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CopyButton } from '@/components/copy-button'
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

function KeyDetailPage() {
  const { id } = Route.useParams()
  const queryClient = useQueryClient()
  // The route component is reused across /keys/:id navigations, so the
  // "revealed" flag is tied to the key id: a secret revealed for one key is
  // never carried over to the next one.
  const [revealedFor, setRevealedFor] = useState<string | null>(null)
  const showSecret = revealedFor === id

  // Evict any fetched secret from the cache when leaving this key.
  useEffect(() => {
    return () => {
      queryClient.removeQueries({ queryKey: ['key', id, 'secret'] })
    }
  }, [id, queryClient])

  const key = useQuery({
    queryKey: ['key', id],
    queryFn: () => getKey(id),
  })

  // The secret is fetched separately and only on demand. Hiding it evicts
  // the cached value (see toggleSecret), so re-showing re-authorizes against
  // the backend instead of serving a cached copy.
  const secret = useQuery({
    queryKey: ['key', id, 'secret'],
    queryFn: () => getKey(id, { showSecretKey: true }),
    enabled: showSecret,
    staleTime: Infinity,
    gcTime: 0,
  })

  const toggleSecret = () => {
    if (showSecret) {
      setRevealedFor(null)
      queryClient.removeQueries({ queryKey: ['key', id, 'secret'] })
    } else {
      setRevealedFor(id)
    }
  }

  const data = key.data

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Link to="/keys" className="hover:underline">キー</Link>
        <span>/</span>
        <span>{data?.name || id}</span>
      </div>

      <h1 className="text-2xl font-bold">{data?.name || 'キー詳細'}</h1>

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
        <p className="text-destructive">キーの読み込みに失敗しました</p>
      ) : data ? (
        <>
          <div className="rounded-lg border p-4 space-y-3">
            <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
              <div>
                <p className="text-muted-foreground">アクセスキー ID</p>
                <div className="flex items-center gap-1">
                  <p className="font-mono text-xs break-all">{data.accessKeyId}</p>
                  <CopyButton value={data.accessKeyId} label="アクセスキー ID をコピー" />
                </div>
              </div>
              <div>
                <p className="text-muted-foreground">作成日時</p>
                <p className="font-medium">{new Date(data.created).toLocaleString()}</p>
              </div>
              <div>
                <p className="text-muted-foreground">有効期限</p>
                <p className="font-medium">
                  {data.expiration ? new Date(data.expiration).toLocaleString() : 'なし'}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground">権限</p>
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
            <div className="text-sm">
              <p className="text-muted-foreground">シークレットアクセスキー</p>
              <div className="flex items-center gap-1">
                {showSecret ? (
                  secret.isLoading ? (
                    <span className="text-muted-foreground">読み込み中...</span>
                  ) : secret.isError ? (
                    <span className="text-destructive">シークレットを取得できませんでした</span>
                  ) : (
                    <>
                      <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs break-all">
                        {secret.data?.secretAccessKey ?? '(取得できませんでした)'}
                      </code>
                      {secret.data?.secretAccessKey && (
                        <CopyButton value={secret.data.secretAccessKey} label="シークレットアクセスキーをコピー" />
                      )}
                    </>
                  )
                ) : (
                  <span className="font-mono text-xs text-muted-foreground">••••••••••••••••</span>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 gap-1 px-2 text-xs"
                  onClick={toggleSecret}
                >
                  {showSecret ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  {showSecret ? '隠す' : 'シークレットを表示'}
                </Button>
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <h2 className="text-lg font-semibold">バケット</h2>
            {data.buckets.length === 0 ? (
              <p className="text-muted-foreground text-sm">関連付けられたバケットはありません</p>
            ) : (
              <div className="rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>バケット</TableHead>
                      <TableHead>権限</TableHead>
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
