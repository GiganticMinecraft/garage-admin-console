import { useMemo, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { listBuckets } from '@/api'
import type { BucketKeyPermissions, KeyDetail } from '@/api'
import { Combobox } from '@/components/combobox'
import type { ComboboxOption } from '@/components/combobox'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { ListTruncatedBanner } from '@/components/list-status'
import { EditPermissionsDialog } from '@/components/edit-permissions-dialog'
import type { EditPermissionsTarget } from '@/components/edit-permissions-dialog'
import { PermissionBadges, PermissionFields } from '@/components/bucket-permission-fields'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useBucketKeyPermissionMutations } from '@/hooks/use-bucket-key-permissions'
import { LocalNameBadge } from '@/components/local-name-badge'
import { bucketDisplayLabel, bucketDisplayName } from '@/lib/bucket-name'
import { shortId } from '@/lib/format'
import { DEFAULT_GRANT, hasAnyPermission } from '@/lib/permissions'

type KeyBucket = KeyDetail['buckets'][number]

function nameOf(b: KeyBucket) {
  return bucketDisplayName(b.id, b.globalAliases, b.localAliases)
}

function bucketLabel(b: KeyBucket): string {
  return bucketDisplayLabel(nameOf(b))
}

interface KeyBucketPermissionsProps {
  keyId: string
  keyName: string
  buckets: KeyBucket[]
}

/**
 * 「バケット」 section of the key page: grant this key access to a bucket
 * picked from the bucket list, edit read / write / owner per bucket, and
 * revoke. Alias-only rows (every permission false) are badged and cannot be
 * revoked.
 */
export function KeyBucketPermissions({ keyId, keyName, buckets }: KeyBucketPermissionsProps) {
  const { grant: grantMutation, edit, revoke } = useBucketKeyPermissionMutations()
  // The enriched bucket list fans out one GetBucketInfo per bucket: only load
  // it once the picker is opened.
  const [listRequested, setListRequested] = useState(false)
  const [grantBucketId, setGrantBucketId] = useState<string | null>(null)
  const [grantPermissions, setGrantPermissions] = useState<BucketKeyPermissions>(DEFAULT_GRANT)
  const [editTarget, setEditTarget] = useState<EditPermissionsTarget | null>(null)
  const [revokeTarget, setRevokeTarget] = useState<KeyBucket | null>(null)
  const keyLabel = keyName || keyId

  const allBuckets = useQuery({ queryKey: ['buckets'], queryFn: listBuckets, enabled: listRequested })

  const options = useMemo<ComboboxOption[]>(() => {
    const granted = new Set(buckets.filter((b) => hasAnyPermission(b.permissions)).map((b) => b.id))
    return (allBuckets.data?.items ?? [])
      .filter((b) => !granted.has(b.id))
      .map((b) => {
        const name = bucketDisplayName(b.id, b.globalAliases, b.localAliases.map((a) => a.alias))
        return {
          value: b.id,
          label: name.source === 'id' ? '(エイリアスなし)' : bucketDisplayLabel(name),
          detail: shortId(b.id),
          keywords: [b.id, ...b.globalAliases, ...b.localAliases.map((a) => a.alias)],
        }
      })
  }, [allBuckets.data, buckets])

  const grant = () => {
    if (!grantBucketId) return
    const v = { bucketId: grantBucketId, keyId, permissions: grantPermissions }
    // A typed-in ID may already be granted: set it exactly (PUT) instead of
    // only adding flags (POST).
    const existing = buckets.find((b) => b.id === grantBucketId)
    const m = hasAnyPermission(existing?.permissions) ? edit : grantMutation
    m.mutate(v, {
      onSuccess: () => {
        setGrantBucketId(null)
        setGrantPermissions(DEFAULT_GRANT)
      },
    })
  }
  const granting = grantMutation.isPending || (edit.isPending && editTarget === null)

  return (
    <div className="space-y-3">
      <h2 className="text-lg font-semibold">バケット</h2>

      <div className="space-y-3 rounded-lg border p-4">
        {allBuckets.data?.truncated && (
          <ListTruncatedBanner>
            Garage の一覧取得の上限に達したため、候補に無いバケットがあります。バケット ID (64 桁) を入力すると「この ID で付与」を選べます。
          </ListTruncatedBanner>
        )}
        <div className="flex flex-wrap gap-2">
          <Combobox
            className="min-w-0 flex-1"
            options={options}
            value={grantBucketId}
            onChange={setGrantBucketId}
            onOpenChange={(open) => {
              if (open) setListRequested(true)
            }}
            loading={allBuckets.isLoading}
            acceptCustomValue={(text) => /^[0-9a-fA-F]{64}$/.test(text)}
            customValueLabel="この ID で付与"
            placeholder={allBuckets.isError ? 'バケット一覧を取得できませんでした' : 'アクセスを許可するバケットを選択'}
            searchPlaceholder="エイリアス / ID で検索"
            emptyText="追加できるバケットがありません"
            aria-label="アクセスを許可するバケット"
          />
          <Button
            size="sm"
            className="h-9"
            onClick={grant}
            disabled={!grantBucketId || !hasAnyPermission(grantPermissions) || granting}
          >
            {granting ? '付与中...' : '付与'}
          </Button>
        </div>
        <PermissionFields value={grantPermissions} onChange={setGrantPermissions} inline />
      </div>

      {buckets.length === 0 ? (
        <p className="text-sm text-muted-foreground">関連付けられたバケットはありません</p>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>バケット</TableHead>
                <TableHead>ローカルエイリアス</TableHead>
                <TableHead>権限</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {buckets.map((bucket) => {
                const aliasOnly = !hasAnyPermission(bucket.permissions)
                return (
                  <TableRow key={bucket.id}>
                    <TableCell>
                      <span className="flex flex-wrap items-center gap-2">
                        <Link
                          to="/buckets/$id"
                          params={{ id: bucket.id }}
                          className="break-all text-primary underline-offset-4 hover:underline"
                        >
                          {nameOf(bucket).name}
                        </Link>
                        <LocalNameBadge name={nameOf(bucket)} />
                      </span>
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      {bucket.localAliases?.length ? (
                        <div className="flex flex-wrap gap-1">
                          {bucket.localAliases.map((a) => (
                            <Badge
                              key={a}
                              variant="secondary"
                              className="break-all whitespace-normal"
                              title="このキーのローカルエイリアス(バケットページで追加・削除できます)"
                            >
                              {a}
                            </Badge>
                          ))}
                        </div>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <PermissionBadges permissions={bucket.permissions} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          setEditTarget({
                            bucketId: bucket.id,
                            keyId,
                            description: `キー「${keyLabel}」のバケット「${bucketLabel(bucket)}」に対する権限`,
                            permissions: bucket.permissions,
                          })
                        }
                      >
                        {aliasOnly ? '権限を付与' : '編集'}
                      </Button>
                      {!aliasOnly && (
                        <Button
                          variant="link"
                          size="sm"
                          className="text-destructive"
                          onClick={() => setRevokeTarget(bucket)}
                        >
                          取り消し
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <EditPermissionsDialog
        target={editTarget}
        onClose={() => setEditTarget(null)}
        isPending={edit.isPending}
        onSave={(permissions) =>
          editTarget
            ? edit.mutateAsync({ bucketId: editTarget.bucketId, keyId, permissions })
            : Promise.resolve()
        }
      />

      <ConfirmDialog
        open={revokeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRevokeTarget(null)
        }}
        title="権限の取り消し"
        description={`バケット「${revokeTarget ? bucketLabel(revokeTarget) : ''}」に対するこのキーの read / write / owner をすべて取り消しますか？`}
        confirmLabel="取り消し"
        pendingLabel="取り消し中..."
        onConfirm={() => {
          if (revokeTarget) return revoke.mutateAsync({ bucketId: revokeTarget.id, keyId })
        }}
        isPending={revoke.isPending}
      />
    </div>
  )
}
