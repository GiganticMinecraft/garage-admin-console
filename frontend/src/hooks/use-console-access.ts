import { useQuery } from '@tanstack/react-query'
import { getKey, getS3Connection } from '@/api'
import { consoleKeyLabel } from '@/lib/object-browser'

/**
 * The console's own S3 key (ID from GET /api/s3/connection, name from the
 * key's info) for messages such as "コンソールのキー(<name>)". Only fetched
 * while `enabled`. The name lookup may fail (e.g. the key was deleted); the
 * label then falls back to the ID.
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
