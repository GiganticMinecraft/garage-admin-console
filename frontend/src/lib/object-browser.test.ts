import { describe, expect, it } from 'vitest'
import { ApiError } from '@/api'
import {
  consoleAccessView,
  consoleKeyLabel,
  emptyObjectsMessage,
  isConsoleKeyAccessDenied,
  shouldRetryObjectList,
} from './object-browser'

const denied = new ApiError(403, 'failed to list objects: ... AccessDenied', 'AccessDenied')

describe('isConsoleKeyAccessDenied', () => {
  it('is true for a 403 with an S3 access-denied code', () => {
    expect(isConsoleKeyAccessDenied(denied)).toBe(true)
    expect(isConsoleKeyAccessDenied(new ApiError(403, 'forbidden', 'Forbidden'))).toBe(true)
  })

  it('is false for a 403 without such a code', () => {
    expect(isConsoleKeyAccessDenied(new ApiError(403, 'Forbidden: missing X-Requested-With header'))).toBe(false)
    expect(isConsoleKeyAccessDenied(new ApiError(403, 'x', 'SomethingElse'))).toBe(false)
  })

  it('is false for other failures', () => {
    expect(isConsoleKeyAccessDenied(new ApiError(404, 'no such bucket', 'NoSuchBucket'))).toBe(false)
    expect(isConsoleKeyAccessDenied(new ApiError(502, 'bad gateway', 'AccessDenied'))).toBe(false)
    expect(isConsoleKeyAccessDenied(new Error('network'))).toBe(false)
    expect(isConsoleKeyAccessDenied(null)).toBe(false)
  })
})

describe('shouldRetryObjectList', () => {
  it('does not retry 4xx', () => {
    expect(shouldRetryObjectList(0, denied)).toBe(false)
    expect(shouldRetryObjectList(0, new ApiError(404, 'x'))).toBe(false)
  })

  it('retries other failures once', () => {
    expect(shouldRetryObjectList(0, new ApiError(502, 'x'))).toBe(true)
    expect(shouldRetryObjectList(1, new ApiError(502, 'x'))).toBe(false)
    expect(shouldRetryObjectList(0, new Error('network'))).toBe(true)
  })
})

describe('consoleAccessView', () => {
  it('shows the list for no error or a generic error', () => {
    expect(consoleAccessView(null, 0, null)).toBe('list')
    expect(consoleAccessView(new ApiError(502, 'x'), 100, null)).toBe('list')
  })

  it('offers a grant when access is denied and nothing was granted yet', () => {
    expect(consoleAccessView(denied, 100, null)).toBe('grant')
  })

  it('keeps offering the grant while the listing has not failed again since a grant', () => {
    expect(consoleAccessView(denied, 100, { changed: true, at: 200 })).toBe('grant')
  })

  it('reports an invalid key when the grant changed nothing', () => {
    expect(consoleAccessView(denied, 100, { changed: false, at: 200 })).toBe('key-invalid')
  })

  it('reports an invalid key when the listing still fails after a grant', () => {
    expect(consoleAccessView(denied, 300, { changed: true, at: 200 })).toBe('key-invalid')
  })

  it('shows the list once the listing works', () => {
    expect(consoleAccessView(null, 0, { changed: true, at: 200 })).toBe('list')
  })
})

describe('consoleKeyLabel', () => {
  it('prefers the key name, then the ID', () => {
    expect(consoleKeyLabel('GK123', 'garage-admin-console')).toBe('garage-admin-console')
    expect(consoleKeyLabel('GK123', '')).toBe('GK123')
    expect(consoleKeyLabel('GK123', '  ')).toBe('GK123')
    expect(consoleKeyLabel('GK123', undefined)).toBe('GK123')
  })

  it('falls back to a generic label when the ID is unknown', () => {
    expect(consoleKeyLabel(undefined, undefined)).toBe('コンソールのキー')
    expect(consoleKeyLabel('', undefined)).toBe('コンソールのキー')
  })
})

describe('emptyObjectsMessage', () => {
  it('says the bucket is empty only when there are no folders either', () => {
    expect(emptyObjectsMessage(0)).toBe('オブジェクトがありません')
  })

  it('says only this level has no files when folders are listed', () => {
    expect(emptyObjectsMessage(1)).toBe('この階層直下にファイルはありません')
    expect(emptyObjectsMessage(68)).toBe('この階層直下にファイルはありません')
  })
})
