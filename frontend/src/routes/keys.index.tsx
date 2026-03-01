import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { listKeys, createKey, deleteKey } from '@/api'
import type { KeyListItem } from '@/api'
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
import { ConfirmDialog } from '@/components/confirm-dialog'

export const Route = createFileRoute('/keys/')({
  component: KeysPage,
})

function KeysPage() {
  const queryClient = useQueryClient()
  const [showCreate, setShowCreate] = useState(false)
  const [newKeyName, setNewKeyName] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<KeyListItem | null>(null)

  const { data: keys, isLoading } = useQuery({
    queryKey: ['keys'],
    queryFn: listKeys,
  })

  const createMutation = useMutation({
    mutationFn: (name: string) => createKey({ name }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      setShowCreate(false)
      setNewKeyName('')
    },
  })

  const deleteMutation = useMutation({
    mutationFn: deleteKey,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['keys'] })
    },
  })

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Keys</h1>
        <Button size="sm" onClick={() => setShowCreate(true)}>
          Create Key
        </Button>
      </div>

      {showCreate && (
        <div className="rounded-lg border p-4">
          <h2 className="mb-2 font-semibold">New Key</h2>
          <div className="flex gap-2">
            <Input
              type="text"
              value={newKeyName}
              onChange={(e) => setNewKeyName(e.target.value)}
              placeholder="Key name"
              className="flex-1"
            />
            <Button
              size="sm"
              onClick={() => createMutation.mutate(newKeyName)}
              disabled={!newKeyName || createMutation.isPending}
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
                <TableHead className="px-4">Access Key ID</TableHead>
                <TableHead className="px-4">Name</TableHead>
                <TableHead className="px-4 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {keys?.map((key: KeyListItem) => (
                <TableRow key={key.id}>
                  <TableCell className="px-4">
                    <Link
                      to="/keys/$id"
                      params={{ id: key.id }}
                      className="font-mono text-primary underline-offset-4 hover:underline"
                    >
                      {key.id}
                    </Link>
                  </TableCell>
                  <TableCell className="px-4 text-muted-foreground">
                    {key.name || '-'}
                  </TableCell>
                  <TableCell className="px-4 text-right">
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => setDeleteTarget(key)}
                    >
                      Delete
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {keys?.length === 0 && (
                <TableRow>
                  <TableCell colSpan={3} className="px-4 py-8 text-center text-muted-foreground">
                    No keys found
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
        title="Delete Key"
        description={`Key "${deleteTarget?.name || deleteTarget?.id}" を削除しますか？この操作は取り消せません。`}
        onConfirm={() => {
          if (deleteTarget) deleteMutation.mutate(deleteTarget.id)
        }}
        isPending={deleteMutation.isPending}
      />
    </div>
  )
}
