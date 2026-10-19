import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { UseQueryResult } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { ShieldAlert, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import {
  createAdminToken,
  deleteAdminToken,
  getCurrentAdminToken,
  listAdminTokens,
} from '@/api'
import type { AdminToken, CreatedAdminToken } from '@/api'
import { AdminScopeEditor } from '@/components/admin-scope-editor'
import { ExpirationCell, ScopeCell } from '@/components/admin-token-cells'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { CopyButton } from '@/components/copy-button'
import { ExpirationInput } from '@/components/expiration-input'
import { AdminTokenSecretDialog } from '@/components/key-secret-dialog'
import { ListEmptyRow, ListError, ListSearch } from '@/components/list-status'
import { SortableTableHead } from '@/components/sortable-table-head'
import { Badge } from '@/components/ui/badge'
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
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { ALL_SCOPE, expirationBody, isFullScope, scopeScore } from '@/lib/admin-scopes'
import { expirationFromIso, expirationValid } from '@/lib/expiration'
import type { ExpirationValue } from '@/lib/expiration'
import { formatDateTime } from '@/lib/format'
import { sortRows, timeValue, useSort } from '@/lib/sort'
import type { SortValue } from '@/lib/sort'
import { useDebouncedValue } from '@/lib/use-debounce'

export const Route = createFileRoute('/admin-tokens/')({
  component: AdminTokensPage,
})

type TokenSortKey = 'name' | 'scope' | 'created' | 'expiration'

function tokenSortValue(t: AdminToken, key: TokenSortKey): SortValue {
  switch (key) {
    case 'name':
      return t.name
    case 'scope':
      return scopeScore(t.scope)
    case 'created':
      return timeValue(t.created)
    case 'expiration':
      return timeValue(t.expiration)
  }
}

function matchesToken(t: AdminToken, q: string): boolean {
  return t.name.toLowerCase().includes(q) || (t.id?.toLowerCase().includes(q) ?? false)
}

function AdminTokensPage() {
  const queryClient = useQueryClient()
  const [showCreate, setShowCreate] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<AdminToken | null>(null)
  // The one-time secret lives only in this state and is dropped on close.
  const [createdToken, setCreatedToken] = useState<CreatedAdminToken | null>(null)
  const [search, setSearch] = useState('')
  const debouncedSearch = useDebouncedValue(search.trim())
  const query = debouncedSearch.toLowerCase()
  const { sort, toggle } = useSort<TokenSortKey>({ key: 'name', direction: 'asc' })

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['admin-tokens'],
    queryFn: listAdminTokens,
  })
  const current = useQuery({
    queryKey: ['admin-tokens', 'current'],
    queryFn: getCurrentAdminToken,
  })
  const currentId = current.data?.id ?? null

  const rows = useMemo(() => {
    if (!data) return []
    const filtered = query ? data.filter((t) => matchesToken(t, query)) : data
    return sortRows(filtered, sort, tokenSortValue)
  }, [data, query, sort])

  const deleteMutation = useMutation({
    mutationFn: deleteAdminToken,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-tokens'] })
      toast.success('管理トークンを削除しました')
    },
    onError: (err) => {
      toast.error(`管理トークンの削除に失敗しました: ${err.message}`)
    },
  })

  const total = data?.length ?? 0
  const colSpan = 6

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">管理トークン</h1>
        <Button size="sm" onClick={() => setShowCreate(true)}>
          トークンを作成
        </Button>
      </div>

      <CurrentTokenCard query={current} />

      {isLoading ? (
        <p className="text-muted-foreground">読み込み中...</p>
      ) : isError ? (
        <ListError title="管理トークン一覧を取得できませんでした" error={error} onRetry={() => refetch()} />
      ) : (
        <>
          <ListSearch
            value={search}
            onChange={setSearch}
            placeholder="名前 / ID で検索"
            shown={rows.length}
            total={total}
          />
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/50">
                  <SortableTableHead label="名前" sortKey="name" sort={sort} onSort={toggle} />
                  <TableHead className="px-4">ID</TableHead>
                  <SortableTableHead label="許可エンドポイント" sortKey="scope" sort={sort} onSort={toggle} />
                  <SortableTableHead label="作成日" sortKey="created" sort={sort} onSort={toggle} />
                  <SortableTableHead label="有効期限" sortKey="expiration" sort={sort} onSort={toggle} />
                  <TableHead className="px-4 text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((token) => {
                  const isCurrent = token.id !== null && token.id === currentId
                  return (
                    <TableRow key={token.id ?? `static:${token.name}`}>
                      <TableCell className="px-4">
                        <span className="inline-flex flex-wrap items-center gap-2">
                          {token.id ? (
                            <Link
                              to="/admin-tokens/$id"
                              params={{ id: token.id }}
                              className="text-primary underline-offset-4 hover:underline"
                            >
                              {token.name || '(名前なし)'}
                            </Link>
                          ) : (
                            <span>{token.name}</span>
                          )}
                          {token.id === null && (
                            <Badge variant="secondary" title="Garage の設定ファイルで定義されたトークンです。ここからは編集・削除できません">
                              Static
                            </Badge>
                          )}
                          {isCurrent && <Badge variant="outline">このコンソール</Badge>}
                        </span>
                      </TableCell>
                      <TableCell className="px-4">
                        {token.id ? (
                          <span className="inline-flex items-center gap-1">
                            <span className="font-mono text-sm text-muted-foreground">{token.id}</span>
                            <CopyButton value={token.id} label="トークン ID をコピー" />
                          </span>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </TableCell>
                      <TableCell className="px-4">
                        <ScopeCell scope={token.scope} />
                      </TableCell>
                      <TableCell className="px-4 whitespace-nowrap text-muted-foreground" title={token.created ?? undefined}>
                        {formatDateTime(token.created)}
                      </TableCell>
                      <TableCell className="px-4 whitespace-nowrap">
                        <ExpirationCell token={token} />
                      </TableCell>
                      <TableCell className="px-4 text-right">
                        {token.id && (
                          <Button variant="destructive" size="sm" onClick={() => setDeleteTarget(token)}>
                            削除
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  )
                })}
                {total === 0 && (
                  <ListEmptyRow
                    colSpan={colSpan}
                    message="管理トークンがありません"
                    actionLabel="最初のトークンを作成"
                    onAction={() => setShowCreate(true)}
                  />
                )}
                {total > 0 && rows.length === 0 && (
                  <ListEmptyRow
                    colSpan={colSpan}
                    message={`「${debouncedSearch}」に一致する管理トークンはありません`}
                    actionLabel="検索をクリア"
                    onAction={() => setSearch('')}
                  />
                )}
              </TableBody>
            </Table>
          </div>
        </>
      )}

      <CreateAdminTokenDialog
        open={showCreate}
        onOpenChange={setShowCreate}
        onCreated={(created) => {
          queryClient.invalidateQueries({ queryKey: ['admin-tokens'] })
          setShowCreate(false)
          setCreatedToken(created)
        }}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}
        title="管理トークンの削除"
        description={
          deleteTarget && deleteTarget.id === currentId
            ? `「${deleteTarget.name}」はこのコンソール自身が使っているトークンです。削除するとコンソールが Garage を操作できなくなります。本当に削除しますか？`
            : `管理トークン「${deleteTarget?.name || deleteTarget?.id}」を削除しますか？このトークンを使っているクライアントは直ちに認証できなくなります。この操作は取り消せません。`
        }
        onConfirm={() => {
          if (deleteTarget?.id) return deleteMutation.mutateAsync(deleteTarget.id)
        }}
        isPending={deleteMutation.isPending}
      />

      <AdminTokenSecretDialog created={createdToken} onClose={() => setCreatedToken(null)} />
    </div>
  )
}

/** Shows which token (and scope) the console itself talks to Garage with. */
function CurrentTokenCard({ query }: { query: UseQueryResult<AdminToken> }) {
  if (query.isLoading) {
    return (
      <div className="rounded-lg border p-4 space-y-2">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-5 w-72" />
      </div>
    )
  }
  if (query.isError) {
    return (
      <div className="rounded-lg border p-4 text-sm">
        <p className="font-medium">このコンソールが使っているトークン</p>
        <p className="text-destructive">取得できませんでした: {query.error.message}</p>
      </div>
    )
  }
  const token = query.data
  if (!token) return null
  const full = isFullScope(token.scope)
  return (
    <div
      className={
        full
          ? 'rounded-lg border border-amber-500/50 bg-amber-500/5 p-4 text-sm space-y-2'
          : 'rounded-lg border p-4 text-sm space-y-2'
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        {full ? (
          <ShieldAlert className="h-4 w-4 text-amber-600 dark:text-amber-400" />
        ) : (
          <ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
        )}
        <p className="font-medium">このコンソールが使っているトークン</p>
        <span className="text-muted-foreground">{token.name}</span>
        {token.id === null && <Badge variant="secondary">Static</Badge>}
        {token.expired && <Badge variant="destructive">期限切れ</Badge>}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-muted-foreground">
        <span>
          許可エンドポイント: <ScopeCell scope={token.scope} />
        </span>
        <span>有効期限: {token.expiration ? formatDateTime(token.expiration) : '無期限'}</span>
      </div>
      {full ? (
        <p className="text-amber-700 dark:text-amber-400">
          フル権限(<code className="font-mono">*</code>)のトークンです。コンソールが乗っ取られた場合にクラスタ全体を操作されるため、
          必要なエンドポイントだけに絞ったトークンへの切り替えを検討してください。
        </p>
      ) : (
        token.scope.length > 0 && (
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer">許可されているエンドポイントを表示</summary>
            <p className="mt-1 font-mono break-words">{token.scope.join(', ')}</p>
          </details>
        )
      )}
    </div>
  )
}

function CreateAdminTokenDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (created: CreatedAdminToken) => void
}) {
  const [name, setName] = useState('')
  const [expiration, setExpiration] = useState<ExpirationValue>(() => expirationFromIso(null))
  const [scope, setScope] = useState<string[]>([ALL_SCOPE])

  const reset = () => {
    setName('')
    setExpiration(expirationFromIso(null))
    setScope([ALL_SCOPE])
  }

  const mutation = useMutation({
    mutationFn: () =>
      createAdminToken({ name: name.trim(), scope, ...expirationBody(expiration) }),
    onSuccess: (created) => {
      reset()
      mutation.reset()
      onCreated(created)
    },
  })

  const canSubmit = name.trim() !== '' && expirationValid(expiration) && scope.length > 0 && !mutation.isPending

  // Closing is blocked while the request is in flight (the secret must not be
  // lost), and clears a previous error so the next open starts clean.
  const handleOpenChange = (next: boolean) => {
    if (!next && mutation.isPending) return
    if (!next) mutation.reset()
    onOpenChange(next)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>管理トークンを作成</DialogTitle>
          <DialogDescription>
            Garage Admin API 用のトークンを発行します。トークン本体は作成直後に一度だけ表示されます。
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
            if (canSubmit) mutation.mutate()
          }}
        >
          <div className="space-y-1">
            <label htmlFor="admin-token-name" className="text-sm font-medium">
              名前
            </label>
            <Input
              id="admin-token-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例: backup-workflow"
              autoFocus
            />
          </div>
          <div className="space-y-1">
            <p className="text-sm font-medium">有効期限</p>
            <ExpirationInput value={expiration} onChange={setExpiration} disabled={mutation.isPending} />
          </div>
          <div className="space-y-1">
            <p className="text-sm font-medium">許可エンドポイント</p>
            <AdminScopeEditor value={scope} onChange={setScope} disabled={mutation.isPending} />
          </div>
          {mutation.isError && (
            <p className="text-sm text-destructive">{mutation.error.message}</p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={mutation.isPending}
            >
              キャンセル
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {mutation.isPending ? '作成中...' : '作成'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
