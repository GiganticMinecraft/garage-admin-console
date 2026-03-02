import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery, useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, useCallback } from 'react'
import {
  getBucket,
  listObjects,
  uploadFile,
  deleteObject,
  downloadObjectUrl,
  grantBucketKey,
  revokeBucketKey,
} from '@/api'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table'
import { Skeleton } from '@/components/ui/skeleton'
import { Checkbox } from '@/components/ui/checkbox'
import { toast } from 'sonner'
import { Folder } from 'lucide-react'

export const Route = createFileRoute('/buckets/$id')({
  component: BucketDetailPage,
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

function PrefixBreadcrumb({
  prefix,
  onNavigate,
}: {
  prefix: string
  onNavigate: (prefix: string) => void
}) {
  if (!prefix) return null
  const segments = prefix.split('/').filter(Boolean)
  return (
    <div className="flex items-center gap-1 text-sm text-muted-foreground">
      <button
        className="hover:underline"
        onClick={() => onNavigate('')}
      >
        /
      </button>
      {segments.map((seg, i) => {
        const path = segments.slice(0, i + 1).join('/') + '/'
        return (
          <span key={path} className="flex items-center gap-1">
            <span>/</span>
            <button
              className="hover:underline"
              onClick={() => onNavigate(path)}
            >
              {seg}
            </button>
          </span>
        )
      })}
    </div>
  )
}

function BucketDetailPage() {
  const { id } = Route.useParams()
  const queryClient = useQueryClient()
  const [prefix, setPrefix] = useState('')
  const [deleteObjectTarget, setDeleteObjectTarget] = useState<string | null>(null)
  const [revokeTarget, setRevokeTarget] = useState<string | null>(null)

  const bucket = useQuery({
    queryKey: ['bucket', id],
    queryFn: () => getBucket(id) as unknown as Promise<BucketDetail>,
  })

  const objects = useInfiniteQuery({
    queryKey: ['objects', id, prefix],
    queryFn: ({ pageParam }) =>
      listObjects(id, prefix || undefined, pageParam || undefined),
    initialPageParam: '' as string,
    getNextPageParam: (lastPage) =>
      lastPage.isTruncated ? lastPage.nextContinuationToken : undefined,
  })

  const allObjects = objects.data?.pages.flatMap((p) => p.objects) ?? []
  const allPrefixes = [
    ...new Set(objects.data?.pages.flatMap((p) => p.prefixes) ?? []),
  ]

  const uploadMutation = useMutation({
    mutationFn: (file: File) => uploadFile(id, file),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['objects', id] })
      toast.success('アップロードしました')
    },
    onError: (error) => {
      toast.error(`アップロードに失敗しました: ${error.message}`)
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (key: string) => deleteObject(id, key),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['objects', id] })
      setDeleteObjectTarget(null)
      toast.success('オブジェクトを削除しました')
    },
    onError: (error) => {
      toast.error(`オブジェクトの削除に失敗しました: ${error.message}`)
    },
  })

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      const file = e.dataTransfer.files[0]
      if (file) uploadMutation.mutate(file)
    },
    [uploadMutation],
  )

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (file) uploadMutation.mutate(file)
    },
    [uploadMutation],
  )

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

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Link to="/buckets" className="hover:underline">バケット</Link>
        <span>/</span>
        <span>{id.slice(0, 16)}...</span>
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
            <p className="font-mono text-xs text-muted-foreground break-all">{data.id}</p>
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
      <div className="space-y-2">
        <h2 className="text-lg font-semibold">オブジェクト</h2>
        <PrefixBreadcrumb prefix={prefix} onNavigate={setPrefix} />
        <div className="flex gap-2">
          <Input
            value={prefix}
            onChange={(e) => setPrefix(e.target.value)}
            placeholder="プレフィックスで絞り込み"
            className="flex-1"
          />
          <Button asChild size="sm">
            <label className="cursor-pointer">
              アップロード
              <input type="file" className="hidden" onChange={handleFileSelect} />
            </label>
          </Button>
        </div>

        {uploadMutation.isPending && (
          <p className="text-sm text-muted-foreground">アップロード中...</p>
        )}
        {uploadMutation.isError && (
          <p className="text-sm text-destructive">{uploadMutation.error.message}</p>
        )}

        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={handleDrop}
          className="rounded-lg border-2 border-dashed p-4 text-center text-sm text-muted-foreground"
        >
          ここにファイルをドラッグ＆ドロップしてアップロード
        </div>

        {/* Prefix navigation */}
        {allPrefixes.map((p: string) => (
          <Button
            key={p}
            variant="link"
            size="sm"
            className="flex h-auto items-center gap-1.5 p-0"
            onClick={() => setPrefix(p)}
          >
            <Folder className="h-4 w-4" />
            {p}
          </Button>
        ))}

        {objects.isLoading ? (
          <p className="text-muted-foreground">オブジェクトを読み込み中...</p>
        ) : objects.isError ? (
          <p className="text-destructive">オブジェクトの読み込みに失敗しました</p>
        ) : (
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>キー</TableHead>
                  <TableHead className="text-right">サイズ</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {allObjects.map((obj) => (
                  <TableRow key={obj.key}>
                    <TableCell className="font-mono text-xs">{obj.key}</TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {formatBytes(obj.size)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="link" size="sm" asChild className="mr-1">
                        <a href={downloadObjectUrl(id, obj.key)}>ダウンロード</a>
                      </Button>
                      <Button
                        variant="link"
                        size="sm"
                        className="text-destructive"
                        onClick={() => setDeleteObjectTarget(obj.key)}
                      >
                        削除
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
                {allObjects.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={3} className="py-8 text-center text-muted-foreground">
                      オブジェクトがありません
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
            {objects.hasNextPage && (
              <div className="border-t px-4 py-2 text-center">
                <Button
                  variant="link"
                  size="sm"
                  onClick={() => objects.fetchNextPage()}
                  disabled={objects.isFetchingNextPage}
                >
                  {objects.isFetchingNextPage ? '読み込み中...' : 'さらに読み込む'}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={deleteObjectTarget !== null}
        onOpenChange={(open) => { if (!open) setDeleteObjectTarget(null) }}
        title="オブジェクトの削除"
        description={`「${deleteObjectTarget}」を削除しますか？この操作は取り消せません。`}
        onConfirm={() => {
          if (deleteObjectTarget) deleteMutation.mutate(deleteObjectTarget)
        }}
        isPending={deleteMutation.isPending}
      />

      <ConfirmDialog
        open={revokeTarget !== null}
        onOpenChange={(open) => { if (!open) setRevokeTarget(null) }}
        title="キーの取り消し"
        description={`キー「${revokeTarget}」のアクセス権限を取り消しますか？`}
        confirmLabel="取り消し"
        pendingLabel="取り消し中..."
        onConfirm={() => {
          if (revokeTarget) revokeMutation.mutate(revokeTarget)
        }}
        isPending={revokeMutation.isPending}
      />
    </div>
  )
}
