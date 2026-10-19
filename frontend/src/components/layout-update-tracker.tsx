import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, Hourglass, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { getLayoutHistory, skipDeadNodes, type LayoutHistory, type LayoutVersionInfo } from '@/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

/**
 * A layout update is in flight while Garage still keeps an older version live
 * (update trackers are only returned when more than one version is live) or
 * some node has not acknowledged the current version yet.
 */
function isUpdateInFlight(h: LayoutHistory | undefined): boolean {
  if (!h) return false
  return (
    h.updateTrackers != null ||
    h.minAck < h.currentVersion ||
    h.versions.some((v) => v.status === 'Draining')
  )
}

type StepState = 'completed' | 'inprogress' | 'waiting'

interface Step {
  name: string
  hint: string
  progress: number
  state: StepState
}

/**
 * ack: the node knows the new version; sync: it finished copying metadata for
 * it; syncAck: it has seen every node sync, so it reads from the new layout.
 * A step is only "in progress" once the previous one has completed on all nodes.
 */
function computeSteps(h: LayoutHistory): { steps: Step[]; total: number } {
  const trackers = Object.values(h.updateTrackers ?? {})
  const total = trackers.length
  const count = (k: 'ack' | 'sync' | 'syncAck') => trackers.filter((t) => t[k] >= h.currentVersion).length
  const defs = [
    { name: 'レイアウトの伝播', hint: '全ノードが新しいバージョンを受け取る (ack)', progress: count('ack') },
    { name: 'メタデータ同期', hint: '各ノードが新レイアウトでのメタデータを同期する (sync)', progress: count('sync') },
    { name: '新レイアウトへ切替', hint: '全ノードの同期完了を確認し新レイアウトで読み書きする (syncAck)', progress: count('syncAck') },
  ]
  let prevDone = true
  const steps = defs.map((d) => {
    const done = total > 0 && d.progress === total
    const state: StepState = done ? 'completed' : prevDone ? 'inprogress' : 'waiting'
    prevDone = done
    return { ...d, state }
  })
  return { steps, total }
}

/** Live (non-historical) versions, newest first. */
function liveVersions(h: LayoutHistory): LayoutVersionInfo[] {
  return h.versions.filter((v) => v.status !== 'Historical').sort((a, b) => b.version - a.version)
}

/**
 * Versions ClusterLayoutSkipDeadNodes accepts: newer than the oldest live
 * version (Garage's min_stored) and at most the current one.
 */
function skipTargets(h: LayoutHistory): number[] {
  const live = liveVersions(h)
  if (live.length < 2) return []
  const minStored = Math.min(...live.map((v) => v.version))
  return live.map((v) => v.version).filter((v) => v > minStored && v <= h.currentVersion)
}

function StepBadge({ state }: { state: StepState }) {
  if (state === 'completed') {
    return (
      <Badge className="bg-green-600 text-white hover:bg-green-600">
        <CheckCircle2 className="h-3 w-3" aria-hidden /> 完了
      </Badge>
    )
  }
  if (state === 'inprogress') {
    return (
      <Badge>
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> 進行中
      </Badge>
    )
  }
  return (
    <Badge variant="outline">
      <Hourglass className="h-3 w-3" aria-hidden /> 待機中
    </Badge>
  )
}

/**
 * Shows the progress of a layout update (GetClusterLayoutHistory) and offers
 * the "force update" escape hatch (ClusterLayoutSkipDeadNodes). Polls every
 * 5 s while an update is in flight and the tab is visible.
 */
export function LayoutUpdateTracker() {
  const history = useQuery({
    queryKey: ['cluster', 'layout', 'history'],
    queryFn: getLayoutHistory,
    refetchInterval: (query) => (isUpdateInFlight(query.state.data) ? 5000 : false),
    refetchIntervalInBackground: false,
  })
  const [showForce, setShowForce] = useState(false)

  if (history.isLoading) return null
  if (history.isError) {
    return (
      <p className="text-sm text-destructive">
        レイアウト更新状況の取得に失敗しました: {history.error.message}
      </p>
    )
  }
  const h = history.data
  if (!h) return null

  if (!isUpdateInFlight(h)) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <CheckCircle2 className="h-4 w-4 text-green-600" aria-hidden />
        レイアウト v{h.currentVersion} は全ノードに反映済みです
      </p>
    )
  }

  const { steps, total } = computeSteps(h)
  const live = liveVersions(h)

  return (
    <div className="space-y-4 rounded-lg border border-amber-300 bg-amber-50/50 p-4 dark:bg-amber-950/20">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">レイアウト更新中 (v{h.currentVersion})</h2>
        <span className="text-xs text-muted-foreground">5 秒ごとに自動更新</span>
      </div>

      <ol className="grid gap-3 md:grid-cols-3">
        {steps.map((s, i) => (
          <li key={s.name} className="space-y-1 rounded-md border bg-background p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">
                {i + 1}. {s.name}
              </span>
              <StepBadge state={s.state} />
            </div>
            <p className="text-sm">
              {total > 0 ? `${s.progress}/${total} ノード` : 'ノード情報なし'}
            </p>
            <p className="text-xs text-muted-foreground">{s.hint}</p>
          </li>
        ))}
      </ol>

      <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground">稼働中のバージョン:</span>
          {live.map((v) => (
            <span key={v.version} className="flex items-center gap-1">
              v{v.version}
              <Badge
                variant={v.status === 'Current' ? 'default' : 'secondary'}
                className={v.status === 'Draining' ? 'bg-amber-200 text-amber-900 dark:bg-amber-900 dark:text-amber-100' : undefined}
              >
                {v.status === 'Current' ? 'current' : 'draining'}
              </Badge>
            </span>
          ))}
          <span className="text-xs text-muted-foreground">(minAck v{h.minAck})</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">停止ノードのせいで進まない場合:</span>
          <Button variant="outline" size="sm" onClick={() => setShowForce(true)} disabled={skipTargets(h).length === 0}>
            Force update
          </Button>
        </div>
      </div>

      {showForce && (
        <ForceUpdateDialog history={h} open={showForce} onOpenChange={setShowForce} />
      )}
    </div>
  )
}

function ForceUpdateDialog({
  history,
  open,
  onOpenChange,
}: {
  history: LayoutHistory
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const targets = skipTargets(history)
  const [version, setVersion] = useState<number>(targets[0] ?? history.currentVersion)
  const [allowMissingData, setAllowMissingData] = useState(false)

  const mutation = useMutation({
    mutationFn: skipDeadNodes,
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['cluster', 'layout'] })
      const acked = res.ackUpdated?.length ?? 0
      const synced = res.syncUpdated?.length ?? 0
      toast.success(
        `v${version} への更新を強制しました (ack 更新 ${acked} ノード${allowMissingData ? ` / sync 更新 ${synced} ノード` : ''})`,
      )
      onOpenChange(false)
    },
  })

  // Same semantics as ConfirmDialog: not dismissible while pending, stays open on failure.
  const handleOpenChange = (next: boolean) => {
    if (!next && mutation.isPending) return
    onOpenChange(next)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>レイアウト更新の強制 (Skip dead nodes)</DialogTitle>
          <DialogDescription>
            停止中のノードや同期を完了できないノードがあるとレイアウト更新が先に進みません。
            停止中のノードの ack を指定バージョンまで進めて、更新を先に進めます。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          <label className="block space-y-1">
            <span className="font-medium">最新とみなすバージョン</span>
            <select
              value={version}
              onChange={(e) => setVersion(Number(e.target.value))}
              disabled={mutation.isPending}
              className="block w-full rounded-md border bg-background px-2 py-1"
            >
              {targets.map((v) => (
                <option key={v} value={v}>
                  v{v}{v === history.currentVersion ? ' (current)' : ''}
                </option>
              ))}
            </select>
          </label>

          <div className="space-y-1 rounded-md border border-destructive/50 bg-destructive/5 p-3">
            <div className="flex items-start gap-2">
              <Checkbox
                id="force-allow-missing-data"
                checked={allowMissingData}
                onCheckedChange={(c) => setAllowMissingData(c === true)}
                disabled={mutation.isPending}
                className="mt-0.5"
              />
              <label htmlFor="force-allow-missing-data" className="space-y-1">
                <span className="font-medium text-destructive">
                  危険: データ欠損を許容する (allowMissingData)
                </span>
                <span className="block text-xs text-muted-foreground">
                  残りのノードでクォーラムを確保できなくても強制します。稼働中を含む全ノードの sync を進めるため、
                  停止ノードにしか無いデータは失われる可能性があります。通常は OFF のままにしてください。
                </span>
              </label>
            </div>
          </div>

          {mutation.isError && (
            <p className="rounded-md bg-destructive/10 p-2 text-destructive">
              強制更新に失敗しました: {mutation.error.message}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={mutation.isPending}>
            キャンセル
          </Button>
          <Button
            variant={allowMissingData ? 'destructive' : 'default'}
            onClick={() => mutation.mutate({ version, allowMissingData })}
            disabled={mutation.isPending || targets.length === 0}
          >
            {mutation.isPending ? '実行中...' : allowMissingData ? 'データ欠損を許容して強制' : '強制更新'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
