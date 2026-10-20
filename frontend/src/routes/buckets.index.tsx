import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { listBuckets, createBucket, deleteBucket } from '@/api'
import type { BucketListItem } from '@/api'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { CopyButton } from '@/components/copy-button'
import { ListEmptyRow, ListError, ListSearch, ListTruncatedBanner } from '@/components/list-status'
import { SortableTableHead } from '@/components/sortable-table-head'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table'
import { LocalNameBadge } from '@/components/local-name-badge'
import { bucketDisplayLabel, bucketDisplayName } from '@/lib/bucket-name'
import { bucketDeleteConsequences, bucketHasObjects } from '@/lib/consequences'
import { formatBytes, formatCount, formatDateTime, shortId } from '@/lib/format'
import { sortRows, timeValue, useSort } from '@/lib/sort'
import type { SortValue } from '@/lib/sort'
import { useDebouncedValue } from '@/lib/use-debounce'
import { useDocumentTitle } from '@/hooks/use-document-title'
import { useBucketKeyPermissionMutations } from '@/hooks/use-bucket-key-permissions'

export const Route = createFileRoute('/buckets/')({
  component: BucketsPage,
})

type BucketSortKey = 'alias' | 'id' | 'objects' | 'bytes' | 'keyCount' | 'created'

function nameOf(b: BucketListItem) {
  return bucketDisplayName(b.id, b.globalAliases, b.localAliases.map((a) => a.alias))
}

function bucketSortValue(b: BucketListItem, key: BucketSortKey): SortValue {
  switch (key) {
    case 'alias': {
      // Alias-less buckets sort first, as before.
      const name = nameOf(b)
      return name.source === 'id' ? '' : name.name
    }
    case 'id':
      return b.id
    case 'objects':
      return b.objects
    case 'bytes':
      return b.bytes
    case 'keyCount':
      return b.keyCount
    case 'created':
      return timeValue(b.created)
  }
}

function matchesBucket(b: BucketListItem, q: string): boolean {
  return (
    b.id.toLowerCase().includes(q) ||
    b.globalAliases.some((a) => a.toLowerCase().includes(q)) ||
    b.localAliases.some((a) => a.alias.toLowerCase().includes(q))
  )
}

function BucketsPage() {
  useDocumentTitle('バケット')
  const queryClient = useQueryClient()
  const [showCreate, setShowCreate] = useState(false)
  const [newBucketAlias, setNewBucketAlias] = useState('')
  const [grantConsole, setGrantConsole] = useState(true)
  const [deleteTarget, setDeleteTarget] = useState<BucketListItem | null>(null)
  const [search, setSearch] = useState('')
  const debouncedSearch = useDebouncedValue(search.trim())
  const query = debouncedSearch.toLowerCase()
  const { sort, toggle } = useSort<BucketSortKey>({ key: 'alias', direction: 'asc' })

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['buckets'],
    queryFn: listBuckets,
  })

  const allBuckets = data?.items
  const rows = useMemo(() => {
    if (!allBuckets) return []
    const filtered = query
      ? allBuckets.filter((b) => matchesBucket(b, query))
      : allBuckets
    return sortRows(filtered, sort, bucketSortValue)
  }, [allBuckets, query, sort])

  // Creating the bucket and granting the console's key are separate Garage
  // calls. A failed grant does not undo the bucket: grantConsole reports it
  // as a warning (afterCreate) and it can be retried from the object browser.
  const { grantConsole: grantConsoleMutation } = useBucketKeyPermissionMutations()
  const resetCreateForm = () => {
    setShowCreate(false)
    setNewBucketAlias('')
    setGrantConsole(true)
  }
  const createMutation = useMutation({
    mutationFn: (v: { alias: string; grantConsole: boolean }) =>
      createBucket({ globalAlias: v.alias }),
    onSuccess: (created, v) => {
      queryClient.invalidateQueries({ queryKey: ['buckets'] })
      resetCreateForm()
      toast.success('バケットを作成しました')
      if (!v.grantConsole) return
      const bucketId = typeof created?.id === 'string' ? created.id : undefined
      if (bucketId) {
        grantConsoleMutation.mutate({ bucketId, afterCreate: true })
      } else {
        toast.warning(
          'コンソールのキーへの権限付与に失敗しました: 作成したバケットの ID を取得できませんでした。バケット詳細のオブジェクト欄から付与できます',
        )
      }
    },
  })

  const deleteMutation = useMutation({
    mutationFn: deleteBucket,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['buckets'] })
      toast.success('バケットを削除しました')
    },
    onError: (error) => {
      toast.error(`バケットの削除に失敗しました: ${error.message}`)
    },
  })

  const total = allBuckets?.length ?? 0
  const colSpan = 7

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">バケット</h1>
        <Button size="sm" onClick={() => setShowCreate(true)}>
          バケットを作成
        </Button>
      </div>

      {showCreate && (
        <div className="rounded-lg border p-4">
          <h2 className="mb-2 font-semibold">新規バケット</h2>
          <div className="flex gap-2">
            <Input
              type="text"
              value={newBucketAlias}
              onChange={(e) => setNewBucketAlias(e.target.value)}
              placeholder="グローバルエイリアス"
              className="flex-1"
              autoFocus
            />
            <Button
              size="sm"
              onClick={() => createMutation.mutate({ alias: newBucketAlias, grantConsole })}
              disabled={!newBucketAlias || createMutation.isPending}
            >
              {createMutation.isPending ? '作成中...' : '作成'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={resetCreateForm}
            >
              キャンセル
            </Button>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <Checkbox
              id="create-bucket-grant-console"
              checked={grantConsole}
              disabled={createMutation.isPending}
              onCheckedChange={(checked) => setGrantConsole(checked === true)}
            />
            <label htmlFor="create-bucket-grant-console" className="text-sm">
              コンソールのキーに read/write を付与する
            </label>
          </div>
          {createMutation.isError && (
            <p className="mt-2 text-sm text-destructive">
              {createMutation.error.message}
            </p>
          )}
        </div>
      )}

      {isLoading ? (
        <p className="text-muted-foreground">読み込み中...</p>
      ) : isError ? (
        <ListError title="バケット一覧を取得できませんでした" error={error} onRetry={() => refetch()} />
      ) : (
        <>
          {data?.truncated && (
            <ListTruncatedBanner>
              Garage の一覧取得の上限に達したため、一部のバケットが表示されていない可能性があります。
            </ListTruncatedBanner>
          )}
          <ListSearch
            value={search}
            onChange={setSearch}
            placeholder="エイリアス / ID で検索"
            shown={rows.length}
            total={total}
          />
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/50">
                  <SortableTableHead label="エイリアス" sortKey="alias" sort={sort} onSort={toggle} />
                  <SortableTableHead label="ID" sortKey="id" sort={sort} onSort={toggle} />
                  <SortableTableHead label="オブジェクト数" sortKey="objects" sort={sort} onSort={toggle} alignRight />
                  <SortableTableHead label="使用量" sortKey="bytes" sort={sort} onSort={toggle} alignRight />
                  <SortableTableHead label="キー数" sortKey="keyCount" sort={sort} onSort={toggle} alignRight />
                  <SortableTableHead label="作成日" sortKey="created" sort={sort} onSort={toggle} />
                  <TableHead className="px-4 text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((bucket) => (
                  <TableRow key={bucket.id}>
                    <TableCell className="px-4 align-top font-medium">
                      <BucketAliasCell bucket={bucket} />
                    </TableCell>
                    <TableCell className="px-4 align-top">
                      <span className="inline-flex items-center gap-1">
                        <span className="font-mono text-sm text-muted-foreground" title={bucket.id}>
                          {shortId(bucket.id)}
                        </span>
                        <CopyButton value={bucket.id} label="バケット ID をコピー" />
                      </span>
                    </TableCell>
                    <TableCell
                      className="px-4 align-top text-right tabular-nums"
                      title={bucket.quotas?.maxObjects != null ? `上限 ${formatCount(bucket.quotas.maxObjects)}` : undefined}
                    >
                      {formatCount(bucket.objects)}
                    </TableCell>
                    <TableCell className="px-4 align-top text-right tabular-nums">
                      {bucket.bytes === null ? '-' : formatBytes(bucket.bytes)}
                      {bucket.quotas?.maxSize != null && (
                        <span className="text-muted-foreground"> / {formatBytes(bucket.quotas.maxSize)}</span>
                      )}
                      {!!bucket.unfinishedMultipartUploads && (
                        <div className="text-xs text-muted-foreground">
                          未完了アップロード {formatCount(bucket.unfinishedMultipartUploads)}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="px-4 align-top text-right tabular-nums">
                      {formatCount(bucket.keyCount)}
                    </TableCell>
                    <TableCell className="px-4 align-top whitespace-nowrap text-muted-foreground" title={bucket.created ?? undefined}>
                      {formatDateTime(bucket.created)}
                    </TableCell>
                    <TableCell className="px-4 align-top text-right">
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => setDeleteTarget(bucket)}
                      >
                        削除
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
                {total === 0 && (
                  <ListEmptyRow
                    colSpan={colSpan}
                    message="バケットがありません"
                    actionLabel="最初のバケットを作成"
                    onAction={() => setShowCreate(true)}
                  />
                )}
                {total > 0 && rows.length === 0 && (
                  <ListEmptyRow
                    colSpan={colSpan}
                    message={`「${debouncedSearch}」に一致するバケットはありません`}
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
        title="バケットの削除"
        description={`バケット「${deleteTarget ? bucketDisplayLabel(nameOf(deleteTarget)) : ''}」を削除しますか？`}
        target={
          deleteTarget
            ? [
                { label: '名前', value: bucketDisplayLabel(nameOf(deleteTarget)) },
                { label: 'ID', value: deleteTarget.id, mono: true },
                { label: 'オブジェクト', value: `${formatCount(deleteTarget.objects)} 件 / ${deleteTarget.bytes === null ? '-' : formatBytes(deleteTarget.bytes)}` },
              ]
            : undefined
        }
        consequences={deleteTarget ? bucketDeleteConsequences(deleteTarget) : undefined}
        irreversible
        confirmDisabled={deleteTarget ? bucketHasObjects(deleteTarget) : false}
        confirmLabel="バケットを削除"
        onConfirm={() => {
          if (deleteTarget) return deleteMutation.mutateAsync(deleteTarget.id)
        }}
        isPending={deleteMutation.isPending}
      />
    </div>
  )
}

/** All global aliases (extra ones collapsed behind 「他 N 件」) plus a local-alias count. */
function BucketAliasCell({ bucket }: { bucket: BucketListItem }) {
  const [expanded, setExpanded] = useState(false)
  const rest = bucket.globalAliases.slice(1)
  const local = bucket.localAliases
  const name = nameOf(bucket)
  return (
    <div className="flex flex-col items-start gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <Link
          to="/buckets/$id"
          params={{ id: bucket.id }}
          className="break-all text-primary underline-offset-4 hover:underline"
        >
          {name.source === 'id' ? '(エイリアスなし)' : name.name}
        </Link>
        <LocalNameBadge name={name} />
        {rest.length > 0 && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            className="text-xs text-muted-foreground underline-offset-4 hover:underline"
          >
            {expanded ? '折りたたむ' : `他 ${rest.length} 件`}
          </button>
        )}
        {local.length > 0 && (
          <Badge
            variant="secondary"
            title={`ローカルエイリアス:\n${local.map((a) => `${a.alias} (${a.accessKeyId})`).join('\n')}`}
          >
            ローカル {local.length}
          </Badge>
        )}
      </div>
      {expanded && (
        <ul className="space-y-0.5 text-sm font-normal text-muted-foreground">
          {rest.map((a) => (
            <li key={a} className="break-all">{a}</li>
          ))}
        </ul>
      )}
    </div>
  )
}
