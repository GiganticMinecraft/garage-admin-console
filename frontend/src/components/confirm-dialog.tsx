import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useRef } from 'react'
import { TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export interface ConfirmTarget {
  label: string
  value: string
  /** ID やキーなど、等幅で見せたい値。 */
  mono?: boolean
}

interface ConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  /**
   * Runs the confirmed action. When it returns a promise (e.g. mutateAsync),
   * the dialog stays open with the pending label until it settles and only
   * closes on success, so failures remain visible instead of silently
   * vanishing with the dialog.
   */
  onConfirm: () => void | Promise<unknown>
  isPending?: boolean
  confirmLabel?: string
  pendingLabel?: string
  confirmVariant?: 'default' | 'destructive'
  /** 操作対象の要約 (ID / 名前 / ノードなど) を小さな表で出す。 */
  target?: ConfirmTarget[]
  /** 「何が起きるか」の箇条書き。警告バナーの中に出す (lib/consequences.ts)。 */
  consequences?: string[]
  /** true なら警告バナーの末尾に「この操作は取り消せません。」を出す。 */
  irreversible?: boolean
  /** 実行できないとわかっている (例: 空でないバケット) とき確定ボタンを止める。 */
  confirmDisabled?: boolean
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  onConfirm,
  isPending,
  confirmLabel = '削除',
  pendingLabel = '削除中...',
  confirmVariant = 'destructive',
  target,
  consequences,
  irreversible,
  confirmDisabled,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  const danger = confirmVariant === 'destructive'
  const showBanner = (consequences?.length ?? 0) > 0 || irreversible
  // While the confirmed action is in flight the dialog cannot be dismissed
  // (Cancel, Escape or overlay click); otherwise the pending promise would
  // later close whatever dialog instance happens to be open at that moment.
  const handleOpenChange = (next: boolean) => {
    if (!next && isPending) return
    onOpenChange(next)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="max-h-[85vh] overflow-y-auto"
        onOpenAutoFocus={(e) => {
          // 誤って Enter で実行しないよう、最初のフォーカスはキャンセルに置く。
          e.preventDefault()
          cancelRef.current?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {target && target.length > 0 && (
          <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1 rounded-md border bg-muted/40 px-3 py-2 text-sm">
            {target.map((t, i) => (
              <div key={`${i}-${t.label}`} className="contents">
                <dt className="text-muted-foreground">{t.label}</dt>
                <dd className={cn('break-all', t.mono && 'font-mono text-xs leading-5')}>{t.value}</dd>
              </div>
            ))}
          </dl>
        )}
        {showBanner && (
          <div
            role="note"
            className={cn(
              'flex gap-2 rounded-md border p-3 text-sm',
              danger
                ? 'border-destructive/50 bg-destructive/5'
                : 'border-amber-500/50 bg-amber-500/5',
            )}
          >
            <TriangleAlert
              aria-hidden="true"
              className={cn('mt-0.5 size-4 shrink-0', danger ? 'text-destructive' : 'text-amber-600 dark:text-amber-400')}
            />
            <div className="space-y-1">
              {consequences && consequences.length > 0 && (
                <ul className="list-disc space-y-1 pl-4">
                  {consequences.map((c, i) => (
                    <li key={`${i}-${c}`}>{c}</li>
                  ))}
                </ul>
              )}
              {irreversible && (
                <p className={cn('font-medium', danger && 'text-destructive')}>この操作は取り消せません。</p>
              )}
            </div>
          </div>
        )}
        <DialogFooter>
          <Button ref={cancelRef} variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            キャンセル
          </Button>
          <Button
            variant={confirmVariant}
            onClick={() => {
              const result = onConfirm()
              if (result && typeof (result as Promise<unknown>).then === 'function') {
                ;(result as Promise<unknown>).then(
                  () => onOpenChange(false),
                  () => {
                    // Keep the dialog open; the caller's onError reports the failure.
                  },
                )
              } else {
                onOpenChange(false)
              }
            }}
            disabled={isPending || confirmDisabled}
          >
            {isPending ? pendingLabel : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
