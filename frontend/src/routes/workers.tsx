import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { getClusterStatus, listWorkers, type Worker, type WorkerState } from '@/api'
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'

export const Route = createFileRoute('/workers')({
  component: WorkersPage,
})

function formatSecsAgo(secs: number): string {
  if (secs < 60) return `${Math.floor(secs)}秒前`
  if (secs < 3600) return `${Math.floor(secs / 60)}分前`
  if (secs < 86400) return `${Math.floor(secs / 3600)}時間前`
  return `${Math.floor(secs / 86400)}日前`
}

type StateKind = 'idle' | 'busy' | 'throttled' | 'other'

function describeState(state: WorkerState): { label: string; kind: StateKind } {
  if (typeof state === 'object' && state !== null && 'throttled' in state) {
    const secs = state.throttled?.durationSecs
    const detail = typeof secs === 'number' ? ` (${secs.toFixed(1)}s)` : ''
    return { label: `throttled${detail}`, kind: 'throttled' }
  }
  if (state === 'idle') return { label: 'idle', kind: 'idle' }
  if (state === 'busy') return { label: 'busy', kind: 'busy' }
  return { label: typeof state === 'string' && state.length > 0 ? state : 'unknown', kind: 'other' }
}

interface NodeGroup {
  nodeId: string
  /** Hostname when the cluster status knows it; otherwise the heading shows the ID only. */
  hostname: string | null
  workers: Worker[]
}

function WorkersPage() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['workers'],
    queryFn: listWorkers,
  })
  // Hostnames come from the cluster status; fall back to the ID prefix if
  // that query fails so the worker list still renders.
  const status = useQuery({
    queryKey: ['cluster', 'status'],
    queryFn: getClusterStatus,
  })

  const groups = useMemo<NodeGroup[]>(() => {
    if (!data) return []
    const names = new Map<string, string>()
    for (const n of status.data?.nodes ?? []) {
      if (n.hostname) names.set(n.id, n.hostname)
    }
    const byNode = new Map<string, Worker[]>()
    for (const w of data.workers) {
      const list = byNode.get(w.nodeId)
      if (list) list.push(w)
      else byNode.set(w.nodeId, [w])
    }
    // Backend already sorts by node ID then worker ID; keep that order.
    return [...byNode.entries()].map(([nodeId, workers]) => ({
      nodeId,
      hostname: names.get(nodeId) ?? null,
      workers,
    }))
  }, [data, status.data])

  const nodeErrors = Object.entries(data?.errors ?? {})

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">ワーカー</h1>

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

      {isLoading ? (
        <p className="text-muted-foreground">読み込み中...</p>
      ) : isError ? (
        <p className="text-destructive">ワーカーの読み込みに失敗しました</p>
      ) : groups.length === 0 ? (
        <p className="text-muted-foreground">ワーカーがありません</p>
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
                {group.workers.length} ワーカー
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
