import type { BlockVersionBacklink, InspectObjectBlock, InspectObjectVersion } from '@/api'
import { formatBytes } from '@/lib/format'

/** Blocks rendered per "さらに表示" step, so objects with thousands of blocks stay responsive. */
export const BLOCK_PAGE_SIZE = 200

export type VersionStateKind = 'uploading' | 'aborted' | 'deleteMarker' | 'complete' | 'unknown'

export interface VersionState {
  kind: VersionStateKind
  label: string
  variant: 'default' | 'secondary' | 'destructive' | 'outline'
}

/**
 * State of one InspectObject version. Garage (v2.4.1 InspectObject) sets
 * exactly one of uploading / aborted / deleteMarker for Uploading, Aborted and
 * Complete(DeleteMarker) versions and none of them for a complete one (inline
 * or block-backed). A response with more than one flag set does not match any
 * Garage state and is shown as unknown rather than guessed.
 */
export function versionState(v: Pick<InspectObjectVersion, 'uploading' | 'aborted' | 'deleteMarker'>): VersionState {
  const flags = [v.uploading, v.aborted, v.deleteMarker].filter(Boolean).length
  if (flags > 1) return { kind: 'unknown', label: '不明な状態', variant: 'destructive' }
  if (v.uploading) return { kind: 'uploading', label: 'アップロード中', variant: 'outline' }
  if (v.aborted) return { kind: 'aborted', label: '中断されたアップロード', variant: 'destructive' }
  if (v.deleteMarker) return { kind: 'deleteMarker', label: '削除マーカー', variant: 'secondary' }
  return { kind: 'complete', label: '完了', variant: 'default' }
}

/**
 * Where the version's data lives. Inline versions keep their data in the
 * object metadata and have no blocks; a delete marker has no data at all; an
 * upload that has not stored a part yet (or an aborted one) may have none. A
 * complete block-backed version listing no block means Garage found no
 * version entry for it (version_table miss), which is not the same as
 * "empty".
 */
export function versionStorageLabel(
  v: Pick<InspectObjectVersion, 'inline' | 'deleteMarker' | 'uploading' | 'aborted' | 'blocks'>,
): string {
  if (v.deleteMarker) return 'データなし'
  if (v.inline) return 'インライン(ブロックなし)'
  const n = v.blocks?.length ?? 0
  if (n > 0) return `${n.toLocaleString('ja-JP')} ブロック`
  if (v.uploading || v.aborted) return 'ブロックなし'
  return 'ブロック情報なし'
}

/** "1.50 KiB (1,536 B)", or '-' when Garage reports no size (uploading, aborted, delete marker). */
export function versionSizeLabel(size: number | null | undefined): string {
  if (size === null || size === undefined) return '-'
  return `${formatBytes(size)} (${size.toLocaleString('ja-JP')} B)`
}

export function encryptionLabel(encrypted: boolean): string {
  return encrypted ? 'SSE-C' : 'なし'
}

/** Shortens a block hash to its first 16 hex characters + "…". */
export function shortHash(hash: string): string {
  return hash.length > 16 ? `${hash.slice(0, 16)}…` : hash
}

export interface BlockRow {
  /** Stable React key: (partNumber, offset) is unique within a version. */
  id: string
  partNumber: number
  offset: number
  offsetLabel: string
  hash: string
  shortHash: string
  sizeLabel: string
}

export function blockRow(b: InspectObjectBlock): BlockRow {
  return {
    id: `${b.partNumber}:${b.offset}`,
    partNumber: b.partNumber,
    offset: b.offset,
    offsetLabel: b.offset.toLocaleString('ja-JP'),
    hash: b.hash,
    shortHash: shortHash(b.hash),
    sizeLabel: formatBytes(b.size),
  }
}

/**
 * The first `limit` blocks as display rows, plus how many are left. Only the
 * shown slice is formatted, so a version with thousands of blocks costs
 * nothing until it is expanded.
 */
export function visibleBlockRows(
  blocks: InspectObjectBlock[] | undefined,
  limit: number,
): { rows: BlockRow[]; remaining: number } {
  const all = blocks ?? []
  const n = Math.max(0, Math.min(limit, all.length))
  return { rows: all.slice(0, n).map(blockRow), remaining: all.length - n }
}

/** Next block limit after "さらに表示". */
export function nextBlockLimit(current: number, total: number): number {
  return Math.min(current + BLOCK_PAGE_SIZE, total)
}

/**
 * Reads a search param as a string. TanStack Router JSON-parses search
 * values, so a hand-typed `?x=123` arrives as a number: numbers and booleans
 * are turned back into strings, anything else (objects, arrays) is dropped.
 * The router re-quotes JSON-like strings when it builds a URL itself, so
 * links made inside the app round-trip exactly.
 */
function searchString(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return undefined
}

/** validateSearch for /blocks: `hash` opens that block's info. */
export function parseBlocksSearch(search: Record<string, unknown>): { hash?: string } {
  const hash = searchString(search.hash)?.trim().toLowerCase()
  return { hash: hash || undefined }
}

/** A Garage block hash: 32-byte blake2 sum, hex. */
export function isBlockHash(hash: string): boolean {
  return /^[0-9a-f]{64}$/.test(hash)
}

/**
 * validateSearch for /buckets/$id: `prefix` is the object browser folder,
 * `inspect` the key whose details are open. Keys are kept verbatim (no trim):
 * S3 keys may start or end with spaces.
 */
export function parseBucketDetailSearch(search: Record<string, unknown>): {
  prefix?: string
  inspect?: string
} {
  return {
    prefix: searchString(search.prefix) || undefined,
    inspect: searchString(search.inspect) || undefined,
  }
}

/**
 * The object a GetBlockInfo version refers to, for a link to its details.
 * Object backlinks always carry bucket and key; upload backlinks only when
 * the upload still knows them.
 */
export function backlinkObject(
  backlink: BlockVersionBacklink | null | undefined,
): { bucketId: string; key: string } | null {
  if (!backlink) return null
  if ('object' in backlink) return { bucketId: backlink.object.bucketId, key: backlink.object.key }
  if ('upload' in backlink) {
    const { bucketId, key } = backlink.upload
    if (bucketId && key) return { bucketId, key }
  }
  return null
}
