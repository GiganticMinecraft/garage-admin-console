import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { listKeys } from '@/api'
import { Combobox } from '@/components/combobox'
import type { ComboboxOption } from '@/components/combobox'
import { ListTruncatedBanner } from '@/components/list-status'
import { shortId } from '@/lib/format'
import { cn } from '@/lib/utils'

/** What a typed-in access key ID must look like to be offered as a custom value. */
const ACCESS_KEY_ID = /^GK[0-9a-fA-F]{8,}$/

interface KeyPickerProps {
  value: string | null
  onChange: (value: string | null) => void
  /** Keys not offered (e.g. ones that already hold a permission). */
  excludeIds?: ReadonlySet<string>
  /** Label of the 「use this typed-in ID」 entry, also named in the truncation banner. */
  customValueLabel?: string
  placeholder: string
  emptyText: string
  'aria-label': string
  className?: string
}

/**
 * Access key Combobox. The enriched key list fans out one GetKeyInfo per key,
 * so it is only loaded once the picker is first opened. When Garage's list
 * limit was reached a banner says so, and a typed-in GK... ID can still be
 * picked.
 */
export function KeyPicker({
  value,
  onChange,
  excludeIds,
  customValueLabel = 'この ID を使う',
  placeholder,
  emptyText,
  'aria-label': ariaLabel,
  className,
}: KeyPickerProps) {
  const [listRequested, setListRequested] = useState(false)
  const allKeys = useQuery({ queryKey: ['keys'], queryFn: listKeys, enabled: listRequested })

  const options = useMemo<ComboboxOption[]>(
    () =>
      (allKeys.data?.items ?? [])
        .filter((k) => !excludeIds?.has(k.id))
        .map((k) => ({
          value: k.id,
          label: k.name || '(名前なし)',
          detail: shortId(k.id),
          keywords: [k.id],
        })),
    [allKeys.data, excludeIds],
  )

  return (
    <div className={cn('min-w-0 space-y-2', className)}>
      {allKeys.data?.truncated && (
        <ListTruncatedBanner>
          Garage の一覧取得の上限に達したため、候補に無いキーがあります。アクセスキー ID を入力すると「{customValueLabel}」を選べます。
        </ListTruncatedBanner>
      )}
      <Combobox
        className="w-full"
        options={options}
        value={value}
        onChange={onChange}
        onOpenChange={(open) => {
          if (open) setListRequested(true)
        }}
        loading={allKeys.isLoading}
        acceptCustomValue={(text) => ACCESS_KEY_ID.test(text)}
        customValueLabel={customValueLabel}
        placeholder={allKeys.isError ? 'キー一覧を取得できませんでした' : placeholder}
        searchPlaceholder="名前 / アクセスキー ID で検索"
        emptyText={emptyText}
        aria-label={ariaLabel}
      />
    </div>
  )
}
