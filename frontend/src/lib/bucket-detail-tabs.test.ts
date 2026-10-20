import { describe, expect, it } from 'vitest'
import { bucketTabBadges, bucketTabSearch, isBucketTab, parseBucketTab } from '@/lib/bucket-detail-tabs'

const key = (id: string) => ({
  accessKeyId: id,
  name: id,
  permissions: { read: true, write: false, owner: false },
})

describe('parseBucketTab', () => {
  it('keeps the non-default tabs', () => {
    expect(parseBucketTab('access')).toBe('access')
    expect(parseBucketTab('settings')).toBe('settings')
  })

  it('drops the default tab and anything unknown', () => {
    expect(parseBucketTab('objects')).toBeUndefined()
    expect(parseBucketTab(undefined)).toBeUndefined()
    expect(parseBucketTab('')).toBeUndefined()
    expect(parseBucketTab('Settings')).toBeUndefined()
    expect(parseBucketTab(1)).toBeUndefined()
    expect(parseBucketTab(['access'])).toBeUndefined()
  })

  it('round-trips through bucketTabSearch', () => {
    expect(bucketTabSearch('objects')).toBeUndefined()
    expect(bucketTabSearch('access')).toBe('access')
    expect(bucketTabSearch('settings')).toBe('settings')
    expect(isBucketTab('objects')).toBe(true)
    expect(isBucketTab('nope')).toBe(false)
  })
})

describe('bucketTabBadges', () => {
  it('shows nothing while loading', () => {
    expect(bucketTabBadges(undefined)).toEqual({})
  })

  it('counts keys, including zero', () => {
    expect(bucketTabBadges({ keys: [key('a'), key('b')] }).access).toBe(2)
    expect(bucketTabBadges({ keys: [] }).access).toBe(0)
    expect(bucketTabBadges({}).access).toBeUndefined()
  })

  it('counts unfinished multipart uploads only when there are some', () => {
    expect(bucketTabBadges({ unfinishedMultipartUploads: 3 }).settings).toBe(3)
    expect(bucketTabBadges({ unfinishedMultipartUploads: 0 }).settings).toBeUndefined()
    expect(bucketTabBadges({}).settings).toBeUndefined()
  })
})
