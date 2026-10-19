import { useState } from 'react'
import type { BucketKeyPermissions } from '@/api'
import { PermissionFields } from '@/components/bucket-permission-fields'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { hasAnyPermission, samePermissions } from '@/lib/permissions'

export interface EditPermissionsTarget {
  bucketId: string
  keyId: string
  /** Human-readable "key ↔ bucket" description for the dialog. */
  description: string
  permissions: BucketKeyPermissions
}

interface EditPermissionsDialogProps {
  target: EditPermissionsTarget | null
  onClose: () => void
  /** Saves the new permission set; the dialog closes when the promise resolves. */
  onSave: (permissions: BucketKeyPermissions) => Promise<unknown>
  isPending: boolean
}

/**
 * Edits one key's read / write / owner on one bucket. The backend turns the
 * new set into AllowBucketKey / DenyBucketKey calls. Failures keep the dialog
 * open with Garage's message.
 */
export function EditPermissionsDialog({ target, onClose, onSave, isPending }: EditPermissionsDialogProps) {
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open && !isPending) onClose()
      }}
    >
      <DialogContent>
        {target && (
          <EditPermissionsForm
            key={`${target.bucketId}/${target.keyId}`}
            target={target}
            onClose={onClose}
            onSave={onSave}
            isPending={isPending}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function EditPermissionsForm({
  target,
  onClose,
  onSave,
  isPending,
}: EditPermissionsDialogProps & { target: EditPermissionsTarget }) {
  const [value, setValue] = useState<BucketKeyPermissions>(target.permissions)
  const [error, setError] = useState<string | null>(null)
  const unchanged = samePermissions(value, target.permissions)

  const save = () => {
    setError(null)
    onSave(value).then(onClose, (e: unknown) => {
      setError(e instanceof Error ? e.message : String(e))
    })
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>権限の編集</DialogTitle>
        <DialogDescription>{target.description}</DialogDescription>
      </DialogHeader>
      <PermissionFields value={value} onChange={setValue} disabled={isPending} />
      {error && <p className="text-sm text-destructive">保存に失敗しました: {error}</p>}
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={isPending}>
          キャンセル
        </Button>
        <Button onClick={save} disabled={isPending || unchanged || !hasAnyPermission(value)}>
          {isPending ? '保存中...' : '保存'}
        </Button>
      </DialogFooter>
    </>
  )
}
