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

/**
 * Outcome of the last console-access grant on this page since the listing
 * last succeeded (the page clears it on every successful listing, so a
 * later revoke by someone else starts over at 'grant').
 */
export type ConsoleGrantResult =
  | {
      /** false when the key already had read and write. */
      changed: boolean
      /** Date.now() when the grant succeeded. */
      at: number
    }
  | { error: unknown }

/** True for Garage's answer about an access key that does not exist. */
export function isMissingKeyError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.code === 'NoSuchAccessKey' || (error.status === 404 && error.code !== 'NoSuchBucket'))
  )
}

export interface ConsoleAccessInput {
  /** Error of the object listing (undefined / null when it did not fail). */
  listError: unknown
  /** When that error was recorded (react-query errorUpdatedAt). */
  listErrorAt: number
  lastGrant: ConsoleGrantResult | null
  /** Error of looking up the console's key (GetKeyInfo), if any. */
  keyLookupError: unknown
  /** The console's key info says it has expired. */
  keyExpired: boolean
}

/**
 * What the object panel shows:
 * - 'list': no access problem (listing, loading or a generic error)
 * - 'grant': the console's key is refused; offer to grant read / write
 * - 'key-expired': refused, and the key has expired
 * - 'key-missing': refused, and the key does not exist (deleted); the
 *   lookup or a grant answered NoSuchAccessKey
 * - 'key-invalid': refused although it already has read / write on the
 *   bucket (the grant reported no change, or the listing still failed after
 *   a grant), so the key itself is likely broken (e.g. wrong secret)
 * Granting is offered only in 'grant': in the other cases it cannot help.
 */
export type ConsoleAccessView = 'list' | 'grant' | 'key-expired' | 'key-missing' | 'key-invalid'

export function consoleAccessView(input: ConsoleAccessInput): ConsoleAccessView {
  if (!isConsoleKeyAccessDenied(input.listError)) return 'list'
  if (input.keyExpired) return 'key-expired'
  const grant = input.lastGrant
  if (isMissingKeyError(input.keyLookupError)) return 'key-missing'
  if (grant && 'error' in grant) return isMissingKeyError(grant.error) ? 'key-missing' : 'grant'
  if (grant && (!grant.changed || input.listErrorAt > grant.at)) return 'key-invalid'
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
export function emptyObjectsMessage(prefixCount: number, hasMore = false): string {
  // Only the pages loaded so far are known: S3 may return a page of folders
  // only, with files on a later page.
  if (hasMore) return '読み込み済みの範囲にファイルはありません。「さらに読み込む」で続きを表示できます'
  return prefixCount > 0 ? 'この階層直下にファイルはありません' : 'オブジェクトがありません'
}
