import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Eye, EyeOff, TriangleAlert } from 'lucide-react'
import { getKey, getS3Connection } from '@/api'
import type { S3Connection } from '@/api'
import { CopyButton } from '@/components/copy-button'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

interface S3ConnectionDialogProps {
  accessKeyId: string
  keyName: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

const REDACTED = '********'

/** Single-quotes a value for POSIX shells. */
function shellQuote(v: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`
}

/** A profile / remote name derived from the key name. */
function profileName(keyName: string): string {
  const slug = keyName.trim().replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  return slug ? `garage-${slug}` : 'garage'
}

function snippets(conn: S3Connection, accessKeyId: string, secret: string, keyName: string) {
  const profile = profileName(keyName)
  return [
    {
      id: 'env',
      title: '環境変数 (シェル)',
      text: [
        `export AWS_ACCESS_KEY_ID=${shellQuote(accessKeyId)}`,
        `export AWS_SECRET_ACCESS_KEY=${shellQuote(secret)}`,
        `export AWS_DEFAULT_REGION=${shellQuote(conn.region)}`,
        `export AWS_ENDPOINT_URL_S3=${shellQuote(conn.endpoint)}`,
      ].join('\n'),
    },
    {
      id: 'aws',
      title: `aws-cli (~/.aws/config) — aws --profile ${profile} s3 ls`,
      text: [
        `[profile ${profile}]`,
        `aws_access_key_id = ${accessKeyId}`,
        `aws_secret_access_key = ${secret}`,
        `region = ${conn.region}`,
        `endpoint_url = ${conn.endpoint}`,
        `s3 =`,
        `  addressing_style = path`,
      ].join('\n'),
    },
    {
      id: 'rclone',
      title: `rclone (~/.config/rclone/rclone.conf) — rclone lsd ${profile}:`,
      text: [
        `[${profile}]`,
        `type = s3`,
        `provider = Other`,
        `access_key_id = ${accessKeyId}`,
        `secret_access_key = ${secret}`,
        `region = ${conn.region}`,
        `endpoint = ${conn.endpoint}`,
        `force_path_style = true`,
      ].join('\n'),
    },
  ]
}

/**
 * 「S3 接続情報」: ready-to-paste env exports, an aws-cli profile and an rclone
 * remote for this key. The secret is fetched only when 「表示」 is clicked,
 * never kept in the query cache (gcTime 0) and dropped when the dialog closes;
 * the key page also evicts every ['key', id, 'secret', ...] query on leave.
 */
export function S3ConnectionDialog({ accessKeyId, keyName, open, onOpenChange }: S3ConnectionDialogProps) {
  const queryClient = useQueryClient()
  const [revealed, setRevealed] = useState(false)
  const secretKey = ['key', accessKeyId, 'secret', 's3-connection']

  const conn = useQuery({
    queryKey: ['s3-connection'],
    queryFn: getS3Connection,
    enabled: open,
    staleTime: Infinity,
  })

  const secret = useQuery({
    queryKey: secretKey,
    queryFn: () => getKey(accessKeyId, { showSecretKey: true }),
    enabled: open && revealed,
    staleTime: Infinity,
    gcTime: 0,
  })

  const hide = () => {
    setRevealed(false)
    queryClient.removeQueries({ queryKey: secretKey, exact: true })
  }

  const handleOpenChange = (next: boolean) => {
    if (!next) hide()
    onOpenChange(next)
  }

  const secretValue = revealed ? secret.data?.secretAccessKey : undefined
  const items = conn.data
    ? snippets(conn.data, accessKeyId, secretValue ?? REDACTED, keyName)
    : []

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>S3 接続情報</DialogTitle>
          <DialogDescription>
            このキーで S3 クライアントを設定するためのスニペットです。シークレットは「表示」を押したときだけ取得します。
          </DialogDescription>
        </DialogHeader>

        {conn.isLoading ? (
          <p className="text-sm text-muted-foreground">読み込み中...</p>
        ) : conn.isError ? (
          <p className="text-sm text-destructive">
            接続情報を取得できませんでした: {conn.error.message}
          </p>
        ) : conn.data ? (
          <div className="min-w-0 space-y-4">
            {!conn.data.publicEndpoint && (
              <p className="flex items-start gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-xs">
                <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                GARAGE_S3_PUBLIC_ENDPOINT が未設定のため、コンソールが内部で使う S3 エンドポイントを表示しています。クラスタ外からは到達できない場合があります。
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-muted-foreground">シークレット:</span>
              {revealed ? (
                secret.isLoading ? (
                  <span className="text-muted-foreground">取得中...</span>
                ) : secret.isError ? (
                  <span className="text-destructive">取得できませんでした: {secret.error.message}</span>
                ) : !secretValue ? (
                  <span className="text-destructive">(取得できませんでした)</span>
                ) : (
                  <span className="text-muted-foreground">表示中</span>
                )
              ) : (
                <span className="text-muted-foreground">非表示 (コピーするには表示してください)</span>
              )}
              <Button
                variant="outline"
                size="xs"
                onClick={() => (revealed ? hide() : setRevealed(true))}
              >
                {revealed ? <EyeOff /> : <Eye />}
                {revealed ? '隠す' : '表示'}
              </Button>
            </div>
            {items.map((s) => (
              <div key={s.id} className="min-w-0 space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-medium">{s.title}</p>
                  {secretValue ? (
                    <CopyButton value={s.text} label={`${s.title} をコピー`} />
                  ) : (
                    <span className="text-xs text-muted-foreground">表示後にコピー可</span>
                  )}
                </div>
                <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs leading-relaxed">
                  {s.text}
                </pre>
              </div>
            ))}
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            閉じる
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
