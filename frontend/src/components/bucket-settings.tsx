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

/** Parses a JSON array of objects, or returns an error message. */
function parseRulesJson(text: string): { rules: Record<string, unknown>[] } | { error: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text.trim() === '' ? '[]' : text)
  } catch (e) {
    return { error: `JSON の構文エラー: ${e instanceof Error ? e.message : String(e)}` }
  }
  if (!Array.isArray(parsed)) return { error: 'ルールは JSON 配列 ([...]) で指定してください' }
  const bad = parsed.findIndex((r) => r === null || typeof r !== 'object' || Array.isArray(r))
  if (bad >= 0) return { error: `${bad + 1} 番目の要素がオブジェクトではありません` }
  return { rules: parsed as Record<string, unknown>[] }
}

function rulesToText(rules: unknown[] | null | undefined): string {
  return JSON.stringify(rules ?? [], null, 2)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Shared save mutation: PUT the partial body, refresh the bucket and the list. */
function useUpdateBucket(bucketId: string, successMessage: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: UpdateBucketBody) => updateBucket(bucketId, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bucket', bucketId] })
      queryClient.invalidateQueries({ queryKey: ['buckets'] })
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

function QuotaCard({ bucket }: { bucket: BucketDetail }) {
  const serverSize = bucket.quotas?.maxSize ?? null
  const serverObjects = bucket.quotas?.maxObjects ?? null
  const initialSize = serverSize != null ? splitBytes(serverSize) : { value: '', unit: 'GiB' }

  const [sizeUnlimited, setSizeUnlimited] = useState(serverSize == null)
  const [sizeValue, setSizeValue] = useState(initialSize.value)
  const [sizeUnit, setSizeUnit] = useState(initialSize.unit)
  const [objectsUnlimited, setObjectsUnlimited] = useState(serverObjects == null)
  const [objectsValue, setObjectsValue] = useState(serverObjects != null ? String(serverObjects) : '')
  const save = useUpdateBucket(bucket.id, 'クォータを保存しました')

  let sizeError: string | null = null
  let maxSize: number | null = null
  if (!sizeUnlimited) {
    const n = Number(sizeValue.trim())
    const factor = SIZE_UNITS.find((u) => u.label === sizeUnit)?.factor ?? 1
    const bytes = Math.round(n * factor)
    if (sizeValue.trim() === '' || !Number.isFinite(n) || bytes <= 0) sizeError = '正の数を入力してください'
    else if (!Number.isSafeInteger(bytes)) sizeError = '値が大きすぎます'
    else maxSize = bytes
  }
  let objectsError: string | null = null
  let maxObjects: number | null = null
  if (!objectsUnlimited) {
    maxObjects = parsePositiveInt(objectsValue)
    if (maxObjects == null) objectsError = '1 以上の整数を入力してください'
  }

  const valid = sizeError == null && objectsError == null
  const dirty =
    sizeUnlimited !== (serverSize == null) ||
    objectsUnlimited !== (serverObjects == null) ||
    (!sizeUnlimited && maxSize !== serverSize) ||
    (!objectsUnlimited && maxObjects !== serverObjects)

  const reset = () => {
    setSizeUnlimited(serverSize == null)
    setSizeValue(initialSize.value)
    setSizeUnit(initialSize.unit)
    setObjectsUnlimited(serverObjects == null)
    setObjectsValue(serverObjects != null ? String(serverObjects) : '')
    save.reset()
  }

  return (
    <SettingsCard
      title="クォータ"
      description="上限を超える書き込みは拒否されます。既存データは削除されません。"
    >
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium">容量</span>
          <label className="flex items-center gap-1.5 text-sm">
            <Checkbox checked={sizeUnlimited} onCheckedChange={(v) => setSizeUnlimited(v === true)} />
            無制限
          </label>
        </div>
        <div className="flex gap-2">
          <Input
            type="number"
            min={0}
            step="any"
            inputMode="decimal"
            value={sizeValue}
            onChange={(e) => setSizeValue(e.target.value)}
            disabled={sizeUnlimited}
            placeholder={sizeUnlimited ? '無制限' : '例: 100'}
            aria-label="最大容量"
            aria-invalid={sizeError != null}
          />
          <select
            value={sizeUnit}
            onChange={(e) => setSizeUnit(e.target.value)}
            disabled={sizeUnlimited}
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
            <Checkbox checked={objectsUnlimited} onCheckedChange={(v) => setObjectsUnlimited(v === true)} />
            無制限
          </label>
        </div>
        <Input
          type="number"
          min={1}
          step={1}
          inputMode="numeric"
          value={objectsValue}
          onChange={(e) => setObjectsValue(e.target.value)}
          disabled={objectsUnlimited}
          placeholder={objectsUnlimited ? '無制限' : '例: 10000'}
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
        onReset={reset}
        onSave={() => save.mutate({ quotas: { maxSize, maxObjects } })}
      />
    </SettingsCard>
  )
}

// ---- 2. website access ----

function WebsiteCard({ bucket }: { bucket: BucketDetail }) {
  const serverEnabled = bucket.websiteAccess
  const cfg = bucket.websiteConfig ?? null
  const serverIndex = cfg?.indexDocument ?? 'index.html'
  const serverError = cfg?.errorDocument ?? ''
  const serverRulesText = rulesToText(cfg?.routingRules)

  const [enabled, setEnabled] = useState(serverEnabled)
  const [indexDocument, setIndexDocument] = useState(serverIndex)
  const [errorDocument, setErrorDocument] = useState(serverError)
  const [rulesText, setRulesText] = useState(serverRulesText)
  const [confirmDisable, setConfirmDisable] = useState(false)
  const save = useUpdateBucket(bucket.id, 'Website 設定を保存しました')

  const rulesTouched = rulesText !== serverRulesText
  const parsedRules = parseRulesJson(rulesText)
  const rulesError = enabled && 'error' in parsedRules ? parsedRules.error : null
  const indexError = enabled && indexDocument.trim() === '' ? 'インデックスドキュメントは必須です' : null

  const dirty =
    enabled !== serverEnabled ||
    (enabled &&
      (indexDocument !== serverIndex || errorDocument !== serverError || rulesTouched))

  const reset = () => {
    setEnabled(serverEnabled)
    setIndexDocument(serverIndex)
    setErrorDocument(serverError)
    setRulesText(serverRulesText)
    save.reset()
  }

  const onSave = () => {
    if (!enabled) {
      setConfirmDisable(true)
      return
    }
    const websiteAccess: NonNullable<UpdateBucketBody['websiteAccess']> = {
      enabled: true,
      indexDocument: indexDocument.trim(),
      errorDocument: errorDocument.trim() || null,
    }
    // Omitting routingRules keeps the current ones; only send them when edited.
    if (rulesTouched && 'rules' in parsedRules) websiteAccess.routingRules = parsedRules.rules
    save.mutate({ websiteAccess })
  }

  return (
    <SettingsCard
      title="Website access"
      description="有効にすると Garage の web エンドポイントからバケットを静的サイトとして配信します。"
    >
      <label className="flex items-center gap-2 text-sm">
        <Switch checked={enabled} onCheckedChange={setEnabled} label="Website access" />
        {enabled ? '有効' : '無効'}
      </label>

      {enabled ? (
        <div className="space-y-3">
          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor={`${bucket.id}-index-doc`}>
              インデックスドキュメント
            </label>
            <Input
              id={`${bucket.id}-index-doc`}
              value={indexDocument}
              onChange={(e) => setIndexDocument(e.target.value)}
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
              value={errorDocument}
              onChange={(e) => setErrorDocument(e.target.value)}
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
              value={rulesText}
              onChange={(e) => setRulesText(e.target.value)}
              spellCheck={false}
              className={TEXTAREA_CLASS}
              aria-invalid={rulesError != null}
            />
            {rulesError ? (
              <p className="text-xs text-destructive">{rulesError}</p>
            ) : (
              <p className="text-xs text-muted-foreground">
                S3 の RoutingRules と同じ形式 (例: {'[{"Condition":{"KeyPrefixEquals":"old/"},"Redirect":{"ReplaceKeyPrefixWith":"new/"}}]'})。
                変更しなければ現在のルールが維持されます。
              </p>
            )}
          </div>
        </div>
      ) : (
        serverEnabled && (
          <p className="text-sm text-amber-700 dark:text-amber-500">
            保存すると Website access が無効になり、インデックス / エラードキュメントとルーティングルールの設定は破棄されます。
          </p>
        )
      )}

      <CardActions
        dirty={dirty}
        canSave={!enabled || (indexError == null && rulesError == null)}
        pending={save.isPending}
        error={save.error}
        onReset={reset}
        onSave={onSave}
      />

      <ConfirmDialog
        open={confirmDisable}
        onOpenChange={setConfirmDisable}
        title="Website access の無効化"
        description="Website access を無効にすると、インデックス / エラードキュメントとルーティングルールの設定は破棄され、再度有効にしても元に戻りません。無効にしますか？"
        confirmLabel="無効にする"
        pendingLabel="保存中..."
        isPending={save.isPending}
        onConfirm={() => save.mutateAsync({ websiteAccess: { enabled: false } })}
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
  const serverRules = bucket[field] ?? []
  const serverText = rulesToText(serverRules)
  const [text, setText] = useState(serverText)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const save = useUpdateBucket(bucket.id, `${title}を保存しました`)

  const parsed = parseRulesJson(text)
  const parseError = 'error' in parsed ? parsed.error : null
  const dirty = text !== serverText

  const send = (rules: Record<string, unknown>[]) =>
    save.mutateAsync(field === 'corsRules' ? { corsRules: rules } : { lifecycleRules: rules })

  const onSave = () => {
    if (!('rules' in parsed)) return
    // [] deletes the whole configuration; make that explicit.
    if (parsed.rules.length === 0 && serverRules.length > 0) {
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
        <span className="text-muted-foreground">
          現在 {serverRules.length} 件のルール
        </span>
        <Button
          size="xs"
          variant="ghost"
          onClick={() => setText(rulesToText(example))}
          disabled={save.isPending}
        >
          例を挿入
        </Button>
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
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
          setText(serverText)
          save.reset()
        }}
        onSave={onSave}
      />

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`${title}の削除`}
        description={`このバケットの${title}を ${serverRules.length} 件すべて削除しますか？`}
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
  const valid = amount.trim() !== '' && Number.isFinite(n) && n >= 0
  const olderThanSecs = valid ? Math.round(n * unitInfo.secs) : 0
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

  const uploads = bucket.unfinishedMultipartUploads
  return (
    <SettingsCard
      title="未完了マルチパートアップロード"
      description="中断されたマルチパートアップロードのパートは、削除するまで容量を消費し続けます。"
    >
      <div className="grid grid-cols-3 gap-3 text-sm">
        <div>
          <p className="text-muted-foreground">アップロード数</p>
          <p className="font-medium">{formatCount(uploads)}</p>
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
        {!valid && <p className="text-xs text-destructive">0 以上の数値を入力してください</p>}
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

/**
 * Bucket settings editor on /buckets/$id. Each card keeps its own form state
 * and is re-keyed by the server values it edits, so a successful save (which
 * refetches the bucket) resets the form to what Garage stored.
 */
export function BucketSettings({ bucket }: { bucket: BucketDetail }) {
  return (
    <div className="space-y-2">
      <h2 className="text-lg font-semibold">バケット設定</h2>
      <div className="grid gap-4 lg:grid-cols-2">
        <QuotaCard key={`quota:${JSON.stringify(bucket.quotas ?? null)}`} bucket={bucket} />
        <WebsiteCard
          key={`web:${bucket.websiteAccess}:${JSON.stringify(bucket.websiteConfig ?? null)}`}
          bucket={bucket}
        />
        <RulesJsonCard
          key={`cors:${JSON.stringify(bucket.corsRules ?? [])}`}
          bucket={bucket}
          field="corsRules"
          title="CORS ルール"
          description="ブラウザからの S3 クロスオリジンアクセスを許可するルールです (S3 の CORSRule と同じ形式)。"
          example={CORS_EXAMPLE}
        />
        <RulesJsonCard
          key={`lifecycle:${JSON.stringify(bucket.lifecycleRules ?? [])}`}
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
