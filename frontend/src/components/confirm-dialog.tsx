import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

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
}: ConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
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
            disabled={isPending}
          >
            {isPending ? pendingLabel : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
