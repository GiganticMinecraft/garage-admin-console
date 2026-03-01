import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { getClusterLayout, applyLayout } from '@/api'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table'
import { Skeleton } from '@/components/ui/skeleton'
import { ConfirmDialog } from '@/components/confirm-dialog'

export const Route = createFileRoute('/layout')({
  component: LayoutPage,
})

interface LayoutRole {
  id: string
  zone: string
  tags: string[]
  capacity: number
  storedPartitions: number
  usableCapacity: number
}

interface ClusterLayout {
  version: number
  roles: LayoutRole[]
  parameters: { zoneRedundancy: string }
  partitionSize: number
  stagedRoleChanges: unknown[]
  stagedParameters: unknown | null
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let value = bytes
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value.toFixed(1)} ${units[i]}`
}

function LayoutPage() {
  const queryClient = useQueryClient()
  const [editBody, setEditBody] = useState('')
  const [showEdit, setShowEdit] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [jsonError, setJsonError] = useState('')
  const [parsedBody, setParsedBody] = useState<unknown>(null)

  const layout = useQuery({
    queryKey: ['cluster', 'layout'],
    queryFn: getClusterLayout as unknown as () => Promise<ClusterLayout>,
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

  const data = layout.data

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Cluster Layout</h1>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setEditBody(JSON.stringify(layout.data, null, 2))
            setShowEdit(!showEdit)
            setJsonError('')
          }}
        >
          {showEdit ? 'Cancel' : 'Edit Raw'}
        </Button>
      </div>

      {layout.isLoading ? (
        <div className="space-y-3">
          <div className="rounded-lg border p-4">
            <div className="grid grid-cols-3 gap-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="space-y-1">
                  <Skeleton className="h-4 w-20" />
                  <Skeleton className="h-5 w-24" />
                </div>
              ))}
            </div>
          </div>
          <Skeleton className="h-48 w-full" />
        </div>
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
            onClick={handleApply}
            disabled={applyMutation.isPending}
          >
            {applyMutation.isPending ? 'Applying...' : 'Apply Layout'}
          </Button>
          {applyMutation.isError && (
            <p className="text-sm text-destructive">{applyMutation.error.message}</p>
          )}
        </div>
      ) : data ? (
        <>
          <div className="rounded-lg border p-4">
            <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
              <div>
                <p className="text-muted-foreground">Version</p>
                <p className="font-medium">{data.version}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Zone Redundancy</p>
                <p className="font-medium">{data.parameters.zoneRedundancy}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Partition Size</p>
                <p className="font-medium">{formatBytes(data.partitionSize)}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Staged Changes</p>
                <p className="font-medium">
                  {data.stagedRoleChanges.length > 0
                    ? <Badge variant="destructive">{data.stagedRoleChanges.length} pending</Badge>
                    : <span className="text-muted-foreground">None</span>}
                </p>
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <h2 className="text-lg font-semibold">Roles</h2>
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Node ID</TableHead>
                    <TableHead>Zone</TableHead>
                    <TableHead className="text-right">Capacity</TableHead>
                    <TableHead className="text-right">Usable</TableHead>
                    <TableHead className="text-right">Partitions</TableHead>
                    <TableHead>Tags</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.roles.map((role) => (
                    <TableRow key={role.id}>
                      <TableCell className="font-mono text-xs">
                        {role.id.slice(0, 16)}...
                      </TableCell>
                      <TableCell>{role.zone}</TableCell>
                      <TableCell className="text-right">{formatBytes(role.capacity)}</TableCell>
                      <TableCell className="text-right">{formatBytes(role.usableCapacity)}</TableCell>
                      <TableCell className="text-right">{role.storedPartitions}</TableCell>
                      <TableCell>
                        {role.tags.length > 0
                          ? role.tags.map((t) => <Badge key={t} variant="outline" className="mr-1">{t}</Badge>)
                          : <span className="text-muted-foreground">-</span>}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        </>
      ) : null}

      <ConfirmDialog
        open={showConfirm}
        onOpenChange={setShowConfirm}
        title="Apply Layout"
        description="レイアウト変更を適用しますか？クラスターの動作に影響する可能性があります。"
        confirmLabel="Apply"
        pendingLabel="Applying..."
        confirmVariant="default"
        onConfirm={() => applyMutation.mutate(parsedBody)}
        isPending={applyMutation.isPending}
      />
    </div>
  )
}
