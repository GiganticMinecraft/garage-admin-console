import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { listKeys, createKey, deleteKey } from '@/api'
import type { KeyListItem } from '@/api'

export const Route = createFileRoute('/keys')({
  component: KeysPage,
})

function KeysPage() {
  const queryClient = useQueryClient()
  const [showCreate, setShowCreate] = useState(false)
  const [newKeyName, setNewKeyName] = useState('')

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
        <button
          onClick={() => setShowCreate(true)}
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          Create Key
        </button>
      </div>

      {showCreate && (
        <div className="rounded-lg border p-4">
          <h2 className="mb-2 font-semibold">New Key</h2>
          <div className="flex gap-2">
            <input
              type="text"
              value={newKeyName}
              onChange={(e) => setNewKeyName(e.target.value)}
              placeholder="Key name"
              className="flex-1 rounded-md border px-3 py-1.5 text-sm"
            />
            <button
              onClick={() => createMutation.mutate(newKeyName)}
              disabled={!newKeyName || createMutation.isPending}
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
                <th className="px-4 py-2 text-left font-medium">Access Key ID</th>
                <th className="px-4 py-2 text-left font-medium">Name</th>
                <th className="px-4 py-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {keys?.map((key: KeyListItem) => (
                <tr key={key.accessKeyId} className="border-b last:border-0">
                  <td className="px-4 py-2">
                    <Link
                      to="/keys/$id"
                      params={{ id: key.accessKeyId }}
                      className="font-mono text-primary underline-offset-4 hover:underline"
                    >
                      {key.accessKeyId}
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-muted-foreground">
                    {key.name || '-'}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <button
                      onClick={() => {
                        if (confirm(`Delete key ${key.accessKeyId}?`))
                          deleteMutation.mutate(key.accessKeyId)
                      }}
                      className="text-sm text-destructive hover:underline"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
              {keys?.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-4 py-8 text-center text-muted-foreground">
                    No keys found
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
