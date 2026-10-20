import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { CheckCircle2, Hourglass, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  getLayoutHistory,
  skipDeadNodes,
  type LayoutHistory,
  type LayoutNodeRole,
  type LayoutVersionInfo,
} from '@/api'
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
 * A layout update is in flight while more than one layout version is live;
 * Garage only returns update trackers in that case.
 */
function isUpdateInFlight(h: LayoutHistory | undefined): boolean {
  return h?.updateTrackers != null
}

/**
 * The tracker only needs each current-layout node's ID and whether it stores
 * data (capacity != null), so callers can pass GetClusterLayout's roles or
 * derive them from GetClusterStatus nodes (whose role is the current one).
 */
export type TrackerRole = Pick<LayoutNodeRole, 'id' | 'capacity'>

type StepState = 'completed' | 'inprogress' | 'waiting'

interface Step {
  name: string
  hint: string
  progress: number
  total: number
  state: StepState
}

/**
 * ack: the node knows the new version; sync: it finished copying metadata for
 * it; syncAck: it has seen the sync complete, so it reads from the new layout.
 * The populations follow Garage (src/rpc/layout/helper.rs, history.rs):
 * ack waits for every node, sync only for storage (non-gateway) nodes, and
 * syncAck for the nodes that have a role in the current layout. Storage nodes
 * and current-layout nodes come from GetClusterLayout's roles, so a node that
 * only had a role in an older live version is counted for ack only.
 * A step is only "in progress" once the previous one has completed.
 */
function computeSteps(h: LayoutHistory, roles: TrackerRole[]): Step[] {
  const trackers = Object.entries(h.updateTrackers ?? {})
  const storage = new Set(roles.filter((r) => r.capacity != null).map((r) => r.id))
  const current = new Set(roles.map((r) => r.id))
  const tally = (k: 'ack' | 'sync' | 'syncAck', among: (id: string) => boolean) => {
    const nodes = trackers.filter(([id]) => among(id))
    return { progress: nodes.filter(([, t]) => t[k] >= h.currentVersion).length, total: nodes.length }
  }
  const defs = [
    { name: 'レイアウトの伝播', hint: '全ノードが新しいバージョンを受け取る (ack)', ...tally('ack', () => true) },
    {
      name: 'メタデータ同期',
      hint: 'ストレージノードが新レイアウトでのメタデータを同期する (sync、gateway は対象外)',
      ...tally('sync', (id) => storage.has(id)),
    },
    {
      name: '新レイアウトへ切替',
      hint: '同期完了を確認し新レイアウトで読み書きする (syncAck、現レイアウトのノード)',
      ...tally('syncAck', (id) => current.has(id)),
    },
  ]
  let prevDone = true
  return defs.map((d) => {
    const done = d.progress === d.total
    const state: StepState = done ? 'completed' : prevDone ? 'inprogress' : 'waiting'
    prevDone = done
    return { ...d, state }
  })
}

/** Live (non-historical) versions, newest first. */
function liveVersions(h: LayoutHistory): LayoutVersionInfo[] {
  return h.versions.filter((v) => v.status !== 'Historical').sort((a, b) => b.version - a.version)
}

/**
 * Versions ClusterLayoutSkipDeadNodes accepts, newest first: newer than the
 * oldest live version (Garage's min_stored) and at most the current one.
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
 *
 * `compact` (dashboard) renders nothing unless an update is in flight, and
 * then a single-row banner of the steps linking to /layout, without the
 * force-update controls.
 */
export function LayoutUpdateTracker({ roles, compact = false }: { roles: TrackerRole[]; compact?: boolean }) {
  const history = useQuery({
    queryKey: ['cluster', 'layout', 'history'],
    queryFn: getLayoutHistory,
    // The dashboard (compact) also polls slowly while idle so that an update
    // started elsewhere shows up without a reload.
    refetchInterval: (query) => (isUpdateInFlight(query.state.data) ? 5000 : compact ? 30_000 : false),
    refetchIntervalInBackground: false,
  })
  const [showForce, setShowForce] = useState(false)

  if (history.isLoading) return null
  if (compact) {
    // On failure, say so instead of showing possibly stale "in progress" data.
    if (history.isError) {
      return (
        <p className="text-xs text-destructive">
          レイアウト更新状況を取得できませんでした: {history.error.message}
        </p>
      )
    }
    const ch = history.data
    if (!ch || !isUpdateInFlight(ch)) return null
    return <CompactTracker history={ch} roles={roles} />
  }
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
        <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400" aria-hidden />
        レイアウト v{h.currentVersion} は全ノードに反映済みです
      </p>
    )
  }

  const steps = computeSteps(h, roles)
  const live = liveVersions(h)

  return (
    <div className="space-y-4 rounded-lg border border-amber-300 bg-amber-50/50 dark:border-amber-500/40 p-4 dark:bg-amber-950/20">
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
              {s.progress}/{s.total} ノード
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

function CompactTracker({ history: h, roles }: { history: LayoutHistory; roles: TrackerRole[] }) {
  const steps = computeSteps(h, roles)
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-amber-300 bg-amber-50/50 dark:border-amber-500/40 px-4 py-3 text-sm dark:bg-amber-950/20">
      <span className="font-semibold">レイアウト更新中 (v{h.currentVersion})</span>
      {steps.map((s, i) => (
        <span key={s.name} className="flex items-center gap-1" title={s.hint}>
          {i + 1}. {s.name} {s.progress}/{s.total}
          <StepBadge state={s.state} />
        </span>
      ))}
      <Link to="/layout" className="ml-auto text-primary underline underline-offset-4">
        詳細・Force update
      </Link>
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
  const [selected, setSelected] = useState<number | null>(null)
  // The targets can change under the open dialog (history polls every 5 s),
  // so the shown and submitted version is clamped to the current targets.
  const version: number | undefined =
    selected != null && targets.includes(selected) ? selected : targets[0]
  const [allowMissingData, setAllowMissingData] = useState(false)

  const mutation = useMutation({
    mutationFn: skipDeadNodes,
    onSuccess: (res, vars) => {
      queryClient.invalidateQueries({ queryKey: ['cluster', 'layout'] })
      const acked = res.ackUpdated?.length ?? 0
      const synced = res.syncUpdated?.length ?? 0
      toast.success(
        `v${vars.version} への更新を強制しました (ack 更新 ${acked} ノード${vars.allowMissingData ? ` / sync 更新 ${synced} ノード` : ''})`,
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
              value={version ?? ''}
              onChange={(e) => setSelected(Number(e.target.value))}
              disabled={mutation.isPending || targets.length === 0}
              className="block w-full rounded-md border bg-background px-2 py-1"
            >
              {targets.length === 0 && <option value="">対象バージョンなし (更新は完了しています)</option>}
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
            onClick={() => {
              if (version != null) mutation.mutate({ version, allowMissingData })
            }}
            disabled={mutation.isPending || version == null}
          >
            {mutation.isPending ? '実行中...' : allowMissingData ? 'データ欠損を許容して強制' : '強制更新'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
