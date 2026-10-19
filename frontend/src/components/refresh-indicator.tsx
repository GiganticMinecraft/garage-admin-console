import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { formatSecsAgo } from '@/lib/workers'

/** 「最終更新: N秒前」, re-rendered every second. */
function UpdatedAgo({ at }: { at: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  return (
    <span className="text-sm text-muted-foreground" title={new Date(at).toLocaleString('ja-JP')}>
      最終更新: {formatSecsAgo(Math.max(0, (now - at) / 1000))}
    </span>
  )
}

/**
 * Page-header 「最終更新: N秒前」 plus a 更新 button.
 *
 * `updatedAt` is a react-query `dataUpdatedAt` (0 = never fetched, hidden).
 * The spinner reflects only the manual refresh, not background polling.
 */
export function RefreshIndicator({
  updatedAt,
  onRefresh,
}: {
  updatedAt: number
  onRefresh: () => Promise<unknown>
}) {
  const [refreshing, setRefreshing] = useState(false)
  const refresh = async () => {
    setRefreshing(true)
    try {
      await onRefresh()
    } finally {
      setRefreshing(false)
    }
  }
  return (
    <div className="flex items-center gap-3">
      {updatedAt > 0 && <UpdatedAgo at={updatedAt} />}
      <Button variant="outline" size="sm" onClick={refresh} disabled={refreshing}>
        <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} aria-hidden />
        更新
      </Button>
    </div>
  )
}
