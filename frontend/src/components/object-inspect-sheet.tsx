import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { ApiError, inspectObject, type InspectObjectVersion } from '@/api'
import { CopyButton } from '@/components/copy-button'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { formatDateTime } from '@/lib/format'
import {
  BLOCK_PAGE_SIZE,
  encryptionLabel,
  nextBlockLimit,
  versionSizeLabel,
  versionState,
  versionStorageLabel,
  visibleBlockRows,
} from '@/lib/inspect-object'
import { shouldRetryObjectList } from '@/lib/object-browser'

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="text-sm">{children}</div>
    </div>
  )
}

function CopyableMono({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex items-start gap-1">
      <span className="min-w-0 break-all font-mono text-xs">{value}</span>
      <CopyButton value={value} label={label} className="-mt-1 shrink-0" />
    </div>
  )
}

/** Block table of one version, rendered BLOCK_PAGE_SIZE rows at a time. */
function VersionBlocks({ blocks }: { blocks: NonNullable<InspectObjectVersion['blocks']> }) {
  const [limit, setLimit] = useState(BLOCK_PAGE_SIZE)
  const { rows, remaining } = visibleBlockRows(blocks, limit)
  return (
    <div className="rounded border">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/50">
            <TableHead className="text-xs text-right">パート</TableHead>
            <TableHead className="text-xs text-right">オフセット</TableHead>
            <TableHead className="text-xs">ハッシュ</TableHead>
            <TableHead className="text-xs text-right">サイズ</TableHead>
            <TableHead className="text-xs" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((b) => (
            <TableRow key={b.id}>
              <TableCell className="text-right text-xs">{b.partNumber}</TableCell>
              <TableCell className="text-right font-mono text-xs">{b.offsetLabel}</TableCell>
              <TableCell className="text-xs">
                <div className="flex items-center gap-1">
                  <span className="font-mono" title={b.hash}>{b.shortHash}</span>
                  <CopyButton value={b.hash} label="ハッシュをコピー" />
                </div>
              </TableCell>
              <TableCell className="whitespace-nowrap text-right text-xs">{b.sizeLabel}</TableCell>
              <TableCell className="text-xs">
                <Link
                  to="/blocks"
                  search={{ hash: b.hash }}
                  className="whitespace-nowrap text-primary underline-offset-4 hover:underline"
                >
                  ブロック情報
                </Link>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {remaining > 0 && (
        <div className="border-t px-3 py-1.5 text-center">
          <Button variant="link" size="sm" onClick={() => setLimit(nextBlockLimit(limit, blocks.length))}>
            さらに表示(残り {remaining.toLocaleString('ja-JP')} 件)
          </Button>
        </div>
      )}
    </div>
  )
}

function VersionCard({ version }: { version: InspectObjectVersion }) {
  const state = versionState(version)
  const headers = version.headers ?? []
  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={state.variant}>{state.label}</Badge>
        {version.inline && <Badge variant="secondary">インライン</Badge>}
        {version.encrypted && <Badge variant="outline">SSE-C</Badge>}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="バージョン UUID">
          <CopyableMono value={version.uuid} label="UUID をコピー" />
        </Field>
        <Field label="作成日時">
          <span title={version.timestamp}>{formatDateTime(version.timestamp)}</span>
        </Field>
        <Field label="サイズ">{versionSizeLabel(version.size)}</Field>
        <Field label="ETag">
          {version.etag ? <CopyableMono value={version.etag} label="ETag をコピー" /> : '-'}
        </Field>
        <Field label="暗号化">{encryptionLabel(version.encrypted)}</Field>
        <Field label="データ">{versionStorageLabel(version)}</Field>
      </div>
      {headers.length > 0 && (
        <Field label="メタデータ(ヘッダー)">
          <ul className="space-y-0.5">
            {headers.map(([name, value], i) => (
              <li key={`${i}-${name}`} className="break-all font-mono text-xs">
                <span className="text-muted-foreground">{name}:</span> {value}
              </li>
            ))}
          </ul>
        </Field>
      )}
      {version.blocks && version.blocks.length > 0 && <VersionBlocks blocks={version.blocks} />}
    </div>
  )
}

/**
 * Side sheet with Garage's internal view of one object (InspectObject):
 * every stored version with its state, size, etag, encryption and data
 * blocks. It goes through the Admin API, so it works even when the console's
 * S3 key cannot read the bucket. Open while `objectKey` is set.
 */
export function ObjectInspectSheet({
  bucketId,
  objectKey,
  onClose,
}: {
  bucketId: string
  objectKey: string | undefined
  onClose: () => void
}) {
  const open = objectKey !== undefined
  const query = useQuery({
    queryKey: ['inspectObject', bucketId, objectKey],
    queryFn: () => inspectObject(bucketId, objectKey!),
    enabled: open,
    // 404 (object gone) and 400 will not change on retry.
    retry: (failureCount, error) => shouldRetryObjectList(failureCount, error),
  })
  const data = query.data
  const notFound = query.error instanceof ApiError && query.error.status === 404

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
        <SheetHeader className="pr-10">
          <SheetTitle>オブジェクトの詳細</SheetTitle>
          <SheetDescription className="break-all font-mono text-xs">{objectKey}</SheetDescription>
        </SheetHeader>
        <div className="space-y-4 px-4 pb-6">
          <div className="grid grid-cols-1 gap-3">
            <Field label="キー">
              {objectKey !== undefined && <CopyableMono value={objectKey} label="キーをコピー" />}
            </Field>
            <Field label="バケット ID">
              <CopyableMono value={data?.bucketId ?? bucketId} label="バケット ID をコピー" />
            </Field>
          </div>

          {query.isLoading ? (
            <p className="text-sm text-muted-foreground">読み込み中...</p>
          ) : notFound ? (
            <p className="text-sm text-destructive">
              オブジェクトが見つかりません。削除されたか、キーが正しくない可能性があります。
            </p>
          ) : query.isError ? (
            <p className="text-sm text-destructive">
              オブジェクト情報の取得に失敗しました: {query.error.message}
            </p>
          ) : data ? (
            <div className="space-y-3">
              <p className="text-sm font-medium">バージョン {data.versions.length} 件</p>
              {data.versions.length === 0 ? (
                <p className="text-sm text-muted-foreground">保存されているバージョンはありません</p>
              ) : (
                data.versions.map((v) => <VersionCard key={v.uuid} version={v} />)
              )}
            </div>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  )
}
