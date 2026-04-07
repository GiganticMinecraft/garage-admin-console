import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  listBlockErrors,
  getBlockInfo,
  purgeBlocks,
  retryBlockResync,
  type BlockError,
  type BlockInfo,
  type MultiResponse,
} from '@/api'
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { toast } from 'sonner'

export const Route = createFileRoute('/blocks')({
  component: BlocksPage,
})

function formatSecsAgo(secs: number): string {
  if (secs < 60) return `${Math.floor(secs)}秒前`
  if (secs < 3600) return `${Math.floor(secs / 60)}分前`
  if (secs < 86400) return `${Math.floor(secs / 3600)}時間前`
  return `${Math.floor(secs / 86400)}日前`
}

function formatSecsUntil(secs: number): string {
  if (secs <= 0) return '即時'
  if (secs < 60) return `${Math.floor(secs)}秒後`
  if (secs < 3600) return `${Math.floor(secs / 60)}分後`
  if (secs < 86400) return `${Math.floor(secs / 3600)}時間後`
  return `${Math.floor(secs / 86400)}日後`
}

function summarizeMultiResponse<T>(resp: MultiResponse<T>): string {
  const successCount = Object.keys(resp.success).length
  const errorCount = Object.keys(resp.error).length
  const parts: string[] = []
  if (successCount > 0) parts.push(`${successCount}ノード成功`)
  if (errorCount > 0) parts.push(`${errorCount}ノードエラー`)
  return parts.join('、')
}

function BlockInfoPanel({ blockHash }: { blockHash: string }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['blockInfo', blockHash],
    queryFn: () => getBlockInfo(blockHash),
  })

  if (isLoading) return <p className="text-muted-foreground text-sm p-2">読み込み中...</p>
  if (isError) return <p className="text-destructive text-sm p-2">ブロック情報の取得に失敗</p>
  if (!data) return null

  return (
    <div className="space-y-3 p-2">
      {Object.keys(data.error).length > 0 && (
        <div className="text-destructive text-sm">
          {Object.entries(data.error).map(([nodeId, msg]) => (
            <p key={nodeId}>ノード {nodeId.slice(0, 12)}…: {msg}</p>
          ))}
        </div>
      )}
      {Object.entries(data.success).map(([nodeId, info]: [string, BlockInfo]) => (
        <div key={nodeId} className="space-y-1">
          <p className="text-sm font-medium">ノード: {nodeId.slice(0, 16)}…</p>
          <p className="text-sm text-muted-foreground">refcount: {info.refcount}</p>
          {info.versions.length > 0 ? (
            <div className="rounded border">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/50">
                    <TableHead className="text-xs">Version ID</TableHead>
                    <TableHead className="text-xs">状態</TableHead>
                    <TableHead className="text-xs">Backlink</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {info.versions.map((v) => (
                    <TableRow key={v.versionId}>
                      <TableCell className="font-mono text-xs">{v.versionId.slice(0, 16)}…</TableCell>
                      <TableCell className="text-xs">
                        <div className="flex gap-1 flex-wrap">
                          {v.refDeleted && <Badge variant="secondary">ref削除</Badge>}
                          {v.versionDeleted && <Badge variant="secondary">ver削除</Badge>}
                          {v.garbageCollected && <Badge variant="secondary">GC済み</Badge>}
                        </div>
                      </TableCell>
                      <TableCell className="text-xs">
                        {v.backlink && 'object' in v.backlink ? (
                          <span className="font-mono">{v.backlink.object.key}</span>
                        ) : v.backlink && 'upload' in v.backlink ? (
                          <span className="font-mono">upload: {v.backlink.upload.uploadId.slice(0, 12)}…</span>
                        ) : (
                          <span className="text-muted-foreground">なし</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">バージョンなし</p>
          )}
        </div>
      ))}
    </div>
  )
}

function BlocksPage() {
  const queryClient = useQueryClient()
  const [expandedHash, setExpandedHash] = useState<string | null>(null)
  const [selectedHashes, setSelectedHashes] = useState<Set<string>>(new Set())
  const [purgeDialogOpen, setPurgeDialogOpen] = useState(false)
  const [resyncDialogOpen, setResyncDialogOpen] = useState(false)

  const { data: errors, isLoading, isError } = useQuery({
    queryKey: ['blockErrors'],
    queryFn: listBlockErrors,
  })

  const purgeMutation = useMutation({
    mutationFn: (hashes: string[]) => purgeBlocks(hashes),
    onSuccess: (resp) => {
      // Show representative result from first successful node, not sum across nodes
      const firstResult = Object.values(resp.success)[0]
      const msg = firstResult
        ? `${firstResult.blocksPurged}ブロックをパージしました`
        : 'パージが完了しました'
      toast.success(`${msg} (${summarizeMultiResponse(resp)})`)
      setSelectedHashes(new Set())
      queryClient.invalidateQueries({ queryKey: ['blockErrors'] })
    },
    onError: () => toast.error('パージに失敗しました'),
  })

  const resyncMutation = useMutation({
    mutationFn: (body: { all: true } | { blockHashes: string[] }) => retryBlockResync(body),
    onSuccess: (resp) => {
      // count is per-node (e.g. blockHashes.len()), so show representative value not sum
      const firstResult = Object.values(resp.success)[0]
      const msg = firstResult
        ? `${firstResult.count}ブロックのリシンクをキューしました`
        : 'リシンクが完了しました'
      toast.success(`${msg} (${summarizeMultiResponse(resp)})`)
      queryClient.invalidateQueries({ queryKey: ['blockErrors'] })
    },
    onError: () => toast.error('リシンクに失敗しました'),
  })

  const toggleSelect = (hash: string) => {
    setSelectedHashes((prev) => {
      const next = new Set(prev)
      if (next.has(hash)) next.delete(hash)
      else next.add(hash)
      return next
    })
  }

  const uniqueHashes = errors ? [...new Set(errors.map((e) => e.blockHash))] : []

  const toggleSelectAll = () => {
    if (selectedHashes.size === uniqueHashes.length) {
      setSelectedHashes(new Set())
    } else {
      setSelectedHashes(new Set(uniqueHashes))
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">ブロックエラー</h1>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={selectedHashes.size === 0 || resyncMutation.isPending}
            onClick={() => setResyncDialogOpen(true)}
          >
            選択をリシンク
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={selectedHashes.size === 0 || purgeMutation.isPending}
            onClick={() => setPurgeDialogOpen(true)}
          >
            選択をパージ
          </Button>
        </div>
      </div>

      {isLoading ? (
        <p className="text-muted-foreground">読み込み中...</p>
      ) : isError ? (
        <p className="text-destructive">ブロックエラーの読み込みに失敗しました</p>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/50">
                <TableHead className="w-10">
                  <input
                    type="checkbox"
                    checked={uniqueHashes.length > 0 && selectedHashes.size === uniqueHashes.length}
                    onChange={toggleSelectAll}
                    className="rounded"
                  />
                </TableHead>
                <TableHead>ブロックハッシュ</TableHead>
                <TableHead>ノード</TableHead>
                <TableHead className="text-right">Refcount</TableHead>
                <TableHead className="text-right">エラー回数</TableHead>
                <TableHead>最終試行</TableHead>
                <TableHead>次回試行</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {errors?.map((err: BlockError) => {
                const key = `${err.nodeId}-${err.blockHash}`
                const isExpanded = expandedHash === key
                return (
                  <TableRow key={key} className="group">
                    <TableCell>
                      <input
                        type="checkbox"
                        checked={selectedHashes.has(err.blockHash)}
                        onChange={() => toggleSelect(err.blockHash)}
                        className="rounded"
                      />
                    </TableCell>
                    <TableCell>
                      <button
                        className="font-mono text-sm hover:underline cursor-pointer text-left"
                        onClick={() => setExpandedHash(isExpanded ? null : key)}
                      >
                        {err.blockHash.slice(0, 16)}…
                      </button>
                      {isExpanded && <BlockInfoPanel blockHash={err.blockHash} />}
                    </TableCell>
                    <TableCell className="font-mono text-sm">
                      {err.nodeId.slice(0, 12)}…
                    </TableCell>
                    <TableCell className="text-right">{err.refcount}</TableCell>
                    <TableCell className="text-right">
                      <Badge variant={err.errorCount > 5 ? 'destructive' : 'secondary'}>
                        {err.errorCount}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {formatSecsAgo(err.lastTrySecsAgo)}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {formatSecsUntil(err.nextTryInSecs)}
                    </TableCell>
                  </TableRow>
                )
              })}
              {errors?.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                    ブロックエラーはありません
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      )}

      <ConfirmDialog
        open={purgeDialogOpen}
        onOpenChange={setPurgeDialogOpen}
        title="ブロックのパージ"
        description={`選択した${selectedHashes.size}件のブロックをパージします。この操作は元に戻せません。`}
        onConfirm={() => purgeMutation.mutate([...selectedHashes])}
        isPending={purgeMutation.isPending}
        confirmLabel="パージ"
        pendingLabel="パージ中..."
      />

      <ConfirmDialog
        open={resyncDialogOpen}
        onOpenChange={setResyncDialogOpen}
        title="ブロックのリシンク"
        description={`選択した${selectedHashes.size}件のブロックのリシンクを再試行します。`}
        onConfirm={() => resyncMutation.mutate({ blockHashes: [...selectedHashes] })}
        isPending={resyncMutation.isPending}
        confirmLabel="リシンク"
        pendingLabel="リシンク中..."
        confirmVariant="default"
      />
    </div>
  )
}
