import { useId } from 'react'
import type { BucketKeyPermissions } from '@/api'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { hasAnyPermission, PERMISSION_DESCRIPTIONS, PERMISSION_FLAGS } from '@/lib/permissions'

interface PermissionFieldsProps {
  value: BucketKeyPermissions
  onChange: (value: BucketKeyPermissions) => void
  disabled?: boolean
  /** Lay the checkboxes out in a wrapping row instead of a vertical list. */
  inline?: boolean
}

/** read / write / owner checkboxes, each with a one-line description. */
export function PermissionFields({ value, onChange, disabled, inline }: PermissionFieldsProps) {
  const id = useId()
  return (
    <div className="space-y-2">
      <div className={inline ? 'flex flex-wrap gap-x-6 gap-y-2' : 'space-y-2'}>
        {PERMISSION_FLAGS.map((perm) => (
          <div key={perm} className="flex items-start gap-2">
            <Checkbox
              id={`${id}-${perm}`}
              className="mt-0.5"
              checked={value[perm]}
              disabled={disabled}
              onCheckedChange={(checked) => onChange({ ...value, [perm]: checked === true })}
            />
            <label htmlFor={`${id}-${perm}`} className="text-sm leading-tight">
              <span className="font-mono font-medium">{perm}</span>
              <span className="block text-xs text-muted-foreground">
                {PERMISSION_DESCRIPTIONS[perm]}
              </span>
            </label>
          </div>
        ))}
      </div>
      {!hasAnyPermission(value) && (
        <p className="text-xs text-destructive">最低 1 つの権限を選択してください</p>
      )}
    </div>
  )
}

/**
 * Badges for a permission set. A set with every flag false is shown as
 * 「エイリアスのみ」 (Garage ≥ 2.4 lists entries that only hold a local alias).
 */
export function PermissionBadges({ permissions }: { permissions: BucketKeyPermissions }) {
  if (!hasAnyPermission(permissions)) {
    return (
      <Badge
        variant="secondary"
        title="ローカルエイリアスだけを持ち、read / write / owner のいずれの権限もありません"
      >
        エイリアスのみ
      </Badge>
    )
  }
  return (
    <div className="flex flex-wrap gap-1">
      {PERMISSION_FLAGS.filter((p) => permissions[p]).map((p) => (
        <Badge key={p} variant="outline" title={PERMISSION_DESCRIPTIONS[p]}>
          {p}
        </Badge>
      ))}
    </div>
  )
}
