import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
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

export const Route = createFileRoute('/buckets/$id')({
  component: BucketDetailPage,
})

function BucketDetailPage() {
  const { id } = Route.useParams()
  const queryClient = useQueryClient()
  const [prefix, setPrefix] = useState('')

  const bucket = useQuery({
    queryKey: ['bucket', id],
    queryFn: () => getBucket(id),
  })

  const objects = useQuery({
    queryKey: ['objects', id, prefix],
    queryFn: () => listObjects(id, prefix || undefined),
  })

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

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Link to="/buckets" className="hover:underline">Buckets</Link>
        <span>/</span>
        <span>{id.slice(0, 16)}...</span>
      </div>

      <h1 className="text-2xl font-bold">Bucket Detail</h1>

      {bucket.isLoading ? (
        <p className="text-muted-foreground">Loading...</p>
      ) : bucket.isError ? (
        <p className="text-destructive">Failed to load bucket</p>
      ) : (
        <div className="rounded-lg border p-4">
          <pre className="overflow-auto text-sm">
            {JSON.stringify(bucket.data, null, 2)}
          </pre>
        </div>
      )}

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
        {/* Existing keys shown from bucket detail */}
        {bucket.data &&
          Array.isArray((bucket.data as Record<string, unknown>).keys) &&
          ((bucket.data as Record<string, unknown>).keys as { accessKeyId: string; permissions: Record<string, boolean> }[]).map(
            (k) => (
              <div key={k.accessKeyId} className="flex items-center justify-between rounded border px-3 py-2 text-sm">
                <span className="font-mono">{k.accessKeyId}</span>
                <button
                  onClick={() => {
                    if (confirm(`Revoke key ${k.accessKeyId}?`))
                      revokeMutation.mutate(k.accessKeyId)
                  }}
                  className="text-destructive hover:underline"
                >
                  Revoke
                </button>
              </div>
            ),
          )}
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
        {objects.data?.prefixes?.map((p: string) => (
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
                {objects.data?.objects?.map((obj) => (
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
                        onClick={() => {
                          if (confirm(`Delete ${obj.key}?`))
                            deleteMutation.mutate(obj.key)
                        }}
                        className="text-destructive hover:underline"
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
                {objects.data?.objects?.length === 0 && (
                  <tr>
                    <td colSpan={3} className="px-4 py-8 text-center text-muted-foreground">
                      No objects found
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
}
