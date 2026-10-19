import { useMemo, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { listKeys } from '@/api'
import type { BucketKeyPermissions } from '@/api'
import { Combobox } from '@/components/combobox'
import type { ComboboxOption } from '@/components/combobox'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { ListTruncatedBanner } from '@/components/list-status'
import { EditPermissionsDialog } from '@/components/edit-permissions-dialog'
import type { EditPermissionsTarget } from '@/components/edit-permissions-dialog'
import { PermissionBadges, PermissionFields } from '@/components/bucket-permission-fields'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useBucketKeyPermissionMutations } from '@/hooks/use-bucket-key-permissions'
import { DEFAULT_GRANT, hasAnyPermission } from '@/lib/permissions'

/** One entry of GetBucketInfo's `keys`. */
export interface BucketKeyEntry {
  accessKeyId: string
  name: string
  permissions: BucketKeyPermissions
  bucketLocalAliases?: string[]
}

interface BucketKeyPermissionsProps {
  bucketId: string
  /** Display name of the bucket (first global alias), for dialog texts. */
  bucketLabel: string
  keys: BucketKeyEntry[] | undefined
}

function shortId(id: string): string {
  return id.length > 16 ? `${id.slice(0, 16)}…` : id
}

/**
 * 「キーの権限」 section of the bucket page: grant a key picked from the key
 * list, edit read / write / owner per key, and revoke. Alias-only entries
 * (every permission false) are badged and cannot be revoked.
 */
export function BucketKeyPermissions({ bucketId, bucketLabel, keys }: BucketKeyPermissionsProps) {
  const { grant: grantMutation, edit, revoke } = useBucketKeyPermissionMutations()
  // The enriched key list fans out one GetKeyInfo per key: only load it once
  // the picker is opened.
  const [listRequested, setListRequested] = useState(false)
  const [grantKeyId, setGrantKeyId] = useState<string | null>(null)
  const [grantPermissions, setGrantPermissions] = useState<BucketKeyPermissions>(DEFAULT_GRANT)
  const [editTarget, setEditTarget] = useState<EditPermissionsTarget | null>(null)
  const [revokeTarget, setRevokeTarget] = useState<BucketKeyEntry | null>(null)

  const allKeys = useQuery({ queryKey: ['keys'], queryFn: listKeys, enabled: listRequested })

  const options = useMemo<ComboboxOption[]>(() => {
    // Keys that already hold a permission are edited from their row instead.
    const granted = new Set(
      (keys ?? []).filter((k) => hasAnyPermission(k.permissions)).map((k) => k.accessKeyId),
    )
    return (allKeys.data?.items ?? [])
      .filter((k) => !granted.has(k.id))
      .map((k) => ({
        value: k.id,
        label: k.name || '(名前なし)',
        detail: shortId(k.id),
        keywords: [k.id],
      }))
  }, [allKeys.data, keys])

  const grant = () => {
    if (!grantKeyId) return
    const v = { bucketId, keyId: grantKeyId, permissions: grantPermissions }
    // A typed-in ID may already hold permissions: set them exactly (PUT)
    // instead of only adding flags (POST).
    const existing = keys?.find((k) => k.accessKeyId === grantKeyId)
    const m = hasAnyPermission(existing?.permissions) ? edit : grantMutation
    m.mutate(v, {
      onSuccess: () => {
        setGrantKeyId(null)
        setGrantPermissions(DEFAULT_GRANT)
      },
    })
  }
  const granting = grantMutation.isPending || (edit.isPending && editTarget === null)

  return (
    <div className="space-y-3">
      <h2 className="text-lg font-semibold">キーの権限</h2>

      <div className="space-y-3 rounded-lg border p-4">
        {allKeys.data?.truncated && (
          <ListTruncatedBanner>
            Garage の一覧取得の上限に達したため、候補に無いキーがあります。アクセスキー ID を入力すると「この ID で付与」を選べます。
          </ListTruncatedBanner>
        )}
        <div className="flex flex-wrap gap-2">
          <Combobox
            className="min-w-0 flex-1"
            options={options}
            value={grantKeyId}
            onChange={setGrantKeyId}
            onOpenChange={(open) => {
              if (open) setListRequested(true)
            }}
            loading={allKeys.isLoading}
            acceptCustomValue={(text) => /^GK[0-9a-fA-F]{8,}$/.test(text)}
            customValueLabel="この ID で付与"
            placeholder={allKeys.isError ? 'キー一覧を取得できませんでした' : '付与するキーを選択'}
            searchPlaceholder="名前 / アクセスキー ID で検索"
            emptyText="付与できるキーがありません"
            aria-label="付与するキー"
          />
          <Button
            size="sm"
            className="h-9"
            onClick={grant}
            disabled={!grantKeyId || !hasAnyPermission(grantPermissions) || granting}
          >
            {granting ? '付与中...' : '付与'}
          </Button>
        </div>
        <PermissionFields value={grantPermissions} onChange={setGrantPermissions} inline />
      </div>

      {keys && keys.length === 0 && (
        <p className="text-sm text-muted-foreground">このバケットにアクセスできるキーはありません</p>
      )}
      {keys?.map((k) => {
        const aliasOnly = !hasAnyPermission(k.permissions)
        return (
          <div
            key={k.accessKeyId}
            className="flex flex-wrap items-center justify-between gap-2 rounded border px-3 py-2 text-sm"
          >
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <Link
                to="/keys/$id"
                params={{ id: k.accessKeyId }}
                className="text-primary underline-offset-4 hover:underline"
              >
                {k.name || '(名前なし)'}
              </Link>
              <span className="font-mono text-xs text-muted-foreground" title={k.accessKeyId}>
                {k.accessKeyId}
              </span>
              <PermissionBadges permissions={k.permissions} />
              {k.bucketLocalAliases?.map((a) => (
                <Badge key={a} variant="secondary" title="このキーのローカルエイリアス">
                  {a}
                </Badge>
              ))}
            </div>
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  setEditTarget({
                    bucketId,
                    keyId: k.accessKeyId,
                    description: `キー「${k.name || k.accessKeyId}」のバケット「${bucketLabel}」に対する権限`,
                    permissions: k.permissions,
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
                  onClick={() => setRevokeTarget(k)}
                >
                  取り消し
                </Button>
              )}
            </div>
          </div>
        )
      })}

      <EditPermissionsDialog
        target={editTarget}
        onClose={() => setEditTarget(null)}
        isPending={edit.isPending}
        onSave={(permissions) =>
          editTarget
            ? edit.mutateAsync({ bucketId, keyId: editTarget.keyId, permissions })
            : Promise.resolve()
        }
      />

      <ConfirmDialog
        open={revokeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRevokeTarget(null)
        }}
        title="キーの取り消し"
        description={`キー「${revokeTarget?.name || revokeTarget?.accessKeyId}」のこのバケットに対する read / write / owner をすべて取り消しますか？`}
        confirmLabel="取り消し"
        pendingLabel="取り消し中..."
        onConfirm={() => {
          if (revokeTarget) return revoke.mutateAsync({ bucketId, keyId: revokeTarget.accessKeyId })
        }}
        isPending={revoke.isPending}
      />
    </div>
  )
}
