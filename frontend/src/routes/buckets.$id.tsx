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
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (key: string) => deleteObject(id, key),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['objects', id] })
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
  const grantMutation = useMutation({
    mutationFn: (accessKeyId: string) =>
      grantBucketKey(id, {
        accessKeyId,
        permissions: { read: true, write: true, owner: false },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bucket', id] })
      setGrantKeyId('')
    },
  })

  const revokeMutation = useMutation({
    mutationFn: (keyId: string) => revokeBucketKey(id, keyId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bucket', id] })
    },
  })

  const data = bucket.data

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Link to="/buckets" className="hover:underline">Buckets</Link>
        <span>/</span>
        <span>{id.slice(0, 16)}...</span>
      </div>

      <h1 className="text-2xl font-bold">
        {data?.globalAliases?.[0] || 'Bucket Detail'}
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
        <p className="text-destructive">Failed to load bucket</p>
      ) : data ? (
        <div className="rounded-lg border p-4 space-y-3">
          <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
            <div>
              <p className="text-muted-foreground">ID</p>
              <p className="font-mono text-xs break-all">{data.id}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Aliases</p>
              <div className="flex flex-wrap gap-1">
                {data.globalAliases?.length
                  ? data.globalAliases.map((a) => (
                      <Badge key={a} variant="secondary">{a}</Badge>
                    ))
                  : <span className="text-muted-foreground">-</span>}
              </div>
            </div>
            <div>
              <p className="text-muted-foreground">Objects</p>
              <p className="font-medium">{data.objects ?? '-'}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Size</p>
              <p className="font-medium">
                {data.bytes != null ? formatBytes(data.bytes) : '-'}
              </p>
            </div>
          </div>
          {data.quotas && (data.quotas.maxSize || data.quotas.maxObjects) && (
            <div className="text-sm">
              <p className="text-muted-foreground">Quotas</p>
              <p>
                {data.quotas.maxObjects != null && `Max objects: ${data.quotas.maxObjects}`}
                {data.quotas.maxSize != null && ` / Max size: ${formatBytes(data.quotas.maxSize)}`}
              </p>
            </div>
          )}
        </div>
      ) : null}

      {/* Key Permissions */}
      <div className="space-y-2">
        <h2 className="text-lg font-semibold">Key Permissions</h2>
        <div className="flex gap-2">
          <Input
            value={grantKeyId}
            onChange={(e) => setGrantKeyId(e.target.value)}
            placeholder="Access Key ID"
            className="flex-1"
          />
          <Button
            size="sm"
            onClick={() => grantMutation.mutate(grantKeyId)}
            disabled={!grantKeyId || grantMutation.isPending}
          >
            Grant
          </Button>
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
              Revoke
            </Button>
          </div>
        ))}
      </div>

      {/* Object Browser */}
      <div className="space-y-2">
        <h2 className="text-lg font-semibold">Objects</h2>
        <div className="flex gap-2">
          <Input
            value={prefix}
            onChange={(e) => setPrefix(e.target.value)}
            placeholder="Prefix filter"
            className="flex-1"
          />
          <Button asChild size="sm">
            <label className="cursor-pointer">
              Upload
              <input type="file" className="hidden" onChange={handleFileSelect} />
            </label>
          </Button>
        </div>

        {uploadMutation.isPending && (
          <p className="text-sm text-muted-foreground">Uploading...</p>
        )}
        {uploadMutation.isError && (
          <p className="text-sm text-destructive">{uploadMutation.error.message}</p>
        )}

        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={handleDrop}
          className="rounded-lg border-2 border-dashed p-4 text-center text-sm text-muted-foreground"
        >
          Drag & drop files here to upload
        </div>

        {/* Prefix navigation */}
        {allPrefixes.map((p: string) => (
          <Button
            key={p}
            variant="link"
            size="sm"
            className="block h-auto p-0"
            onClick={() => setPrefix(p)}
          >
            {p}
          </Button>
        ))}

        {objects.isLoading ? (
          <p className="text-muted-foreground">Loading objects...</p>
        ) : objects.isError ? (
          <p className="text-destructive">Failed to load objects</p>
        ) : (
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Key</TableHead>
                  <TableHead className="text-right">Size</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
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
                        <a href={downloadObjectUrl(id, obj.key)}>Download</a>
                      </Button>
                      <Button
                        variant="link"
                        size="sm"
                        className="text-destructive"
                        onClick={() => setDeleteObjectTarget(obj.key)}
                      >
                        Delete
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
                {allObjects.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={3} className="py-8 text-center text-muted-foreground">
                      No objects found
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
                  {objects.isFetchingNextPage ? 'Loading...' : 'Load More'}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={deleteObjectTarget !== null}
        onOpenChange={(open) => { if (!open) setDeleteObjectTarget(null) }}
        title="Delete Object"
        description={`"${deleteObjectTarget}" を削除しますか？この操作は取り消せません。`}
        onConfirm={() => {
          if (deleteObjectTarget) deleteMutation.mutate(deleteObjectTarget)
        }}
        isPending={deleteMutation.isPending}
      />

      <ConfirmDialog
        open={revokeTarget !== null}
        onOpenChange={(open) => { if (!open) setRevokeTarget(null) }}
        title="Revoke Key"
        description={`Key "${revokeTarget}" のアクセス権限を取り消しますか？`}
        onConfirm={() => {
          if (revokeTarget) revokeMutation.mutate(revokeTarget)
        }}
        isPending={revokeMutation.isPending}
      />
    </div>
  )
}
