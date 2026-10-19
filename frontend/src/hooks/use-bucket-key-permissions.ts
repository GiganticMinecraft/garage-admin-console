import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { grantBucketKey, revokeBucketKey, setBucketKeyPermissions } from '@/api'
import type { BucketKeyPermissions } from '@/api'

interface Target {
  bucketId: string
  keyId: string
}

type WithPermissions = Target & { permissions: BucketKeyPermissions }

/**
 * Mutations for one key's permissions on one bucket, shared by the bucket
 * page and the key page:
 * - grant: new grant (the key holds no permission yet) → POST / AllowBucketKey
 * - edit: set an existing grant to exactly the given flags → PUT, which the
 *   backend turns into AllowBucketKey + DenyBucketKey
 * - revoke: DELETE / DenyBucketKey for all three flags
 *
 * They are separate mutations so the grant form and the edit dialog have
 * their own pending state. Both sides are refreshed on settle, not only on
 * success: an edit can fail after AllowBucketKey already applied, and the UI
 * must show that partial state. Failure toasts live here (not in per-call
 * callbacks) so they still fire if the caller unmounts. The key's secret
 * query is deliberately not touched (exact match).
 */
export function useBucketKeyPermissionMutations() {
  const queryClient = useQueryClient()

  const refresh = ({ bucketId, keyId }: Target) => {
    queryClient.invalidateQueries({ queryKey: ['bucket', bucketId] })
    queryClient.invalidateQueries({ queryKey: ['key', keyId], exact: true })
    queryClient.invalidateQueries({ queryKey: ['buckets'] })
    queryClient.invalidateQueries({ queryKey: ['keys'] })
  }

  const grant = useMutation({
    mutationFn: (v: WithPermissions) =>
      grantBucketKey(v.bucketId, { accessKeyId: v.keyId, permissions: v.permissions }),
    onSuccess: () => toast.success('権限を付与しました'),
    onError: (error) => toast.error(`権限の付与に失敗しました: ${error.message}`),
    onSettled: (_data, _error, v) => refresh(v),
  })

  const edit = useMutation({
    mutationFn: (v: WithPermissions) =>
      setBucketKeyPermissions(v.bucketId, v.keyId, v.permissions),
    onSuccess: (result) =>
      toast.success(result.changed ? '権限を更新しました' : '権限に変更はありません'),
    onError: (error) => toast.error(`権限の更新に失敗しました: ${error.message}`),
    onSettled: (_data, _error, v) => refresh(v),
  })

  const revoke = useMutation({
    mutationFn: (v: Target) => revokeBucketKey(v.bucketId, v.keyId),
    onSuccess: () => toast.success('権限を取り消しました'),
    onError: (error) => toast.error(`権限の取り消しに失敗しました: ${error.message}`),
    onSettled: (_data, _error, v) => refresh(v),
  })

  return { grant, edit, revoke }
}
