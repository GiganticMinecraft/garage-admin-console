import { useMemo, useState } from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery } from '@tanstack/react-query'
import {
  getClusterHealth,
  getClusterStatus,
  getStorageHealth,
  launchRepair,
  listBlockErrors,
  type RepairType,
} from '@/api'
import {
  blockErrorsCard,
  blockErrorsCoverage,
  decideMaintenanceStatus,
  nodeStatsInput,
  resyncErrorsCard,
  resyncQueueCard,
  scrubCorruptionCard,
  staleCard,
  summarizeNodeMetric,
  type CardSpec,
  type FetchState,
} from '@/lib/maintenance-status'
import { showMultiResponseToast } from '@/lib/multi-response'
import { nonStorageNodeIds } from '@/lib/nodes'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { toast } from 'sonner'
import { REPAIR_OPERATIONS, SCRUB_COMMANDS } from '@/lib/repair-operations'
import { PAGE_POLLING } from '@/lib/polling'
import { RefreshIndicator } from '@/components/refresh-indicator'
import { useDocumentTitle } from '@/hooks/use-document-title'

export const Route = createFileRoute('/repair')({
  component: RepairPage,
})

const PLAYBOOKS: {
  title: string
  summary: string
  steps: { text: string; link?: { to: string; label: string } }[]
}[] = [
  {
    title: 'ノード追加・削除などのレイアウト変更後',
    summary: '最もよくあるメンテナンス手順です。',
    steps: [
      { text: 'レイアウトの適用後、数時間待ってリシンクが収まらなければ「ブロック整合性検証」を実行' },
      { text: 'エラーが残る場合はブロックエラーページで対象を確認', link: { to: '/blocks', label: 'ブロックエラー' } },
      { text: '必要なら purge してから blockRefs / blockRc を実行' },
    ],
  },
  {
    title: 'リシンクエラーが出ているとき',
    summary: 'まずどのブロックが失敗しているか確認します。',
    steps: [
      { text: 'ブロックエラーページでエラーの詳細を確認', link: { to: '/blocks', label: 'ブロックエラー' } },
      { text: '復旧不能なブロックは purge し、その後 blockRefs / blockRc を実行' },
      { text: 'キューが空にならない場合のみ「リシンクキューのクリア」を検討' },
    ],
  },
  {
    title: 'Scrub の確認と手動実行',
    summary: 'Scrub は 25〜35 日ごとに自動実行されます。通常は手動で実行する必要はありません。',
    steps: [
      { text: 'ワーカーページで「Block scrub worker」の最終実行日時と次回予定を確認', link: { to: '/workers', label: 'ワーカー' } },
      { text: 'ディスク I/O エラーの兆候があれば、次回予定を待たずに手動で Scrub を開始' },
      { text: '「破損検出回数」が増加していればディスク交換を検討' },
    ],
  },
  {
    title: '大規模障害からの復旧',
    summary: '広範囲の整合性確認が必要な場合の手順です。',
    steps: [
      { text: 'メタデータの異常が疑われるなら「テーブル修復」を実行' },
      { text: 'データの再配置には「ブロック整合性検証」を実行' },
      { text: 'バージョンやブロック参照の不整合があれば個別の修復を追加' },
    ],
  },
]

const SEVERITY_VARIANT = {
  low: 'secondary',
  medium: 'default',
  high: 'destructive',
} as const

const SEVERITY_LABEL = {
  low: 'まれに使用',
  medium: '障害時に使用',
  high: '最終手段',
}

/** react-query status → the decision's FetchState. */
function fetchState(q: { isPending: boolean; isError: boolean }): FetchState {
  return q.isError ? 'error' : q.isPending ? 'pending' : 'success'
}

function SignalCard({
  title,
  value,
  hint,
  tone = 'neutral',
}: {
  title: string
  value: string
  hint: string
  tone?: 'neutral' | 'warning' | 'danger'
}) {
  const valueClass =
    tone === 'danger'
      ? 'text-destructive'
      : tone === 'warning'
        ? 'text-amber-600 dark:text-amber-400'
        : 'text-foreground'

  return (
    <div className="rounded-lg border p-4 space-y-2">
      <p className="text-sm text-muted-foreground">{title}</p>
      <p className={`text-2xl font-semibold ${valueClass}`}>{value}</p>
      <p className="text-sm text-muted-foreground">{hint}</p>
    </div>
  )
}

function CardSkeleton() {
  return (
    <div className="rounded-lg border p-4 space-y-2">
      <Skeleton className="h-4 w-24" />
      <Skeleton className="h-8 w-20" />
      <Skeleton className="h-4 w-full" />
    </div>
  )
}

function SectionSkeleton() {
  return (
    <div className="grid gap-3 md:grid-cols-3">
      {Array.from({ length: 3 }).map((_, i) => (
        <CardSkeleton key={i} />
      ))}
    </div>
  )
}

function RepairPage() {
  useDocumentTitle('メンテナンス')
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [pendingRepairType, setPendingRepairType] = useState<RepairType | null>(null)
  const [pendingLabel, setPendingLabel] = useState('')
  const [pendingSeverity, setPendingSeverity] = useState<'low' | 'medium' | 'high'>('medium')

  const health = useQuery({
    queryKey: ['cluster', 'health'],
    queryFn: getClusterHealth,
    ...PAGE_POLLING,
  })

  const blockErrors = useQuery({
    queryKey: ['blockErrors'],
    queryFn: listBlockErrors,
    ...PAGE_POLLING,
  })

  // Per-node resync stats and scrub-corruptions_detected, the same source as
  // the dashboard (one GetNodeStatistics fan-out, cached server-side). Own
  // key: the dashboard caches a derived shape under ['cluster', 'storage-health'].
  const storageHealth = useQuery({
    queryKey: ['maintenance', 'storage-health'],
    queryFn: getStorageHealth,
    ...PAGE_POLLING,
  })
  const refreshAll = () => Promise.all([health.refetch(), blockErrors.refetch(), storageHealth.refetch()])
  const updatedAt = Math.max(health.dataUpdatedAt, blockErrors.dataUpdatedAt, storageHealth.dataUpdatedAt)

  // Hostnames for the per-node breakdown, and which nodes hold no blocks
  // (gateways are left out of block-level coverage); shares the dashboard's cache.
  const status = useQuery({
    queryKey: ['cluster', 'status'],
    queryFn: getClusterStatus,
  })
  const nodeNames = useMemo(
    () => new Map((status.data?.nodes ?? []).flatMap((n) => (n.hostname ? [[n.id, n.hostname] as const] : []))),
    [status.data],
  )
  const skip = useMemo(() => nonStorageNodeIds(status.data?.nodes), [status.data])

  const mutation = useMutation({
    mutationFn: (repairType: RepairType) => launchRepair(repairType),
    onSuccess: (resp) => {
      showMultiResponseToast(resp, {
        action: '操作',
        successMessage: () => '操作を実行しました',
      })
    },
    onError: (error) => toast.error(`操作に失敗しました: ${error.message}`),
  })

  const requestRepair = (
    repairType: RepairType,
    label: string,
    severity: 'low' | 'medium' | 'high',
  ) => {
    setPendingRepairType(repairType)
    setPendingLabel(label)
    setPendingSeverity(severity)
    setConfirmOpen(true)
  }

  const isClusterHealthy = health.data?.status === 'healthy'
  const coverage = blockErrorsCoverage(blockErrors.data, skip)
  const blockErrorsInput = {
    state: fetchState(blockErrors),
    count: coverage.count,
    checkedNodeCount: coverage.checkedNodeCount,
    nodeErrorCount: coverage.nodeErrors.length,
  }
  const recommendation = decideMaintenanceStatus({
    health: { state: fetchState(health), status: health.data?.status },
    blockErrors: blockErrorsInput,
    nodeStats: nodeStatsInput(fetchState(storageHealth), storageHealth.data, skip),
  })
  const blockErrorsSpec = blockErrorsCard(blockErrorsInput)

  // Decided on data presence, not isError: a paused query (offline) has
  // neither. When a refetch failed over cached data, keep the values but
  // flag them as stale.
  const sh = storageHealth.data
  const opts = { names: nodeNames, skip }
  const stale = (spec: CardSpec) =>
    storageHealth.isError ? staleCard(spec, (storageHealth.errorUpdatedAt - storageHealth.dataUpdatedAt) / 1000) : spec
  const metricCards: { title: string; spec: CardSpec }[] | null = sh
    ? [
        { title: 'リシンクエラー数', spec: stale(resyncErrorsCard(summarizeNodeMetric(sh, (n) => n.resyncErrors, 'stats', opts))) },
        { title: 'リシンクキュー長', spec: stale(resyncQueueCard(summarizeNodeMetric(sh, (n) => n.resyncQueueLen, 'stats', opts))) },
        { title: '破損検出回数 (累積)', spec: stale(scrubCorruptionCard(summarizeNodeMetric(sh, (n) => n.scrubCorruptions, 'vars', opts))) },
      ]
    : null

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold">メンテナンス</h1>
          <p className="text-muted-foreground">
            クラスタの状態を確認し、必要な修復操作を実行します。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <RefreshIndicator updatedAt={updatedAt} onRefresh={refreshAll} />
          <Button asChild variant="outline" size="sm">
            <Link to="/blocks">ブロックエラーを見る</Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link to="/layout">レイアウトを確認</Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <a href="https://grafana.onp-k8s.admin.seichi.click/d/garage-block-metrics/45d7fdb?orgId=1" target="_blank" rel="noopener noreferrer">
              メトリクス推移 (Grafana)
            </a>
          </Button>
        </div>
      </div>

      <div className="space-y-3">
        <h2 className="text-lg font-semibold">クラスタの状態</h2>
        {health.isLoading || blockErrors.isLoading ? (
          <SectionSkeleton />
        ) : (
          <div className="grid gap-3 md:grid-cols-3">
            <SignalCard
              title="ヘルスステータス"
              value={health.isError ? '取得失敗' : isClusterHealthy ? 'healthy' : health.data?.status ?? 'unknown'}
              hint={
                health.isError
                  ? 'Garage API に接続できませんでした。'
                  : isClusterHealthy
                    ? 'クラスタは正常です。'
                    : 'クラスタに異常があります。'
              }
              tone={health.isError ? 'warning' : isClusterHealthy ? 'neutral' : 'warning'}
            />
            <SignalCard
              title="ブロックエラー数"
              value={blockErrorsSpec.value}
              hint={blockErrorsSpec.hint}
              tone={blockErrorsSpec.tone}
            />
            <SignalCard
              title="推奨アクション"
              value={recommendation.value}
              hint={recommendation.hint}
              tone={recommendation.tone}
            />
          </div>
        )}
      </div>

      <div className="space-y-3">
        <h2 className="text-lg font-semibold">ブロック管理メトリクス</h2>
        {storageHealth.isLoading ? (
          <SectionSkeleton />
        ) : (
          <div className="grid gap-3 md:grid-cols-3">
            {metricCards
              ? metricCards.map(({ title, spec }) => (
                  <SignalCard key={title} title={title} value={spec.value} hint={spec.hint} tone={spec.tone} />
                ))
              : ['リシンクエラー数', 'リシンクキュー長', '破損検出回数 (累積)'].map((title) => (
                  <SignalCard
                    key={title}
                    title={title}
                    value="取得失敗"
                    hint="Garage のノード別ストレージ情報 (/api/cluster/storage-health) を取得できませんでした。"
                    tone="warning"
                  />
                ))}
          </div>
        )}
      </div>

      <div className="space-y-3">
        <h2 className="text-lg font-semibold">よくある対応手順</h2>
        <div className="grid gap-3 lg:grid-cols-2">
          {PLAYBOOKS.map((playbook) => (
            <div key={playbook.title} className="rounded-lg border p-4 space-y-3">
              <div>
                <h3 className="font-medium">{playbook.title}</h3>
                <p className="text-sm text-muted-foreground">{playbook.summary}</p>
              </div>
              <ol className="space-y-2 text-sm text-muted-foreground">
                {playbook.steps.map((step, index) => (
                  <li key={step.text} className="flex gap-3">
                    <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-secondary text-xs text-secondary-foreground">
                      {index + 1}
                    </span>
                    <span>
                      {step.text}
                      {step.link && (
                        <>
                          {' → '}
                          <Link to={step.link.to} className="text-primary underline underline-offset-4 hover:text-primary/80">
                            {step.link.label}
                          </Link>
                        </>
                      )}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </div>
      </div>

      <div className="space-y-3">
        <h2 className="text-lg font-semibold">修復操作</h2>
        <div className="grid gap-3">
          {REPAIR_OPERATIONS.map((op) => (
            <div key={op.value} className="rounded-lg border p-4 space-y-3">
              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <h3 className="font-medium">{op.label}</h3>
                    <Badge variant={SEVERITY_VARIANT[op.severity]}>{SEVERITY_LABEL[op.severity]}</Badge>
                  </div>
                  <p className="text-sm text-muted-foreground">{op.description}</p>
                </div>
                <Button
                  size="sm"
                  variant={op.severity === 'high' ? 'destructive' : 'default'}
                  disabled={mutation.isPending}
                  onClick={() => requestRepair(op.value, op.label, op.severity)}
                >
                  実行
                </Button>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <div className="rounded-md bg-muted/40 p-3">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">いつ使うか</p>
                  <p className="mt-1 text-sm">{op.when}</p>
                </div>
                <div className="rounded-md bg-muted/40 p-3">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">注意</p>
                  <p className="mt-1 text-sm">{op.caution}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="space-y-3">
        <div>
          <h2 className="text-lg font-semibold">Scrub</h2>
          <p className="text-sm text-muted-foreground">
            全ブロックのチェックサムを検証し、破損データを検出します。
            25〜35 日ごとに自動実行されるため、通常は手動操作は不要です。
            ディスク障害の疑いがあるときに即座に開始したい場合や、I/O 負荷を制御したい場合に使います。
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {SCRUB_COMMANDS.map((cmd) => (
            <div key={cmd.value} className="rounded-lg border p-4 space-y-3">
              <div className="space-y-1">
                <h3 className="font-medium">Scrub {cmd.label}</h3>
                <p className="text-sm text-muted-foreground">{cmd.description}</p>
              </div>
              <Button
                size="sm"
                variant={cmd.value === 'cancel' ? 'destructive' : 'outline'}
                disabled={mutation.isPending}
                onClick={() => requestRepair({ scrub: cmd.value }, `Scrub ${cmd.label}`, 'medium')}
              >
                実行
              </Button>
            </div>
          ))}
        </div>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`${pendingLabel}の実行`}
        description={
          pendingSeverity === 'high'
            ? 'この操作は最終手段です。ブロックエラーページで原因を確認し、必要な purge を済ませたうえで実行してください。'
            : 'この操作を全ノードに対して実行します。クラスタの負荷が一時的に上がる可能性があります。'
        }
        onConfirm={() => {
          if (pendingRepairType) return mutation.mutateAsync(pendingRepairType)
        }}
        isPending={mutation.isPending}
        confirmLabel="実行"
        pendingLabel="実行中..."
        confirmVariant={pendingSeverity === 'high' ? 'destructive' : 'default'}
      />
    </div>
  )
}
