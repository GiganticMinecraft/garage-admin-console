import { ApiError } from '@/api'

/** S3 error codes the backend reports with 403 when the key is refused. */
const ACCESS_DENIED_CODES = new Set(['AccessDenied', 'Forbidden'])

/**
 * True when listing failed because S3 refused the console's own key: the
 * backend maps S3 AccessDenied / Forbidden to 403 and passes the code along
 * (handler_objects.go s3ErrorStatus). Any other 403 is shown as a generic
 * error.
 */
export function isConsoleKeyAccessDenied(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 403 &&
    error.code !== undefined &&
    ACCESS_DENIED_CODES.has(error.code)
  )
}

/**
 * Retry policy for the object listing: 4xx answers (permissions, missing
 * bucket) will not change on retry, so they are shown at once. Other
 * failures are retried once, like the global default.
 */
export function shouldRetryObjectList(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status < 500) return false
  return failureCount < 1
}

/** Outcome of the last successful console-access grant on this page. */
export interface ConsoleGrantResult {
  /** false when the key already had read and write. */
  changed: boolean
  /** Date.now() when the grant succeeded. */
  at: number
}

/**
 * What the object panel shows:
 * - 'list': no access problem (listing, loading or a generic error)
 * - 'grant': the console's key is refused; offer to grant read / write
 * - 'key-invalid': it is refused although it already has read / write on the
 *   bucket (the grant reported no change, or the listing still failed after
 *   a grant), so the key itself is likely broken (wrong secret, deleted key).
 *   Granting again would not help.
 */
export type ConsoleAccessView = 'list' | 'grant' | 'key-invalid'

export function consoleAccessView(
  error: unknown,
  errorUpdatedAt: number,
  lastGrant: ConsoleGrantResult | null,
): ConsoleAccessView {
  if (!isConsoleKeyAccessDenied(error)) return 'list'
  if (lastGrant && (!lastGrant.changed || errorUpdatedAt > lastGrant.at)) return 'key-invalid'
  return 'grant'
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
