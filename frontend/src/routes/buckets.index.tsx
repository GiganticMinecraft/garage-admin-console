import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { listBuckets, createBucket, deleteBucket } from '@/api'
import type { BucketListItem } from '@/api'
import { ConfirmDialog } from '@/components/confirm-dialog'
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

export const Route = createFileRoute('/buckets/')({
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
        <Button size="sm" onClick={() => setShowCreate(true)}>
          Create Bucket
        </Button>
      </div>

      {showCreate && (
        <div className="rounded-lg border p-4">
          <h2 className="mb-2 font-semibold">New Bucket</h2>
          <div className="flex gap-2">
            <Input
              type="text"
              value={newBucketAlias}
              onChange={(e) => setNewBucketAlias(e.target.value)}
              placeholder="Global alias"
              className="flex-1"
            />
            <Button
              size="sm"
              onClick={() => createMutation.mutate(newBucketAlias)}
              disabled={!newBucketAlias || createMutation.isPending}
            >
              {createMutation.isPending ? 'Creating...' : 'Create'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowCreate(false)}
            >
              Cancel
            </Button>
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
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/50">
                <TableHead className="px-4">ID</TableHead>
                <TableHead className="px-4">Aliases</TableHead>
                <TableHead className="px-4 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {buckets?.map((bucket: BucketListItem) => (
                <TableRow key={bucket.id}>
                  <TableCell className="px-4">
                    <Link
                      to="/buckets/$id"
                      params={{ id: bucket.id }}
                      className="text-primary underline-offset-4 hover:underline"
                    >
                      {bucket.id.slice(0, 16)}...
                    </Link>
                  </TableCell>
                  <TableCell className="px-4 text-muted-foreground">
                    {bucket.globalAliases?.join(', ') || '-'}
                  </TableCell>
                  <TableCell className="px-4 text-right">
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => setDeleteTarget(bucket)}
                    >
                      Delete
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {buckets?.length === 0 && (
                <TableRow>
                  <TableCell colSpan={3} className="px-4 py-8 text-center text-muted-foreground">
                    No buckets found
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
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
