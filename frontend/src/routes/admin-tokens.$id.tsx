import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'
import { deleteAdminToken, getAdminToken, getCurrentAdminToken, updateAdminToken } from '@/api'
import type { AdminToken, AdminTokenBody } from '@/api'
import { AdminScopeEditor } from '@/components/admin-scope-editor'
import { ExpirationCell, ScopeCell } from '@/components/admin-token-cells'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { CopyButton } from '@/components/copy-button'
import { ExpirationInput } from '@/components/expiration-input'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { expirationBody, sameScope } from '@/lib/admin-scopes'
import { expirationFromIso, expirationValid, sameExpiration } from '@/lib/expiration'
import { formatDateTime } from '@/lib/format'

export const Route = createFileRoute('/admin-tokens/$id')({
  component: AdminTokenDetailPage,
})

function AdminTokenDetailPage() {
  const { id } = Route.useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [showDelete, setShowDelete] = useState(false)

  const token = useQuery({
    queryKey: ['admin-token', id],
    queryFn: () => getAdminToken(id),
  })
  const current = useQuery({
    queryKey: ['admin-tokens', 'current'],
    queryFn: getCurrentAdminToken,
  })
  const isCurrent = current.data?.id != null && current.data.id === id

  const deleteMutation = useMutation({
    mutationFn: () => deleteAdminToken(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-tokens'] })
      queryClient.removeQueries({ queryKey: ['admin-token', id] })
      toast.success('管理トークンを削除しました')
      navigate({ to: '/admin-tokens' })
    },
    onError: (err) => {
      toast.error(`管理トークンの削除に失敗しました: ${err.message}`)
    },
  })

  const data = token.data

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Link to="/admin-tokens" className="hover:underline">管理トークン</Link>
        <span>/</span>
        <span>{data?.name || id}</span>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-bold">{data?.name || '管理トークン詳細'}</h1>
          {isCurrent && <Badge variant="outline">このコンソール</Badge>}
        </div>
        {data && (
          <Button variant="destructive" size="sm" onClick={() => setShowDelete(true)}>
            削除
          </Button>
        )}
      </div>

      {token.isLoading ? (
        <div className="rounded-lg border p-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="space-y-1">
                <Skeleton className="h-4 w-20" />
                <Skeleton className="h-5 w-28" />
              </div>
            ))}
          </div>
        </div>
      ) : token.isError ? (
        <div className="space-y-2">
          <p className="text-destructive">管理トークンを取得できませんでした: {token.error.message}</p>
          <Button variant="outline" size="sm" onClick={() => token.refetch()}>
            再試行
          </Button>
        </div>
      ) : data ? (
        <>
          <div className="rounded-lg border p-4">
            <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
              <div>
                <p className="text-muted-foreground">ID</p>
                <div className="flex items-center gap-1">
                  <p className="font-mono text-xs break-all">{data.id ?? '-'}</p>
                  {data.id && <CopyButton value={data.id} label="トークン ID をコピー" />}
                </div>
              </div>
              <div>
                <p className="text-muted-foreground">作成日時</p>
                <p className="font-medium">{formatDateTime(data.created)}</p>
              </div>
              <div>
                <p className="text-muted-foreground">有効期限</p>
                <ExpirationCell token={data} />
              </div>
              <div>
                <p className="text-muted-foreground">許可エンドポイント</p>
                <ScopeCell scope={data.scope} />
              </div>
            </div>
          </div>

          {/* Remount on every server-side change so the form starts from the saved values. */}
          <EditAdminTokenForm
            key={`${data.name}|${data.expiration}|${data.scope.join(',')}`}
            id={id}
            token={data}
            isCurrent={isCurrent}
          />
        </>
      ) : null}

      <ConfirmDialog
        open={showDelete}
        onOpenChange={setShowDelete}
        title="管理トークンの削除"
        description={
          isCurrent
            ? `「${data?.name}」はこのコンソール自身が使っているトークンです。削除するとコンソールが Garage を操作できなくなります。本当に削除しますか？`
            : `管理トークン「${data?.name || id}」を削除しますか？このトークンを使っているクライアントは直ちに認証できなくなります。この操作は取り消せません。`
        }
        onConfirm={() => deleteMutation.mutateAsync()}
        isPending={deleteMutation.isPending}
      />
    </div>
  )
}

function EditAdminTokenForm({
  id,
  token,
  isCurrent,
}: {
  id: string
  token: AdminToken
  isCurrent: boolean
}) {
  const queryClient = useQueryClient()
  const initialExpiration = expirationFromIso(token.expiration)
  const [name, setName] = useState(token.name)
  const [expiration, setExpiration] = useState(initialExpiration)
  const [scope, setScope] = useState<string[]>(token.scope)

  const nameDirty = name.trim() !== token.name
  const expirationDirty = !sameExpiration(expiration, initialExpiration)
  const scopeDirty = !sameScope(scope, token.scope)
  const dirty = nameDirty || expirationDirty || scopeDirty

  const mutation = useMutation({
    mutationFn: () => {
      // Send only what changed, so a concurrent edit of another field is not overwritten.
      const body: AdminTokenBody = {}
      if (nameDirty) body.name = name.trim()
      if (expirationDirty) Object.assign(body, expirationBody(expiration))
      if (scopeDirty) body.scope = scope
      return updateAdminToken(id, body)
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(['admin-token', id], updated)
      queryClient.invalidateQueries({ queryKey: ['admin-tokens'] })
      toast.success('管理トークンを更新しました')
    },
  })

  const canSave =
    dirty && name.trim() !== '' && expirationValid(expiration) && scope.length > 0 && !mutation.isPending

  const reset = () => {
    setName(token.name)
    setExpiration(initialExpiration)
    setScope(token.scope)
    mutation.reset()
  }

  return (
    <form
      className="space-y-4 rounded-lg border p-4"
      onSubmit={(e) => {
        e.preventDefault()
        if (canSave) mutation.mutate()
      }}
    >
      <h2 className="text-lg font-semibold">設定</h2>
      <div className="max-w-md space-y-1">
        <label htmlFor="admin-token-name" className="text-sm font-medium">
          名前
        </label>
        <Input
          id="admin-token-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={mutation.isPending}
        />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium">有効期限</p>
        <ExpirationInput value={expiration} onChange={setExpiration} disabled={mutation.isPending} />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium">許可エンドポイント</p>
        {isCurrent && (
          <p className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            このコンソール自身のトークンです。必要なエンドポイントを外すとコンソールの該当機能が動かなくなります。
          </p>
        )}
        <AdminScopeEditor value={scope} onChange={setScope} disabled={mutation.isPending} />
      </div>
      {mutation.isError && <p className="text-sm text-destructive">{mutation.error.message}</p>}
      <div className="flex gap-2">
        <Button type="submit" disabled={!canSave}>
          {mutation.isPending ? '保存中...' : '保存'}
        </Button>
        {dirty && (
          <Button type="button" variant="ghost" onClick={reset} disabled={mutation.isPending}>
            変更を破棄
          </Button>
        )}
      </div>
    </form>
  )
}
