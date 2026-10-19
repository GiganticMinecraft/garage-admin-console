import type { BucketKeyPermissions } from '@/api'

export const PERMISSION_FLAGS = ['read', 'write', 'owner'] as const

export const PERMISSION_DESCRIPTIONS: Record<keyof BucketKeyPermissions, string> = {
  read: 'オブジェクトの一覧表示とダウンロード',
  write: 'オブジェクトのアップロード・上書き・削除',
  owner: 'バケット設定(ウェブサイト・CORS・ライフサイクル)の変更とバケットの削除',
}

export const DEFAULT_GRANT: BucketKeyPermissions = { read: true, write: false, owner: false }

/**
 * false for an alias-only entry: Garage ≥ 2.4 also lists keys / buckets that
 * only hold a local alias, with every permission false.
 */
export function hasAnyPermission(p: BucketKeyPermissions | null | undefined): boolean {
  return !!p && (p.read || p.write || p.owner)
}

export function samePermissions(a: BucketKeyPermissions, b: BucketKeyPermissions): boolean {
  return a.read === b.read && a.write === b.write && a.owner === b.owner
}
