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
  why: string
  trigger: string
  caution: string
  severity: 'low' | 'medium' | 'high'
}[] = [
  {
    value: 'blocks',
    label: 'ブロック整合性検証',
    why: '不足レプリカの再配置とブロック整合性の回復に使います。',
    trigger: 'layout apply 後、ノード障害・交換後、復旧後の定番操作です。',
    caution: '数時間待って resync が自然収束しない場合に実行します。',
    severity: 'medium',
  },
  {
    value: 'blockRc',
    label: 'ブロック参照カウント修復',
    why: '参照カウントを再計算し、RC 不整合を修正します。',
    trigger: 'ログに RC 不整合が出るとき、ブロックエラーが高止まりしているとき。',
    caution: '根本原因が block ref 側にある場合は blockRefs と併用を検討します。',
    severity: 'medium',
  },
  {
    value: 'tables',
    label: 'テーブル修復',
    why: 'メタデータテーブルの全体同期を促します。',
    trigger: '通常不要。メタデータ同期の異常や大規模障害後に限定します。',
    caution: '毎時の自動同期があるため、安易な定期実行は不要です。',
    severity: 'medium',
  },
  {
    value: 'versions',
    label: 'バージョン修復',
    why: 'オブジェクト version メタデータの不整合を是正します。',
    trigger: '長時間停止や障害後に object/version の整合が崩れた疑いがあるとき。',
    caution: '通常運用で使う操作ではありません。',
    severity: 'medium',
  },
  {
    value: 'blockRefs',
    label: 'ブロック参照修復',
    why: 'block ref と object/version の参照関係を修復します。',
    trigger: '孤立参照が GC を妨げている、version 系の不整合が疑われるとき。',
    caution: 'versions や blockRc とセットで判断する操作です。',
    severity: 'medium',
  },
  {
    value: 'rebalance',
    label: 'リバランス',
    why: 'ストレージ構成変更後にデータ配置を均します。',
    trigger: 'ディスク追加、ノード追加、容量配分変更後。',
    caution: '障害対応ではなく構成変更後の整流化です。',
    severity: 'low',
  },
  {
    value: 'multipartUploads',
    label: 'マルチパート修復',
    why: '中断された multipart upload 関連のメタデータを整えます。',
    trigger: 'multipart upload 周りだけおかしいとき。',
    caution: '一般的な障害対応の主軸ではありません。',
    severity: 'low',
  },
  {
    value: 'aliases',
    label: 'エイリアス修復',
    why: 'バケット alias の不整合を修正します。',
    trigger: 'alias 解決だけが壊れているとき。',
    caution: '極めてまれな用途です。',
    severity: 'low',
  },
  {
    value: 'clearResyncQueue',
    label: 'リシンクキューのクリア',
    why: '詰まった resync キューを強制的に空にします。',
    trigger: '永久失敗ブロックを purge した後の最終手段です。',
    caution: '先に /blocks で原因を確認し、必要な purge を済ませてから使います。',
    severity: 'high',
  },
]

const SCRUB_COMMANDS: { value: ScrubCommand; label: string; summary: string }[] = [
  { value: 'start', label: '開始', summary: '全ブロックの整合性検証を開始します。' },
  { value: 'pause', label: '一時停止', summary: '実行中の scrub を止めます。' },
  { value: 'resume', label: '再開', summary: '一時停止した scrub を再開します。' },
  { value: 'cancel', label: 'キャンセル', summary: '実行中の scrub を中止します。' },
]

const PLAYBOOKS: {
  title: string
  summary: string
  steps: { text: string; link?: { to: string; label: string } }[]
}[] = [
  {
    title: 'レイアウト変更後',
    summary: '最も一般的なメンテナンス導線です。',
    steps: [
      { text: 'layout apply 後しばらく待ち、自然収束しないなら blocks を実行' },
      { text: 'ブロックエラーが残る場合は対象 hash を確認', link: { to: '/blocks', label: 'ブロックエラー' } },
      { text: '必要なら purge 後に blockRefs / blockRc を続ける' },
    ],
  },
  {
    title: 'リシンクエラー発生時',
    summary: 'まずブロック単位で原因を見ます。',
    steps: [
      { text: 'errored block を確認し、詳細を開く', link: { to: '/blocks', label: 'ブロックエラー' } },
      { text: '喪失確定なら purge、その後 blockRefs / blockRc を実行' },
      { text: 'キューだけが詰まるなら clearResyncQueue は最後に検討' },
    ],
  },
  {
    title: '定期メンテナンス',
    summary: 'scrub は定期運用で使う操作です。',
    steps: [
      { text: 'scrub は四半期ごとの実施を目安にする' },
      { text: 'ディスク I/O エラーが疑われるときは定期外でも開始を検討' },
      { text: 'corruption 系メトリクスは本来 Prometheus で監視する' },
    ],
  },
  {
    title: '大規模障害後',
    summary: '広範囲の整合性確認が必要です。',
    steps: [
      { text: 'metadata の異常が疑われるなら tables' },
      { text: 'データ配置と不足レプリカの回復に blocks' },
      { text: '症状が version / block ref に及ぶ場合のみ個別修復を追加' },
    ],
  },
]

const SEVERITY_VARIANT = {
  low: 'secondary',
  medium: 'default',
  high: 'destructive',
} as const

const SEVERITY_LABEL = {
  low: '限定用途',
  medium: '要判断',
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
    onError: () => toast.error('修復操作に失敗しました'),
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
      <div className="rounded-2xl border bg-gradient-to-br from-slate-50 via-white to-amber-50 p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="space-y-2">
            <p className="text-sm font-medium text-muted-foreground">Maintenance Console</p>
            <h1 className="text-3xl font-semibold tracking-tight">メンテナンス判断と修復操作</h1>
            <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
              クラスタ状態・ブロックエラー・Garage メトリクスから現在の兆候を確認し、
              必要な修復操作をそのまま実行できます。
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline" size="sm">
              <Link to="/blocks">ブロックエラーを見る</Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link to="/layout">レイアウトを確認</Link>
            </Button>
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <div>
          <h2 className="text-lg font-semibold">現在見えているシグナル</h2>
          <p className="text-sm text-muted-foreground">
            即時判断に使えるのは、クラスタ状態とブロックエラー一覧です。
          </p>
        </div>
        {health.isLoading || blockErrors.isLoading ? (
          <SectionSkeleton />
        ) : (
          <div className="grid gap-3 md:grid-cols-3">
            <SignalCard
              title="クラスタ状態"
              value={health.isError ? '取得失敗' : isClusterHealthy ? 'healthy' : health.data?.status ?? 'unknown'}
              hint={
                health.isError
                  ? 'クラスタ health API の取得に失敗しました。'
                  : isClusterHealthy
                    ? '大域的な health は正常です。'
                    : 'クラスタ全体の健康状態に異常があります。'
              }
              tone={health.isError ? 'warning' : isClusterHealthy ? 'neutral' : 'warning'}
            />
            <SignalCard
              title="ブロックエラー数"
              value={blockErrors.isError ? '取得失敗' : errorCount.toString()}
              hint={
                blockErrors.isError
                  ? '/blocks 一覧を取得できませんでした。'
                  : errorCount > 0
                    ? '0 でないため、まず /blocks で対象 hash を確認すべき状態です。'
                    : '現時点で見えている resync error はありません。'
              }
              tone={blockErrors.isError ? 'warning' : errorCount > 0 ? 'danger' : 'neutral'}
            />
            <SignalCard
              title="次の推奨アクション"
              value={shouldInvestigateBlocks ? 'まず /blocks' : '定期保守のみ'}
              hint={
                shouldInvestigateBlocks
                  ? 'blocks 実行や purge の前に、どの block が失敗しているかを確認します。'
                  : '緊急兆候がなければ scrub や layout 後の blocks を計画的に行います。'
              }
              tone={shouldInvestigateBlocks ? 'danger' : 'neutral'}
            />
          </div>
        )}
      </div>

      <div className="space-y-3">
        <div>
          <h2 className="text-lg font-semibold">ブロック管理メトリクス</h2>
          <p className="text-sm text-muted-foreground">
            Garage の /metrics から取得した、修復判断に直結する 3 指標です。
          </p>
        </div>
        {metrics.isLoading ? (
          <SectionSkeleton />
        ) : metrics.isError ? (
          <div className="grid gap-3 md:grid-cols-3">
            <SignalCard title="resync_errored_blocks" value="取得失敗" hint="Garage /metrics エンドポイントに接続できませんでした。" tone="warning" />
            <SignalCard title="resync_queue_length" value="取得失敗" hint="Garage /metrics エンドポイントに接続できませんでした。" tone="warning" />
            <SignalCard title="corruption_counter" value="取得失敗" hint="Garage /metrics エンドポイントに接続できませんでした。" tone="warning" />
          </div>
        ) : (
          <div className="grid gap-3 md:grid-cols-3">
            <SignalCard
              title="resync_errored_blocks"
              value={metrics.data!.resyncErroredBlocks.toString()}
              hint={
                metrics.data!.resyncErroredBlocks > 0
                  ? '0 でないためブロック喪失の可能性があります。/blocks で確認してください。'
                  : '正常。リシンクに失敗しているブロックはありません。'
              }
              tone={metrics.data!.resyncErroredBlocks > 0 ? 'danger' : 'neutral'}
            />
            <SignalCard
              title="resync_queue_length"
              value={metrics.data!.resyncQueueLength.toLocaleString()}
              hint={
                metrics.data!.resyncQueueLength > 1000
                  ? 'キューが大きいです。layout 変更直後でなければ詰まりを疑います。'
                  : metrics.data!.resyncQueueLength > 0
                    ? 'リシンク進行中です。layout 変更後は一時的に増加します。'
                    : '正常。リシンク待ちのブロックはありません。'
              }
              tone={metrics.data!.resyncQueueLength > 1000 ? 'warning' : 'neutral'}
            />
            <SignalCard
              title="corruption_counter"
              value={metrics.data!.corruptionCounter.toString()}
              hint={
                metrics.data!.corruptionCounter > 0
                  ? 'scrub が破損ブロックを検出しています。ディスク障害の可能性を確認してください。'
                  : '正常。scrub による破損検出はありません。'
              }
              tone={metrics.data!.corruptionCounter > 0 ? 'danger' : 'neutral'}
            />
          </div>
        )}
      </div>

      <div className="space-y-3">
        <div>
          <h2 className="text-lg font-semibold">状況別プレイブック</h2>
          <p className="text-sm text-muted-foreground">
            操作名から考えるのではなく、障害や変更イベントから逆引きします。
          </p>
        </div>
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
        <div>
          <h2 className="text-lg font-semibold">操作カタログ</h2>
          <p className="text-sm text-muted-foreground">
            各操作の用途、典型トリガー、注意点を並べています。高リスク操作は最後段に寄せています。
          </p>
        </div>
        <div className="grid gap-3">
          {REPAIR_OPERATIONS.map((op) => (
            <div key={op.value} className="rounded-lg border p-4 space-y-3">
              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <h3 className="font-medium">{op.label}</h3>
                    <Badge variant={SEVERITY_VARIANT[op.severity]}>{SEVERITY_LABEL[op.severity]}</Badge>
                  </div>
                  <p className="text-sm text-muted-foreground">{op.why}</p>
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
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">使う場面</p>
                  <p className="mt-1 text-sm">{op.trigger}</p>
                </div>
                <div className="rounded-md bg-muted/40 p-3">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">注意点</p>
                  <p className="mt-1 text-sm">{op.caution}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="space-y-3">
        <div>
          <h2 className="text-lg font-semibold">Scrub 操作</h2>
          <p className="text-sm text-muted-foreground">
            定期メンテナンスやディスク障害疑いの場面で使います。I/O 負荷が高く、実行時間も長くなりがちです。
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {SCRUB_COMMANDS.map((cmd) => (
            <div key={cmd.value} className="rounded-lg border p-4 space-y-3">
              <div className="space-y-1">
                <h3 className="font-medium">Scrub {cmd.label}</h3>
                <p className="text-sm text-muted-foreground">{cmd.summary}</p>
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
            ? 'この操作は最終手段です。先に /blocks で原因確認と purge の要否を確認したうえで実行してください。'
            : 'この操作を全ノードに対して実行します。クラスタ負荷が一時的に上がる可能性があります。'
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
