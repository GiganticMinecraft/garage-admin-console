import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useMemo, useRef, useState } from 'react'
import {
  ApiError,
  MAX_BATCH_DOWNLOAD_KEYS,
  deleteObject,
  deleteObjects,
  deletePrefix,
  downloadObjectUrl,
  downloadObjectsZip,
  getPrefixSummary,
  listObjects,
  uploadObject,
  type PrefixSummary,
} from '@/api'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { toast } from 'sonner'
import { ArrowDown, ArrowUp, ArrowUpDown, Folder, FolderUp } from 'lucide-react'

const MAX_CONCURRENT_UPLOADS = 3
const PREFIX_DEBOUNCE_MS = 300

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
}

const dateFormatter = new Intl.DateTimeFormat('ja-JP', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
})

function formatDate(value: string | undefined): string {
  if (!value) return '-'
  const d = new Date(value)
  // Go's zero time ("0001-01-01T00:00:00Z") means S3 sent no LastModified.
  if (Number.isNaN(d.getTime()) || d.getUTCFullYear() <= 1) return '-'
  return dateFormatter.format(d)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function PrefixBreadcrumb({
  prefix,
  onNavigate,
}: {
  prefix: string
  onNavigate: (prefix: string) => void
}) {
  if (!prefix) return null
  const segments = prefix.split('/').filter(Boolean)
  return (
    <div className="flex items-center gap-1 text-sm text-muted-foreground">
      <button
        className="hover:underline"
        onClick={() => onNavigate('')}
      >
        /
      </button>
      {segments.map((seg, i) => {
        const path = segments.slice(0, i + 1).join('/') + '/'
        const isLast = i === segments.length - 1
        return (
          <span key={path} className="flex items-center gap-1">
            <span>&gt;</span>
            {isLast ? (
              <span>{seg}</span>
            ) : (
              <button
                className="hover:underline"
                onClick={() => onNavigate(path)}
              >
                {seg}
              </button>
            )}
          </span>
        )
      })}
    </div>
  )
}

type SortKey = 'name' | 'size' | 'lastModified'
type SortDir = 'asc' | 'desc'

function SortableHead({
  label,
  column,
  sortKey,
  sortDir,
  onSort,
  className,
}: {
  label: string
  column: SortKey
  sortKey: SortKey
  sortDir: SortDir
  onSort: (column: SortKey) => void
  className?: string
}) {
  const active = sortKey === column
  const Icon = !active ? ArrowUpDown : sortDir === 'asc' ? ArrowUp : ArrowDown
  return (
    <TableHead
      className={className}
      aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        className="inline-flex items-center gap-1 hover:text-foreground"
        onClick={() => onSort(column)}
      >
        {label}
        <Icon className={`h-3.5 w-3.5 ${active ? '' : 'opacity-40'}`} aria-hidden />
      </button>
    </TableHead>
  )
}

type UploadStatus = 'queued' | 'uploading' | 'done' | 'error' | 'conflict'

interface UploadItem {
  id: number
  bucket: string
  file: File
  key: string
  overwrite: boolean
  loaded: number
  total: number
  status: UploadStatus
  error?: string
}

const uploadStatusLabel: Record<UploadStatus, string> = {
  queued: '待機中',
  uploading: 'アップロード中',
  done: '完了',
  error: '失敗',
  conflict: '同名のオブジェクトが存在',
}

/** Joins the current prefix (treated as a folder) and a relative path. */
function keyFor(prefix: string, relativePath: string): string {
  if (!prefix) return relativePath
  return (prefix.endsWith('/') ? prefix : `${prefix}/`) + relativePath
}

function parentPrefix(prefix: string): string {
  const segments = prefix.replace(/\/$/, '').split('/')
  segments.pop()
  return segments.length > 0 ? segments.join('/') + '/' : ''
}

interface PrefixDeleteTarget extends PrefixSummary {
  prefix: string
}

export function ObjectBrowser({
  bucketId,
  bucketName,
  prefix,
  onPrefixChange,
}: {
  /** Bucket ID used in API paths. */
  bucketId: string
  /** Human-readable alias, used for the ZIP filename. */
  bucketName?: string
  prefix: string
  onPrefixChange: (prefix: string) => void
}) {
  const queryClient = useQueryClient()

  // --- Prefix input (debounced) and selection -------------------------------
  const [prefixInput, setPrefixInput] = useState(prefix)
  const [syncedPrefix, setSyncedPrefix] = useState(prefix)
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // When the prefix changes (debounced commit, breadcrumb, back/forward),
  // mirror it into the input and drop the selection: objects that are no
  // longer visible must not ride along into a ZIP or a bulk delete.
  if (prefix !== syncedPrefix) {
    setSyncedPrefix(prefix)
    setPrefixInput(prefix)
    setSelectedKeys(new Set())
  }

  const goToPrefix = (next: string) => {
    clearTimeout(debounceTimer.current)
    setPrefixInput(next)
    onPrefixChange(next)
  }

  const handlePrefixInput = (value: string) => {
    setPrefixInput(value)
    clearTimeout(debounceTimer.current)
    debounceTimer.current = setTimeout(() => onPrefixChange(value), PREFIX_DEBOUNCE_MS)
  }

  // --- Listing and sorting ------------------------------------------------
  const objects = useInfiniteQuery({
    queryKey: ['objects', bucketId, prefix],
    queryFn: ({ pageParam }) =>
      listObjects(bucketId, prefix || undefined, pageParam || undefined),
    initialPageParam: '' as string,
    getNextPageParam: (lastPage) =>
      lastPage.isTruncated ? lastPage.nextContinuationToken : undefined,
  })

  const allObjects = useMemo(
    () => objects.data?.pages.flatMap((p) => p.objects ?? []) ?? [],
    [objects.data],
  )
  const allPrefixes = [
    ...new Set(objects.data?.pages.flatMap((p) => p.prefixes ?? []) ?? []),
  ]

  const [sortKey, setSortKey] = useState<SortKey>('name')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const handleSort = (column: SortKey) => {
    if (column === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(column)
      // Newest / largest first is the more useful default for those columns.
      setSortDir(column === 'name' ? 'asc' : 'desc')
    }
  }
  const sortedObjects = useMemo(() => {
    const sign = sortDir === 'asc' ? 1 : -1
    return [...allObjects].sort((a, b) => {
      let cmp: number
      if (sortKey === 'size') cmp = a.size - b.size
      else if (sortKey === 'lastModified')
        cmp = (Date.parse(a.lastModified) || 0) - (Date.parse(b.lastModified) || 0)
      else cmp = 0
      if (cmp === 0) cmp = a.key < b.key ? -1 : a.key > b.key ? 1 : 0
      return cmp * sign
    })
  }, [allObjects, sortKey, sortDir])

  const invalidateObjects = () => {
    queryClient.invalidateQueries({ queryKey: ['objects', bucketId] })
    queryClient.invalidateQueries({ queryKey: ['bucket', bucketId] })
  }

  // --- Selection ----------------------------------------------------------
  const toggleSelect = (key: string) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }
  const isAllSelected = allObjects.length > 0 && allObjects.every((obj) => selectedKeys.has(obj.key))
  const toggleSelectAll = () => {
    setSelectedKeys((prev) => {
      const next = new Set(prev)
      if (isAllSelected) {
        for (const obj of allObjects) next.delete(obj.key)
      } else {
        for (const obj of allObjects) next.add(obj.key)
      }
      return next
    })
  }

  // --- Upload queue -------------------------------------------------------
  const [uploads, setUploads] = useState<UploadItem[]>([])
  const pendingUploads = useRef<UploadItem[]>([])
  const activeUploads = useRef(0)
  const nextUploadId = useRef(1)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)

  const patchUpload = (id: number, patch: Partial<UploadItem>) => {
    setUploads((prev) => prev.map((u) => (u.id === id ? { ...u, ...patch } : u)))
  }

  // Starts queued uploads until MAX_CONCURRENT_UPLOADS are in flight; every
  // finished upload calls it again. Runs only from event handlers and
  // promise callbacks, never during render.
  const pumpUploads = () => {
    while (activeUploads.current < MAX_CONCURRENT_UPLOADS && pendingUploads.current.length > 0) {
      const item = pendingUploads.current.shift()!
      activeUploads.current++
      patchUpload(item.id, { status: 'uploading', loaded: 0, error: undefined })
      uploadObject(item.bucket, item.file, {
        key: item.key,
        overwrite: item.overwrite,
        // XHR totals include the multipart framing; scale to the file size.
        onProgress: (loaded, total) =>
          patchUpload(item.id, { loaded: total > 0 ? Math.round((item.total * loaded) / total) : 0 }),
      })
        .then(() => {
          patchUpload(item.id, { status: 'done', loaded: item.total })
        })
        .catch((error: unknown) => {
          if (error instanceof ApiError && error.status === 409) {
            patchUpload(item.id, { status: 'conflict', error: error.message })
          } else {
            patchUpload(item.id, { status: 'error', error: errorMessage(error) })
          }
        })
        .finally(() => {
          activeUploads.current--
          pumpUploads()
          // Refresh the listing once the queue drains rather than per file,
          // so a folder of hundreds of files doesn't trigger hundreds of
          // list requests.
          if (activeUploads.current === 0) invalidateObjects()
        })
    }
  }

  const enqueue = (items: UploadItem[]) => {
    if (items.length === 0) return
    setUploads((prev) => [...prev, ...items])
    pendingUploads.current.push(...items)
    pumpUploads()
  }

  const enqueueFiles = (files: File[], useRelativePath: boolean) => {
    enqueue(
      files.map((file) => ({
        id: nextUploadId.current++,
        bucket: bucketId,
        file,
        // Folder uploads keep the path below the chosen folder.
        key: keyFor(prefix, useRelativePath && file.webkitRelativePath ? file.webkitRelativePath : file.name),
        overwrite: false,
        loaded: 0,
        total: file.size,
        status: 'queued' as const,
      })),
    )
  }

  const requeue = (targets: UploadItem[], overwrite: boolean) => {
    const retried = targets.map((u) => ({ ...u, overwrite, status: 'queued' as const, loaded: 0 }))
    const ids = new Set(retried.map((u) => u.id))
    setUploads((prev) => prev.map((u) => (ids.has(u.id) ? retried.find((r) => r.id === u.id)! : u)))
    pendingUploads.current.push(...retried)
    pumpUploads()
  }

  const dismissUploads = (predicate: (u: UploadItem) => boolean) => {
    setUploads((prev) => prev.filter((u) => !predicate(u)))
  }

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>, useRelativePath: boolean) => {
    const files = Array.from(e.target.files ?? [])
    // Reset so choosing the same file again still fires onChange.
    e.target.value = ''
    enqueueFiles(files, useRelativePath)
  }

  const [isDragging, setIsDragging] = useState(false)
  const dragCounter = useRef(0)
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    dragCounter.current = 0
    setIsDragging(false)
    enqueueFiles(Array.from(e.dataTransfer.files), false)
  }

  const conflicts = uploads.filter((u) => u.status === 'conflict')
  const activeCount = uploads.filter((u) => u.status === 'uploading' || u.status === 'queued').length
  const finishedCount = uploads.filter((u) => u.status === 'done').length

  // --- Single, bulk and prefix delete --------------------------------------
  const [deleteObjectTarget, setDeleteObjectTarget] = useState<string | null>(null)
  const deleteMutation = useMutation({
    mutationFn: (key: string) => deleteObject(bucketId, key),
    onSuccess: (_data, key) => {
      invalidateObjects()
      setSelectedKeys((prev) => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
      toast.success('オブジェクトを削除しました')
    },
    onError: (error) => {
      toast.error(`オブジェクトの削除に失敗しました: ${error.message}`)
    },
  })

  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false)
  const bulkDeleteMutation = useMutation({
    mutationFn: (keys: string[]) => deleteObjects(bucketId, keys),
    onSuccess: (result) => {
      invalidateObjects()
      const errors = result.errors ?? []
      // Keep only the keys that failed selected so they can be retried.
      setSelectedKeys(new Set(errors.map((e) => e.key)))
      if (errors.length > 0) {
        toast.error(
          `${result.deleted}件を削除し、${errors.length}件の削除に失敗しました: ${errors[0].key}: ${errors[0].message}`,
        )
      } else {
        toast.success(`${result.deleted}件のオブジェクトを削除しました`)
      }
    },
    onError: (error) => {
      toast.error(`一括削除に失敗しました: ${error.message}`)
    },
  })

  const [prefixDeleteTarget, setPrefixDeleteTarget] = useState<PrefixDeleteTarget | null>(null)
  const summaryMutation = useMutation({
    mutationFn: (target: string) => getPrefixSummary(bucketId, target),
    onSuccess: (summary, target) => setPrefixDeleteTarget({ ...summary, prefix: target }),
    onError: (error) => {
      toast.error(`オブジェクト数の取得に失敗しました: ${error.message}`)
    },
  })
  const prefixDeleteMutation = useMutation({
    mutationFn: (target: string) => deletePrefix(bucketId, target),
    onSuccess: (result, target) => {
      invalidateObjects()
      const errors = result.errors ?? []
      if (errors.length > 0) {
        toast.error(
          `${result.deleted}件を削除し、${errors.length}件の削除に失敗しました: ${errors[0].key}: ${errors[0].message}`,
        )
      } else if (result.truncated) {
        toast.warning(`${result.deleted}件を削除しました。上限に達したため残りがあります。もう一度実行してください`)
      } else {
        toast.success(`「${target}」以下の${result.deleted}件を削除しました`)
        if (target === prefix && target.endsWith('/')) goToPrefix(parentPrefix(target))
      }
    },
    onError: (error) => {
      toast.error(`プレフィックスの削除に失敗しました: ${error.message}`)
    },
  })

  // --- Batch download -----------------------------------------------------
  const batchDownloadMutation = useMutation({
    mutationFn: (keys: string[]) => downloadObjectsZip(bucketId, keys, bucketName),
    onSuccess: () => {
      setSelectedKeys(new Set())
      toast.success('ダウンロードを開始しました')
    },
    onError: (error: Error) => {
      toast.error(`一括ダウンロードに失敗しました: ${error.message}`)
    },
  })
  const tooManyForZip = selectedKeys.size > MAX_BATCH_DOWNLOAD_KEYS

  return (
    <div className="space-y-2">
      <h2 className="text-lg font-semibold">オブジェクト</h2>
      <PrefixBreadcrumb prefix={prefix} onNavigate={goToPrefix} />
      <div className="flex flex-wrap gap-2">
        <Input
          value={prefixInput}
          onChange={(e) => handlePrefixInput(e.target.value)}
          placeholder="プレフィックスで絞り込み"
          className="min-w-48 flex-1"
          aria-label="プレフィックス"
        />
        <Button size="sm" onClick={() => fileInputRef.current?.click()}>
          アップロード
        </Button>
        <Button size="sm" variant="outline" onClick={() => folderInputRef.current?.click()}>
          フォルダをアップロード
        </Button>
        {prefix && (
          <Button
            size="sm"
            variant="outline"
            className="text-destructive"
            onClick={() => summaryMutation.mutate(prefix)}
            disabled={summaryMutation.isPending}
          >
            {summaryMutation.isPending ? '件数を確認中...' : 'このプレフィックス以下を削除'}
          </Button>
        )}
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          multiple
          onChange={(e) => handleFileInput(e, false)}
        />
        <input
          ref={(el) => {
            folderInputRef.current = el
            if (el) el.webkitdirectory = true
          }}
          type="file"
          className="hidden"
          multiple
          onChange={(e) => handleFileInput(e, true)}
        />
      </div>

      <div
        onDragOver={(e) => e.preventDefault()}
        onDragEnter={(e) => {
          e.preventDefault()
          dragCounter.current++
          setIsDragging(true)
        }}
        onDragLeave={(e) => {
          e.preventDefault()
          dragCounter.current--
          if (dragCounter.current === 0) setIsDragging(false)
        }}
        onDrop={handleDrop}
        className={`rounded-lg border-2 border-dashed p-4 text-center text-sm text-muted-foreground transition-colors ${
          isDragging ? 'border-primary bg-primary/5' : ''
        }`}
      >
        ここにファイルをドラッグ＆ドロップしてアップロード
      </div>

      {/* Upload queue */}
      {uploads.length > 0 && (
        <div className="space-y-2 rounded-lg border p-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">アップロード</span>
            <span className="text-muted-foreground">
              {activeCount > 0 ? `残り ${activeCount} 件 / ` : ''}完了 {finishedCount} / {uploads.length} 件
            </span>
            <div className="ml-auto flex gap-1">
              {conflicts.length > 0 && (
                <>
                  <Button size="sm" variant="destructive" onClick={() => requeue(conflicts, true)}>
                    競合 {conflicts.length} 件をすべて上書き
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => dismissUploads((u) => u.status === 'conflict')}
                  >
                    競合をスキップ
                  </Button>
                </>
              )}
              <Button
                size="sm"
                variant="link"
                onClick={() => dismissUploads((u) => u.status === 'done' || u.status === 'error')}
                disabled={!uploads.some((u) => u.status === 'done' || u.status === 'error')}
              >
                完了・失敗を消去
              </Button>
            </div>
          </div>
          <ul className="max-h-64 space-y-1.5 overflow-y-auto text-sm" aria-live="polite">
            {uploads.map((u) => {
              const percent = u.total > 0 ? Math.min(100, Math.round((u.loaded / u.total) * 100)) : u.status === 'done' ? 100 : 0
              return (
                <li key={u.id} className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate font-mono text-xs" title={u.key}>
                      {u.key}
                    </span>
                    <span
                      className={`shrink-0 text-xs ${
                        u.status === 'error' || u.status === 'conflict'
                          ? 'text-destructive'
                          : 'text-muted-foreground'
                      }`}
                    >
                      {uploadStatusLabel[u.status]}
                      {u.status === 'uploading' && ` ${percent}%`}
                      {u.status !== 'error' && ` (${formatBytes(u.total)})`}
                    </span>
                    {u.status === 'conflict' && (
                      <>
                        <Button
                          size="sm"
                          variant="link"
                          className="h-auto p-0 text-destructive"
                          onClick={() => requeue([u], true)}
                        >
                          上書き
                        </Button>
                        <Button
                          size="sm"
                          variant="link"
                          className="h-auto p-0"
                          onClick={() => dismissUploads((x) => x.id === u.id)}
                        >
                          スキップ
                        </Button>
                      </>
                    )}
                    {u.status === 'error' && (
                      <Button
                        size="sm"
                        variant="link"
                        className="h-auto p-0"
                        onClick={() => requeue([u], u.overwrite)}
                      >
                        再試行
                      </Button>
                    )}
                  </div>
                  {(u.status === 'uploading' || u.status === 'queued') && (
                    <div
                      className="h-1.5 w-full overflow-hidden rounded bg-muted"
                      role="progressbar"
                      aria-label={`${u.key} のアップロード進捗`}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={percent}
                    >
                      <div className="h-full bg-primary transition-[width]" style={{ width: `${percent}%` }} />
                    </div>
                  )}
                  {u.status === 'error' && u.error && (
                    <p className="text-xs text-destructive">{u.error}</p>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {/* Batch action bar */}
      {selectedKeys.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 px-4 py-2">
          <span className="text-sm text-muted-foreground">
            {selectedKeys.size}件選択中
          </span>
          <Button
            size="sm"
            onClick={() => batchDownloadMutation.mutate([...selectedKeys])}
            disabled={batchDownloadMutation.isPending || tooManyForZip}
            title={tooManyForZip ? `一括ダウンロードは最大 ${MAX_BATCH_DOWNLOAD_KEYS} 件までです` : undefined}
          >
            {batchDownloadMutation.isPending ? '準備中...' : '一括ダウンロード'}
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => setBulkDeleteOpen(true)}
            disabled={bulkDeleteMutation.isPending}
          >
            選択を削除
          </Button>
          <Button
            variant="link"
            size="sm"
            onClick={() => setSelectedKeys(new Set())}
          >
            選択解除
          </Button>
          {tooManyForZip && (
            <span className="text-xs text-destructive">
              一括ダウンロードは最大 {MAX_BATCH_DOWNLOAD_KEYS} 件までです
            </span>
          )}
        </div>
      )}

      {/* Prefix navigation */}
      {prefix && (
        <Button
          variant="link"
          size="sm"
          className="flex h-auto items-center gap-1.5 p-0"
          onClick={() => goToPrefix(parentPrefix(prefix))}
        >
          <FolderUp className="h-4 w-4" />
          ../
        </Button>
      )}
      {allPrefixes.map((p: string) => (
        <Button
          key={p}
          variant="link"
          size="sm"
          className="flex h-auto items-center gap-1.5 p-0"
          onClick={() => goToPrefix(p)}
        >
          <Folder className="h-4 w-4" />
          {p}
        </Button>
      ))}

      {objects.isLoading ? (
        <p className="text-muted-foreground">オブジェクトを読み込み中...</p>
      ) : objects.isError ? (
        <p className="text-destructive">
          オブジェクトの読み込みに失敗しました: {objects.error.message}
        </p>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <input
                    type="checkbox"
                    checked={isAllSelected}
                    onChange={toggleSelectAll}
                    className="rounded"
                    aria-label="すべて選択"
                  />
                </TableHead>
                <SortableHead label="キー" column="name" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
                <SortableHead
                  label="サイズ"
                  column="size"
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onSort={handleSort}
                  className="text-right"
                />
                <SortableHead
                  label="更新日時"
                  column="lastModified"
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onSort={handleSort}
                  className="text-right"
                />
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedObjects.map((obj) => (
                <TableRow key={obj.key}>
                  <TableCell>
                    <input
                      type="checkbox"
                      checked={selectedKeys.has(obj.key)}
                      onChange={() => toggleSelect(obj.key)}
                      className="rounded"
                      aria-label={`${obj.key} を選択`}
                    />
                  </TableCell>
                  <TableCell className="font-mono text-xs">{obj.key}</TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {formatBytes(obj.size)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-right text-muted-foreground">
                    {formatDate(obj.lastModified)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button variant="link" size="sm" asChild className="mr-1">
                      <a href={downloadObjectUrl(bucketId, obj.key)}>ダウンロード</a>
                    </Button>
                    <Button
                      variant="link"
                      size="sm"
                      className="text-destructive"
                      onClick={() => setDeleteObjectTarget(obj.key)}
                    >
                      削除
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {sortedObjects.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                    オブジェクトがありません
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          {objects.hasNextPage && (
            <div className="border-t px-4 py-2 text-center">
              <Button
                variant="link"
                size="sm"
                onClick={() => objects.fetchNextPage()}
                disabled={objects.isFetchingNextPage}
              >
                {objects.isFetchingNextPage ? '読み込み中...' : 'さらに読み込む'}
              </Button>
            </div>
          )}
          {objects.hasNextPage && (
            <p className="border-t px-4 py-1.5 text-xs text-muted-foreground">
              並べ替えは読み込み済みのオブジェクトにのみ適用されます
            </p>
          )}
        </div>
      )}

      <ConfirmDialog
        open={deleteObjectTarget !== null}
        onOpenChange={(open) => { if (!open) setDeleteObjectTarget(null) }}
        title="オブジェクトの削除"
        description={`「${deleteObjectTarget}」を削除しますか？この操作は取り消せません。`}
        onConfirm={() => {
          if (deleteObjectTarget) return deleteMutation.mutateAsync(deleteObjectTarget)
        }}
        isPending={deleteMutation.isPending}
      />

      <ConfirmDialog
        open={bulkDeleteOpen}
        onOpenChange={setBulkDeleteOpen}
        title="選択したオブジェクトの削除"
        description={`選択した ${selectedKeys.size} 件のオブジェクトを削除しますか？この操作は取り消せません。`}
        onConfirm={() => bulkDeleteMutation.mutateAsync([...selectedKeys])}
        isPending={bulkDeleteMutation.isPending}
      />

      <ConfirmDialog
        open={prefixDeleteTarget !== null}
        onOpenChange={(open) => { if (!open) setPrefixDeleteTarget(null) }}
        title="プレフィックス以下の削除"
        description={
          prefixDeleteTarget
            ? prefixDeleteTarget.count === 0
              ? `「${prefixDeleteTarget.prefix}」で始まるオブジェクトはありません。`
              : `「${prefixDeleteTarget.prefix}」で始まる ${prefixDeleteTarget.count}${prefixDeleteTarget.truncated ? ' 件以上' : ' 件'}のオブジェクト（${formatBytes(prefixDeleteTarget.bytes)}${prefixDeleteTarget.truncated ? ' 以上' : ''}）を削除しますか？サブフォルダも含まれます。この操作は取り消せません。` +
                (prefixDeleteTarget.truncated ? ' 1 回の操作で削除できるのは上限件数までです。' : '')
            : ''
        }
        onConfirm={() => {
          if (prefixDeleteTarget && prefixDeleteTarget.count > 0)
            return prefixDeleteMutation.mutateAsync(prefixDeleteTarget.prefix)
        }}
        isPending={prefixDeleteMutation.isPending}
      />
    </div>
  )
}
