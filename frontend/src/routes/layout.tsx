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
import { LayoutPreview } from '@/components/layout-preview'
import { LayoutUpdateTracker } from '@/components/layout-update-tracker'
import { formatBytes } from '@/lib/format'
import { nodeDisplayName } from '@/lib/nodes'

export const Route = createFileRoute('/layout')({
  component: LayoutPage,
})

const GIB = 1024 ** 3

/** formatBytes for nullable fields (gateway roles have no capacity). */
function formatSize(bytes: number | null): string {
  return bytes == null ? '-' : formatBytes(bytes)
}

function formatRedundancy(z: ZoneRedundancy): string {
  return z === 'maximum' ? 'maximum' : `atLeast ${z.atLeast}`
}

/** The editable fields of a row, as strings so "unchanged" can be detected exactly. */
interface RoleFields {
  zone: string
  capacityGiB: string
  tags: string
}

/**
 * One row of the edit form. Capacity is edited in GiB; empty means gateway.
 * `effective` is what the next layout version would contain for this node
 * (a staged change wins over the applied role), `original` is the form state
 * derived from it so a row only counts as changed when the operator edited it.
 */
interface RoleDraft extends RoleFields {
  id: string
  hostname: string | null
  isUp: boolean
  /** Role in the applied layout, if any. */
  applied: LayoutNodeRole | null
  /** Role after staged changes: null when unassigned or staged for removal. */
  effective: Pick<LayoutNodeRole, 'zone' | 'tags' | 'capacity'> | null
  original: RoleFields
  remove: boolean
}

function capacityToGiB(capacity: number | null): string {
  return capacity != null ? String(Math.round((capacity / GIB) * 100) / 100) : ''
}

function draftFromNode(
  node: Pick<ClusterNode, 'id' | 'hostname' | 'isUp'>,
  applied: LayoutNodeRole | undefined,
  staged: NodeRoleChange | undefined,
): RoleDraft {
  const stagedRemove = staged != null && 'remove' in staged
  const effective = stagedRemove ? null : (staged ?? applied ?? null)
  const fields: RoleFields = {
    zone: effective?.zone ?? applied?.zone ?? '',
    capacityGiB: capacityToGiB(effective?.capacity ?? applied?.capacity ?? null),
    tags: (effective?.tags ?? applied?.tags ?? []).join(', '),
  }
  return {
    id: node.id,
    hostname: node.hostname,
    isUp: node.isUp,
    applied: applied ?? null,
    effective,
    original: fields,
    ...fields,
    remove: stagedRemove,
  }
}

function parseTags(s: string): string[] {
  return s.split(',').map((t) => t.trim()).filter(Boolean)
}

/**
 * Convert a draft to the change Garage expects, or null when the operator did
 * not touch the row. Comparison is on the form strings, not on bytes
 * re-derived from a rounded GiB value, so untouched rows never re-stage.
 */
function draftToChange(d: RoleDraft): NodeRoleChange | null | Error {
  const name = nodeDisplayName(d)
  const wasRemoved = d.effective == null && d.applied != null
  if (d.remove) {
    if (wasRemoved) return null // already staged for removal
    return d.applied ? { id: d.id, remove: true } : null
  }
  const untouched =
    d.zone === d.original.zone && d.capacityGiB === d.original.capacityGiB && d.tags === d.original.tags
  if (untouched && !wasRemoved) return null
  if (untouched && wasRemoved && !d.zone.trim()) return null

  const zone = d.zone.trim()
  const tags = parseTags(d.tags)
  let capacity: number | null = null
  if (d.capacityGiB.trim() !== '') {
    const n = Number(d.capacityGiB)
    if (!Number.isFinite(n) || n <= 0) {
      return new Error(`${name}: 容量は正の数 (GiB) で入力してください`)
    }
    capacity = Math.round(n * GIB)
  }
  if (!zone) {
    // Node that has no role and was left blank: nothing to stage.
    if (!d.effective && !d.applied) return null
    return new Error(`${name}: ゾーンは必須です`)
  }
  return { id: d.id, zone, tags, capacity }
}

function LayoutPage() {
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [drafts, setDrafts] = useState<RoleDraft[]>([])
  const [redundancy, setRedundancy] = useState<'maximum' | 'atLeast'>('maximum')
  const [redundancyN, setRedundancyN] = useState('1')
  const [showApply, setShowApply] = useState(false)
  const [showRevert, setShowRevert] = useState(false)

  const layout = useQuery({ queryKey: ['cluster', 'layout'], queryFn: getClusterLayout })
  const status = useQuery({ queryKey: ['cluster', 'status'], queryFn: getClusterStatus })

  const hostnames = useMemo(() => {
    const m = new Map<string, string>()
    for (const n of status.data?.nodes ?? []) if (n.hostname) m.set(n.id, n.hostname)
    return m
  }, [status.data])
  const nameOf = (id: string) => nodeDisplayName({ id, hostname: hostnames.get(id) ?? null })

  const previewMutation = useMutation({
    mutationFn: previewLayout,
    onError: (error) => toast.error(`プレビューに失敗しました: ${error.message}`),
  })

  // Any change to the staged set makes a previous preview stale.
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['cluster', 'layout'] })
    queryClient.invalidateQueries({ queryKey: ['cluster', 'status'] })
    previewMutation.reset()
  }

  const stageMutation = useMutation({
    mutationFn: stageLayout,
    onSuccess: () => {
      invalidate()
      // A new staged set supersedes the result of the previous apply.
      applyMutation.reset()
      setEditing(false)
      toast.success('変更をステージしました。プレビューで確認してから適用してください。')
    },
    onError: (error) => toast.error(`ステージに失敗しました: ${error.message}`),
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
      applyMutation.reset()
      toast.success('ステージ中の変更を取り消しました')
    },
    onError: (error) => toast.error(`取り消しに失敗しました: ${error.message}`),
  })

  const data: ClusterLayout | undefined = layout.data

  const startEditing = () => {
    if (!data) return
    const roleById = new Map(data.roles.map((r) => [r.id, r]))
    const stagedById = new Map(data.stagedRoleChanges.map((c) => [c.id, c]))
    const nodes = status.data?.nodes ?? []
    const known = new Set(nodes.map((n) => n.id))
    const rows = nodes.map((n) => draftFromNode(n, roleById.get(n.id), stagedById.get(n.id)))
    // Roles or staged changes for nodes the status endpoint does not know about (e.g. gone) stay editable.
    for (const id of new Set([...roleById.keys(), ...stagedById.keys()])) {
      if (!known.has(id)) {
        rows.push(draftFromNode({ id, hostname: null, isUp: false }, roleById.get(id), stagedById.get(id)))
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
    let nextZ: ZoneRedundancy = 'maximum'
    if (redundancy === 'atLeast') {
      const n = Number(redundancyN)
      if (!Number.isInteger(n) || n < 1) {
        toast.error('ゾーン冗長性 (atLeast) は 1 以上の整数で入力してください')
        return
      }
      nextZ = { atLeast: n }
    }
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
  const stagedCount = staged.length + (data?.stagedParameters ? 1 : 0)
  const hasStaged = stagedCount > 0
  const nextVersion = (data?.version ?? 0) + 1
  const preview = previewMutation.data ?? null
  const applied = applyMutation.data ?? null

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
                <p className="font-medium">{formatSize(data.partitionSize)}</p>
              </div>
              <div>
                <p className="text-muted-foreground">保留中の変更</p>
                <p className="font-medium">
                  {hasStaged
                    ? <Badge variant="destructive">{stagedCount} 件保留中</Badge>
                    : <span className="text-muted-foreground">なし</span>}
                </p>
              </div>
            </div>
          </div>

          <LayoutUpdateTracker roles={data.roles} />

          {applied && !editing && (
            <div className="space-y-3 rounded-lg border p-4">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-lg font-semibold">v{applied.layout.version} の適用結果</h2>
                <Button variant="ghost" size="sm" onClick={() => applyMutation.reset()}>
                  閉じる
                </Button>
              </div>
              <LayoutPreview result={applied} nameOf={nameOf} />
            </div>
          )}

          {hasStaged && !editing && (
            <div className="space-y-3 rounded-lg border border-amber-300 bg-amber-50/50 p-4 dark:bg-amber-950/20">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-lg font-semibold">ステージ中の変更</h2>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      applyMutation.reset()
                      previewMutation.mutate()
                    }}
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
                      <span className="font-mono text-xs text-muted-foreground">{nodeDisplayName({ id: c.id, hostname: null })}</span>
                      {'remove' in c ? (
                        <Badge variant="destructive">削除</Badge>
                      ) : (
                        <>
                          <Badge variant={before ? 'secondary' : 'default'}>{before ? '変更' : '追加'}</Badge>
                          <span>
                            zone {before && before.zone !== c.zone ? <s className="text-muted-foreground">{before.zone}</s> : null} {c.zone}
                            {' / '}容量 {before && before.capacity !== c.capacity ? <s className="text-muted-foreground">{formatSize(before.capacity)}</s> : null} {c.capacity == null ? 'gateway' : formatSize(c.capacity)}
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
                <LayoutPreview result={preview} nameOf={nameOf} />
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
                              <div className="font-medium">{nodeDisplayName(d)}</div>
                              <div className="font-mono text-xs text-muted-foreground">{nodeDisplayName({ id: d.id, hostname: null })}</div>
                              {!d.applied && !d.effective && <Badge variant="outline" className="mt-1">ロール未割当</Badge>}
                              {d.applied && d.effective == null && !d.remove && <Badge variant="destructive" className="mt-1">削除をステージ中</Badge>}
                              {d.effective && d.applied && d.effective !== d.applied && <Badge variant="secondary" className="mt-1">変更をステージ中</Badge>}
                              {d.effective && !d.applied && <Badge variant="default" className="mt-1">追加をステージ中</Badge>}
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
                          {(d.applied || d.effective) && (
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
                            <div className="font-mono text-xs text-muted-foreground">{nodeDisplayName({ id: role.id, hostname: null })}</div>
                          </TableCell>
                          <TableCell>{role.zone}</TableCell>
                          <TableCell className="text-right">
                            {role.capacity == null ? <Badge variant="outline">gateway</Badge> : formatSize(role.capacity)}
                          </TableCell>
                          <TableCell className="text-right">{formatSize(role.usableCapacity)}</TableCell>
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
        description="ステージ中の変更を適用します。パーティションの再配置が始まり、クラスタの負荷が一時的に上がります。進捗はこのページの「レイアウト更新中」トラッカーで確認できます。完了後もデータブロックのリシンクには数時間かかることがあります。"
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
