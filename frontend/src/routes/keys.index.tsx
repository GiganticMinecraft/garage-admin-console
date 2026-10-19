import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { listKeys, deleteKey } from '@/api'
import type { KeyListItem, KeyDetail } from '@/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CreateKeyDialog } from '@/components/create-key-dialog'
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { CopyButton } from '@/components/copy-button'
import { KeySecretDialog } from '@/components/key-secret-dialog'
import { ListEmptyRow, ListError, ListSearch, ListTruncatedBanner } from '@/components/list-status'
import { SortableTableHead } from '@/components/sortable-table-head'
import { formatCount, formatDateTime } from '@/lib/format'
import { sortRows, timeValue, useSort } from '@/lib/sort'
import type { SortValue } from '@/lib/sort'
import { useDebouncedValue } from '@/lib/use-debounce'
import { toast } from 'sonner'

export const Route = createFileRoute('/keys/')({
  component: KeysPage,
})

type KeySortKey = 'name' | 'id' | 'bucketCount' | 'created' | 'expiration'

function keySortValue(k: KeyListItem, key: KeySortKey): SortValue {
  switch (key) {
    case 'name':
      return k.name
    case 'id':
      return k.id
    case 'bucketCount':
      return k.bucketCount
    case 'created':
      return timeValue(k.created)
    case 'expiration':
      // No expiration (never expires) is null, which compareSortValues keeps
      // at the end in both directions.
      return timeValue(k.expiration)
  }
}

function matchesKey(k: KeyListItem, q: string): boolean {
  return k.id.toLowerCase().includes(q) || k.name.toLowerCase().includes(q)
}

function KeysPage() {
  const queryClient = useQueryClient()
  const [showCreate, setShowCreate] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<KeyListItem | null>(null)
  const [createdKey, setCreatedKey] = useState<KeyDetail | null>(null)
  const [search, setSearch] = useState('')
  const debouncedSearch = useDebouncedValue(search.trim())
  const query = debouncedSearch.toLowerCase()
  const { sort, toggle } = useSort<KeySortKey>({ key: 'name', direction: 'asc' })

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['keys'],
    queryFn: listKeys,
  })

  const allKeys = data?.items
  const rows = useMemo(() => {
    if (!allKeys) return []
    const filtered = query
      ? allKeys.filter((k) => matchesKey(k, query))
      : allKeys
    return sortRows(filtered, sort, keySortValue)
  }, [allKeys, query, sort])

  const handleCreated = (created: KeyDetail) => {
    queryClient.invalidateQueries({ queryKey: ['keys'] })
    // The secret is only returned here; show it once so the operator can copy it.
    setCreatedKey(created)
  }

  const deleteMutation = useMutation({
    mutationFn: deleteKey,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      toast.success('キーを削除しました')
    },
    onError: (error) => {
      toast.error(`キーの削除に失敗しました: ${error.message}`)
    },
  })

  const total = allKeys?.length ?? 0
  const colSpan = 6

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">キー</h1>
        <Button size="sm" onClick={() => setShowCreate(true)}>
          キーを作成
        </Button>
      </div>

      <CreateKeyDialog open={showCreate} onOpenChange={setShowCreate} onCreated={handleCreated} />

      {isLoading ? (
        <p className="text-muted-foreground">読み込み中...</p>
      ) : isError ? (
        <ListError title="キー一覧を取得できませんでした" error={error} onRetry={() => refetch()} />
      ) : (
        <>
          {data?.truncated && (
            <ListTruncatedBanner>
              Garage の一覧取得の上限に達したため、一部のキーが表示されていない可能性があります。
            </ListTruncatedBanner>
          )}
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
                  <SortableTableHead label="ID" sortKey="id" sort={sort} onSort={toggle} />
                  <SortableTableHead label="バケット数" sortKey="bucketCount" sort={sort} onSort={toggle} alignRight />
                  <SortableTableHead label="作成日" sortKey="created" sort={sort} onSort={toggle} />
                  <SortableTableHead label="有効期限" sortKey="expiration" sort={sort} onSort={toggle} />
                  <TableHead className="px-4 text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((key) => (
                  <TableRow key={key.id}>
                    <TableCell className="px-4">
                      <Link
                        to="/keys/$id"
                        params={{ id: key.id }}
                        className="text-primary underline-offset-4 hover:underline"
                      >
                        {key.name || '(名前なし)'}
                      </Link>
                    </TableCell>
                    <TableCell className="px-4">
                      <span className="inline-flex items-center gap-1">
                        <span className="font-mono text-sm text-muted-foreground" title={key.id}>
                          {key.id.length > 16 ? `${key.id.slice(0, 16)}…` : key.id}
                        </span>
                        <CopyButton value={key.id} label="アクセスキー ID をコピー" />
                      </span>
                    </TableCell>
                    <TableCell className="px-4 text-right tabular-nums">
                      {formatCount(key.bucketCount)}
                    </TableCell>
                    <TableCell className="px-4 whitespace-nowrap text-muted-foreground" title={key.created ?? undefined}>
                      {formatDateTime(key.created)}
                    </TableCell>
                    <TableCell className="px-4 whitespace-nowrap">
                      <span className="inline-flex items-center gap-2">
                        {key.expiration ? (
                          <span className="text-muted-foreground" title={key.expiration}>
                            {formatDateTime(key.expiration)}
                          </span>
                        ) : (
                          <span className="text-muted-foreground" title="無期限" aria-label="無期限">
                            ∞
                          </span>
                        )}
                        {key.expired && <Badge variant="destructive">期限切れ</Badge>}
                      </span>
                    </TableCell>
                    <TableCell className="px-4 text-right">
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => setDeleteTarget(key)}
                      >
                        削除
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
                {total === 0 && (
                  <ListEmptyRow
                    colSpan={colSpan}
                    message="キーがありません"
                    actionLabel="最初のキーを作成"
                    onAction={() => setShowCreate(true)}
                  />
                )}
                {total > 0 && rows.length === 0 && (
                  <ListEmptyRow
                    colSpan={colSpan}
                    message={`「${debouncedSearch}」に一致するキーはありません`}
                    actionLabel="検索をクリア"
                    onAction={() => setSearch('')}
                  />
                )}
              </TableBody>
            </Table>
          </div>
        </>
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}
        title="キーの削除"
        description={`キー「${deleteTarget?.name || deleteTarget?.id}」を削除しますか？この操作は取り消せません。`}
        onConfirm={() => {
          if (deleteTarget) return deleteMutation.mutateAsync(deleteTarget.id)
        }}
        isPending={deleteMutation.isPending}
      />

      <KeySecretDialog created={createdKey} onClose={() => setCreatedKey(null)} />
    </div>
  )
}
