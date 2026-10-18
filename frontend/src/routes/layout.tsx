import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  getClusterLayout,
  getClusterStatus,
  stageLayout,
  previewLayout,
  applyLayout,
  revertLayout,
  type ClusterLayout,
  type ClusterNode,
  type LayoutNodeRole,
  type NodeRoleChange,
  type ZoneRedundancy,
} from '@/api'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table'
import { Skeleton } from '@/components/ui/skeleton'
import { ConfirmDialog } from '@/components/confirm-dialog'

export const Route = createFileRoute('/layout')({
  component: LayoutPage,
})

const GIB = 1024 ** 3

function formatBytes(bytes: number | null): string {
  if (bytes == null) return '-'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']
  let i = 0
  let value = bytes
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value.toFixed(1)} ${units[i]}`
}

function formatRedundancy(z: ZoneRedundancy): string {
  return z === 'maximum' ? 'maximum' : `atLeast ${z.atLeast}`
}

function shortId(id: string): string {
  return `${id.slice(0, 16)}…`
}

/** One row of the edit form. Capacity is edited in GiB; empty means gateway. */
interface RoleDraft {
  id: string
  hostname: string | null
  isUp: boolean
  current: LayoutNodeRole | null
  zone: string
  capacityGiB: string
  tags: string
  remove: boolean
}

function draftFromNode(
  node: Pick<ClusterNode, 'id' | 'hostname' | 'isUp' | 'role'>,
  role: LayoutNodeRole | undefined,
): RoleDraft {
  return {
    id: node.id,
    hostname: node.hostname,
    isUp: node.isUp,
    current: role ?? null,
    zone: role?.zone ?? node.role?.zone ?? '',
    capacityGiB: role?.capacity != null ? String(Math.round((role.capacity / GIB) * 100) / 100) : '',
    tags: role?.tags.join(', ') ?? '',
    remove: false,
  }
}

/** Convert a draft to the change Garage expects, or null when nothing changed. */
function draftToChange(d: RoleDraft): NodeRoleChange | null | Error {
  if (d.remove) {
    return d.current ? { id: d.id, remove: true } : null
  }
  const zone = d.zone.trim()
  const tags = d.tags.split(',').map((t) => t.trim()).filter(Boolean)
  let capacity: number | null = null
  if (d.capacityGiB.trim() !== '') {
    const n = Number(d.capacityGiB)
    if (!Number.isFinite(n) || n <= 0) {
      return new Error(`${d.hostname ?? shortId(d.id)}: 容量は正の数 (GiB) で入力してください`)
    }
    capacity = Math.round(n * GIB)
  }
  if (!d.current) {
    // Node without a role: only a change if the operator filled in a zone.
    if (!zone) return null
    return { id: d.id, zone, tags, capacity }
  }
  if (!zone) return new Error(`${d.hostname ?? shortId(d.id)}: ゾーンは必須です`)
  const same =
    zone === d.current.zone &&
    capacity === d.current.capacity &&
    tags.join(',') === d.current.tags.join(',')
  return same ? null : { id: d.id, zone, tags, capacity }
}

function LayoutPage() {
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [drafts, setDrafts] = useState<RoleDraft[]>([])
  const [redundancy, setRedundancy] = useState<'maximum' | 'atLeast'>('maximum')
  const [redundancyN, setRedundancyN] = useState('1')
  const [showApply, setShowApply] = useState(false)
  const [showRevert, setShowRevert] = useState(false)
  const [preview, setPreview] = useState<string[] | null>(null)

  const layout = useQuery({ queryKey: ['cluster', 'layout'], queryFn: getClusterLayout })
  const status = useQuery({ queryKey: ['cluster', 'status'], queryFn: getClusterStatus })

  const hostnames = useMemo(() => {
    const m = new Map<string, string>()
    for (const n of status.data?.nodes ?? []) if (n.hostname) m.set(n.id, n.hostname)
    return m
  }, [status.data])
  const nameOf = (id: string) => hostnames.get(id) ?? shortId(id)

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['cluster', 'layout'] })
    queryClient.invalidateQueries({ queryKey: ['cluster', 'status'] })
    setPreview(null)
  }

  const stageMutation = useMutation({
    mutationFn: stageLayout,
    onSuccess: () => {
      invalidate()
      setEditing(false)
      toast.success('変更をステージしました。プレビューで確認してから適用してください。')
    },
    onError: (error) => toast.error(`ステージに失敗しました: ${error.message}`),
  })

  const previewMutation = useMutation({
    mutationFn: previewLayout,
    onSuccess: (res) => setPreview(res.message),
    onError: (error) => {
      setPreview(null)
      toast.error(`プレビューに失敗しました: ${error.message}`)
    },
  })

  const applyMutation = useMutation({
    mutationFn: (version: number) => applyLayout(version),
    onSuccess: (res) => {
      invalidate()
      toast.success(`レイアウト v${res.layout.version} を適用しました`)
    },
    onError: (error) => toast.error(`レイアウトの適用に失敗しました: ${error.message}`),
  })

  const revertMutation = useMutation({
    mutationFn: revertLayout,
    onSuccess: () => {
      invalidate()
      toast.success('ステージ中の変更を取り消しました')
    },
    onError: (error) => toast.error(`取り消しに失敗しました: ${error.message}`),
  })

  const data: ClusterLayout | undefined = layout.data

  const startEditing = () => {
    if (!data) return
    const roleById = new Map(data.roles.map((r) => [r.id, r]))
    const nodes = status.data?.nodes ?? []
    const known = new Set(nodes.map((n) => n.id))
    const rows = nodes.map((n) => draftFromNode(n, roleById.get(n.id)))
    // Roles for nodes the status endpoint does not know about (e.g. gone) still need to be editable.
    for (const r of data.roles) {
      if (!known.has(r.id)) {
        rows.push(draftFromNode({ id: r.id, hostname: null, isUp: false, role: null }, r))
      }
    }
    setDrafts(rows)
    const z = data.stagedParameters?.zoneRedundancy ?? data.parameters.zoneRedundancy
    setRedundancy(z === 'maximum' ? 'maximum' : 'atLeast')
    setRedundancyN(z === 'maximum' ? '1' : String(z.atLeast))
    setEditing(true)
  }

  const updateDraft = (id: string, patch: Partial<RoleDraft>) =>
    setDrafts((ds) => ds.map((d) => (d.id === id ? { ...d, ...patch } : d)))

  const submitStage = () => {
    if (!data) return
    const roles: NodeRoleChange[] = []
    for (const d of drafts) {
      const c = draftToChange(d)
      if (c instanceof Error) {
        toast.error(c.message)
        return
      }
      if (c) roles.push(c)
    }
    const currentZ = data.stagedParameters?.zoneRedundancy ?? data.parameters.zoneRedundancy
    const nextZ: ZoneRedundancy =
      redundancy === 'maximum' ? 'maximum' : { atLeast: Math.max(1, Number(redundancyN) || 1) }
    const zChanged = JSON.stringify(currentZ) !== JSON.stringify(nextZ)
    if (roles.length === 0 && !zChanged) {
      toast.info('変更はありません')
      return
    }
    stageMutation.mutate({
      roles,
      ...(zChanged ? { parameters: { zoneRedundancy: nextZ } } : {}),
    })
  }

  const staged = data?.stagedRoleChanges ?? []
  const hasStaged = staged.length > 0 || (data?.stagedParameters != null)
  const nextVersion = (data?.version ?? 0) + 1

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">クラスタレイアウト</h1>
        {!editing && data && (
          <Button variant="outline" size="sm" onClick={startEditing} disabled={status.isLoading}>
            ロールを編集
          </Button>
        )}
      </div>

      {layout.isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      ) : layout.isError ? (
        <p className="text-destructive">レイアウトの読み込みに失敗しました: {layout.error.message}</p>
      ) : data ? (
        <>
          <div className="rounded-lg border p-4">
            <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
              <div>
                <p className="text-muted-foreground">バージョン</p>
                <p className="font-medium">{data.version}</p>
              </div>
              <div>
                <p className="text-muted-foreground">ゾーン冗長性</p>
                <p className="font-medium">
                  {formatRedundancy(data.parameters.zoneRedundancy)}
                  {data.stagedParameters && (
                    <span className="ml-2 text-xs text-amber-600">
                      → {formatRedundancy(data.stagedParameters.zoneRedundancy)} (保留中)
                    </span>
                  )}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground">パーティションサイズ</p>
                <p className="font-medium">{formatBytes(data.partitionSize)}</p>
              </div>
              <div>
                <p className="text-muted-foreground">保留中の変更</p>
                <p className="font-medium">
                  {hasStaged
                    ? <Badge variant="destructive">{staged.length} 件保留中</Badge>
                    : <span className="text-muted-foreground">なし</span>}
                </p>
              </div>
            </div>
          </div>

          {hasStaged && !editing && (
            <div className="space-y-3 rounded-lg border border-amber-300 bg-amber-50/50 p-4 dark:bg-amber-950/20">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-lg font-semibold">ステージ中の変更</h2>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => previewMutation.mutate()}
                    disabled={previewMutation.isPending}
                  >
                    {previewMutation.isPending ? '計算中...' : 'プレビュー'}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setShowRevert(true)}>
                    取り消し
                  </Button>
                  <Button size="sm" onClick={() => setShowApply(true)}>
                    v{nextVersion} として適用
                  </Button>
                </div>
              </div>
              <ul className="space-y-1 text-sm">
                {staged.map((c) => {
                  const before = data.roles.find((r) => r.id === c.id)
                  return (
                    <li key={c.id} className="flex flex-wrap items-baseline gap-2">
                      <span className="font-medium">{nameOf(c.id)}</span>
                      <span className="font-mono text-xs text-muted-foreground">{shortId(c.id)}</span>
                      {'remove' in c ? (
                        <Badge variant="destructive">削除</Badge>
                      ) : (
                        <>
                          <Badge variant={before ? 'secondary' : 'default'}>{before ? '変更' : '追加'}</Badge>
                          <span>
                            zone {before && before.zone !== c.zone ? <s className="text-muted-foreground">{before.zone}</s> : null} {c.zone}
                            {' / '}容量 {before && before.capacity !== c.capacity ? <s className="text-muted-foreground">{formatBytes(before.capacity)}</s> : null} {c.capacity == null ? 'gateway' : formatBytes(c.capacity)}
                            {' / '}tags [{c.tags.join(', ')}]
                          </span>
                        </>
                      )}
                    </li>
                  )
                })}
                {data.stagedParameters && (
                  <li>ゾーン冗長性: {formatRedundancy(data.stagedParameters.zoneRedundancy)}</li>
                )}
              </ul>
              {preview && (
                <pre className="max-h-80 overflow-auto rounded bg-muted p-3 text-xs whitespace-pre-wrap">
                  {preview.join('\n')}
                </pre>
              )}
            </div>
          )}

          {editing ? (
            <div className="space-y-3 rounded-lg border p-4">
              <h2 className="text-lg font-semibold">ロールの編集</h2>
              <p className="text-sm text-muted-foreground">
                ここで保存しても即時反映はされません。ステージ → プレビュー → 適用の順に進みます。容量は GiB 単位で、空欄にするとゲートウェイノードになります。
              </p>
              <div className="overflow-x-auto rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>ノード</TableHead>
                      <TableHead>ゾーン</TableHead>
                      <TableHead>容量 (GiB)</TableHead>
                      <TableHead>タグ (カンマ区切り)</TableHead>
                      <TableHead>削除</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {drafts.map((d) => (
                      <TableRow key={d.id} className={d.remove ? 'opacity-60' : undefined}>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <span className={`inline-block h-2 w-2 rounded-full ${d.isUp ? 'bg-green-500' : 'bg-red-500'}`} />
                            <div>
                              <div className="font-medium">{d.hostname ?? shortId(d.id)}</div>
                              <div className="font-mono text-xs text-muted-foreground">{shortId(d.id)}</div>
                              {!d.current && <Badge variant="outline" className="mt-1">ロール未割当</Badge>}
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>
                          <Input
                            value={d.zone}
                            list="layout-zones"
                            disabled={d.remove}
                            onChange={(e) => updateDraft(d.id, { zone: e.target.value })}
                            className="w-32"
                          />
                        </TableCell>
                        <TableCell>
                          <Input
                            type="number"
                            min={0}
                            step="any"
                            value={d.capacityGiB}
                            disabled={d.remove}
                            placeholder="gateway"
                            onChange={(e) => updateDraft(d.id, { capacityGiB: e.target.value })}
                            className="w-32"
                          />
                        </TableCell>
                        <TableCell>
                          <Input
                            value={d.tags}
                            disabled={d.remove}
                            onChange={(e) => updateDraft(d.id, { tags: e.target.value })}
                            className="w-40"
                          />
                        </TableCell>
                        <TableCell>
                          {d.current && (
                            <input
                              type="checkbox"
                              className="rounded"
                              checked={d.remove}
                              onChange={(e) => updateDraft(d.id, { remove: e.target.checked })}
                              aria-label={`${d.hostname ?? d.id} をレイアウトから削除`}
                            />
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <datalist id="layout-zones">
                  {[...new Set(data.roles.map((r) => r.zone))].map((z) => <option key={z} value={z} />)}
                </datalist>
              </div>
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <span className="text-muted-foreground">ゾーン冗長性</span>
                <select
                  value={redundancy}
                  onChange={(e) => setRedundancy(e.target.value as 'maximum' | 'atLeast')}
                  className="rounded-md border bg-background px-2 py-1"
                >
                  <option value="maximum">maximum</option>
                  <option value="atLeast">atLeast</option>
                </select>
                {redundancy === 'atLeast' && (
                  <Input
                    type="number"
                    min={1}
                    value={redundancyN}
                    onChange={(e) => setRedundancyN(e.target.value)}
                    className="w-20"
                  />
                )}
              </div>
              <div className="flex gap-2">
                <Button onClick={submitStage} disabled={stageMutation.isPending}>
                  {stageMutation.isPending ? 'ステージ中...' : '変更をステージ'}
                </Button>
                <Button variant="ghost" onClick={() => setEditing(false)}>
                  キャンセル
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <h2 className="text-lg font-semibold">現在のロール (v{data.version})</h2>
              {data.roles.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  ロールが割り当てられたノードがありません。「ロールを編集」からゾーンと容量を設定してください。
                </p>
              ) : (
                <div className="rounded-lg border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>ノード</TableHead>
                        <TableHead>ゾーン</TableHead>
                        <TableHead className="text-right">容量</TableHead>
                        <TableHead className="text-right">利用可能</TableHead>
                        <TableHead className="text-right">パーティション</TableHead>
                        <TableHead>タグ</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.roles.map((role) => (
                        <TableRow key={role.id}>
                          <TableCell>
                            <div className="font-medium">{nameOf(role.id)}</div>
                            <div className="font-mono text-xs text-muted-foreground">{shortId(role.id)}</div>
                          </TableCell>
                          <TableCell>{role.zone}</TableCell>
                          <TableCell className="text-right">
                            {role.capacity == null ? <Badge variant="outline">gateway</Badge> : formatBytes(role.capacity)}
                          </TableCell>
                          <TableCell className="text-right">{formatBytes(role.usableCapacity)}</TableCell>
                          <TableCell className="text-right">{role.storedPartitions ?? '-'}</TableCell>
                          <TableCell>
                            {role.tags.length > 0
                              ? role.tags.map((t) => <Badge key={t} variant="outline" className="mr-1">{t}</Badge>)
                              : <span className="text-muted-foreground">-</span>}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          )}
        </>
      ) : null}

      <ConfirmDialog
        open={showApply}
        onOpenChange={setShowApply}
        title={`レイアウト v${nextVersion} の適用`}
        description="ステージ中の変更を適用します。パーティションの再配置が始まり、クラスタの負荷が一時的に上がります。適用後は数時間待ってリシンクの収束を確認してください。"
        confirmLabel="適用"
        pendingLabel="適用中..."
        confirmVariant="default"
        onConfirm={() => applyMutation.mutateAsync(nextVersion)}
        isPending={applyMutation.isPending}
      />
      <ConfirmDialog
        open={showRevert}
        onOpenChange={setShowRevert}
        title="ステージ中の変更の取り消し"
        description="ステージ中のロール変更とパラメータ変更を全て破棄します。適用済みのレイアウトには影響しません。"
        confirmLabel="取り消す"
        pendingLabel="取り消し中..."
        onConfirm={() => revertMutation.mutateAsync()}
        isPending={revertMutation.isPending}
      />
    </div>
  )
}
