import type { BucketDetail } from '@/api'

/** Tabs on /buckets/$id, in display order. */
export const BUCKET_TABS = ['objects', 'access', 'settings'] as const
export type BucketTab = (typeof BUCKET_TABS)[number]
/** What `?tab=` holds: the default tab is left out of the URL. */
export type BucketTabSearch = Exclude<BucketTab, 'objects'>

/** Shown when `?tab=` is absent or not one of BUCKET_TABS. */
export const DEFAULT_BUCKET_TAB = 'objects' satisfies BucketTab

export function isBucketTab(value: unknown): value is BucketTab {
  return typeof value === 'string' && (BUCKET_TABS as readonly string[]).includes(value)
}

/**
 * `?tab=` for /buckets/$id. The default tab parses to undefined so plain
 * /buckets/$id links and ?tab=objects land on the same page.
 */
export function parseBucketTab(value: unknown): BucketTabSearch | undefined {
  return isBucketTab(value) && value !== DEFAULT_BUCKET_TAB ? value : undefined
}

/** The search value to store for a tab: undefined for the default one. */
export function bucketTabSearch(tab: BucketTab): BucketTabSearch | undefined {
  return tab === DEFAULT_BUCKET_TAB ? undefined : tab
}

/**
 * Counts shown next to the tab labels. Access: the number of keys with a
 * permission on the bucket (0 is shown too, it is worth noticing). Settings:
 * the number of unfinished multipart uploads, only when there are some.
 * Nothing is shown while the bucket is loading or when Garage did not report
 * the value.
 */
export function bucketTabBadges(
  bucket: Pick<BucketDetail, 'keys' | 'unfinishedMultipartUploads'> | undefined,
): { access?: number; settings?: number } {
  if (!bucket) return {}
  const mpu = bucket.unfinishedMultipartUploads
  return {
    access: bucket.keys ? bucket.keys.length : undefined,
    settings: mpu != null && mpu > 0 ? mpu : undefined,
  }
}
