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
import { escalationMessage, sameScope, scopeCoversConsole, scopeEscalates } from '@/lib/admin-scopes'
import { expirationBody, expirationFromIso, expirationValid, sameExpiration } from '@/lib/expiration'
import { formatDateTime } from '@/lib/format'
import { useConsoleScope } from '@/hooks/use-console-scope'
import { useDocumentTitle } from '@/hooks/use-document-title'

export const Route = createFileRoute('/admin-tokens/$id')({
  component: AdminTokenDetailPage,
})

function AdminTokenDetailPage() {
  useDocumentTitle('管理トークン詳細')
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
  // A config-file token (id null) can never be the token shown on this page.
  const isCurrent = current.data?.id != null && current.data.id === id

  const deleteMutation = useMutation({
    mutationFn: () => deleteAdminToken(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-tokens'], exact: true })
      if (isCurrent) queryClient.invalidateQueries({ queryKey: ['admin-tokens', 'current'] })
      toast.success('管理トークンを削除しました')
      // Drop the cached detail only once this page has unmounted; removing it
      // while mounted triggers a refetch that briefly shows a 404.
      void navigate({ to: '/admin-tokens' }).then(() => {
        queryClient.removeQueries({ queryKey: ['admin-token', id] })
      })
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
                <div className="flex flex-wrap items-center gap-1.5">
                  <ScopeCell scope={data.scope} />
                  <ScopeBadges scope={data.scope} />
                </div>
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

  const nameDirty = name.trim() !== token.name.trim()
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
      queryClient.invalidateQueries({ queryKey: ['admin-tokens'], exact: true })
      if (isCurrent) queryClient.invalidateQueries({ queryKey: ['admin-tokens', 'current'] })
      toast.success('管理トークンを更新しました')
    },
    // The escalation confirmation stays open over the form on failure, so
    // also report it where it is visible.
    onError: (err) => {
      toast.error(`管理トークンの更新に失敗しました: ${err.message}`)
    },
  })

  const canSave =
    dirty && name.trim() !== '' && expirationValid(expiration) && scope.length > 0 && !mutation.isPending
  // Saving a scope change that newly amounts to * goes through a
  // confirmation; narrowing an already escalating token does not.
  const [confirmEscalation, setConfirmEscalation] = useState(false)
  const escalation = scopeDirty && !scopeEscalates(token.scope).escalates ? escalationMessage(scope) : null

  const reset = () => {
    setName(token.name)
    setExpiration(initialExpiration)
    setScope(token.scope)
    mutation.reset()
  }

  return (
    <>
      <form
        className="space-y-4 rounded-lg border p-4"
        onSubmit={(e) => {
          e.preventDefault()
          if (!canSave) return
          if (escalation) setConfirmEscalation(true)
          else mutation.mutate()
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
          <AdminScopeEditor value={scope} onChange={setScope} disabled={mutation.isPending} consolePreset />
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
      <ConfirmDialog
        open={confirmEscalation}
        onOpenChange={setConfirmEscalation}
        title="* と同等の権限への変更"
        description={`${escalation ?? ''} このままスコープを保存しますか？`}
        onConfirm={() => mutation.mutateAsync()}
        isPending={mutation.isPending}
        confirmLabel="保存"
        pendingLabel="保存中..."
        confirmVariant="default"
      />
    </>
  )
}

/**
 * Whether the saved scope amounts to * and whether it grants everything the
 * console preset needs. An unavailable console scope is shown as 判定不可,
 * not as covered.
 */
function ScopeBadges({ scope }: { scope: string[] }) {
  const consoleScope = useConsoleScope()
  const escalation = scopeEscalates(scope)
  const coverage = consoleScope.data ? scopeCoversConsole(scope, consoleScope.data) : null
  return (
    <>
      {escalation.escalates && (
        <Badge
          variant="outline"
          className="border-amber-500/50 text-amber-700 dark:text-amber-400"
          title={escalation.reason ?? undefined}
        >
          <TriangleAlert />* と同等
        </Badge>
      )}
      {coverage ? (
        coverage.covers ? (
          <Badge variant="outline" title="このコンソールが呼び出すエンドポイント(CreateAdminToken / UpdateAdminToken を除く)をすべて許可しています">
            コンソール用を満たす
          </Badge>
        ) : (
          <Badge variant="secondary" title={`不足: ${coverage.missing.join(', ')}`}>
            コンソール用に {coverage.missing.length} 件不足
          </Badge>
        )
      ) : consoleScope.isError ? (
        <Badge variant="outline" className="text-muted-foreground" title={consoleScope.error.message}>
          コンソール用: 判定不可
        </Badge>
      ) : null}
    </>
  )
}
