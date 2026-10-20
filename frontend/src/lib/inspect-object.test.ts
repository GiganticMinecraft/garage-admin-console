import { describe, expect, it } from 'vitest'
import type { InspectObjectBlock } from '@/api'
import {
  BLOCK_PAGE_SIZE,
  backlinkObject,
  blockRow,
  encryptionLabel,
  isBlockHash,
  nextBlockLimit,
  objectFolder,
  parseBlocksSearch,
  parseBucketDetailSearch,
  shortHash,
  versionSizeLabel,
  versionState,
  versionStorageLabel,
  visibleBlockRows,
} from './inspect-object'

const HASH = 'ab'.repeat(32)
const flags = { uploading: false, aborted: false, deleteMarker: false }

describe('versionState', () => {
  it('maps each Garage version state to its own label', () => {
    expect(versionState(flags).kind).toBe('complete')
    expect(versionState({ ...flags, uploading: true })).toMatchObject({ kind: 'uploading', label: 'アップロード中' })
    expect(versionState({ ...flags, aborted: true })).toMatchObject({ kind: 'aborted', variant: 'destructive' })
    expect(versionState({ ...flags, deleteMarker: true })).toMatchObject({ kind: 'deleteMarker', label: '削除マーカー' })
  })

  it('does not guess when flags contradict each other', () => {
    expect(versionState({ uploading: true, aborted: true, deleteMarker: false }).kind).toBe('unknown')
    expect(versionState({ uploading: false, aborted: true, deleteMarker: true }).kind).toBe('unknown')
  })
})

describe('versionStorageLabel', () => {
  const block: InspectObjectBlock = { partNumber: 1, offset: 0, hash: HASH, size: 10 }
  const base = { inline: false, ...flags }
  it('distinguishes inline, delete marker, missing blocks and block counts', () => {
    expect(versionStorageLabel({ ...base, inline: true })).toBe('インライン(ブロックなし)')
    expect(versionStorageLabel({ ...base, deleteMarker: true })).toBe('データなし')
    // A complete block-backed version without blocks: Garage had no version entry.
    expect(versionStorageLabel(base)).toBe('ブロック情報なし')
    expect(versionStorageLabel({ ...base, blocks: [] })).toBe('ブロック情報なし')
    expect(versionStorageLabel({ ...base, blocks: Array(1234).fill(block) })).toBe('1,234 ブロック')
  })
  it('does not call an in-progress multipart upload empty: its parts are separate versions', () => {
    expect(versionStorageLabel({ ...base, uploading: true })).toContain('アップロード中のパートはここには表示されません')
    expect(versionStorageLabel({ ...base, aborted: true })).toBe('ブロックなし')
    expect(versionStorageLabel({ ...base, uploading: true, blocks: [block] })).toBe('1 ブロック')
  })
})

describe('versionSizeLabel / encryptionLabel', () => {
  it('shows "-" for a missing size, not 0 B', () => {
    expect(versionSizeLabel(null)).toBe('-')
    expect(versionSizeLabel(undefined)).toBe('-')
    expect(versionSizeLabel(0)).toBe('0 B (0 B)')
    expect(versionSizeLabel(1536)).toBe('1.50 KiB (1,536 B)')
  })
  it('labels SSE-C', () => {
    expect(encryptionLabel(true)).toBe('SSE-C')
    expect(encryptionLabel(false)).toBe('なし')
  })
})

describe('block rows', () => {
  const blocks: InspectObjectBlock[] = Array.from({ length: 450 }, (_, i) => ({
    partNumber: 1 + Math.floor(i / 100),
    offset: (i % 100) * 1048576,
    hash: i.toString(16).padStart(64, '0'),
    size: 1048576,
  }))

  it('formats one block', () => {
    expect(blockRow({ partNumber: 2, offset: 3145728, hash: HASH, size: 1048576 })).toEqual({
      id: '2:3145728',
      partNumber: 2,
      offset: 3145728,
      offsetLabel: '3,145,728',
      hash: HASH,
      shortHash: `${HASH.slice(0, 16)}…`,
      sizeLabel: '1.00 MiB',
    })
    expect(shortHash('abc')).toBe('abc')
  })

  it('pages blocks 200 at a time', () => {
    let limit = BLOCK_PAGE_SIZE
    let page = visibleBlockRows(blocks, limit)
    expect(page.rows).toHaveLength(200)
    expect(page.remaining).toBe(250)
    limit = nextBlockLimit(limit, blocks.length)
    expect(limit).toBe(400)
    limit = nextBlockLimit(limit, blocks.length)
    expect(limit).toBe(450)
    page = visibleBlockRows(blocks, limit)
    expect(page.rows).toHaveLength(450)
    expect(page.remaining).toBe(0)
    expect(new Set(page.rows.map((r) => r.id)).size).toBe(450)
  })

  it('handles versions without blocks', () => {
    expect(visibleBlockRows(undefined, BLOCK_PAGE_SIZE)).toEqual({ rows: [], remaining: 0 })
  })
})

describe('search params', () => {
  it('parses /blocks?hash=', () => {
    expect(parseBlocksSearch({})).toEqual({ hash: undefined })
    expect(parseBlocksSearch({ hash: '' })).toEqual({ hash: undefined })
    expect(parseBlocksSearch({ hash: ` ${HASH.toUpperCase()} ` })).toEqual({ hash: HASH })
    expect(parseBlocksSearch({ hash: { a: 1 } })).toEqual({ hash: undefined })
    // The router JSON-parses hand-typed values; a number is not a hash string.
    expect(parseBlocksSearch({ hash: 123 })).toEqual({ hash: undefined })
  })

  it('validates block hashes', () => {
    expect(isBlockHash(HASH)).toBe(true)
    expect(isBlockHash(HASH.slice(1))).toBe(false)
    expect(isBlockHash('zz'.repeat(32))).toBe(false)
  })

  it('parses /buckets/$id?prefix=&inspect=', () => {
    expect(parseBucketDetailSearch({})).toEqual({ prefix: undefined, inspect: undefined })
    expect(parseBucketDetailSearch({ prefix: 'a/', inspect: ' dir/x y.json ' })).toEqual({
      prefix: 'a/',
      inspect: ' dir/x y.json ',
    })
    expect(parseBucketDetailSearch({ inspect: '' })).toEqual({ prefix: undefined, inspect: undefined })
    // `?inspect=007` arrives as 7: String(7) would be another key, so it is dropped.
    expect(parseBucketDetailSearch({ inspect: 7, prefix: true })).toEqual({ prefix: undefined, inspect: undefined })
    expect(parseBucketDetailSearch({ inspect: ['a'] })).toEqual({ prefix: undefined, inspect: undefined })
  })
})

describe('objectFolder', () => {
  it('returns the prefix up to the last slash', () => {
    expect(objectFolder('a/b/c.json')).toBe('a/b/')
    expect(objectFolder('root.json')).toBe('')
    expect(objectFolder('dir/')).toBe('dir/')
  })
})

describe('backlinkObject', () => {
  it('links object backlinks and uploads that still know their key', () => {
    expect(backlinkObject({ object: { bucketId: 'b', key: 'k' } })).toEqual({ bucketId: 'b', key: 'k' })
    const upload = { uploadId: 'u', uploadDeleted: false, uploadGarbageCollected: false }
    expect(backlinkObject({ upload: { ...upload, bucketId: 'b', key: 'k' } })).toEqual({ bucketId: 'b', key: 'k' })
    expect(backlinkObject({ upload: { ...upload, bucketId: 'b', key: null } })).toBeNull()
    expect(backlinkObject({ upload })).toBeNull()
    expect(backlinkObject(null)).toBeNull()
    expect(backlinkObject(undefined)).toBeNull()
  })
})
