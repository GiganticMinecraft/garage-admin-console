import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { getClusterStatus, listWorkers, type Worker } from '@/api'
import {
  DEFAULT_WORKER_FILTER,
  describeState,
  filterAndSortWorkers,
  formatSecsAgo,
  type WorkerFilter,
} from '@/lib/workers'
import { PAGE_POLLING } from '@/lib/polling'
import { RefreshIndicator } from '@/components/refresh-indicator'
import { useDocumentTitle } from '@/hooks/use-document-title'
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'

export const Route = createFileRoute('/workers')({
  component: WorkersPage,
})

interface NodeGroup {
  nodeId: string
  /** Hostname when the cluster status knows it; otherwise the heading shows the ID only. */
  hostname: string | null
  /** Workers of this node that pass the filter, in display order. */
  workers: Worker[]
  /** All workers of this node, before filtering. */
  total: number
}

function WorkersPage() {
  useDocumentTitle('ワーカー')
  const { data, isLoading, isError, dataUpdatedAt, refetch } = useQuery({
    queryKey: ['workers'],
    queryFn: listWorkers,
    ...PAGE_POLLING,
  })
  // Hostnames come from the cluster status; fall back to the ID prefix if
  // that query fails so the worker list still renders.
  const status = useQuery({
    queryKey: ['cluster', 'status'],
    queryFn: getClusterStatus,
    ...PAGE_POLLING,
  })
  const refreshAll = () => Promise.all([refetch(), status.refetch()])

  const [filter, setFilter] = useState<WorkerFilter>(DEFAULT_WORKER_FILTER)
  const update = (patch: Partial<WorkerFilter>) => setFilter((f) => ({ ...f, ...patch }))

  const names = useMemo(() => {
    const m = new Map<string, string>()
    for (const n of status.data?.nodes ?? []) {
      if (n.hostname) m.set(n.id, n.hostname)
    }
    return m
  }, [status.data])

  // Nodes in the backend's order (sorted by node ID).
  const nodeIds = useMemo(() => [...new Set((data?.workers ?? []).map((w) => w.nodeId))], [data])

  const groups = useMemo<NodeGroup[]>(() => {
    if (!data) return []
    const visible = filterAndSortWorkers(data.workers, filter)
    return nodeIds
      .map((nodeId) => ({
        nodeId,
        hostname: names.get(nodeId) ?? null,
        workers: visible.filter((w) => w.nodeId === nodeId),
        total: data.workers.filter((w) => w.nodeId === nodeId).length,
      }))
      .filter((g) => g.workers.length > 0)
  }, [data, filter, nodeIds, names])

  const totalCount = data?.workers.length ?? 0
  const shownCount = groups.reduce((sum, g) => sum + g.workers.length, 0)
  const nodeErrors = Object.entries(data?.errors ?? {})
  const nodeLabel = (id: string) => names.get(id) ?? `${id.slice(0, 16)}…`

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">ワーカー</h1>
        <RefreshIndicator updatedAt={dataUpdatedAt} onRefresh={refreshAll} />
      </div>

      {nodeErrors.length > 0 && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
          <p className="font-medium text-destructive">応答しなかったノードがあります</p>
          <ul className="mt-1 space-y-0.5 text-muted-foreground">
            {nodeErrors.map(([nodeId, msg]) => (
              <li key={nodeId}>
                <span className="font-mono text-xs">{nodeId.slice(0, 16)}…</span>: {msg}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
        <Input
          placeholder="名前・ID・エラーメッセージで検索"
          value={filter.search}
          onChange={(e) => update({ search: e.target.value })}
          className="sm:w-72"
          aria-label="ワーカーを検索"
        />
        <select
          value={filter.nodeId ?? ''}
          onChange={(e) => update({ nodeId: e.target.value || null })}
          className="h-9 rounded-md border bg-background px-3 text-sm"
          aria-label="ノードで絞り込み"
        >
          <option value="">すべてのノード</option>
          {nodeIds.map((id) => (
            <option key={id} value={id}>
              {nodeLabel(id)}
            </option>
          ))}
        </select>
        <div className="flex items-center gap-2">
          <Checkbox
            id="workers-only-noteworthy"
            checked={filter.onlyNoteworthy}
            onCheckedChange={(c) => update({ onlyNoteworthy: c === true })}
          />
          <label htmlFor="workers-only-noteworthy" className="text-sm">
            異常・稼働中のみ
          </label>
        </div>
        <div className="flex items-center gap-2">
          <Checkbox
            id="workers-hide-disabled"
            checked={filter.hideDisabled}
            onCheckedChange={(c) => update({ hideDisabled: c === true })}
          />
          <label htmlFor="workers-hide-disabled" className="text-sm">
            無効なワーカーを隠す
          </label>
        </div>
        {data && (
          <span className="text-sm text-muted-foreground tabular-nums sm:ml-auto">
            {shownCount} / {totalCount} 件を表示
          </span>
        )}
      </div>

      {isLoading ? (
        <p className="text-muted-foreground">読み込み中...</p>
      ) : isError ? (
        <p className="text-destructive">ワーカーの読み込みに失敗しました</p>
      ) : totalCount === 0 ? (
        <p className="text-muted-foreground">ワーカーがありません</p>
      ) : groups.length === 0 ? (
        <p className="text-muted-foreground">条件に一致するワーカーがありません</p>
      ) : (
        groups.map((group) => (
          <div key={group.nodeId} className="space-y-2">
            <h2 className="flex items-baseline gap-2 text-lg font-semibold">
              {group.hostname ?? <span className="font-mono">{group.nodeId.slice(0, 16)}…</span>}
              {group.hostname && (
                <span className="font-mono text-xs font-normal text-muted-foreground">
                  {group.nodeId.slice(0, 16)}…
                </span>
              )}
              <span className="text-xs font-normal text-muted-foreground">
                {group.workers.length === group.total
                  ? `${group.total} ワーカー`
                  : `${group.workers.length} / ${group.total} ワーカー`}
              </span>
            </h2>
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/50">
                <TableHead>名前</TableHead>
                <TableHead>状態</TableHead>
                <TableHead>詳細</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {group.workers.map((worker: Worker) => {
                const { label: stateLabel, kind: stateKind } = describeState(worker.state)
                const hasError = worker.consecutiveErrors > 0
                const stateVariant = hasError
                  ? 'destructive'
                  : stateKind === 'idle'
                    ? 'secondary'
                    : stateKind === 'busy'
                      ? 'default'
                      : 'outline'
                return (
                <TableRow key={`${worker.nodeId}-${worker.id}`}>
                  <TableCell className="font-medium">
                    {worker.name || '-'}
                    <span className="ml-1.5 font-mono text-xs font-normal text-muted-foreground">#{worker.id}</span>
                  </TableCell>
                  <TableCell>
                    <Badge variant={stateVariant}>{stateLabel}</Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    <div className="flex flex-wrap gap-x-4 gap-y-1">
                      {worker.consecutiveErrors > 0 && worker.errors > 0 && (
                        <>
                          <span className="text-destructive font-medium">
                            エラー: {worker.errors}（連続 {worker.consecutiveErrors} 回）
                          </span>
                          {worker.lastError && (
                            <span className="basis-full text-destructive text-xs">{worker.lastError.message}</span>
                          )}
                        </>
                      )}
                      {worker.consecutiveErrors === 0 && worker.errors > 0 && (
                        <>
                          <span className="text-muted-foreground">
                            過去のエラー: {worker.errors}回
                            {worker.lastError && `（${formatSecsAgo(worker.lastError.secsAgo)}に回復済み）`}
                          </span>
                          {worker.lastError && (
                            <span className="basis-full text-muted-foreground text-xs">{worker.lastError.message}</span>
                          )}
                        </>
                      )}
                      {worker.persistentErrors != null && worker.persistentErrors > 0 && (
                        <span>永続エラー: <span className="font-medium">{worker.persistentErrors.toLocaleString()}</span></span>
                      )}
                      {worker.queueLength != null && worker.queueLength > 0 && (
                        <span>キュー: <span className="font-medium">{worker.queueLength.toLocaleString()}</span></span>
                      )}
                      {worker.tranquility != null && (
                        <span>tranquility: <span className="font-medium">{worker.tranquility}</span></span>
                      )}
                      {worker.progress != null && (
                        <span>進捗: <span className="font-medium">{worker.progress}</span></span>
                      )}
                      {worker.freeform.length > 0 && (
                        <span className="basis-full text-xs">
                          {worker.freeform.join(' / ')}
                        </span>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
          </div>
        ))
      )}
    </div>
  )
}
