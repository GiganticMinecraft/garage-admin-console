import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, useCallback } from 'react'
import {
  getBucket,
  grantBucketKey,
  revokeBucketKey,
} from '@/api'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { ObjectBrowser } from '@/components/object-browser'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Checkbox } from '@/components/ui/checkbox'
import { toast } from 'sonner'
import { Copy, Check } from 'lucide-react'

export const Route = createFileRoute('/buckets/$id')({
  component: BucketDetailPage,
  validateSearch: (search: Record<string, unknown>): { prefix?: string } => ({
    prefix: (search.prefix as string) || undefined,
  }),
})

interface BucketDetail {
  id: string
  globalAliases?: string[]
  websiteAccess?: boolean
  websiteConfig?: { indexDocument: string; errorDocument: string } | null
  keys?: {
    accessKeyId: string
    name: string
    permissions: { read: boolean; write: boolean; owner: boolean }
  }[]
  objects?: number
  bytes?: number
  unfinishedUploads?: number
  unfinishedUploadBytes?: number
  quotas?: { maxSize: number | null; maxObjects: number | null }
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
}

function BucketDetailPage() {
  const { id } = Route.useParams()
  const { prefix: rawPrefix } = Route.useSearch()
  const prefix = rawPrefix ?? ''
  const navigate = useNavigate()
  const queryClient = useQueryClient()
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
  const [revokeTarget, setRevokeTarget] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const bucket = useQuery({
    queryKey: ['bucket', id],
    queryFn: () => getBucket(id) as unknown as Promise<BucketDetail>,
  })

  // Key grant state
  const [grantKeyId, setGrantKeyId] = useState('')
  const [grantPermissions, setGrantPermissions] = useState({
    read: true,
    write: false,
    owner: false,
  })
  const grantMutation = useMutation({
    mutationFn: (accessKeyId: string) =>
      grantBucketKey(id, {
        accessKeyId,
        permissions: grantPermissions,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bucket', id] })
      setGrantKeyId('')
      setGrantPermissions({ read: true, write: false, owner: false })
      toast.success('キーを付与しました')
    },
    onError: (error: Error) => {
      toast.error(`キーの付与に失敗: ${error.message}`)
    },
  })

  const revokeMutation = useMutation({
    mutationFn: (keyId: string) => revokeBucketKey(id, keyId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bucket', id] })
      setRevokeTarget(null)
      toast.success('キーを取り消しました')
    },
    onError: (error) => {
      toast.error(`キーの取り消しに失敗しました: ${error.message}`)
    },
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
      <div className="space-y-2">
        <h2 className="text-lg font-semibold">キーの権限</h2>
        <div className="space-y-2">
          <div className="flex gap-2">
            <Input
              value={grantKeyId}
              onChange={(e) => setGrantKeyId(e.target.value)}
              placeholder="アクセスキー ID"
              className="flex-1"
            />
            <Button
              size="sm"
              onClick={() => grantMutation.mutate(grantKeyId)}
              disabled={!grantKeyId || grantMutation.isPending}
            >
              付与
            </Button>
          </div>
          <div className="flex items-center gap-4">
            {(['read', 'write', 'owner'] as const).map((perm) => (
              <label key={perm} className="flex items-center gap-1.5 text-sm">
                <Checkbox
                  checked={grantPermissions[perm]}
                  onCheckedChange={(checked) =>
                    setGrantPermissions((prev) => ({ ...prev, [perm]: !!checked }))
                  }
                />
                {perm}
              </label>
            ))}
          </div>
        </div>
        {data?.keys?.map((k) => (
          <div key={k.accessKeyId} className="flex items-center justify-between rounded border px-3 py-2 text-sm">
            <div className="flex items-center gap-2">
              <span className="font-mono">{k.accessKeyId}</span>
              {k.name && <span className="text-muted-foreground">({k.name})</span>}
              <div className="flex gap-1">
                {k.permissions.read && <Badge variant="outline">read</Badge>}
                {k.permissions.write && <Badge variant="outline">write</Badge>}
                {k.permissions.owner && <Badge variant="outline">owner</Badge>}
              </div>
            </div>
            <Button
              variant="link"
              size="sm"
              className="text-destructive"
              onClick={() => setRevokeTarget(k.accessKeyId)}
            >
              取り消し
            </Button>
          </div>
        ))}
      </div>

      {/* Object Browser */}
      <ObjectBrowser
        bucketId={id}
        bucketName={data?.globalAliases?.[0]}
        prefix={prefix}
        onPrefixChange={setPrefix}
      />

      <ConfirmDialog
        open={revokeTarget !== null}
        onOpenChange={(open) => { if (!open) setRevokeTarget(null) }}
        title="キーの取り消し"
        description={`キー「${revokeTarget}」のアクセス権限を取り消しますか？`}
        confirmLabel="取り消し"
        pendingLabel="取り消し中..."
        onConfirm={() => {
          if (revokeTarget) return revokeMutation.mutateAsync(revokeTarget)
        }}
        isPending={revokeMutation.isPending}
      />
    </div>
  )
}
