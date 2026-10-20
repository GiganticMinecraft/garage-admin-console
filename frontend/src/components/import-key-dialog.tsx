import { useId, useState } from 'react'
import type { FormEvent } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Eye, EyeOff } from 'lucide-react'
import { ApiError, importKey } from '@/api'
import type { KeyDetail } from '@/api'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { validateImportKey } from '@/lib/keys'
import type { ImportKeyBody } from '@/lib/keys'

interface ImportKeyDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called with the ImportKey response (without the secret). */
  onImported: (key: KeyDetail) => void
}

/** 「キーをインポート」 dialog: name, access key ID and secret of an existing key. */
export function ImportKeyDialog({ open, onOpenChange, onImported }: ImportKeyDialogProps) {
  const mutation = useMutation({ mutationFn: importKey })
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
          <ImportKeyForm
            pending={mutation.isPending}
            error={mutation.error}
            onCancel={() => {
              mutation.reset()
              onOpenChange(false)
            }}
            onSubmit={(body) =>
              mutation.mutate(body, {
                onSuccess: (imported) => {
                  onOpenChange(false)
                  mutation.reset()
                  onImported(imported)
                },
              })
            }
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function importErrorMessage(error: Error): string {
  if (error instanceof ApiError && error.code === 'KeyAlreadyExists') {
    return 'このアクセスキー ID は既に存在します (削除済みのキーの ID も再利用できません)'
  }
  return error.message
}

function ImportKeyForm({
  pending,
  error,
  onCancel,
  onSubmit,
}: {
  pending: boolean
  error: Error | null
  onCancel: () => void
  onSubmit: (body: ImportKeyBody) => void
}) {
  const id = useId()
  const [name, setName] = useState('')
  const [accessKeyId, setAccessKeyId] = useState('')
  const [secretAccessKey, setSecretAccessKey] = useState('')
  const [revealed, setRevealed] = useState(false)
  // Show field errors only once the field was edited or a submit was tried,
  // so an untouched dialog does not open in red.
  const [touched, setTouched] = useState({ accessKeyId: false, secretAccessKey: false })
  const v = validateImportKey({ name, accessKeyId, secretAccessKey })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    setTouched({ accessKeyId: true, secretAccessKey: true })
    if (!v.body || pending) return
    onSubmit(v.body)
  }

  const idError = touched.accessKeyId ? v.errors.accessKeyId : undefined
  const secretError = touched.secretAccessKey ? v.errors.secretAccessKey : undefined

  return (
    <form onSubmit={submit} className="grid gap-4" noValidate>
      <DialogHeader>
        <DialogTitle>キーをインポート</DialogTitle>
        <DialogDescription>
          他のクラスタから移設するキーなど、既存のアクセスキー ID とシークレットの組をそのまま登録します。新しいキーを作るときは「キーを作成」を使ってください。バケットへの権限はインポート後に付与してください。
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
          placeholder="キー名 (省略時は Imported key)"
          autoFocus
          disabled={pending}
        />
      </div>
      <div className="space-y-1.5">
        <label htmlFor={`${id}-akid`} className="text-sm font-medium">
          アクセスキー ID
        </label>
        <Input
          id={`${id}-akid`}
          value={accessKeyId}
          onChange={(e) => {
            setAccessKeyId(e.target.value)
            setTouched((t) => ({ ...t, accessKeyId: true }))
          }}
          placeholder="GK..."
          className="font-mono"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={idError ? true : undefined}
          aria-describedby={`${id}-akid-msg`}
          disabled={pending}
        />
        <p id={`${id}-akid-msg`} className="text-xs">
          {idError ? (
            <span className="text-destructive">{idError}</span>
          ) : v.warnings.accessKeyId ? (
            <span className="text-muted-foreground">{v.warnings.accessKeyId}</span>
          ) : null}
        </p>
      </div>
      <div className="space-y-1.5">
        <label htmlFor={`${id}-secret`} className="text-sm font-medium">
          シークレットアクセスキー
        </label>
        <div className="flex gap-2">
          <Input
            id={`${id}-secret`}
            type={revealed ? 'text' : 'password'}
            value={secretAccessKey}
            onChange={(e) => {
              setSecretAccessKey(e.target.value)
              setTouched((t) => ({ ...t, secretAccessKey: true }))
            }}
            className="font-mono"
            autoComplete="new-password"
            spellCheck={false}
            aria-invalid={secretError ? true : undefined}
            aria-describedby={`${id}-secret-msg`}
            disabled={pending}
          />
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={() => setRevealed((r) => !r)}
            aria-label={revealed ? 'シークレットを隠す' : 'シークレットを表示'}
            aria-pressed={revealed}
            disabled={pending}
          >
            {revealed ? <EyeOff /> : <Eye />}
          </Button>
        </div>
        <p id={`${id}-secret-msg`} className="text-xs">
          {secretError ? (
            <span className="text-destructive">{secretError}</span>
          ) : v.warnings.secretAccessKey ? (
            <span className="text-muted-foreground">{v.warnings.secretAccessKey}</span>
          ) : null}
        </p>
      </div>
      {error && (
        <p className="text-sm text-destructive">インポートに失敗しました: {importErrorMessage(error)}</p>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>
          キャンセル
        </Button>
        <Button type="submit" disabled={pending || (touched.accessKeyId && touched.secretAccessKey && !v.body)}>
          {pending ? 'インポート中...' : 'インポート'}
        </Button>
      </DialogFooter>
    </form>
  )
}
