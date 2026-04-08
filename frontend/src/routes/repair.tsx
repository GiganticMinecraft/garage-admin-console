import { useState } from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery } from '@tanstack/react-query'
import {
  getClusterHealth,
  getMaintenanceMetrics,
  launchRepair,
  listBlockErrors,
  type RepairType,
  type ScrubCommand,
} from '@/api'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { toast } from 'sonner'

export const Route = createFileRoute('/repair')({
  component: RepairPage,
})

const REPAIR_OPERATIONS: {
  value: Exclude<RepairType, { scrub: ScrubCommand }>
  label: string
  description: string
  when: string
  caution: string
  severity: 'low' | 'medium' | 'high'
}[] = [
  {
    value: 'blocks',
    label: 'ブロック整合性検証',
    description: 'レプリカが不足しているブロックを検出し、他のノードからコピーして再配置します。',
    when: 'ノードの追加・削除・ゾーン変更などのレイアウト変更を適用した後、ノード障害や交換の後に実行します。',
    caution: 'リシンクが自然に収まるまで数時間待ってから実行してください。',
    severity: 'medium',
  },
  {
    value: 'blockRc',
    label: 'ブロック参照カウント修復',
    description: 'ブロックの参照カウントを全て再計算し、不整合を修正します。',
    when: 'ログに参照カウント不整合の警告が出ているとき、ブロックエラーが減らないとき。',
    caution: '原因がブロック参照側にある場合は blockRefs も合わせて実行してください。',
    severity: 'medium',
  },
  {
    value: 'tables',
    label: 'テーブル修復',
    description: 'メタデータテーブルの全体同期を手動で実行します。',
    when: 'メタデータの同期がおかしいとき、大規模障害からの復旧時に限定して使います。',
    caution: '毎時の自動同期があるため、通常は不要です。',
    severity: 'medium',
  },
  {
    value: 'versions',
    label: 'バージョン修復',
    description: '親オブジェクトが存在しない孤立バージョンを検出し、削除済みにマークします。',
    when: '複数ノードの長時間停止後にオブジェクトの一覧や取得がおかしいとき。',
    caution: '通常運用では使いません。',
    severity: 'medium',
  },
  {
    value: 'blockRefs',
    label: 'ブロック参照修復',
    description: '親バージョンが存在しない孤立ブロック参照を検出し、削除済みにマークします。',
    when: '孤立した参照がブロックの GC を妨げているとき。',
    caution: 'versions や blockRc と合わせて判断してください。',
    severity: 'medium',
  },
  {
    value: 'rebalance',
    label: 'リバランス',
    description: 'ストレージ間のデータ配置を均等化します。',
    when: 'ディスクやノードの追加後、容量配分の変更後に実行します。',
    caution: '障害対応ではなく、構成変更後の後処理です。',
    severity: 'low',
  },
  {
    value: 'multipartUploads',
    label: 'マルチパートアップロード修復',
    description: '親バージョンが存在しないマルチパートアップロードのメタデータを削除済みにマークします。',
    when: 'マルチパートアップロード周りだけが異常なとき。',
    caution: '一般的な障害対応で使うことはほぼありません。',
    severity: 'low',
  },
  {
    value: 'aliases',
    label: 'エイリアス修復',
    description: 'バケットエイリアスの不整合を修正します。',
    when: 'バケット名でのアクセスだけが壊れているとき。',
    caution: '非常にまれな用途です。',
    severity: 'low',
  },
  {
    value: 'clearResyncQueue',
    label: 'リシンクキューのクリア',
    description: 'リシンクキューを強制的に空にします。キューに残っているブロックは全てスキップされます。',
    when: '喪失が確定したブロックを purge した後、キューが空にならないときの最終手段です。',
    caution: '先にブロックエラーページで原因を確認し、必要な purge を済ませてから使ってください。',
    severity: 'high',
  },
]

const SCRUB_COMMANDS: { value: ScrubCommand; label: string; description: string }[] = [
  { value: 'start', label: '開始', description: '全ブロックのチェックサム検証を開始します。ディスク I/O が増加します。' },
  { value: 'pause', label: '一時停止', description: '実行中の Scrub を一時停止します。' },
  { value: 'resume', label: '再開', description: '一時停止中の Scrub を再開します。' },
  { value: 'cancel', label: 'キャンセル', description: '実行中の Scrub を中止します。' },
]

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
    title: '定期メンテナンス',
    summary: '四半期ごとを目安に Scrub を実行します。',
    steps: [
      { text: 'Scrub を開始してブロックの破損がないか検証' },
      { text: 'ディスク I/O エラーの兆候があれば定期外でも Scrub を実行' },
      { text: '上部の「破損検出回数」が増加していればディスク交換を検討' },
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
        ? 'text-amber-600'
        : 'text-foreground'

  return (
    <div className="rounded-lg border p-4 space-y-2">
      <p className="text-sm text-muted-foreground">{title}</p>
      <p className={`text-2xl font-semibold ${valueClass}`}>{value}</p>
      <p className="text-sm text-muted-foreground">{hint}</p>
    </div>
  )
}

function SectionSkeleton() {
  return (
    <div className="grid gap-3 md:grid-cols-3">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="rounded-lg border p-4 space-y-2">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-8 w-20" />
          <Skeleton className="h-4 w-full" />
        </div>
      ))}
    </div>
  )
}

function RepairPage() {
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [pendingRepairType, setPendingRepairType] = useState<RepairType | null>(null)
  const [pendingLabel, setPendingLabel] = useState('')
  const [pendingSeverity, setPendingSeverity] = useState<'low' | 'medium' | 'high'>('medium')

  const health = useQuery({
    queryKey: ['cluster', 'health'],
    queryFn: getClusterHealth,
  })

  const blockErrors = useQuery({
    queryKey: ['blockErrors'],
    queryFn: listBlockErrors,
  })

  const metrics = useQuery({
    queryKey: ['maintenance', 'metrics'],
    queryFn: getMaintenanceMetrics,
  })

  const mutation = useMutation({
    mutationFn: (repairType: RepairType) => launchRepair(repairType),
    onSuccess: (resp) => {
      const successCount = Object.keys(resp.success).length
      const errorCount = Object.keys(resp.error).length
      if (errorCount > 0) {
        const errors = Object.entries(resp.error).map(([n, m]) => `${n.slice(0, 12)}…: ${m}`).join(', ')
        toast.error(`${errorCount}ノードでエラー: ${errors}`)
      }
      if (successCount > 0) {
        toast.success(`${successCount}ノードで操作を実行しました`)
      }
    },
    onError: () => toast.error('操作に失敗しました'),
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

  const errorCount = blockErrors.data?.length ?? 0
  const shouldInvestigateBlocks = errorCount > 0
  const isClusterHealthy = health.data?.status === 'healthy'

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
          <Button asChild variant="outline" size="sm">
            <Link to="/blocks">ブロックエラーを見る</Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link to="/layout">レイアウトを確認</Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <a href="https://grafana.onp-k8s.admin.seichi.click/d/garage-block-metrics" target="_blank" rel="noopener noreferrer">
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
              value={blockErrors.isError ? '取得失敗' : errorCount.toString()}
              hint={
                blockErrors.isError
                  ? 'ブロックエラーの取得に失敗しました。'
                  : errorCount > 0
                    ? 'エラーがあります。ブロックエラーページで内容を確認してください。'
                    : 'リシンクエラーはありません。'
              }
              tone={blockErrors.isError ? 'warning' : errorCount > 0 ? 'danger' : 'neutral'}
            />
            <SignalCard
              title="推奨アクション"
              value={shouldInvestigateBlocks ? 'エラー調査' : '異常なし'}
              hint={
                shouldInvestigateBlocks
                  ? '操作を実行する前に、ブロックエラーページで失敗しているブロックを確認してください。'
                  : '緊急の対応は不要です。定期的な Scrub を計画してください。'
              }
              tone={shouldInvestigateBlocks ? 'danger' : 'neutral'}
            />
          </div>
        )}
      </div>

      <div className="space-y-3">
        <h2 className="text-lg font-semibold">ブロック管理メトリクス</h2>
        {metrics.isLoading ? (
          <SectionSkeleton />
        ) : metrics.isError ? (
          <div className="grid gap-3 md:grid-cols-3">
            <SignalCard title="リシンクエラー数" value="取得失敗" hint="Garage の /metrics に接続できませんでした。" tone="warning" />
            <SignalCard title="リシンクキュー長" value="取得失敗" hint="Garage の /metrics に接続できませんでした。" tone="warning" />
            <SignalCard title="破損検出回数" value="取得失敗" hint="Garage の /metrics に接続できませんでした。" tone="warning" />
          </div>
        ) : (
          <div className="grid gap-3 md:grid-cols-3">
            <SignalCard
              title="リシンクエラー数"
              value={metrics.data!.resyncErroredBlocks.toString()}
              hint={
                metrics.data!.resyncErroredBlocks > 0
                  ? 'リシンクに失敗しているブロックがあります。ブロックエラーページで確認してください。'
                  : '正常です。'
              }
              tone={metrics.data!.resyncErroredBlocks > 0 ? 'danger' : 'neutral'}
            />
            <SignalCard
              title="リシンクキュー長"
              value={metrics.data!.resyncQueueLength.toLocaleString()}
              hint={
                metrics.data!.resyncQueueLength > 0
                  ? 'リシンク待ちのブロックがあります。増減の推移は Grafana で確認してください。'
                  : 'リシンク待ちはありません。'
              }
              tone="neutral"
            />
            <SignalCard
              title="破損検出回数 (累積)"
              value={metrics.data!.corruptionCounter.toString()}
              hint="Scrub で検出された破損の累積回数です。増加の有無は Grafana で確認してください。"
              tone="neutral"
            />
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
            全ブロックのチェックサムを検証し、破損データを検出します。ディスク I/O が増加するため、負荷に注意してください。
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
          if (pendingRepairType) mutation.mutate(pendingRepairType)
        }}
        isPending={mutation.isPending}
        confirmLabel="実行"
        pendingLabel="実行中..."
        confirmVariant={pendingSeverity === 'high' ? 'destructive' : 'default'}
      />
    </div>
  )
}
