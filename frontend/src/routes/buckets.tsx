import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { listBuckets, createBucket, deleteBucket } from '@/api'
import type { BucketListItem } from '@/api'
import { ConfirmDialog } from '@/components/confirm-dialog'

export const Route = createFileRoute('/buckets')({
  component: BucketsPage,
})

function BucketsPage() {
  const queryClient = useQueryClient()
  const [showCreate, setShowCreate] = useState(false)
  const [newBucketAlias, setNewBucketAlias] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<BucketListItem | null>(null)

  const { data: buckets, isLoading } = useQuery({
    queryKey: ['buckets'],
    queryFn: listBuckets,
  })

  const createMutation = useMutation({
    mutationFn: (alias: string) =>
      createBucket({ globalAlias: alias }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['buckets'] })
      setShowCreate(false)
      setNewBucketAlias('')
    },
  })

  const deleteMutation = useMutation({
    mutationFn: deleteBucket,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['buckets'] })
    },
  })

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Buckets</h1>
        <button
          onClick={() => setShowCreate(true)}
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          Create Bucket
        </button>
      </div>

      {showCreate && (
        <div className="rounded-lg border p-4">
          <h2 className="mb-2 font-semibold">New Bucket</h2>
          <div className="flex gap-2">
            <input
              type="text"
              value={newBucketAlias}
              onChange={(e) => setNewBucketAlias(e.target.value)}
              placeholder="Global alias"
              className="flex-1 rounded-md border px-3 py-1.5 text-sm"
            />
            <button
              onClick={() => createMutation.mutate(newBucketAlias)}
              disabled={!newBucketAlias || createMutation.isPending}
              className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {createMutation.isPending ? 'Creating...' : 'Create'}
            </button>
            <button
              onClick={() => setShowCreate(false)}
              className="rounded-md border px-3 py-1.5 text-sm"
            >
              Cancel
            </button>
          </div>
          {createMutation.isError && (
            <p className="mt-2 text-sm text-destructive">
              {createMutation.error.message}
            </p>
          )}
        </div>
      )}

      {isLoading ? (
        <p className="text-muted-foreground">Loading...</p>
      ) : (
        <div className="rounded-lg border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="px-4 py-2 text-left font-medium">ID</th>
                <th className="px-4 py-2 text-left font-medium">Aliases</th>
                <th className="px-4 py-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {buckets?.map((bucket: BucketListItem) => (
                <tr key={bucket.id} className="border-b last:border-0">
                  <td className="px-4 py-2">
                    <Link
                      to="/buckets/$id"
                      params={{ id: bucket.id }}
                      className="text-primary underline-offset-4 hover:underline"
                    >
                      {bucket.id.slice(0, 16)}...
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-muted-foreground">
                    {bucket.globalAliases?.join(', ') || '-'}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <button
                      onClick={() => setDeleteTarget(bucket)}
                      className="text-sm text-destructive hover:underline"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
              {buckets?.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-4 py-8 text-center text-muted-foreground">
                    No buckets found
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}
        title="Delete Bucket"
        description={`Bucket "${deleteTarget?.globalAliases?.[0] || deleteTarget?.id.slice(0, 16)}" を削除しますか？この操作は取り消せません。`}
        onConfirm={() => {
          if (deleteTarget) deleteMutation.mutate(deleteTarget.id)
        }}
        isPending={deleteMutation.isPending}
      />
    </div>
  )
}
