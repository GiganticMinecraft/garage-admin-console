import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Eye, EyeOff, Plug, Settings } from 'lucide-react'
import { getKey } from '@/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CopyButton } from '@/components/copy-button'
import { KeyBucketPermissions } from '@/components/key-bucket-permissions'
import { KeySettingsDialog } from '@/components/key-settings-dialog'
import { S3ConnectionDialog } from '@/components/s3-connection-dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { formatDateTime } from '@/lib/format'
import { useDocumentTitle } from '@/hooks/use-document-title'

export const Route = createFileRoute('/keys/$id')({
  component: KeyDetailPage,
})

function KeyDetailPage() {
  useDocumentTitle('キー詳細')
  const { id } = Route.useParams()
  const queryClient = useQueryClient()
  // The route component is reused across /keys/:id navigations, so the
  // "revealed" flag is tied to the key id: a secret revealed for one key is
  // never carried over to the next one.
  const [revealedFor, setRevealedFor] = useState<string | null>(null)
  const showSecret = revealedFor === id
  const [showSettings, setShowSettings] = useState(false)
  const [showS3, setShowS3] = useState(false)

  // Evict any fetched secret from the cache when leaving this key.
  useEffect(() => {
    return () => {
      queryClient.removeQueries({ queryKey: ['key', id, 'secret'] })
    }
  }, [id, queryClient])

  const key = useQuery({
    queryKey: ['key', id],
    queryFn: () => getKey(id),
  })

  // The secret is fetched separately and only on demand. Hiding it evicts
  // the cached value (see toggleSecret), so re-showing re-authorizes against
  // the backend instead of serving a cached copy.
  const secret = useQuery({
    queryKey: ['key', id, 'secret'],
    queryFn: () => getKey(id, { showSecretKey: true }),
    enabled: showSecret,
    staleTime: Infinity,
    gcTime: 0,
  })

  const toggleSecret = () => {
    if (showSecret) {
      setRevealedFor(null)
      queryClient.removeQueries({ queryKey: ['key', id, 'secret'] })
    } else {
      setRevealedFor(id)
    }
  }

  const data = key.data

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Link to="/keys" className="hover:underline">キー</Link>
        <span>/</span>
        <span>{data?.name || id}</span>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold">{data?.name || 'キー詳細'}</h1>
        {data && (
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setShowS3(true)}>
              <Plug />
              S3 接続情報
            </Button>
            <Button variant="outline" size="sm" onClick={() => setShowSettings(true)}>
              <Settings />
              設定を編集
            </Button>
          </div>
        )}
      </div>

      {key.isLoading ? (
        <div className="rounded-lg border p-4 space-y-3">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="space-y-1">
                <Skeleton className="h-4 w-20" />
                <Skeleton className="h-5 w-28" />
              </div>
            ))}
          </div>
        </div>
      ) : key.isError ? (
        <p className="text-destructive">キーの読み込みに失敗しました</p>
      ) : data ? (
        <>
          <div className="rounded-lg border p-4 space-y-3">
            <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
              <div>
                <p className="text-muted-foreground">アクセスキー ID</p>
                <div className="flex items-center gap-1">
                  <p className="font-mono text-xs break-all">{data.accessKeyId}</p>
                  <CopyButton value={data.accessKeyId} label="アクセスキー ID をコピー" />
                </div>
              </div>
              <div>
                <p className="text-muted-foreground">作成日時</p>
                <p className="font-medium">{new Date(data.created).toLocaleString()}</p>
              </div>
              <div>
                <p className="text-muted-foreground">有効期限</p>
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-medium" title={data.expiration ?? undefined}>
                    {data.expiration ? formatDateTime(data.expiration) : '無期限'}
                  </p>
                  {data.expired && <Badge variant="destructive">期限切れ</Badge>}
                </div>
              </div>
              <div>
                <p className="text-muted-foreground">バケットの作成</p>
                <div className="flex gap-1">
                  {data.permissions?.createBucket ? (
                    <Badge variant="outline">許可</Badge>
                  ) : (
                    <span className="text-muted-foreground">不可</span>
                  )}
                </div>
              </div>
            </div>
            <div className="text-sm">
              <p className="text-muted-foreground">シークレットアクセスキー</p>
              <div className="flex items-center gap-1">
                {showSecret ? (
                  secret.isLoading ? (
                    <span className="text-muted-foreground">読み込み中...</span>
                  ) : secret.isError ? (
                    <span className="text-destructive">シークレットを取得できませんでした</span>
                  ) : (
                    <>
                      <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs break-all">
                        {secret.data?.secretAccessKey ?? '(取得できませんでした)'}
                      </code>
                      {secret.data?.secretAccessKey && (
                        <CopyButton value={secret.data.secretAccessKey} label="シークレットアクセスキーをコピー" />
                      )}
                    </>
                  )
                ) : (
                  <span className="font-mono text-xs text-muted-foreground">••••••••••••••••</span>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 gap-1 px-2 text-xs"
                  onClick={toggleSecret}
                >
                  {showSecret ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  {showSecret ? '隠す' : 'シークレットを表示'}
                </Button>
              </div>
            </div>
          </div>

          <KeyBucketPermissions
            key={id}
            keyId={data.accessKeyId}
            keyName={data.name}
            buckets={data.buckets ?? []}
          />

          <KeySettingsDialog keyDetail={data} open={showSettings} onOpenChange={setShowSettings} />
          <S3ConnectionDialog
            key={`s3-${id}`}
            accessKeyId={data.accessKeyId}
            keyName={data.name}
            open={showS3}
            onOpenChange={setShowS3}
          />
        </>
      ) : null}
    </div>
  )
}
