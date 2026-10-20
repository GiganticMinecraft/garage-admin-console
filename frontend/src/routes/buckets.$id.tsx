import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useState, useCallback } from 'react'
import {
  getBucket,
} from '@/api'
import { BucketAliases } from '@/components/bucket-aliases'
import { BucketKeyPermissions } from '@/components/bucket-key-permissions'
import { BucketSettings } from '@/components/bucket-settings'
import { ObjectBrowser } from '@/components/object-browser'
import { LocalNameBadge } from '@/components/local-name-badge'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  bucketTabBadges,
  bucketTabSearch,
  DEFAULT_BUCKET_TAB,
  isBucketTab,
  type BucketTab,
} from '@/lib/bucket-detail-tabs'
import { bucketDisplayLabel, bucketDisplayName } from '@/lib/bucket-name'
import { formatBytes, formatCount } from '@/lib/format'
import { parseBucketDetailSearch } from '@/lib/inspect-object'
import { toast } from 'sonner'
import { Copy, Check } from 'lucide-react'
import { useDocumentTitle } from '@/hooks/use-document-title'

export const Route = createFileRoute('/buckets/$id')({
  component: BucketDetailPage,
  validateSearch: parseBucketDetailSearch,
})

function BucketDetailPage() {
  useDocumentTitle('バケット詳細')
  const { id } = Route.useParams()
  const { tab: rawTab, prefix: rawPrefix, inspect } = Route.useSearch()
  const tab: BucketTab = rawTab ?? DEFAULT_BUCKET_TAB
  const prefix = rawPrefix ?? ''
  const navigate = useNavigate()
  const setPrefix = useCallback(
    (newPrefix: string) => {
      navigate({
        to: '/buckets/$id',
        params: { id },
        search: (prev) => ({ tab: prev.tab, prefix: newPrefix || undefined }),
        replace: true,
      })
    },
    [navigate, id],
  )
  // A history entry per tab, so back / forward move between tabs. The folder
  // is kept; the object details only belong to the objects tab.
  const setTab = useCallback(
    (next: string) => {
      if (!isBucketTab(next)) return
      navigate({
        to: '/buckets/$id',
        params: { id },
        search: (prev) => ({
          tab: bucketTabSearch(next),
          prefix: prev.prefix,
          inspect: next === 'objects' ? prev.inspect : undefined,
        }),
      })
    },
    [navigate, id],
  )
  // Opening / closing the details keeps the folder the user is in.
  const setInspect = useCallback(
    (key: string | undefined) => {
      navigate({
        to: '/buckets/$id',
        params: { id },
        search: (prev) => ({ ...prev, inspect: key }),
        replace: true,
      })
    },
    [navigate, id],
  )
  const [copied, setCopied] = useState(false)

  const bucket = useQuery({
    queryKey: ['bucket', id],
    queryFn: () => getBucket(id),
  })

  const data = bucket.data
  const localAliases = data?.keys?.flatMap((k) => k.bucketLocalAliases ?? []) ?? []
  const aliasCount = (data?.globalAliases?.length ?? 0) + localAliases.length
  const name = bucketDisplayName(data?.id ?? id, data?.globalAliases, localAliases)
  const badges = bucketTabBadges(data)

  const handleCopyId = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(data?.id ?? id)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error('クリップボードへのコピーに失敗しました')
    }
  }, [data, id])

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Link to="/buckets" className="hover:underline">バケット</Link>
        <span>/</span>
        <span className="break-all">{name.name}</span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-2xl font-bold break-all">
          {name.source === 'id' ? 'バケット詳細' : name.name}
        </h1>
        <LocalNameBadge name={name} />
        {aliasCount > 1 && (
          <Badge variant="secondary" title="グローバル / ローカルエイリアスの合計">
            エイリアス {aliasCount} 件
          </Badge>
        )}
      </div>

      {bucket.isLoading ? (
        <div className="rounded-lg border p-4 space-y-3">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {Array.from({ length: 2 }).map((_, i) => (
              <div key={i} className="space-y-1">
                <Skeleton className="h-4 w-20" />
                <Skeleton className="h-5 w-28" />
              </div>
            ))}
          </div>
        </div>
      ) : bucket.isError ? (
        <p className="text-destructive">バケットの読み込みに失敗しました</p>
      ) : data ? (
        <div className="rounded-lg border p-4 space-y-3">
          <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
            <div>
              <p className="text-muted-foreground">オブジェクト数</p>
              <p className="font-medium">{formatCount(data.objects)}</p>
            </div>
            <div>
              <p className="text-muted-foreground">サイズ</p>
              <p className="font-medium">
                {data.bytes != null ? formatBytes(data.bytes) : '-'}
              </p>
            </div>
          </div>
          <div className="text-sm">
            <p className="text-muted-foreground">ID</p>
            <div className="flex items-center gap-1.5">
              <p className="font-mono text-xs text-muted-foreground break-all">{data.id}</p>
              <button
                onClick={handleCopyId}
                className="shrink-0 text-muted-foreground hover:text-foreground"
                title="IDをコピー"
              >
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              </button>
            </div>
          </div>
          {data.quotas && (data.quotas.maxSize || data.quotas.maxObjects) && (
            <div className="text-sm">
              <p className="text-muted-foreground">クォータ</p>
              <p>
                {data.quotas.maxObjects != null && `最大オブジェクト数: ${data.quotas.maxObjects}`}
                {data.quotas.maxSize != null && ` / 最大サイズ: ${formatBytes(data.quotas.maxSize)}`}
              </p>
            </div>
          )}
        </div>
      ) : null}

      {/*
        Every tab stays mounted (forceMount, hidden when inactive) so that an
        upload queue or an unsaved settings form survives a tab switch.
      */}
      <Tabs value={tab} onValueChange={setTab} className="gap-4">
        <div className="max-w-full overflow-x-auto">
          <TabsList>
            <TabsTrigger value="objects">オブジェクト</TabsTrigger>
            <TabsTrigger value="access">
              アクセス権
              {badges.access !== undefined && (
                <Badge variant="secondary" className="px-1.5" title="このバケットに権限を持つキーの数">
                  {formatCount(badges.access)}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="settings">
              設定
              {badges.settings !== undefined && (
                <Badge variant="outline" className="px-1.5" title="未完了のマルチパートアップロード">
                  未完了 {formatCount(badges.settings)}
                </Badge>
              )}
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="objects" forceMount className="data-[state=inactive]:hidden">
          <ObjectBrowser
            key={`objects-${id}`}
            bucketId={id}
            bucketName={data?.globalAliases?.[0]}
            prefix={prefix}
            onPrefixChange={setPrefix}
            inspectKey={tab === 'objects' ? inspect : undefined}
            onInspectKeyChange={setInspect}
            onShowKeyPermissions={() => setTab('access')}
          />
        </TabsContent>

        <TabsContent value="access" forceMount className="space-y-6 data-[state=inactive]:hidden">
          {data && <BucketAliases key={`aliases-${id}`} bucket={data} />}
          <BucketKeyPermissions
            key={`perms-${id}`}
            bucketId={id}
            bucketLabel={bucketDisplayLabel(name)}
            keys={data?.keys}
          />
        </TabsContent>

        {/* Quotas, website, CORS, lifecycle, unfinished uploads */}
        <TabsContent value="settings" forceMount className="data-[state=inactive]:hidden">
          {data ? (
            <BucketSettings key={`settings-${id}`} bucket={data} />
          ) : bucket.isError ? (
            <p className="text-destructive">バケットの読み込みに失敗したため、設定を表示できません</p>
          ) : (
            <p className="text-muted-foreground">読み込み中...</p>
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}
