import { shortId } from '@/lib/format'

/** The name a bucket is shown under, and where it comes from. */
export interface BucketDisplayName {
  name: string
  /**
   * - global: the first global alias
   * - local: no global alias, so the first local alias (only valid for the
   *   key that holds it; show it with a 「ローカル」 badge)
   * - id: no alias at all, so the shortened bucket ID
   */
  source: 'global' | 'local' | 'id'
}

/** First global alias, else first local alias, else the shortened ID. */
export function bucketDisplayName(
  id: string,
  globalAliases?: readonly string[] | null,
  localAliases?: readonly string[] | null,
): BucketDisplayName {
  const global = globalAliases?.[0]
  if (global) return { name: global, source: 'global' }
  const local = localAliases?.[0]
  if (local) return { name: local, source: 'local' }
  return { name: shortId(id), source: 'id' }
}

/** Plain-text form for dialog texts: local names get a 「(ローカル)」 suffix. */
export function bucketDisplayLabel(d: BucketDisplayName): string {
  return d.source === 'local' ? `${d.name}(ローカル)` : d.name
}
