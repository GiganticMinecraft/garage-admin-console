import type { BucketDisplayName } from '@/lib/bucket-name'
import { Badge } from '@/components/ui/badge'

/**
 * 「ローカル」 badge next to a bucket name that is a local alias (the bucket
 * has no global alias), so it is not mistaken for a global name.
 */
export function LocalNameBadge({ name }: { name: BucketDisplayName }) {
  if (name.source !== 'local') return null
  return (
    <Badge
      variant="outline"
      title="グローバルエイリアスが無いため、キーのローカルエイリアスで表示しています"
    >
      ローカル
    </Badge>
  )
}
