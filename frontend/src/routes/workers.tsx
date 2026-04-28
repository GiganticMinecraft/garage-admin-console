import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { listWorkers, type Worker, type WorkerState } from '@/api'
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
    return { label: `throttled (${state.throttled})`, kind: 'throttled' }
  }
  if (state === 'idle') return { label: 'idle', kind: 'idle' }
  if (state === 'busy') return { label: 'busy', kind: 'busy' }
  return { label: typeof state === 'string' && state.length > 0 ? state : 'unknown', kind: 'other' }
}

function WorkersPage() {
  const { data: workers, isLoading, isError } = useQuery({
    queryKey: ['workers'],
    queryFn: listWorkers,
  })

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">ワーカー</h1>

      {isLoading ? (
        <p className="text-muted-foreground">読み込み中...</p>
      ) : isError ? (
        <p className="text-destructive">ワーカーの読み込みに失敗しました</p>
      ) : (
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
              {workers?.map((worker: Worker) => {
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
                <TableRow key={worker.id}>
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
              {workers?.length === 0 && (
                <TableRow>
                  <TableCell colSpan={3} className="px-4 py-8 text-center text-muted-foreground">
                    ワーカーがありません
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}
