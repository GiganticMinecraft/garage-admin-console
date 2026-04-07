import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation } from '@tanstack/react-query'
import {
  launchRepair,
  type RepairType,
  type ScrubCommand,
} from '@/api'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { toast } from 'sonner'

export const Route = createFileRoute('/repair')({
  component: RepairPage,
})

const REPAIR_OPERATIONS: {
  value: string
  label: string
  description: string
  severity: 'low' | 'medium' | 'high'
}[] = [
  {
    value: 'tables',
    label: 'テーブル修復',
    description: '全メタデータテーブルを走査し、不整合を修復します。データの読み書きに問題がある場合に実行してください。',
    severity: 'medium',
  },
  {
    value: 'blocks',
    label: 'ブロック整合性検証',
    description: 'ブロックの所在を確認し、レプリカが不足しているノードにデータを再配置します。ノード障害後の復旧時に有用です。',
    severity: 'medium',
  },
  {
    value: 'versions',
    label: 'バージョン修復',
    description: 'オブジェクトのバージョンメタデータを検証・修復します。オブジェクトの一覧や取得で不整合がある場合に実行してください。',
    severity: 'medium',
  },
  {
    value: 'multipartUploads',
    label: 'マルチパートアップロード修復',
    description: '中断されたマルチパートアップロードのメタデータを修復します。アップロードが途中で止まった場合に有用です。',
    severity: 'low',
  },
  {
    value: 'blockRefs',
    label: 'ブロック参照修復',
    description: 'ブロックとオブジェクト間の参照関係を検証・修復します。',
    severity: 'medium',
  },
  {
    value: 'blockRc',
    label: 'ブロック参照カウント修復',
    description: 'ブロックの参照カウントを再計算します。不要なブロックが削除されない場合に実行してください。',
    severity: 'medium',
  },
  {
    value: 'rebalance',
    label: 'リバランス',
    description: 'クラスタのレイアウト変更後にデータを再配置します。ノードの追加・削除後に実行してください。',
    severity: 'low',
  },
  {
    value: 'aliases',
    label: 'エイリアス修復',
    description: 'バケットのグローバル/ローカルエイリアスの不整合を修復します。',
    severity: 'low',
  },
  {
    value: 'clearResyncQueue',
    label: 'リシンクキューのクリア',
    description: 'ブロックのリシンクキューを全てクリアします。キューが詰まってリシンクが進まない場合に使用してください。',
    severity: 'high',
  },
]

const SCRUB_COMMANDS: { value: ScrubCommand; label: string; description: string }[] = [
  { value: 'start', label: '開始', description: '全ブロックのチェックサムを検証するフルスキャンを開始します。ディスク I/O が増加します。' },
  { value: 'pause', label: '一時停止', description: '実行中の Scrub を一時停止します。' },
  { value: 'resume', label: '再開', description: '一時停止中の Scrub を再開します。' },
  { value: 'cancel', label: 'キャンセル', description: '実行中の Scrub を中止します。' },
]

const SEVERITY_VARIANT = {
  low: 'secondary',
  medium: 'default',
  high: 'destructive',
} as const

const SEVERITY_LABEL = {
  low: '低リスク',
  medium: '中リスク',
  high: '高リスク',
}

function RepairPage() {
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [pendingRepairType, setPendingRepairType] = useState<RepairType | null>(null)
  const [pendingLabel, setPendingLabel] = useState('')

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

  const requestRepair = (repairType: RepairType, label: string) => {
    setPendingRepairType(repairType)
    setPendingLabel(label)
    setConfirmOpen(true)
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">メンテナンス操作</h1>
        <p className="text-muted-foreground mt-1">
          全ノードに対して修復・検証操作を実行します。操作中はクラスタの負荷が上がる場合があります。
        </p>
      </div>

      <div className="space-y-3">
        <h2 className="text-lg font-semibold">修復操作</h2>
        <div className="grid gap-3">
          {REPAIR_OPERATIONS.map((op) => (
            <div key={op.value} className="rounded-lg border p-4 flex items-start justify-between gap-4">
              <div className="space-y-1 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{op.label}</span>
                  <Badge variant={SEVERITY_VARIANT[op.severity]}>{SEVERITY_LABEL[op.severity]}</Badge>
                </div>
                <p className="text-sm text-muted-foreground">{op.description}</p>
              </div>
              <Button
                size="sm"
                variant={op.severity === 'high' ? 'destructive' : 'default'}
                disabled={mutation.isPending}
                onClick={() => requestRepair(op.value as RepairType, op.label)}
              >
                実行
              </Button>
            </div>
          ))}
        </div>
      </div>

      <div className="space-y-3">
        <h2 className="text-lg font-semibold">Scrub (データ整合性チェック)</h2>
        <p className="text-sm text-muted-foreground">
          全ブロックのチェックサムを検証し、破損データを検出します。長時間かかる場合があります。
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          {SCRUB_COMMANDS.map((cmd) => (
            <div key={cmd.value} className="rounded-lg border p-4 space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-medium">Scrub {cmd.label}</span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={mutation.isPending}
                  onClick={() => requestRepair({ scrub: cmd.value }, `Scrub ${cmd.label}`)}
                >
                  実行
                </Button>
              </div>
              <p className="text-sm text-muted-foreground">{cmd.description}</p>
            </div>
          ))}
        </div>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`${pendingLabel}の実行`}
        description="この操作を全ノードに対して実行します。クラスタの負荷が一時的に上がる可能性があります。よろしいですか？"
        onConfirm={() => {
          if (pendingRepairType) mutation.mutate(pendingRepairType)
        }}
        isPending={mutation.isPending}
        confirmLabel="実行"
        pendingLabel="実行中..."
        confirmVariant="default"
      />
    </div>
  )
}
