import { useMemo, useRef, useState, type MouseEvent } from 'react'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CircleCheck, CircleX, Plus } from 'lucide-react'
import {
  connectClusterNodes,
  getClusterStatus,
  type ClusterNode,
  type PartitionUsage,
} from '@/api'
import {
  DEFAULT_GROUP_BY,
  GROUP_BY_OPTIONS,
  ROLE_LABELS,
  connectOutcome,
  groupNodes,
  lastSeenLabel,
  pairConnectResults,
  parseConnectInput,
  type ConnectResultRow,
  type NodeGroupBy,
} from '@/lib/node-list'
import { nodeDisplayName, nodeRoleKind } from '@/lib/nodes'
import { formatUsage, shortId, usagePercent } from '@/lib/format'
import { pollEvery } from '@/lib/polling'
import { USAGE_CRIT, USAGE_WARN } from '@/lib/thresholds'
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
import { Skeleton } from '@/components/ui/skeleton'
import { CopyButton } from '@/components/copy-button'
import { RefreshIndicator } from '@/components/refresh-indicator'
import { useDocumentTitle } from '@/hooks/use-document-title'

export const Route = createFileRoute('/nodes/')({
  component: NodesPage,
})

/** Same cadence and cache entry as the dashboard's cluster status. */
const STATUS_POLLING = pollEvery(15_000)

const TEXTAREA_CLASS =
  'w-full min-h-32 rounded-md border bg-transparent px-3 py-2 font-mono text-xs shadow-xs outline-none ' +
  'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] ' +
  'aria-invalid:border-destructive dark:bg-input/30'

// ---------------------------------------------------------------------------
// Card

function UsageBar({ label, partition }: { label: string; partition: PartitionUsage | null | undefined }) {
  if (!partition) {
    return (
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>{label}</span>
        <span>情報なし</span>
      </div>
    )
  }
  const used = partition.total - partition.available
  const percent = usagePercent(used, partition.total)
  const color = percent >= USAGE_CRIT * 100 ? 'bg-red-500' : percent >= USAGE_WARN * 100 ? 'bg-amber-500' : 'bg-blue-500'
  return (
    <div className="space-y-1">
      <div className="flex justify-between gap-2 text-xs">
        <span>{label}</span>
        <span className="text-muted-foreground">{formatUsage(used, partition.total)}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${percent}%` }} />
      </div>
    </div>
  )
}

function RoleBadge({ node }: { node: ClusterNode }) {
  const kind = nodeRoleKind(node)
  if (kind === 'draining') {
    return (
      <Badge variant="destructive" title="レイアウトから外されましたが、まだデータを保持しています">
        {ROLE_LABELS[kind]}
      </Badge>
    )
  }
  return <Badge variant={kind === 'unassigned' ? 'outline' : 'secondary'}>{ROLE_LABELS[kind]}</Badge>
}

/**
 * One node. The name is the real (keyboard-reachable) link to the node page;
 * a click anywhere else on the card opens it too, except on buttons/links and
 * when the click ends a text selection, so the address can still be selected
 * and badge titles still show on hover.
 */
function NodeCard({ node }: { node: ClusterNode }) {
  const navigate = useNavigate()
  const kind = nodeRoleKind(node)
  const lastSeen = lastSeenLabel(node)
  const openNode = (e: MouseEvent<HTMLDivElement>) => {
    if (e.target instanceof Element && e.target.closest('a, button')) return
    if (window.getSelection()?.toString()) return
    navigate({ to: '/nodes/$id', params: { id: node.id } })
  }
  return (
    <div
      onClick={openNode}
      className={`cursor-pointer space-y-3 rounded-lg border p-4 transition-colors hover:bg-muted/40 ${
        node.isUp ? '' : 'border-red-500/40'
      }`}
    >
      <div className="flex items-start gap-2">
        <span
          className={`mt-1.5 inline-block h-2.5 w-2.5 shrink-0 rounded-full ${node.isUp ? 'bg-green-500' : 'bg-red-500'}`}
          aria-label={node.isUp ? '接続中' : '切断中'}
          role="img"
        />
        <div className="min-w-0 flex-1">
          <Link
            to="/nodes/$id"
            params={{ id: node.id }}
            className="block truncate font-semibold hover:underline"
          >
            {nodeDisplayName(node)}
          </Link>
          <div className="flex items-center gap-1 font-mono text-xs text-muted-foreground">
            {shortId(node.id)}
            <CopyButton value={node.id} label="ノード ID をコピー" />
          </div>
        </div>
        <RoleBadge node={node} />
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">アドレス</dt>
        <dd className="flex min-w-0 items-center gap-1">
          {node.addr ? (
            <>
              <span className="truncate font-mono" title={node.addr}>{node.addr}</span>
              <CopyButton value={node.addr} label="アドレスをコピー" />
            </>
          ) : (
            <span className="text-muted-foreground">不明</span>
          )}
        </dd>
        <dt className="text-muted-foreground">ゾーン</dt>
        <dd>{node.role?.zone ?? <span className="text-muted-foreground">なし</span>}</dd>
        <dt className="text-muted-foreground">タグ</dt>
        <dd className="flex flex-wrap gap-1">
          {node.role && node.role.tags.length > 0 ? (
            node.role.tags.map((t) => (
              <Badge key={t} variant="outline" className="text-[10px]">
                {t}
              </Badge>
            ))
          ) : (
            <span className="text-muted-foreground">なし</span>
          )}
        </dd>
        <dt className="text-muted-foreground">バージョン</dt>
        <dd>{node.garageVersion ?? <span className="text-muted-foreground">不明</span>}</dd>
      </dl>

      {lastSeen && <p className="text-xs text-red-600 dark:text-red-400">切断中・{lastSeen}</p>}

      {kind !== 'gateway' && (
        <div className="space-y-2">
          <UsageBar label="データ" partition={node.dataPartition} />
          <UsageBar label="メタデータ" partition={node.metadataPartition} />
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Connect dialog

function ConnectResults({ rows }: { rows: ConnectResultRow[] }) {
  const outcome = connectOutcome(rows)
  const ok = rows.filter((r) => r.success).length
  const summary =
    outcome === 'all'
      ? `${ok} ノードに接続しました`
      : outcome === 'partial'
        ? `${ok} / ${rows.length} ノードに接続しました。失敗した行を確認してください`
        : 'どのノードにも接続できませんでした'
  return (
    <div className="space-y-2">
      <p className={`text-sm font-medium ${outcome === 'all' ? '' : 'text-destructive'}`}>{summary}</p>
      <ul className="space-y-1.5">
        {rows.map((r, i) => (
          <li key={i} className="flex items-start gap-2 text-xs">
            {r.success ? (
              <CircleCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-green-600" aria-label="成功" />
            ) : (
              <CircleX className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" aria-label="失敗" />
            )}
            <div className="min-w-0">
              <p className="font-mono break-all">{r.peer}</p>
              {!r.success && <p className="text-destructive break-words">{r.error ?? 'Garage がエラー内容を返しませんでした'}</p>}
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

function ConnectNodesDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient()
  const [text, setText] = useState('')
  const [rows, setRows] = useState<ConnectResultRow[] | null>(null)
  const parsed = useMemo(() => parseConnectInput(text), [text])
  // Bumped whenever the dialog closes; a request answered after that belongs
  // to a previous session and must not write its results into this one.
  const session = useRef(0)

  const connect = useMutation({
    mutationFn: (peers: string[]) => connectClusterNodes(peers),
    onSuccess: (results) => {
      if (results.some((r) => r.success)) {
        queryClient.invalidateQueries({ queryKey: ['cluster', 'status'] })
      }
    },
  })
  const pending = connect.isPending

  // While a request is in flight the dialog cannot be closed (button, ESC,
  // overlay and the X all come through here) and the input is locked, so the
  // results shown always belong to the text above them.
  const handleOpenChange = (next: boolean) => {
    if (!next && pending) return
    if (!next) {
      session.current++
      setText('')
      setRows(null)
      connect.reset()
    }
    onOpenChange(next)
  }

  const submit = () => {
    const peers = parsed.peers
    const current = session.current
    setRows(null)
    connect.mutate(peers, {
      onSuccess: (results) => {
        if (session.current === current) setRows(pairConnectResults(peers, results))
      },
    })
  }

  const canSubmit = parsed.peers.length > 0 && parsed.errors.length === 0 && !pending

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>ノードを接続</DialogTitle>
          <DialogDescription>
            接続先を 1 行に 1 ノードずつ <code className="font-mono">&lt;ノード ID&gt;@&lt;アドレス&gt;:&lt;ポート&gt;</code>{' '}
            の形式で入力します。接続先のノードで <code className="font-mono">garage node id</code> を実行すると、この形式で表示されます。
            接続するだけでレイアウトは変わりません。
          </DialogDescription>
        </DialogHeader>

        <form
          className="min-w-0 space-y-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (canSubmit) submit()
          }}
        >
          <textarea
            aria-label="接続するノード"
            value={text}
            disabled={pending}
            onChange={(e) => {
              setText(e.target.value)
              setRows(null)
              connect.reset()
            }}
            spellCheck={false}
            placeholder="563e1ac825ee3323aa441e72c26d1030d6d4414aeb3dd25287c531e7fc2bc95d@[fc00:1::1]:3901"
            className={`${TEXTAREA_CLASS} disabled:opacity-60`}
            aria-invalid={parsed.errors.length > 0}
          />
          {parsed.errors.length > 0 && (
            <ul className="space-y-0.5 text-xs text-destructive">
              {parsed.errors.map((e, i) => (
                <li key={i}>
                  {e.line} 行目: {e.message}
                </li>
              ))}
            </ul>
          )}
          {connect.isError && (
            <p className="text-sm text-destructive">接続を要求できませんでした: {connect.error.message}</p>
          )}
          {rows && <ConnectResults rows={rows} />}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => handleOpenChange(false)} disabled={pending}>
              閉じる
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {pending ? '接続中...' : '接続'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Page

function NodesPage() {
  useDocumentTitle('ノード')
  const status = useQuery({ queryKey: ['cluster', 'status'], queryFn: getClusterStatus, ...STATUS_POLLING })
  const [groupBy, setGroupBy] = useState<NodeGroupBy>(DEFAULT_GROUP_BY)
  const [connectOpen, setConnectOpen] = useState(false)

  const groups = useMemo(() => groupNodes(status.data?.nodes ?? [], groupBy), [status.data, groupBy])
  const nodes = status.data?.nodes ?? []
  const upCount = nodes.filter((n) => n.isUp).length

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">ノード</h1>
          {status.data && (
            <p className="text-sm text-muted-foreground">
              {nodes.length} ノード (接続中 {upCount}・切断中 {nodes.length - upCount})
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <RefreshIndicator updatedAt={status.dataUpdatedAt} onRefresh={() => status.refetch()} />
          <Button size="sm" onClick={() => setConnectOpen(true)}>
            <Plus className="h-4 w-4" aria-hidden />
            ノードを接続
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-sm" role="group" aria-label="グループ化">
        <span className="text-muted-foreground">グループ化:</span>
        {GROUP_BY_OPTIONS.map((o) => (
          <Button
            key={o.value}
            size="sm"
            variant={groupBy === o.value ? 'default' : 'outline'}
            aria-pressed={groupBy === o.value}
            onClick={() => setGroupBy(o.value)}
          >
            {o.label}
          </Button>
        ))}
      </div>

      {status.isPending ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-56 w-full" />
          ))}
        </div>
      ) : status.isError && !status.data ? (
        <p className="text-sm text-destructive">クラスタの状態を取得できませんでした: {status.error.message}</p>
      ) : (
        <>
          {status.isError && (
            <p className="text-sm text-destructive">
              最新の状態を取得できませんでした (表示は前回取得時のものです): {status.error.message}
            </p>
          )}
          {groups.length === 0 ? (
            <p className="text-sm text-muted-foreground">ノードがありません</p>
          ) : (
            groups.map((g) => (
              <section key={g.key} className="space-y-3">
                <h2 className="text-lg font-semibold">
                  {g.label} <span className="text-sm font-normal text-muted-foreground">({g.nodes.length})</span>
                </h2>
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  {g.nodes.map((n) => (
                    <NodeCard key={n.id} node={n} />
                  ))}
                </div>
              </section>
            ))
          )}
        </>
      )}

      <ConnectNodesDialog open={connectOpen} onOpenChange={setConnectOpen} />
    </div>
  )
}
