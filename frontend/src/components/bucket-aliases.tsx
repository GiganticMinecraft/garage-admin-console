import { useId, useMemo, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { addBucketAlias, listKeys, removeBucketAlias } from '@/api'
import type { BucketAliasTarget, BucketDetail } from '@/api'
import { Combobox } from '@/components/combobox'
import type { ComboboxOption } from '@/components/combobox'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { ListTruncatedBanner } from '@/components/list-status'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

/** One alias of the bucket, global or in a key's local namespace. */
type AliasRow =
  | { kind: 'global'; alias: string }
  | { kind: 'local'; alias: string; accessKeyId: string; keyName: string }

function rowTarget(row: AliasRow): BucketAliasTarget {
  return row.kind === 'global'
    ? { globalAlias: row.alias }
    : { localAlias: row.alias, accessKeyId: row.accessKeyId }
}

/** Global aliases first, then every key's local aliases. */
function bucketAliasRows(bucket: BucketDetail): AliasRow[] {
  const rows: AliasRow[] = (bucket.globalAliases ?? []).map((alias) => ({ kind: 'global', alias }))
  for (const k of bucket.keys ?? []) {
    for (const alias of k.bucketLocalAliases ?? []) {
      rows.push({ kind: 'local', alias, accessKeyId: k.accessKeyId, keyName: k.name })
    }
  }
  return rows
}

/**
 * Client-side copy of Garage's is_valid_bucket_name (S3 bucket naming
 * rules), which applies to both global and local aliases. Returns an error
 * message, or null when the name is acceptable. The backend and Garage check
 * again; punycode is left to Garage.
 */
function aliasNameError(name: string): string | null {
  if (name.length < 3 || name.length > 63) return '3〜63 文字で入力してください'
  if (!/^[a-z0-9.-]+$/.test(name)) return '英小文字・数字・ハイフン・ドットのみ使えます'
  if (!/^[a-z0-9].*[a-z0-9]$/.test(name)) return '先頭と末尾は英小文字か数字にしてください'
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(name)) return 'IP アドレス形式の名前は使えません'
  if (name.endsWith('-s3alias')) return '「-s3alias」で終わる名前は使えません'
  return null
}

function shortId(id: string): string {
  return id.length > 16 ? `${id.slice(0, 16)}…` : id
}

interface BucketAliasesProps {
  bucket: BucketDetail
}

/**
 * 「エイリアス」 section of the bucket page: lists global aliases and the
 * local aliases keys hold on this bucket, adds either kind (AddBucketAlias)
 * and removes them after a confirmation naming the alias (RemoveBucketAlias).
 * Garage refuses to remove a bucket's very last alias, so that button is
 * disabled; removing the last global alias while local ones remain needs an
 * explicit confirmation since the bucket loses its global name.
 */
export function BucketAliases({ bucket }: BucketAliasesProps) {
  const queryClient = useQueryClient()
  const id = useId()
  const [isLocal, setIsLocal] = useState(false)
  const [aliasInput, setAliasInput] = useState('')
  const [keyId, setKeyId] = useState<string | null>(null)
  // The enriched key list fans out one GetKeyInfo per key: only load it once
  // the picker is opened.
  const [listRequested, setListRequested] = useState(false)
  const [removeTarget, setRemoveTarget] = useState<AliasRow | null>(null)

  const rows = useMemo(() => bucketAliasRows(bucket), [bucket])
  const globalCount = rows.filter((r) => r.kind === 'global').length

  const allKeys = useQuery({ queryKey: ['keys'], queryFn: listKeys, enabled: listRequested })
  const keyOptions = useMemo<ComboboxOption[]>(
    () =>
      (allKeys.data?.items ?? []).map((k) => ({
        value: k.id,
        label: k.name || '(名前なし)',
        detail: shortId(k.id),
        keywords: [k.id],
      })),
    [allKeys.data],
  )

  // Both the bucket list and key pages show aliases. On failure the bucket is
  // refetched too, in case the change raced with another one.
  const refresh = (target: BucketAliasTarget, updated?: BucketDetail) => {
    if (updated) queryClient.setQueryData(['bucket', bucket.id], updated)
    else queryClient.invalidateQueries({ queryKey: ['bucket', bucket.id] })
    queryClient.invalidateQueries({ queryKey: ['buckets'] })
    if ('accessKeyId' in target) {
      queryClient.invalidateQueries({ queryKey: ['key', target.accessKeyId], exact: true })
    }
  }

  const add = useMutation({
    mutationFn: (target: BucketAliasTarget) => addBucketAlias(bucket.id, target),
    onSuccess: (updated, target) => {
      toast.success('エイリアスを追加しました')
      setAliasInput('')
      refresh(target, updated)
    },
    onError: (error, target) => {
      toast.error(`エイリアスの追加に失敗しました: ${error.message}`)
      refresh(target)
    },
  })

  const remove = useMutation({
    mutationFn: (target: BucketAliasTarget) => removeBucketAlias(bucket.id, target),
    onSuccess: (updated, target) => {
      toast.success('エイリアスを削除しました')
      refresh(target, updated)
    },
    onError: (error, target) => {
      toast.error(`エイリアスの削除に失敗しました: ${error.message}`)
      refresh(target)
    },
  })

  const alias = aliasInput.trim()
  const nameError = alias ? aliasNameError(alias) : null
  const duplicate = rows.some((r) =>
    isLocal ? r.kind === 'local' && r.accessKeyId === keyId && r.alias === alias : r.kind === 'global' && r.alias === alias,
  )
  const canAdd = !!alias && !nameError && !duplicate && (!isLocal || !!keyId) && !add.isPending

  const submit = () => {
    if (!canAdd) return
    add.mutate(isLocal && keyId ? { localAlias: alias, accessKeyId: keyId } : { globalAlias: alias })
  }

  const removingLastGlobal =
    removeTarget?.kind === 'global' && globalCount === 1 && rows.length > 1
  const removeDescription = removeTarget
    ? (removeTarget.kind === 'global'
        ? `グローバルエイリアス「${removeTarget.alias}」を削除しますか？`
        : `キー「${removeTarget.keyName || removeTarget.accessKeyId}」のローカルエイリアス「${removeTarget.alias}」を削除しますか？`) +
      (removingLastGlobal
        ? ' これはこのバケット最後のグローバルエイリアスです。削除するとグローバルな名前ではアクセスできなくなり、ローカルエイリアスを持つキーからしか名前で参照できなくなります。'
        : '')
    : ''

  return (
    <div className="space-y-3">
      <h2 className="text-lg font-semibold">エイリアス</h2>

      <div className="space-y-3 rounded-lg border p-4">
        <div className="flex items-center gap-2">
          <Checkbox
            id={`${id}-local`}
            checked={isLocal}
            onCheckedChange={(checked) => setIsLocal(checked === true)}
          />
          <label htmlFor={`${id}-local`} className="text-sm">
            キーにローカル
            <span className="ml-2 text-xs text-muted-foreground">
              選んだキーからだけ見える名前を付けます
            </span>
          </label>
        </div>
        {isLocal && allKeys.data?.truncated && (
          <ListTruncatedBanner>
            Garage の一覧取得の上限に達したため、候補に無いキーがあります。アクセスキー ID を入力すると「この ID を使う」を選べます。
          </ListTruncatedBanner>
        )}
        <div className="flex flex-wrap gap-2">
          {isLocal && (
            <Combobox
              className="min-w-0 flex-1"
              options={keyOptions}
              value={keyId}
              onChange={setKeyId}
              onOpenChange={(open) => {
                if (open) setListRequested(true)
              }}
              loading={allKeys.isLoading}
              acceptCustomValue={(text) => /^GK[0-9a-fA-F]{8,}$/.test(text)}
              placeholder={allKeys.isError ? 'キー一覧を取得できませんでした' : 'キーを選択'}
              searchPlaceholder="名前 / アクセスキー ID で検索"
              emptyText="キーがありません"
              aria-label="ローカルエイリアスを付けるキー"
            />
          )}
          <Input
            className="min-w-0 flex-1"
            value={aliasInput}
            onChange={(e) => setAliasInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit()
            }}
            placeholder={isLocal ? 'ローカルエイリアス' : 'グローバルエイリアス'}
            aria-label={isLocal ? '追加するローカルエイリアス' : '追加するグローバルエイリアス'}
            aria-invalid={!!nameError || duplicate}
          />
          <Button size="sm" className="h-9" onClick={submit} disabled={!canAdd}>
            {add.isPending ? '追加中...' : '追加'}
          </Button>
        </div>
        {nameError && <p className="text-xs text-destructive">{nameError}</p>}
        {!nameError && duplicate && (
          <p className="text-xs text-destructive">このエイリアスは既に設定されています</p>
        )}
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          このバケットにはエイリアスがありません(名前ではアクセスできません)
        </p>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>種類</TableHead>
                <TableHead>エイリアス</TableHead>
                <TableHead>キー</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const last = rows.length === 1
                return (
                  <TableRow
                    key={row.kind === 'global' ? `g:${row.alias}` : `l:${row.accessKeyId}:${row.alias}`}
                  >
                    <TableCell>
                      <Badge variant={row.kind === 'global' ? 'default' : 'secondary'}>
                        {row.kind === 'global' ? 'グローバル' : 'ローカル'}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-sm break-all whitespace-normal">
                      {row.alias}
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      {row.kind === 'local' ? (
                        <span className="flex flex-wrap items-center gap-x-2">
                          <Link
                            to="/keys/$id"
                            params={{ id: row.accessKeyId }}
                            className="text-primary underline-offset-4 hover:underline"
                          >
                            {row.keyName || '(名前なし)'}
                          </Link>
                          <span className="font-mono text-xs text-muted-foreground" title={row.accessKeyId}>
                            {shortId(row.accessKeyId)}
                          </span>
                        </span>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="link"
                        size="sm"
                        className="text-destructive"
                        disabled={last}
                        title={
                          last
                            ? '最後のエイリアスは削除できません(バケットごと削除してください)'
                            : undefined
                        }
                        onClick={() => setRemoveTarget(row)}
                      >
                        削除
                      </Button>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <ConfirmDialog
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(null)
        }}
        title={removingLastGlobal ? '最後のグローバルエイリアスの削除' : 'エイリアスの削除'}
        description={removeDescription}
        confirmLabel={removingLastGlobal ? 'それでも削除' : '削除'}
        onConfirm={() => {
          if (removeTarget) return remove.mutateAsync(rowTarget(removeTarget))
        }}
        isPending={remove.isPending}
      />
    </div>
  )
}
