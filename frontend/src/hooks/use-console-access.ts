import { useQuery } from '@tanstack/react-query'
import type { QueryClient } from '@tanstack/react-query'
import { getKey, getS3Connection } from '@/api'
import { consoleKeyLabel } from '@/lib/object-browser'

/**
 * The console's own S3 key (ID from GET /api/s3/connection, name from the
 * key's info) for messages such as "コンソールのキー(<name>)". Only fetched
 * while `enabled`. The name lookup may fail (e.g. the key is not visible to
 * the admin token); the label then falls back to the ID.
 */
export function useConsoleKey(enabled: boolean) {
  const conn = useQuery({
    queryKey: ['s3-connection'],
    queryFn: getS3Connection,
    enabled,
    staleTime: Infinity,
  })
  const accessKeyId = conn.data?.accessKeyId || undefined
  const key = useQuery({
    queryKey: ['key', accessKeyId],
    queryFn: () => getKey(accessKeyId!),
    enabled: enabled && !!accessKeyId,
    retry: false,
  })
  return {
    accessKeyId,
    label: consoleKeyLabel(accessKeyId, key.data?.name),
  }
}

/**
 * Refreshes what a console-access grant changes: the bucket's key
 * permissions (the ['bucket', id] query), its object listing, the lists, and
 * the console key's own detail. The key's secret query is not touched
 * (exact match).
 */
export function refreshAfterConsoleAccess(
  queryClient: QueryClient,
  bucketId: string,
  accessKeyId: string | undefined,
) {
  queryClient.invalidateQueries({ queryKey: ['objects', bucketId] })
  queryClient.invalidateQueries({ queryKey: ['bucket', bucketId] })
  queryClient.invalidateQueries({ queryKey: ['buckets'] })
  queryClient.invalidateQueries({ queryKey: ['keys'] })
  if (accessKeyId) {
    queryClient.invalidateQueries({ queryKey: ['key', accessKeyId], exact: true })
  }
}
