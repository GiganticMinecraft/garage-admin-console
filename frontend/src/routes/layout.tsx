import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { getClusterLayout, applyLayout } from '@/api'

export const Route = createFileRoute('/layout')({
  component: LayoutPage,
})

function LayoutPage() {
  const queryClient = useQueryClient()
  const [editBody, setEditBody] = useState('')
  const [showEdit, setShowEdit] = useState(false)

  const layout = useQuery({
    queryKey: ['cluster', 'layout'],
    queryFn: getClusterLayout,
  })

  const applyMutation = useMutation({
    mutationFn: (body: unknown) => applyLayout(body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cluster', 'layout'] })
      setShowEdit(false)
    },
  })

  const handleApply = () => {
    try {
      const parsed = JSON.parse(editBody)
      if (confirm('Apply layout changes? This may affect cluster operations.')) {
        applyMutation.mutate(parsed)
      }
    } catch {
      alert('Invalid JSON')
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Cluster Layout</h1>
        <button
          onClick={() => {
            setEditBody(JSON.stringify(layout.data, null, 2))
            setShowEdit(!showEdit)
          }}
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          {showEdit ? 'Cancel' : 'Edit'}
        </button>
      </div>

      {layout.isLoading ? (
        <p className="text-muted-foreground">Loading...</p>
      ) : layout.isError ? (
        <p className="text-destructive">Failed to load layout</p>
      ) : showEdit ? (
        <div className="space-y-2">
          <textarea
            value={editBody}
            onChange={(e) => setEditBody(e.target.value)}
            rows={20}
            className="w-full rounded-md border px-3 py-2 font-mono text-sm"
          />
          <button
            onClick={handleApply}
            disabled={applyMutation.isPending}
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {applyMutation.isPending ? 'Applying...' : 'Apply Layout'}
          </button>
          {applyMutation.isError && (
            <p className="text-sm text-destructive">{applyMutation.error.message}</p>
          )}
        </div>
      ) : (
        <div className="rounded-lg border p-4">
          <pre className="overflow-auto text-sm">
            {JSON.stringify(layout.data, null, 2)}
          </pre>
        </div>
      )}
    </div>
  )
}
