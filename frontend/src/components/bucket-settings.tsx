import { useState, type ReactNode } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  cleanupIncompleteUploads,
  updateBucket,
  type BucketDetail,
  type UpdateBucketBody,
} from '@/api'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { formatBytes, formatCount } from '@/lib/format'
import { cn } from '@/lib/utils'

// ---- helpers ----

const SIZE_UNITS = [
  { label: 'B', factor: 1 },
  { label: 'KiB', factor: 1024 },
  { label: 'MiB', factor: 1024 ** 2 },
  { label: 'GiB', factor: 1024 ** 3 },
  { label: 'TiB', factor: 1024 ** 4 },
] as const

const SELECT_CLASS = 'h-9 rounded-md border bg-background px-3 text-sm disabled:opacity-50'
const TEXTAREA_CLASS =
  'w-full min-h-40 rounded-md border bg-transparent px-3 py-2 font-mono text-xs shadow-xs outline-none ' +
  'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] ' +
  'aria-invalid:border-destructive dark:bg-input/30'

/** Upper bound for the cleanup age (10 years). */
const MAX_CLEANUP_AGE_SECS = 10 * 365 * 86400

/** Picks the largest unit that represents bytes exactly, e.g. 10 GiB -> {10, GiB}. */
function splitBytes(bytes: number): { value: string; unit: string } {
  for (let i = SIZE_UNITS.length - 1; i > 0; i--) {
    const u = SIZE_UNITS[i]
    if (bytes % u.factor === 0) return { value: String(bytes / u.factor), unit: u.label }
  }
  return { value: String(bytes), unit: 'B' }
}

/** Parses a positive integer count; null when invalid. */
function parsePositiveInt(text: string): number | null {
  const t = text.trim()
  if (!/^\d+$/.test(t)) return null
  const n = Number(t)
  return n > 0 && Number.isSafeInteger(n) ? n : null
}

/** A quota of 0 or less (or absent) is treated as unlimited. */
function normalizeQuota(v: number | null | undefined): number | null {
  return v != null && v > 0 ? v : null
}

type Rules = Record<string, unknown>[]

/** Parses a JSON array of objects, or returns an error message. */
function parseRulesJson(text: string): { rules: Rules } | { error: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text.trim() === '' ? '[]' : text)
  } catch (e) {
    return { error: `JSON の構文エラー: ${e instanceof Error ? e.message : String(e)}` }
  }
  if (!Array.isArray(parsed)) return { error: 'ルールは JSON 配列 ([...]) で指定してください' }
  const bad = parsed.findIndex((r) => r === null || typeof r !== 'object' || Array.isArray(r))
  if (bad >= 0) return { error: `${bad + 1} 番目の要素がオブジェクトではありません` }
  return { rules: parsed as Rules }
}

function rulesToText(rules: unknown[] | null | undefined): string {
  return JSON.stringify(rules ?? [], null, 2)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Form state derived from a slice of the server data. The form is reset
 * explicitly (after a save, from the PUT response; or by リセット). When the
 * server slice changes underneath (background refetch) the form follows it
 * only while it is untouched, so in-progress edits are never overwritten.
 */
function useServerForm<S, F>(server: S, toForm: (s: S) => F) {
  const [base, setBase] = useState(server)
  const [form, setForm] = useState(() => toForm(server))
  const pristine = JSON.stringify(form) === JSON.stringify(toForm(base))
  if (pristine && JSON.stringify(server) !== JSON.stringify(base)) {
    // Adjusting state during render (React's documented pattern for
    // deriving state from changed props).
    setBase(server)
    setForm(toForm(server))
  }
  const resetTo = (s: S) => {
    setBase(s)
    setForm(toForm(s))
  }
  const update = (patch: Partial<F>) => setForm((f) => ({ ...f, ...patch }))
  return { base, form, update, resetTo }
}

/**
 * Shared save mutation. UpdateBucket answers with the full bucket info, which
 * goes straight into the bucket query (no extra GET) and is handed to onSaved
 * so the card can reset its form to what Garage stored.
 */
function useUpdateBucket(bucketId: string, successMessage: string, onSaved: (bucket: BucketDetail) => void) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: UpdateBucketBody) => updateBucket(bucketId, body),
    onSuccess: (data) => {
      queryClient.setQueryData(['bucket', bucketId], data)
      queryClient.invalidateQueries({ queryKey: ['buckets'] })
      onSaved(data)
      toast.success(successMessage)
    },
    onError: (error) => {
      toast.error(`保存に失敗しました: ${errorMessage(error)}`)
    },
  })
}

// ---- layout pieces ----

function SettingsCard({
  title,
  experimental,
  description,
  children,
}: {
  title: string
  experimental?: boolean
  description?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="space-y-3 rounded-lg border p-4">
      <div className="space-y-1">
        <h3 className="flex items-center gap-2 font-medium">
          {title}
          {experimental && <Badge variant="outline">Experimental</Badge>}
        </h3>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  )
}

/** 保存 (primary only while dirty) + リセット, plus the last save error. */
function CardActions({
  dirty,
  canSave,
  pending,
  onSave,
  onReset,
  error,
}: {
  dirty: boolean
  canSave: boolean
  pending: boolean
  onSave: () => void
  onReset: () => void
  error: unknown
}) {
  return (
    <div className="space-y-2">
      {error != null && (
        <p className="text-sm text-destructive" role="alert">
          保存に失敗しました: {errorMessage(error)}
        </p>
      )}
      <div className="flex gap-2">
        <Button
          size="sm"
          variant={dirty ? 'default' : 'outline'}
          disabled={!dirty || !canSave || pending}
          onClick={onSave}
        >
          {pending ? '保存中...' : '保存'}
        </Button>
        <Button size="sm" variant="ghost" disabled={!dirty || pending} onClick={onReset}>
          リセット
        </Button>
      </div>
    </div>
  )
}

function Switch({
  checked,
  onCheckedChange,
  label,
  disabled,
}: {
  checked: boolean
  onCheckedChange: (v: boolean) => void
  label: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent transition-colors outline-none',
        'focus-visible:ring-ring/50 focus-visible:ring-[3px] disabled:opacity-50',
        checked ? 'bg-primary' : 'bg-input dark:bg-input/80',
      )}
    >
      <span
        className={cn(
          'pointer-events-none block size-4 rounded-full bg-background shadow-sm transition-transform',
          checked ? 'translate-x-4' : 'translate-x-0.5',
        )}
      />
    </button>
  )
}

// ---- 1. quotas ----

interface QuotaServer {
  maxSize: number | null
  maxObjects: number | null
}

function quotaServer(b: BucketDetail): QuotaServer {
  return { maxSize: normalizeQuota(b.quotas?.maxSize), maxObjects: normalizeQuota(b.quotas?.maxObjects) }
}

function quotaForm(s: QuotaServer) {
  const size = s.maxSize != null ? splitBytes(s.maxSize) : { value: '', unit: 'GiB' }
  return {
    sizeUnlimited: s.maxSize == null,
    sizeValue: size.value,
    sizeUnit: size.unit,
    objectsUnlimited: s.maxObjects == null,
    objectsValue: s.maxObjects != null ? String(s.maxObjects) : '',
  }
}

function QuotaCard({ bucket }: { bucket: BucketDetail }) {
  const { base, form, update, resetTo } = useServerForm(quotaServer(bucket), quotaForm)
  const save = useUpdateBucket(bucket.id, 'クォータを保存しました', (b) => resetTo(quotaServer(b)))

  let sizeError: string | null = null
  let maxSize: number | null = null
  if (!form.sizeUnlimited) {
    const n = Number(form.sizeValue.trim())
    const factor = SIZE_UNITS.find((u) => u.label === form.sizeUnit)?.factor ?? 1
    const bytes = Math.round(n * factor)
    if (form.sizeValue.trim() === '' || !Number.isFinite(n) || bytes <= 0) sizeError = '正の数を入力してください'
    else if (!Number.isSafeInteger(bytes)) sizeError = '値が大きすぎます'
    else maxSize = bytes
  }
  let objectsError: string | null = null
  let maxObjects: number | null = null
  if (!form.objectsUnlimited) {
    maxObjects = parsePositiveInt(form.objectsValue)
    if (maxObjects == null) objectsError = '1 以上の整数を入力してください'
  }

  const valid = sizeError == null && objectsError == null
  const dirty =
    form.sizeUnlimited !== (base.maxSize == null) ||
    form.objectsUnlimited !== (base.maxObjects == null) ||
    (!form.sizeUnlimited && maxSize !== base.maxSize) ||
    (!form.objectsUnlimited && maxObjects !== base.maxObjects)

  return (
    <SettingsCard
      title="クォータ"
      description="上限を超える書き込みは拒否されます。既存データは削除されません。"
    >
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium">容量</span>
          <label className="flex items-center gap-1.5 text-sm">
            <Checkbox
              checked={form.sizeUnlimited}
              onCheckedChange={(v) => update({ sizeUnlimited: v === true })}
            />
            無制限
          </label>
        </div>
        <div className="flex gap-2">
          <Input
            type="number"
            min={0}
            step="any"
            inputMode="decimal"
            value={form.sizeValue}
            onChange={(e) => update({ sizeValue: e.target.value })}
            disabled={form.sizeUnlimited}
            placeholder={form.sizeUnlimited ? '無制限' : '例: 100'}
            aria-label="最大容量"
            aria-invalid={sizeError != null}
          />
          <select
            value={form.sizeUnit}
            onChange={(e) => update({ sizeUnit: e.target.value })}
            disabled={form.sizeUnlimited}
            className={SELECT_CLASS}
            aria-label="容量の単位"
          >
            {SIZE_UNITS.map((u) => (
              <option key={u.label} value={u.label}>{u.label}</option>
            ))}
          </select>
        </div>
        {sizeError ? (
          <p className="text-xs text-destructive">{sizeError}</p>
        ) : (
          maxSize != null && <p className="text-xs text-muted-foreground">= {formatCount(maxSize)} バイト</p>
        )}
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium">オブジェクト数</span>
          <label className="flex items-center gap-1.5 text-sm">
            <Checkbox
              checked={form.objectsUnlimited}
              onCheckedChange={(v) => update({ objectsUnlimited: v === true })}
            />
            無制限
          </label>
        </div>
        <Input
          type="number"
          min={1}
          step={1}
          inputMode="numeric"
          value={form.objectsValue}
          onChange={(e) => update({ objectsValue: e.target.value })}
          disabled={form.objectsUnlimited}
          placeholder={form.objectsUnlimited ? '無制限' : '例: 10000'}
          aria-label="最大オブジェクト数"
          aria-invalid={objectsError != null}
        />
        {objectsError && <p className="text-xs text-destructive">{objectsError}</p>}
      </div>

      <CardActions
        dirty={dirty}
        canSave={valid}
        pending={save.isPending}
        error={save.error}
        onReset={() => {
          resetTo(base)
          save.reset()
        }}
        onSave={() => save.mutate({ quotas: { maxSize, maxObjects } })}
      />
    </SettingsCard>
  )
}

// ---- 2. website access ----

interface WebsiteServer {
  enabled: boolean
  indexDocument: string
  errorDocument: string
  rulesText: string
  ruleCount: number
}

function websiteServer(b: BucketDetail): WebsiteServer {
  const cfg = b.websiteConfig ?? null
  return {
    enabled: b.websiteAccess,
    indexDocument: cfg?.indexDocument ?? 'index.html',
    errorDocument: cfg?.errorDocument ?? '',
    rulesText: rulesToText(cfg?.routingRules),
    ruleCount: cfg?.routingRules?.length ?? 0,
  }
}

function websiteForm(s: WebsiteServer) {
  return {
    enabled: s.enabled,
    indexDocument: s.indexDocument,
    errorDocument: s.errorDocument,
    rulesText: s.rulesText,
  }
}

type WebsiteConfirm = { kind: 'disable' } | { kind: 'clear-rules'; body: UpdateBucketBody }

function WebsiteCard({ bucket }: { bucket: BucketDetail }) {
  const { base, form, update, resetTo } = useServerForm(websiteServer(bucket), websiteForm)
  const [confirm, setConfirm] = useState<WebsiteConfirm | null>(null)
  const save = useUpdateBucket(bucket.id, 'Website 設定を保存しました', (b) => resetTo(websiteServer(b)))

  const rulesTouched = form.rulesText !== base.rulesText
  const parsedRules = parseRulesJson(form.rulesText)
  const rulesError = form.enabled && 'error' in parsedRules ? parsedRules.error : null
  const indexError = form.enabled && form.indexDocument.trim() === '' ? 'インデックスドキュメントは必須です' : null

  const dirty =
    form.enabled !== base.enabled ||
    (form.enabled &&
      (form.indexDocument !== base.indexDocument || form.errorDocument !== base.errorDocument || rulesTouched))

  const onSave = () => {
    if (!form.enabled) {
      setConfirm({ kind: 'disable' })
      return
    }
    const websiteAccess: NonNullable<UpdateBucketBody['websiteAccess']> = {
      enabled: true,
      indexDocument: form.indexDocument.trim(),
      errorDocument: form.errorDocument.trim() || null,
    }
    // Omitting routingRules keeps the current ones; only send them when edited.
    let clearsRules = false
    if (rulesTouched && 'rules' in parsedRules) {
      if (parsedRules.rules.length > 0) {
        websiteAccess.routingRules = parsedRules.rules
      } else if (base.ruleCount > 0) {
        // An emptied textarea deletes every rule: never do that silently.
        websiteAccess.routingRules = []
        clearsRules = true
      }
    }
    if (clearsRules) {
      setConfirm({ kind: 'clear-rules', body: { websiteAccess } })
      return
    }
    save.mutate({ websiteAccess })
  }

  return (
    <SettingsCard
      title="Website access"
      description="有効にすると Garage の web エンドポイントからバケットを静的サイトとして配信します。"
    >
      <label className="flex items-center gap-2 text-sm">
        <Switch checked={form.enabled} onCheckedChange={(v) => update({ enabled: v })} label="Website access" />
        {form.enabled ? '有効' : '無効'}
      </label>

      {form.enabled ? (
        <div className="space-y-3">
          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor={`${bucket.id}-index-doc`}>
              インデックスドキュメント
            </label>
            <Input
              id={`${bucket.id}-index-doc`}
              value={form.indexDocument}
              onChange={(e) => update({ indexDocument: e.target.value })}
              placeholder="index.html"
              aria-invalid={indexError != null}
            />
            {indexError && <p className="text-xs text-destructive">{indexError}</p>}
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor={`${bucket.id}-error-doc`}>
              エラードキュメント (任意)
            </label>
            <Input
              id={`${bucket.id}-error-doc`}
              value={form.errorDocument}
              onChange={(e) => update({ errorDocument: e.target.value })}
              placeholder="error.html"
            />
          </div>
          <div className="space-y-1">
            <label className="flex items-center gap-2 text-sm font-medium" htmlFor={`${bucket.id}-routing`}>
              ルーティングルール (JSON)
              <Badge variant="outline">Experimental</Badge>
            </label>
            <textarea
              id={`${bucket.id}-routing`}
              value={form.rulesText}
              onChange={(e) => update({ rulesText: e.target.value })}
              spellCheck={false}
              className={TEXTAREA_CLASS}
              aria-invalid={rulesError != null}
            />
            {rulesError ? (
              <p className="text-xs text-destructive">{rulesError}</p>
            ) : (
              <p className="text-xs text-muted-foreground">
                S3 の RoutingRules と同じ形式 (例: {'[{"Condition":{"KeyPrefixEquals":"old/"},"Redirect":{"ReplaceKeyPrefixWith":"new/"}}]'})。
                変更しなければ現在のルールが維持されます。空にして保存するとすべてのルールを削除します (確認あり)。
              </p>
            )}
          </div>
        </div>
      ) : (
        base.enabled && (
          <p className="text-sm text-amber-700 dark:text-amber-500">
            保存すると Website access が無効になり、インデックス / エラードキュメントとルーティングルールの設定は破棄されます。
          </p>
        )
      )}

      <CardActions
        dirty={dirty}
        canSave={!form.enabled || (indexError == null && rulesError == null)}
        pending={save.isPending}
        error={save.error}
        onReset={() => {
          resetTo(base)
          save.reset()
        }}
        onSave={onSave}
      />

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => { if (!open) setConfirm(null) }}
        title={confirm?.kind === 'clear-rules' ? 'ルーティングルールの削除' : 'Website access の無効化'}
        description={
          confirm?.kind === 'clear-rules'
            ? `ルーティングルールを ${base.ruleCount} 件すべて削除しますか？`
            : 'Website access を無効にすると、インデックス / エラードキュメントとルーティングルールの設定は破棄され、再度有効にしても元に戻りません。無効にしますか？'
        }
        confirmLabel={confirm?.kind === 'clear-rules' ? '削除して保存' : '無効にする'}
        pendingLabel="保存中..."
        isPending={save.isPending}
        onConfirm={() =>
          save.mutateAsync(
            confirm?.kind === 'clear-rules' ? confirm.body : { websiteAccess: { enabled: false } },
          )
        }
      />
    </SettingsCard>
  )
}

// ---- 3 & 4. CORS / lifecycle rules (raw JSON) ----

function RulesJsonCard({
  bucket,
  field,
  title,
  description,
  example,
}: {
  bucket: BucketDetail
  field: 'corsRules' | 'lifecycleRules'
  title: string
  description: ReactNode
  example: unknown[]
}) {
  const pick = (b: BucketDetail): Rules => b[field] ?? []
  const toForm = (rules: Rules) => ({ text: rulesToText(rules) })
  const { base, form, update, resetTo } = useServerForm(pick(bucket), toForm)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const save = useUpdateBucket(bucket.id, `${title}を保存しました`, (b) => resetTo(pick(b)))

  const parsed = parseRulesJson(form.text)
  const parseError = 'error' in parsed ? parsed.error : null
  const dirty = form.text !== rulesToText(base)

  const send = (rules: Rules) =>
    save.mutateAsync(field === 'corsRules' ? { corsRules: rules } : { lifecycleRules: rules })

  const onSave = () => {
    if (!('rules' in parsed)) return
    // [] deletes the whole configuration; make that explicit.
    if (parsed.rules.length === 0 && base.length > 0) {
      setConfirmDelete(true)
      return
    }
    send(parsed.rules).catch(() => {
      // reported by the mutation's onError and the inline error
    })
  }

  return (
    <SettingsCard title={title} experimental description={description}>
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">現在 {base.length} 件のルール</span>
        <Button
          size="xs"
          variant="ghost"
          onClick={() => update({ text: rulesToText(example) })}
          disabled={save.isPending}
        >
          例を挿入
        </Button>
      </div>
      <textarea
        value={form.text}
        onChange={(e) => update({ text: e.target.value })}
        spellCheck={false}
        className={TEXTAREA_CLASS}
        aria-label={`${title} (JSON)`}
        aria-invalid={parseError != null}
      />
      {parseError ? (
        <p className="text-xs text-destructive">{parseError}</p>
      ) : (
        <p className="text-xs text-muted-foreground">
          空の配列 [] を保存するとすべてのルールを削除します。変更しない限り送信されません。
        </p>
      )}

      <CardActions
        dirty={dirty}
        canSave={parseError == null}
        pending={save.isPending}
        error={save.error}
        onReset={() => {
          resetTo(base)
          save.reset()
        }}
        onSave={onSave}
      />

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`${title}の削除`}
        description={`このバケットの${title}を ${base.length} 件すべて削除しますか？`}
        isPending={save.isPending}
        onConfirm={() => send([])}
      />
    </SettingsCard>
  )
}

const CORS_EXAMPLE = [
  {
    AllowedOrigin: ['https://example.com'],
    AllowedMethod: ['GET', 'HEAD'],
    AllowedHeader: ['*'],
    ExposeHeader: ['ETag'],
    MaxAgeSeconds: 3600,
  },
]

const LIFECYCLE_EXAMPLE = [
  {
    ID: 'abort-incomplete-uploads',
    Status: 'Enabled',
    AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
  },
  {
    ID: 'expire-tmp',
    Status: 'Enabled',
    Filter: { Prefix: 'tmp/' },
    Expiration: { Days: 30 },
  },
]

// ---- 5. unfinished multipart uploads ----

const AGE_UNITS = [
  { value: 'hours', label: '時間', secs: 3600 },
  { value: 'days', label: '日', secs: 86400 },
] as const

function UnfinishedUploadsCard({ bucket }: { bucket: BucketDetail }) {
  const queryClient = useQueryClient()
  const [amount, setAmount] = useState('1')
  const [unit, setUnit] = useState<(typeof AGE_UNITS)[number]['value']>('days')
  const [confirmOpen, setConfirmOpen] = useState(false)

  const n = Number(amount.trim())
  const unitInfo = AGE_UNITS.find((u) => u.value === unit) ?? AGE_UNITS[1]
  const olderThanSecs = Math.round(n * unitInfo.secs)
  let ageError: string | null = null
  if (amount.trim() === '' || !Number.isFinite(n) || n < 0 || !Number.isSafeInteger(olderThanSecs)) {
    ageError = '0 以上の数値を入力してください'
  } else if (olderThanSecs > MAX_CLEANUP_AGE_SECS) {
    ageError = '10 年以内で指定してください'
  }
  const valid = ageError == null
  const tooRecent = valid && olderThanSecs < 3600

  const cleanup = useMutation({
    mutationFn: () => cleanupIncompleteUploads(bucket.id, olderThanSecs),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['bucket', bucket.id] })
      queryClient.invalidateQueries({ queryKey: ['buckets'] })
      toast.success(`${formatCount(res?.uploadsDeleted ?? 0)} 件の未完了アップロードを削除しました`)
    },
    onError: (error) => {
      toast.error(`未完了アップロードの削除に失敗しました: ${errorMessage(error)}`)
    },
  })

  return (
    <SettingsCard
      title="未完了マルチパートアップロード"
      description="中断されたマルチパートアップロードのパートは、削除するまで容量を消費し続けます。"
    >
      <div className="grid grid-cols-3 gap-3 text-sm">
        <div>
          <p className="text-muted-foreground">アップロード数</p>
          <p className="font-medium">{formatCount(bucket.unfinishedMultipartUploads)}</p>
        </div>
        <div>
          <p className="text-muted-foreground">パート数</p>
          <p className="font-medium">{formatCount(bucket.unfinishedMultipartUploadParts)}</p>
        </div>
        <div>
          <p className="text-muted-foreground">サイズ</p>
          <p className="font-medium">
            {bucket.unfinishedMultipartUploadBytes != null ? formatBytes(bucket.unfinishedMultipartUploadBytes) : '-'}
          </p>
        </div>
      </div>

      <div className="space-y-2">
        <span className="text-sm font-medium">古いアップロードを削除</span>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            type="number"
            min={0}
            step="any"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="w-24"
            aria-label="経過時間"
            aria-invalid={!valid}
          />
          <select
            value={unit}
            onChange={(e) => setUnit(e.target.value as typeof unit)}
            className={SELECT_CLASS}
            aria-label="経過時間の単位"
          >
            {AGE_UNITS.map((u) => (
              <option key={u.value} value={u.value}>{u.label}</option>
            ))}
          </select>
          <span className="text-sm text-muted-foreground">以上前に開始されたもの</span>
          <Button
            size="sm"
            variant="destructive"
            disabled={!valid || cleanup.isPending}
            onClick={() => setConfirmOpen(true)}
          >
            {cleanup.isPending ? '削除中...' : '古いアップロードを削除'}
          </Button>
        </div>
        {ageError && <p className="text-xs text-destructive">{ageError}</p>}
        {tooRecent && (
          <p className="text-sm text-amber-700 dark:text-amber-500">
            注意: 1 時間未満を指定すると、現在進行中のアップロードも中断される可能性があります。
          </p>
        )}
      </div>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="未完了アップロードの削除"
        description={
          `${amount} ${unitInfo.label}以上前に開始された未完了のマルチパートアップロードを削除します。` +
          (tooRecent ? '1 時間未満のため、進行中のアップロードが失敗する可能性があります。' : '') +
          'この操作は取り消せません。'
        }
        isPending={cleanup.isPending}
        onConfirm={() => cleanup.mutateAsync()}
      />
    </SettingsCard>
  )
}

// ---- section ----

/** Bucket settings editor on /buckets/$id; each card keeps its own form state. */
export function BucketSettings({ bucket }: { bucket: BucketDetail }) {
  return (
    <div className="space-y-2">
      <h2 className="text-lg font-semibold">バケット設定</h2>
      <div className="grid gap-4 lg:grid-cols-2">
        <QuotaCard bucket={bucket} />
        <WebsiteCard bucket={bucket} />
        <RulesJsonCard
          bucket={bucket}
          field="corsRules"
          title="CORS ルール"
          description="ブラウザからの S3 クロスオリジンアクセスを許可するルールです (S3 の CORSRule と同じ形式)。"
          example={CORS_EXAMPLE}
        />
        <RulesJsonCard
          bucket={bucket}
          field="lifecycleRules"
          title="ライフサイクルルール"
          description="期限切れオブジェクトや未完了アップロードを自動削除するルールです (S3 の Lifecycle Rule と同じ形式)。"
          example={LIFECYCLE_EXAMPLE}
        />
        <UnfinishedUploadsCard bucket={bucket} />
      </div>
    </div>
  )
}
