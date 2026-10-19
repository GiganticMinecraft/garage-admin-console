import { describe, expect, it } from 'vitest'
import { ApiError } from '@/api'
import { consoleKeyLabel, emptyObjectsMessage, isConsoleKeyAccessDenied } from './object-browser'

describe('isConsoleKeyAccessDenied', () => {
  it('is true for a 403 from the object list', () => {
    expect(
      isConsoleKeyAccessDenied(
        new ApiError(403, 'failed to list objects: ... AccessDenied', 'AccessDenied'),
      ),
    ).toBe(true)
  })

  it('is false for other failures', () => {
    expect(isConsoleKeyAccessDenied(new ApiError(404, 'no such bucket', 'NoSuchBucket'))).toBe(false)
    expect(isConsoleKeyAccessDenied(new ApiError(502, 'bad gateway'))).toBe(false)
    expect(isConsoleKeyAccessDenied(new Error('network'))).toBe(false)
    expect(isConsoleKeyAccessDenied(null)).toBe(false)
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
