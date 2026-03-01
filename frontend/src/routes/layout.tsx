import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { getClusterLayout, applyLayout } from '@/api'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/confirm-dialog'

export const Route = createFileRoute('/layout')({
  component: LayoutPage,
})

function LayoutPage() {
  const queryClient = useQueryClient()
  const [editBody, setEditBody] = useState('')
  const [showEdit, setShowEdit] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [jsonError, setJsonError] = useState('')
  const [parsedBody, setParsedBody] = useState<unknown>(null)

  const layout = useQuery({
    queryKey: ['cluster', 'layout'],
    queryFn: getClusterLayout,
  })

  const applyMutation = useMutation({
    mutationFn: (body: unknown) => applyLayout(body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cluster', 'layout'] })
      setShowEdit(false)
      setJsonError('')
    },
  })

  const handleApply = () => {
    try {
      const parsed = JSON.parse(editBody)
      setJsonError('')
      setParsedBody(parsed)
      setShowConfirm(true)
    } catch {
      setJsonError('Invalid JSON')
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Cluster Layout</h1>
        <Button
          variant="outline"
          onClick={() => {
            setEditBody(JSON.stringify(layout.data, null, 2))
            setShowEdit(!showEdit)
            setJsonError('')
          }}
        >
          {showEdit ? 'Cancel' : 'Edit'}
        </Button>
      </div>

      {layout.isLoading ? (
        <p className="text-muted-foreground">Loading...</p>
      ) : layout.isError ? (
        <p className="text-destructive">Failed to load layout</p>
      ) : showEdit ? (
        <div className="space-y-2">
          <textarea
            value={editBody}
            onChange={(e) => {
              setEditBody(e.target.value)
              setJsonError('')
            }}
            rows={20}
            className="w-full rounded-md border px-3 py-2 font-mono text-sm focus-visible:ring-ring/50 focus-visible:ring-[3px]"
          />
          {jsonError && (
            <p className="text-sm text-destructive">{jsonError}</p>
          )}
          <Button
            variant="default"
            onClick={handleApply}
            disabled={applyMutation.isPending}
          >
            {applyMutation.isPending ? 'Applying...' : 'Apply Layout'}
          </Button>
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

      <ConfirmDialog
        open={showConfirm}
        onOpenChange={setShowConfirm}
        title="Apply Layout"
        description="Apply layout changes? This may affect cluster operations."
        confirmLabel="Apply"
        pendingLabel="Applying..."
        confirmVariant="default"
        onConfirm={() => applyMutation.mutate(parsedBody)}
        isPending={applyMutation.isPending}
      />
    </div>
  )
}
