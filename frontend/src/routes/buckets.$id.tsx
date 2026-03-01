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
        <p className="text-muted-foreground">Loading...</p>
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
          <input
            type="text"
            value={grantKeyId}
            onChange={(e) => setGrantKeyId(e.target.value)}
            placeholder="Access Key ID"
            className="flex-1 rounded-md border px-3 py-1.5 text-sm"
          />
          <button
            onClick={() => grantMutation.mutate(grantKeyId)}
            disabled={!grantKeyId || grantMutation.isPending}
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            Grant
          </button>
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
            <button
              onClick={() => setRevokeTarget(k.accessKeyId)}
              className="text-destructive hover:underline"
            >
              Revoke
            </button>
          </div>
        ))}
      </div>

      {/* Object Browser */}
      <div className="space-y-2">
        <h2 className="text-lg font-semibold">Objects</h2>
        <div className="flex gap-2">
          <input
            type="text"
            value={prefix}
            onChange={(e) => setPrefix(e.target.value)}
            placeholder="Prefix filter"
            className="flex-1 rounded-md border px-3 py-1.5 text-sm"
          />
          <label className="cursor-pointer rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90">
            Upload
            <input type="file" className="hidden" onChange={handleFileSelect} />
          </label>
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
          <button
            key={p}
            onClick={() => setPrefix(p)}
            className="block text-sm text-primary hover:underline"
          >
            {p}
          </button>
        ))}

        {objects.isLoading ? (
          <p className="text-muted-foreground">Loading objects...</p>
        ) : objects.isError ? (
          <p className="text-destructive">Failed to load objects</p>
        ) : (
          <div className="rounded-lg border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="px-4 py-2 text-left font-medium">Key</th>
                  <th className="px-4 py-2 text-right font-medium">Size</th>
                  <th className="px-4 py-2 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {allObjects.map((obj) => (
                  <tr key={obj.key} className="border-b last:border-0">
                    <td className="px-4 py-2 font-mono text-xs">{obj.key}</td>
                    <td className="px-4 py-2 text-right text-muted-foreground">
                      {formatBytes(obj.size)}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <a
                        href={downloadObjectUrl(id, obj.key)}
                        className="mr-2 text-primary hover:underline"
                      >
                        Download
                      </a>
                      <button
                        onClick={() => setDeleteObjectTarget(obj.key)}
                        className="text-destructive hover:underline"
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
                {allObjects.length === 0 && (
                  <tr>
                    <td colSpan={3} className="px-4 py-8 text-center text-muted-foreground">
                      No objects found
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            {objects.hasNextPage && (
              <div className="border-t px-4 py-2 text-center">
                <button
                  onClick={() => objects.fetchNextPage()}
                  disabled={objects.isFetchingNextPage}
                  className="text-sm text-primary hover:underline disabled:opacity-50"
                >
                  {objects.isFetchingNextPage ? 'Loading...' : 'Load More'}
                </button>
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
