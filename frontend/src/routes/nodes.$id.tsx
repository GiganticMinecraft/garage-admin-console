import { useMemo, useState, type ReactNode } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react'
import { toast } from 'sonner'
import {
  createMetadataSnapshot,
  getClusterStatus,
  getNode,
  getNodeStats,
  getNodeWorkerVariables,
  launchNodeRepair,
  listNodeWorkers,
  setNodeWorkerVariable,
  type MultiResponse,
  type NodeInfo,
  type NodeStatistics,
  type PartitionUsage,
  type RepairType,
  type WorkerVariables,
} from '@/api'
import { REPAIR_OPERATIONS, SCRUB_COMMANDS } from '@/lib/repair-operations'
import { formatBytes } from '@/lib/format'
import { USAGE_CRIT, USAGE_WARN } from '@/lib/thresholds'
import { STATE_RANK, describeState, formatSecsAgo, persistentErrorsLabel } from '@/lib/workers'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { CopyButton } from '@/components/copy-button'
import { useDocumentTitle } from '@/hooks/use-document-title'

export const Route = createFileRoute('/nodes/$id')({
  component: NodeDetailPage,
})

/**
 * Turns a MultiResponse from a mutating node endpoint into a toast. When no
 * node succeeded it throws, so the mutation fails and ConfirmDialog stays open.
 */
function reportMulti<T>(resp: MultiResponse<T>, action: string): void {
  const ok = Object.keys(resp.success ?? {}).length
  const errors = Object.entries(resp.error ?? {})
  const errorText = errors.map(([n, m]) => `${n.slice(0, 8)}…: ${m}`).join(' / ')
  if (ok === 0) {
    throw new Error(errorText || '応答したノードがありません')
  }
  if (errors.length > 0) {
    toast.warning(`${action}: ${ok} ノードで成功、${errors.length} ノードで失敗 (${errorText})`)
  } else {
    toast.success(ok > 1 ? `${action}: ${ok} ノードで実行しました` : `${action}を実行しました`)
  }
}

// ---------------------------------------------------------------------------
// Header

function PartitionBar({ label, partition }: { label: string; partition: PartitionUsage | null | undefined }) {
  if (!partition) {
    return (
      <div className="flex justify-between text-sm text-muted-foreground">
        <span>{label}</span>
        <span>情報なし</span>
      </div>
    )
  }
  const used = partition.total - partition.available
  const percent = partition.total > 0 ? (used / partition.total) * 100 : 0
  const color =
    percent >= USAGE_CRIT * 100 ? 'bg-red-500' : percent >= USAGE_WARN * 100 ? 'bg-amber-500' : 'bg-blue-500'
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-sm">
        <span>{label}</span>
        <span className="text-muted-foreground">
          {formatBytes(used)} / {formatBytes(partition.total)} ({percent.toFixed(1)}%)・空き {formatBytes(partition.available)}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.min(percent, 100)}%` }} />
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="text-sm font-medium break-words">{children}</div>
    </div>
  )
}

function NodeHeader({ info }: { info: NodeInfo }) {
  const role = info.role
  return (
    <div className="space-y-4 rounded-lg border p-4">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Field label="ノード ID">
          <span className="flex items-center gap-1 font-mono">
            {info.nodeId.slice(0, 16)}…
            <CopyButton value={info.nodeId} label="ノード ID をコピー" />
          </span>
        </Field>
        <Field label="アドレス">
          <span className="font-mono">{info.addr ?? '不明'}</span>
        </Field>
        <Field label="ゾーン">
          {role ? (
            <Badge variant="secondary">{role.zone}</Badge>
          ) : info.draining ? (
            <Badge variant="destructive" title="レイアウトから外されましたが、まだデータを保持しています">draining</Badge>
          ) : (
            <Badge variant="outline">ロール未割当</Badge>
          )}
        </Field>
        <Field label="容量">
          {role ? (role.capacity != null ? formatBytes(role.capacity) : 'ゲートウェイ') : '-'}
        </Field>
        <Field label="タグ">
          {role && role.tags.length > 0 ? (
            <span className="flex flex-wrap gap-1">
              {role.tags.map((t) => (
                <Badge key={t} variant="outline">{t}</Badge>
              ))}
            </span>
          ) : (
            <span className="text-muted-foreground">なし</span>
          )}
        </Field>
        <Field label="Garage バージョン">{info.garageVersion}</Field>
        <Field label="DB エンジン">{info.dbEngine}</Field>
        <Field label="rustc">{info.rustVersion}</Field>
      </div>
      {info.garageFeatures && info.garageFeatures.length > 0 && (
        <Field label="ビルド機能 (features)">
          <span className="flex flex-wrap gap-1 pt-1">
            {info.garageFeatures.map((f) => (
              <Badge key={f} variant="outline" className="font-mono text-xs font-normal">{f}</Badge>
            ))}
          </span>
        </Field>
      )}
      <div className="space-y-3">
        <PartitionBar label="データパーティション" partition={info.dataPartition} />
        <PartitionBar label="メタデータパーティション" partition={info.metadataPartition} />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Statistics

function StatsSection({ stats }: { stats: NodeStatistics }) {
  const bm = stats.blockManagerStats
  const tables = stats.tableStats
  return (
    <div className="space-y-4">
      {bm ? (
        <div className="grid gap-3 md:grid-cols-3">
          <StatCard title="RC エントリ数" value={bm.rcEntries} hint="参照カウンタのエントリ数 (≒ ブロック数)" />
          <StatCard title="リシンクキュー長" value={bm.resyncQueueLen} hint="リシンク待ちのブロック数" />
          <StatCard
            title="リシンクエラー"
            value={bm.resyncErrors}
            hint="リシンクに失敗しているブロック数"
            danger={bm.resyncErrors > 0}
          />
        </div>
      ) : null}
      {tables ? (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/50">
                <TableHead>テーブル</TableHead>
                <TableHead className="text-right">アイテム</TableHead>
                <TableHead className="text-right">Merkle アイテム</TableHead>
                <TableHead className="text-right">Merkle キュー</TableHead>
                <TableHead className="text-right">挿入キュー</TableHead>
                <TableHead className="text-right">GC キュー</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tables.map((t) => (
                <TableRow key={t.tableName}>
                  <TableCell className="font-mono text-sm">{t.tableName}</TableCell>
                  <TableCell className="text-right tabular-nums">{t.items.toLocaleString()}</TableCell>
                  <TableCell className="text-right tabular-nums">{t.merkleItems.toLocaleString()}</TableCell>
                  <QueueCell value={t.merkleQueueLen} />
                  <QueueCell value={t.insertQueueLen} />
                  <QueueCell value={t.gcQueueLen} />
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}
      {!bm && !tables && (
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground">
            このノードは構造化された統計を返しませんでした (Garage v2.3.0 未満)。生の出力を表示します。
          </p>
          <pre className="overflow-x-auto rounded-lg border bg-muted/40 p-3 text-xs">{stats.freeform}</pre>
        </div>
      )}
    </div>
  )
}

function QueueCell({ value }: { value: number }) {
  return (
    <TableCell className={`text-right tabular-nums ${value > 0 ? 'font-medium text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}`}>
      {value.toLocaleString()}
    </TableCell>
  )
}

function StatCard({ title, value, hint, danger }: { title: string; value: number; hint: string; danger?: boolean }) {
  return (
    <div className="space-y-1 rounded-lg border p-4">
      <p className="text-sm text-muted-foreground">{title}</p>
      <p className={`text-2xl font-semibold tabular-nums ${danger ? 'text-destructive' : ''}`}>{value.toLocaleString()}</p>
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Worker variables

interface TunableVariable {
  name: string
  label: string
  description: string
  min: number
  /** Slider upper bound; the number input accepts larger values when maxInput allows. */
  sliderMax: number
  maxInput?: number
  /** true when a larger value means faster / more disk load (worker count). */
  higherIsFaster: boolean
}

const TUNABLE_VARIABLES: TunableVariable[] = [
  {
    name: 'resync-tranquility',
    label: 'リシンク tranquility',
    description: 'ブロックのリシンク 1 回ごとに、処理時間の何倍休むか。0 で休まず全力、大きいほどディスク負荷が下がります (既定 2)。',
    min: 0,
    sliderMax: 20,
    higherIsFaster: false,
  },
  {
    name: 'resync-worker-count',
    label: 'リシンクワーカー数',
    description: '並行して動くリシンクワーカーの数 (1〜8、既定 1)。増やすとキューが早く減る一方でディスクとネットワークの負荷が上がります。',
    min: 1,
    sliderMax: 8,
    maxInput: 8,
    higherIsFaster: true,
  },
  {
    name: 'scrub-tranquility',
    label: 'Scrub tranquility',
    description: 'Scrub でブロックを 1 つ検証するごとに、処理時間の何倍休むか。大きいほど Scrub は遅くなりますがディスクを温存します (既定 4)。',
    min: 0,
    sliderMax: 20,
    higherIsFaster: false,
  },
]

const READONLY_VARIABLES: { name: string; label: string }[] = [
  { name: 'scrub-last-completed', label: 'Scrub 最終完了' },
  { name: 'scrub-next-run', label: 'Scrub 次回予定' },
  { name: 'scrub-corruptions_detected', label: 'Scrub 破損検出数 (累積)' },
  { name: 'lifecycle-last-completed', label: 'ライフサイクル最終完了' },
]

function formatVariableValue(name: string, value: string): string {
  if (value === 'never') return '未実行'
  if (name.endsWith('-last-completed') || name.endsWith('-next-run')) {
    const d = new Date(value)
    if (!Number.isNaN(d.getTime()) && value.includes('T')) return d.toLocaleString('ja-JP')
  }
  return value
}

function WorkerVariablesCard({ nodeId, vars }: { nodeId: string; vars: WorkerVariables }) {
  const queryClient = useQueryClient()
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [allNodes, setAllNodes] = useState(false)

  const mutation = useMutation({
    mutationFn: async (body: { variable: string; value: string; allNodes: boolean }) => {
      const { variable, value } = body
      const resp = await setNodeWorkerVariable(nodeId, body)
      reportMulti(resp, `${variable} を ${value} に変更`)
      return variable
    },
    onSuccess: (variable) => {
      setDrafts((d) => {
        const next = { ...d }
        delete next[variable]
        return next
      })
      queryClient.invalidateQueries({ queryKey: ['node', nodeId, 'worker-variables'] })
      queryClient.invalidateQueries({ queryKey: ['node', nodeId, 'workers'] })
    },
    onError: (error) => toast.error(`worker 変数の変更に失敗しました: ${error.message}`),
  })

  const known = new Set([...TUNABLE_VARIABLES, ...READONLY_VARIABLES].map((v) => v.name))
  const others = Object.entries(vars).filter(([k]) => !known.has(k)).sort(([a], [b]) => a.localeCompare(b))

  return (
    <div className="space-y-4 rounded-lg border p-4">
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Worker 変数</h2>
          <p className="text-sm text-muted-foreground">
            リシンクと Scrub の速度を調整します。変更は即座に反映され、ノードの再起動後も保持されます。
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={allNodes} onCheckedChange={(v) => setAllNodes(v === true)} />
          全ノードに適用
        </label>
      </div>

      <div className="space-y-5">
        {TUNABLE_VARIABLES.map((tv) => {
          const current = vars[tv.name]
          if (current === undefined) {
            return (
              <div key={tv.name} className="text-sm text-muted-foreground">
                {tv.label}: このノードでは利用できません
              </div>
            )
          }
          const draft = drafts[tv.name] ?? current
          const n = Number(draft)
          const valid =
            draft.trim() !== '' &&
            Number.isInteger(n) &&
            n >= tv.min &&
            (tv.maxInput === undefined || n <= tv.maxInput)
          const changed = draft !== current
          const sliderMax = Math.max(tv.sliderMax, Number(current) || 0)
          const fastLabel = '速い・ディスク負荷高'
          const slowLabel = '遅い・ディスク温存'
          return (
            <div key={tv.name} className="space-y-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div>
                  <span className="font-medium">{tv.label}</span>
                  <span className="ml-2 font-mono text-xs text-muted-foreground">{tv.name}</span>
                </div>
                <span className="text-sm text-muted-foreground">
                  現在値 <span className="font-medium text-foreground tabular-nums">{current}</span>
                </span>
              </div>
              <p className="text-sm text-muted-foreground">{tv.description}</p>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <div className="flex-1 space-y-1">
                  <input
                    type="range"
                    min={tv.min}
                    max={sliderMax}
                    step={1}
                    value={Number.isFinite(n) ? Math.min(Math.max(n, tv.min), sliderMax) : tv.min}
                    onChange={(e) => setDrafts((d) => ({ ...d, [tv.name]: e.target.value }))}
                    className="w-full accent-primary"
                    aria-label={tv.label}
                  />
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>{tv.higherIsFaster ? slowLabel : fastLabel}</span>
                    <span>{tv.higherIsFaster ? fastLabel : slowLabel}</span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    min={tv.min}
                    max={tv.maxInput}
                    step={1}
                    value={draft}
                    onChange={(e) => setDrafts((d) => ({ ...d, [tv.name]: e.target.value }))}
                    className="w-24"
                    aria-invalid={!valid}
                    aria-label={`${tv.label} の値`}
                  />
                  <Button
                    size="sm"
                    disabled={!changed || !valid || mutation.isPending}
                    onClick={() => mutation.mutate({ variable: tv.name, value: String(n), allNodes })}
                  >
                    {allNodes ? '全ノードに適用' : '適用'}
                  </Button>
                  {changed && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={mutation.isPending}
                      onClick={() =>
                        setDrafts((d) => {
                          const next = { ...d }
                          delete next[tv.name]
                          return next
                        })
                      }
                    >
                      戻す
                    </Button>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>

      <div className="grid grid-cols-2 gap-3 border-t pt-4 md:grid-cols-4">
        {READONLY_VARIABLES.filter((v) => vars[v.name] !== undefined).map((v) => (
          <Field key={v.name} label={v.label}>
            {/* scrub-corruptions_detected is a lifetime counter: not colored as a current problem. */}
            <span>{formatVariableValue(v.name, vars[v.name])}</span>
          </Field>
        ))}
        {others.map(([k, v]) => (
          <Field key={k} label={k}>
            <span className="font-mono">{v}</span>
          </Field>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Maintenance

type RepairChoice = { key: string; value: RepairType; label: string; description: string; caution?: string; high: boolean }

const REPAIR_CHOICES: RepairChoice[] = [
  ...REPAIR_OPERATIONS.map((op) => ({
    key: op.value,
    value: op.value as RepairType,
    label: op.label,
    description: `${op.description} ${op.when}`,
    caution: op.caution,
    high: op.severity === 'high',
  })),
  ...SCRUB_COMMANDS.map((cmd) => ({
    key: `scrub-${cmd.value}`,
    value: { scrub: cmd.value } as RepairType,
    label: `Scrub ${cmd.label}`,
    description: cmd.description,
    high: false,
  })),
]

function MaintenanceCard({ nodeId, nodeName }: { nodeId: string; nodeName: string }) {
  const [choiceKey, setChoiceKey] = useState(REPAIR_CHOICES[0].key)
  const [repairOpen, setRepairOpen] = useState(false)
  const [snapshotOpen, setSnapshotOpen] = useState(false)
  const [snapshotAll, setSnapshotAll] = useState(false)
  const choice = REPAIR_CHOICES.find((c) => c.key === choiceKey) ?? REPAIR_CHOICES[0]

  const repair = useMutation({
    mutationFn: async (c: RepairChoice) => {
      reportMulti(await launchNodeRepair(nodeId, c.value), c.label)
    },
    onError: (error) => toast.error(`修復操作に失敗しました: ${error.message}`),
  })

  const snapshot = useMutation({
    mutationFn: async (all: boolean) => {
      reportMulti(await createMetadataSnapshot(nodeId, all), 'メタデータスナップショット')
    },
    onError: (error) => toast.error(`スナップショットの作成に失敗しました: ${error.message}`),
  })

  return (
    <div className="space-y-4 rounded-lg border p-4">
      <div>
        <h2 className="text-lg font-semibold">メンテナンス</h2>
        <p className="text-sm text-muted-foreground">
          このノードだけを対象に修復操作やスナップショットを実行します。全ノード対象の修復は
          <Link to="/repair" className="mx-1 text-primary underline underline-offset-4">メンテナンス</Link>
          ページから実行できます。
        </p>
      </div>

      <div className="space-y-2">
        <h3 className="font-medium">修復操作</h3>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <select
            value={choiceKey}
            onChange={(e) => setChoiceKey(e.target.value)}
            className="h-9 rounded-md border bg-background px-3 text-sm"
            aria-label="修復操作の種類"
          >
            {REPAIR_CHOICES.map((c) => (
              <option key={c.key} value={c.key}>{c.label}</option>
            ))}
          </select>
          <Button
            size="sm"
            variant={choice.high ? 'destructive' : 'default'}
            disabled={repair.isPending}
            onClick={() => setRepairOpen(true)}
          >
            このノードで実行
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">{choice.description}</p>
        {choice.caution && <p className="text-sm text-amber-700 dark:text-amber-500">注意: {choice.caution}</p>}
      </div>

      <div className="space-y-2 border-t pt-4">
        <h3 className="font-medium">メタデータスナップショット</h3>
        <p className="text-sm text-muted-foreground">
          メタデータ DB のスナップショットをメタデータディレクトリの snapshots/ に作成します。DB 破損時の復旧に使えます。
          自動スナップショット (metadata_auto_snapshot_interval) とは別に、作業前などに手動で取得したいときに使います。
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={snapshotAll} onCheckedChange={(v) => setSnapshotAll(v === true)} />
            全ノードで作成
          </label>
          <Button size="sm" variant="outline" disabled={snapshot.isPending} onClick={() => setSnapshotOpen(true)}>
            {snapshot.isPending ? '作成中...' : 'スナップショットを作成'}
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={repairOpen}
        onOpenChange={setRepairOpen}
        title={`${choice.label}の実行`}
        description={
          choice.high
            ? `${nodeName} で最終手段の操作を実行します。ブロックエラーページで原因を確認し、必要な purge を済ませたうえで実行してください。`
            : `${nodeName} に対してこの操作を実行します。ノードの負荷が一時的に上がる可能性があります。`
        }
        onConfirm={() => repair.mutateAsync(choice)}
        isPending={repair.isPending}
        confirmLabel="実行"
        pendingLabel="実行中..."
        confirmVariant={choice.high ? 'destructive' : 'default'}
      />
      <ConfirmDialog
        open={snapshotOpen}
        onOpenChange={setSnapshotOpen}
        title="メタデータスナップショットの作成"
        description={
          snapshotAll
            ? '全ノードでメタデータのスナップショットを作成します。完了までディスク I/O が増え、メタデータの容量を消費します。'
            : `${nodeName} でメタデータのスナップショットを作成します。完了までディスク I/O が増え、メタデータの容量を消費します。`
        }
        onConfirm={() => snapshot.mutateAsync(snapshotAll)}
        isPending={snapshot.isPending}
        confirmLabel="作成"
        pendingLabel="作成中..."
        confirmVariant="default"
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Workers

type SortKey = 'name' | 'state'

function SortIcon({ active, dir }: { active: boolean; dir: 1 | -1 }) {
  if (!active) return <ArrowUpDown className="h-3.5 w-3.5" />
  return dir === 1 ? <ArrowUp className="h-3.5 w-3.5" /> : <ArrowDown className="h-3.5 w-3.5" />
}

function WorkersSection({ nodeId }: { nodeId: string }) {
  const workers = useQuery({
    queryKey: ['node', nodeId, 'workers'],
    queryFn: () => listNodeWorkers(nodeId),
  })
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'name', dir: 1 })

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase()
    const list = (workers.data?.workers ?? [])
      .map((w) => {
        const state = describeState(w.state)
        return { w, state: { ...state, rank: STATE_RANK[state.kind] } }
      })
      .filter(({ w, state }) => !q || w.name.toLowerCase().includes(q) || state.label.includes(q))
    list.sort((a, b) => {
      const c =
        sort.key === 'name'
          ? a.w.name.localeCompare(b.w.name)
          : a.state.rank - b.state.rank || a.w.name.localeCompare(b.w.name)
      return c * sort.dir
    })
    return list
  }, [workers.data, search, sort])

  const toggleSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: 1 }))

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-lg font-semibold">
          ワーカー
          {workers.data && (
            <span className="ml-2 text-sm font-normal text-muted-foreground">{workers.data.workers.length} 件</span>
          )}
        </h2>
        <Input
          placeholder="名前・状態で検索"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="sm:w-64"
        />
      </div>
      {workers.isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : workers.isError ? (
        <p className="text-destructive">ワーカーを読み込めませんでした: {workers.error.message}</p>
      ) : Object.keys(workers.data?.errors ?? {}).length > 0 && rows.length === 0 ? (
        <p className="text-destructive">
          ワーカーを読み込めませんでした: {Object.values(workers.data?.errors ?? {}).join(' / ')}
        </p>
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground">{search ? '一致するワーカーがありません' : 'ワーカーがありません'}</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/50">
                <TableHead>
                  <button type="button" className="inline-flex items-center gap-1" onClick={() => toggleSort('name')}>
                    名前 <SortIcon active={sort.key === 'name'} dir={sort.dir} />
                  </button>
                </TableHead>
                <TableHead>
                  <button type="button" className="inline-flex items-center gap-1" onClick={() => toggleSort('state')}>
                    状態 <SortIcon active={sort.key === 'state'} dir={sort.dir} />
                  </button>
                </TableHead>
                <TableHead>詳細</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map(({ w, state }) => {
                const hasError = w.consecutiveErrors > 0
                return (
                  <TableRow key={w.id}>
                    <TableCell className="font-medium">{w.name || '-'}</TableCell>
                    <TableCell>
                      <Badge
                        variant={hasError ? 'destructive' : state.kind === 'busy' ? 'default' : state.kind === 'idle' ? 'secondary' : 'outline'}
                      >
                        {state.label}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      <div className="flex flex-wrap gap-x-4 gap-y-1">
                        {w.errors > 0 && (
                          <span className={hasError ? 'font-medium text-destructive' : ''}>
                            エラー: {w.errors}
                            {hasError ? `（連続 ${w.consecutiveErrors} 回）` : w.lastError ? `（${formatSecsAgo(w.lastError.secsAgo)}、回復済み）` : ''}
                          </span>
                        )}
                        {w.lastError && hasError && (
                          <span className="basis-full text-xs text-destructive">{w.lastError.message}</span>
                        )}
                        {w.queueLength != null && w.queueLength > 0 && (
                          <span>キュー: <span className="font-medium">{w.queueLength.toLocaleString()}</span></span>
                        )}
                        {w.tranquility != null && <span>tranquility: <span className="font-medium">{w.tranquility}</span></span>}
                        {w.progress != null && <span>進捗: <span className="font-medium">{w.progress}</span></span>}
                        {w.persistentErrors != null && w.persistentErrors > 0 && (
                          <span>{persistentErrorsLabel(w)}: <span className="font-medium">{w.persistentErrors}</span></span>
                        )}
                        {w.freeform.length > 0 && <span className="basis-full text-xs">{w.freeform.join(' / ')}</span>}
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Page

function NodeDetailPage() {
  useDocumentTitle('ノード詳細')
  const { id } = Route.useParams()

  // Cluster status still knows hostname / up state / last seen for nodes that
  // are down and therefore cannot answer GetNodeInfo themselves.
  const status = useQuery({ queryKey: ['cluster', 'status'], queryFn: getClusterStatus })
  const clusterNode = status.data?.nodes.find((n) => n.id === id || (id.length >= 8 && n.id.startsWith(id)))
  // Garage resolves `node=<id>` against the cluster layout, so nodes without
  // a role (not yet assigned in the layout) always answer 400 there. Wait for
  // the cluster status, then skip the per-node queries for those nodes. If
  // the status itself fails, still try the per-node queries.
  const unassigned = clusterNode != null && clusterNode.role == null
  const perNodeEnabled = !status.isPending && !unassigned

  const info = useQuery({ queryKey: ['node', id, 'info'], queryFn: () => getNode(id), retry: 1, enabled: perNodeEnabled })
  const stats = useQuery({ queryKey: ['node', id, 'stats'], queryFn: () => getNodeStats(id), retry: 1, enabled: perNodeEnabled })
  const vars = useQuery({
    queryKey: ['node', id, 'worker-variables'],
    queryFn: () => getNodeWorkerVariables(id),
    retry: 1,
    enabled: perNodeEnabled,
  })

  const hostname = info.data?.hostname ?? clusterNode?.hostname ?? null
  const fullId = info.data?.nodeId ?? clusterNode?.id ?? id
  const title = hostname || `${fullId.slice(0, 16)}…`
  const isUp = info.data?.isUp ?? clusterNode?.isUp
  const draining = info.data?.draining ?? clusterNode?.draining

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Link to="/" className="hover:underline">ダッシュボード</Link>
        <span>/</span>
        <span>ノード</span>
        <span>/</span>
        <span>{title}</span>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        {isUp !== undefined && isUp !== null && (
          <span className={`inline-block h-2.5 w-2.5 rounded-full ${isUp ? 'bg-green-500' : 'bg-red-500'}`} />
        )}
        <h1 className="text-2xl font-bold">{title}</h1>
        {isUp === true && <Badge variant="secondary">接続中</Badge>}
        {isUp === false && (
          <Badge variant="destructive">
            切断中
            {clusterNode?.lastSeenSecsAgo != null && ` (最終確認 ${formatSecsAgo(clusterNode.lastSeenSecsAgo)})`}
          </Badge>
        )}
        {draining && <Badge variant="destructive">draining</Badge>}
        <span className="flex items-center gap-1 font-mono text-xs text-muted-foreground">
          {fullId.slice(0, 16)}…
          <CopyButton value={fullId} label="ノード ID をコピー" />
        </span>
      </div>

      {status.isPending ? (
        <Skeleton className="h-48 w-full" />
      ) : unassigned ? (
        <div className="space-y-1 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4 text-sm">
          <p className="font-medium">レイアウト未割当のためノード別情報は取得できません</p>
          <p className="text-muted-foreground">
            Garage はノード指定の API をクラスタレイアウト上のノードに対してのみ解決します。
            <Link to="/layout" className="mx-1 text-primary underline underline-offset-4">レイアウト</Link>
            でロールを割り当てて適用すると、統計・Worker 変数・メンテナンス操作が使えるようになります。
          </p>
          <p className="text-muted-foreground">
            アドレス: <span className="font-mono">{clusterNode?.addr ?? '不明'}</span>・バージョン: {clusterNode?.garageVersion ?? '不明'}
          </p>
        </div>
      ) : (
        <>
        {info.isLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : info.isError ? (
          <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm">
            <p className="font-medium text-destructive">ノード情報を取得できませんでした</p>
            <p className="text-muted-foreground">{info.error.message}</p>
            {clusterNode && (
              <p className="mt-2 text-muted-foreground">
                クラスタステータス上のアドレス: <span className="font-mono">{clusterNode.addr ?? '不明'}</span>・バージョン:{' '}
                {clusterNode.garageVersion ?? '不明'}
              </p>
            )}
          </div>
        ) : (
          <NodeHeader info={info.data!} />
        )}

        <div className="space-y-3">
          <h2 className="text-lg font-semibold">統計</h2>
          {stats.isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : stats.isError ? (
            <p className="text-destructive">統計を取得できませんでした: {stats.error.message}</p>
          ) : (
            <StatsSection stats={stats.data!} />
          )}
        </div>

        {vars.isLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : vars.isError ? (
          <p className="text-destructive">Worker 変数を取得できませんでした: {vars.error.message}</p>
        ) : (
          <WorkerVariablesCard nodeId={id} vars={vars.data!} />
        )}

        <MaintenanceCard nodeId={id} nodeName={title} />

        <WorkersSection nodeId={id} />
        </>
      )}
    </div>
  )
}
