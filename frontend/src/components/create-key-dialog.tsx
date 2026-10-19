import { useId, useState } from 'react'
import type { FormEvent } from 'react'
import { useMutation } from '@tanstack/react-query'
import { createKey } from '@/api'
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
import { expirationFromIso, expirationIso, expirationValid } from '@/lib/expiration'
import type { ExpirationValue } from '@/lib/expiration'

interface CreateKeyDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called with the CreateKey response, which carries the new secret. */
  onCreated: (key: KeyDetail) => void
}

/** 「キーを作成」 dialog: name, expiration and the createBucket permission. */
export function CreateKeyDialog({ open, onOpenChange, onCreated }: CreateKeyDialogProps) {
  const mutation = useMutation({ mutationFn: createKey })
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
        {open && (
          <CreateKeyForm
            pending={mutation.isPending}
            error={mutation.error}
            onCancel={() => {
              mutation.reset()
              onOpenChange(false)
            }}
            onSubmit={(body) =>
              mutation.mutate(body, {
                onSuccess: (created) => {
                  onOpenChange(false)
                  mutation.reset()
                  onCreated(created)
                },
              })
            }
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function CreateKeyForm({
  pending,
  error,
  onCancel,
  onSubmit,
}: {
  pending: boolean
  error: Error | null
  onCancel: () => void
  onSubmit: (body: KeySettingsRequest) => void
}) {
  const id = useId()
  const [name, setName] = useState('')
  const [expiration, setExpiration] = useState<ExpirationValue>(() => expirationFromIso(null))
  const [createBucket, setCreateBucket] = useState(false)
  const valid = name.trim() !== '' && expirationValid(expiration)

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!valid || pending) return
    const body: KeySettingsRequest = { name: name.trim() }
    const iso = expirationIso(expiration)
    if (iso) body.expiration = iso
    else body.neverExpires = true
    if (createBucket) body.allow = { createBucket: true }
    onSubmit(body)
  }

  return (
    <form onSubmit={submit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>キーを作成</DialogTitle>
        <DialogDescription>
          作成後にシークレットアクセスキーを表示します。バケットへの権限は作成後に付与してください。
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-1.5">
        <label htmlFor={`${id}-name`} className="text-sm font-medium">
          名前
        </label>
        <Input
          id={`${id}-name`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="キー名"
          autoFocus
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
      {error && <p className="text-sm text-destructive">作成に失敗しました: {error.message}</p>}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>
          キャンセル
        </Button>
        <Button type="submit" disabled={!valid || pending}>
          {pending ? '作成中...' : '作成'}
        </Button>
      </DialogFooter>
    </form>
  )
}
