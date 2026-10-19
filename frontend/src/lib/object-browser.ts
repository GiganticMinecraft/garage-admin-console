import { ApiError } from '@/api'

/**
 * True when listing failed because the console's own S3 key has no access
 * to the bucket. The backend maps S3 AccessDenied / Forbidden to 403 with
 * that code (handler_objects.go s3ErrorStatus). A 403 without one of those
 * codes is treated the same way: the object routes have no other source of
 * 403 once the request passed the CSRF check.
 */
export function isConsoleKeyAccessDenied(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403
}

/**
 * How to refer to the console's key in messages: its name when known,
 * otherwise its access key ID, otherwise a generic label (the backend did not
 * report it, e.g. an older deployment).
 */
export function consoleKeyLabel(accessKeyId: string | undefined, name: string | undefined): string {
  const trimmedName = name?.trim()
  if (trimmedName) return trimmedName
  if (accessKeyId) return accessKeyId
  return 'コンソールのキー'
}

/**
 * Empty-state text for the object table. Folders (common prefixes) are
 * listed above the table, so an empty table with folders present only means
 * this level has no files of its own, not that the bucket is empty.
 */
export function emptyObjectsMessage(prefixCount: number): string {
  return prefixCount > 0 ? 'この階層直下にファイルはありません' : 'オブジェクトがありません'
}
