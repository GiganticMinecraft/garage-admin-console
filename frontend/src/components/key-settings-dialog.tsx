import { useId, useState } from 'react'
import type { FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { updateKey } from '@/api'
import type { KeyDetail, KeySettingsRequest } from '@/api'
import { ExpirationInput } from '@/components/expiration-input'
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
import { Input } from '@/components/ui/input'
import { expirationBody, expirationFromIso, expirationValid, sameExpiration } from '@/lib/expiration'
import type { ExpirationValue } from '@/lib/expiration'

interface KeySettingsDialogProps {
  keyDetail: KeyDetail | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * Edits a key's name, expiration and createBucket permission with UpdateKey.
 * Only the fields that changed are sent.
 */
export function KeySettingsDialog({ keyDetail, open, onOpenChange }: KeySettingsDialogProps) {
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: (body: KeySettingsRequest) => updateKey(keyDetail!.accessKeyId, body),
    onSuccess: (updated) => {
      // Refresh the detail without touching the separately cached secret.
      queryClient.invalidateQueries({ queryKey: ['key', updated.accessKeyId], exact: true })
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      toast.success('キーの設定を更新しました')
      onOpenChange(false)
    },
  })

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && mutation.isPending) return
        if (!next) mutation.reset()
        onOpenChange(next)
      }}
    >
      <DialogContent>
        {open && keyDetail && (
          <KeySettingsForm
            keyDetail={keyDetail}
            pending={mutation.isPending}
            error={mutation.error}
            onCancel={() => {
              mutation.reset()
              onOpenChange(false)
            }}
            onSubmit={(body) => mutation.mutate(body)}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function KeySettingsForm({
  keyDetail,
  pending,
  error,
  onCancel,
  onSubmit,
}: {
  keyDetail: KeyDetail
  pending: boolean
  error: Error | null
  onCancel: () => void
  onSubmit: (body: KeySettingsRequest) => void
}) {
  const id = useId()
  const [initialExpiration] = useState(() => expirationFromIso(keyDetail.expiration))
  const [name, setName] = useState(keyDetail.name)
  const [expiration, setExpiration] = useState<ExpirationValue>(initialExpiration)
  const [createBucket, setCreateBucket] = useState(keyDetail.permissions.createBucket)

  const body: KeySettingsRequest = {}
  if (name.trim() !== keyDetail.name) body.name = name.trim()
  if (!sameExpiration(expiration, initialExpiration)) Object.assign(body, expirationBody(expiration))
  if (createBucket !== keyDetail.permissions.createBucket) {
    if (createBucket) body.allow = { createBucket: true }
    else body.deny = { createBucket: true }
  }
  const dirty = Object.keys(body).length > 0
  const valid = name.trim() !== '' && expirationValid(expiration)

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!dirty || !valid || pending) return
    onSubmit(body)
  }

  return (
    <form onSubmit={submit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>キーの設定</DialogTitle>
        <DialogDescription className="font-mono text-xs">{keyDetail.accessKeyId}</DialogDescription>
      </DialogHeader>
      <div className="space-y-1.5">
        <label htmlFor={`${id}-name`} className="text-sm font-medium">
          名前
        </label>
        <Input
          id={`${id}-name`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={pending}
        />
      </div>
      <div className="space-y-1.5">
        <p className="text-sm font-medium">有効期限</p>
        <ExpirationInput value={expiration} onChange={setExpiration} disabled={pending} />
      </div>
      <div className="flex items-start gap-2">
        <Checkbox
          id={`${id}-cb`}
          className="mt-0.5"
          checked={createBucket}
          disabled={pending}
          onCheckedChange={(checked) => setCreateBucket(checked === true)}
        />
        <label htmlFor={`${id}-cb`} className="text-sm leading-tight">
          バケットを作成できる
          <span className="block text-xs text-muted-foreground">
            S3 API の CreateBucket でこのキーが新しいバケットを作れるようにします
          </span>
        </label>
      </div>
      {error && <p className="text-sm text-destructive">更新に失敗しました: {error.message}</p>}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>
          キャンセル
        </Button>
        <Button type="submit" disabled={!dirty || !valid || pending}>
          {pending ? '保存中...' : '保存'}
        </Button>
      </DialogFooter>
    </form>
  )
}
