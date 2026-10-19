import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useState, useCallback } from 'react'
import {
  getBucket,
} from '@/api'
import { BucketKeyPermissions } from '@/components/bucket-key-permissions'
import { BucketSettings } from '@/components/bucket-settings'
import { ObjectBrowser } from '@/components/object-browser'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { formatBytes } from '@/lib/format'
import { toast } from 'sonner'
import { Copy, Check } from 'lucide-react'

export const Route = createFileRoute('/buckets/$id')({
  component: BucketDetailPage,
  validateSearch: (search: Record<string, unknown>): { prefix?: string } => ({
    prefix: (search.prefix as string) || undefined,
  }),
})

function BucketDetailPage() {
  const { id } = Route.useParams()
  const { prefix: rawPrefix } = Route.useSearch()
  const prefix = rawPrefix ?? ''
  const navigate = useNavigate()
  const setPrefix = useCallback(
    (newPrefix: string) => {
      navigate({
        to: '/buckets/$id',
        params: { id },
        search: { prefix: newPrefix || undefined },
        replace: true,
      })
    },
    [navigate, id],
  )
  const [copied, setCopied] = useState(false)

  const bucket = useQuery({
    queryKey: ['bucket', id],
    queryFn: () => getBucket(id),
  })

  const data = bucket.data

  const handleCopyId = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(data?.id ?? id)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error('クリップボードへのコピーに失敗しました')
    }
  }, [data, id])

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Link to="/buckets" className="hover:underline">バケット</Link>
        <span>/</span>
        <span>{data?.globalAliases?.[0] || `${id.slice(0, 16)}...`}</span>
      </div>

      <h1 className="text-2xl font-bold">
        {data?.globalAliases?.[0] || 'バケット詳細'}
      </h1>

      {bucket.isLoading ? (
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
      ) : bucket.isError ? (
        <p className="text-destructive">バケットの読み込みに失敗しました</p>
      ) : data ? (
        <div className="rounded-lg border p-4 space-y-3">
          <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
            <div>
              <p className="text-muted-foreground">エイリアス</p>
              <div className="flex flex-wrap gap-1">
                {data.globalAliases?.length
                  ? data.globalAliases.map((a) => (
                      <Badge key={a} variant="secondary">{a}</Badge>
                    ))
                  : <span className="text-muted-foreground">-</span>}
              </div>
            </div>
            <div>
              <p className="text-muted-foreground">オブジェクト数</p>
              <p className="font-medium">{data.objects ?? '-'}</p>
            </div>
            <div>
              <p className="text-muted-foreground">サイズ</p>
              <p className="font-medium">
                {data.bytes != null ? formatBytes(data.bytes) : '-'}
              </p>
            </div>
          </div>
          <div className="text-sm">
            <p className="text-muted-foreground">ID</p>
            <div className="flex items-center gap-1.5">
              <p className="font-mono text-xs text-muted-foreground break-all">{data.id}</p>
              <button
                onClick={handleCopyId}
                className="shrink-0 text-muted-foreground hover:text-foreground"
                title="IDをコピー"
              >
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              </button>
            </div>
          </div>
          {data.quotas && (data.quotas.maxSize || data.quotas.maxObjects) && (
            <div className="text-sm">
              <p className="text-muted-foreground">クォータ</p>
              <p>
                {data.quotas.maxObjects != null && `最大オブジェクト数: ${data.quotas.maxObjects}`}
                {data.quotas.maxSize != null && ` / 最大サイズ: ${formatBytes(data.quotas.maxSize)}`}
              </p>
            </div>
          )}
        </div>
      ) : null}

      {/* Key Permissions */}
      <BucketKeyPermissions
        key={id}
        bucketId={id}
        bucketLabel={data?.globalAliases?.[0] || id.slice(0, 16)}
        keys={data?.keys}
      />

      {/* Object Browser */}
      <ObjectBrowser
        key={id}
        bucketId={id}
        bucketName={data?.globalAliases?.[0]}
        prefix={prefix}
        onPrefixChange={setPrefix}
      />

      {/* Bucket settings (quotas, website, CORS, lifecycle, unfinished uploads) */}
      {data && <BucketSettings key={id} bucket={data} />}
    </div>
  )
}
