import { useId, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { Check, ChevronsUpDown, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

export interface ComboboxOption {
  value: string
  /** Main text of the option and of the trigger once selected. */
  label: string
  /** Secondary text (e.g. a shortened ID), shown muted and in monospace. */
  detail?: string
  /** Extra strings matched by the search box besides label / detail / value. */
  keywords?: string[]
  disabled?: boolean
}

interface ComboboxProps {
  options: ComboboxOption[]
  value: string | null
  onChange: (value: string | null) => void
  /** Called when the popover opens or closes (e.g. to start loading options lazily). */
  onOpenChange?: (open: boolean) => void
  placeholder?: string
  searchPlaceholder?: string
  emptyText?: string
  /** Shown in place of the option list while the options are loading. */
  loading?: boolean
  /**
   * When set, a search text accepted by this predicate that matches no
   * option's value is offered as an extra 「この ID を使う」 entry, so values
   * missing from a truncated list can still be picked.
   */
  acceptCustomValue?: (text: string) => boolean
  /** Label of that extra entry; defaults to 「この ID を使う」. */
  customValueLabel?: string
  disabled?: boolean
  className?: string
  'aria-label'?: string
}

function matches(o: ComboboxOption, q: string): boolean {
  if (!q) return true
  return [o.label, o.detail ?? '', o.value, ...(o.keywords ?? [])].some((s) =>
    s.toLowerCase().includes(q),
  )
}

/**
 * Searchable single-select built on the radix Popover: a button showing the
 * selection opens a search box with a filtered option list. Arrow keys move
 * the highlight, Enter selects, Escape closes.
 */
export function Combobox({
  options,
  value,
  onChange,
  onOpenChange,
  placeholder = '選択してください',
  searchPlaceholder = '検索',
  emptyText = '該当する項目がありません',
  loading,
  acceptCustomValue,
  customValueLabel = 'この ID を使う',
  disabled,
  className,
  'aria-label': ariaLabel,
}: ComboboxProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const listId = useId()
  const listRef = useRef<HTMLUListElement>(null)

  const selected = options.find((o) => o.value === value) ?? null
  const trimmed = query.trim()
  const q = trimmed.toLowerCase()
  const filtered = useMemo(() => {
    const list = options.filter((o) => matches(o, q))
    if (
      acceptCustomValue &&
      trimmed &&
      acceptCustomValue(trimmed) &&
      !options.some((o) => o.value === trimmed)
    ) {
      list.push({ value: trimmed, label: customValueLabel, detail: trimmed })
    }
    return list
  }, [options, q, trimmed, acceptCustomValue, customValueLabel])

  // Clamped highlight: the list can shrink under the stored index.
  const activeIndex = filtered.length === 0 ? -1 : Math.min(Math.max(active, 0), filtered.length - 1)

  const handleOpenChange = (next: boolean) => {
    setOpen(next)
    onOpenChange?.(next)
    if (next) {
      setQuery('')
      const idx = options.findIndex((o) => o.value === value)
      setActive(Math.max(idx, 0))
    }
  }

  const choose = (o: ComboboxOption) => {
    if (o.disabled) return
    onChange(o.value)
    handleOpenChange(false)
  }

  const scrollTo = (i: number) => {
    listRef.current?.querySelector(`[data-index="${i}"]`)?.scrollIntoView({ block: 'nearest' })
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (activeIndex < 0) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const delta = e.key === 'ArrowDown' ? 1 : -1
      const next = (activeIndex + delta + filtered.length) % filtered.length
      setActive(next)
      scrollTo(next)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      choose(filtered[activeIndex])
    }
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-label={ariaLabel}
          disabled={disabled}
          className={cn('h-9 justify-between font-normal', className)}
        >
          {selected ? (
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate">{selected.label}</span>
              {selected.detail && (
                <span className="truncate font-mono text-xs text-muted-foreground">
                  {selected.detail}
                </span>
              )}
            </span>
          ) : value ? (
            // A custom value not present in the options.
            <span className="truncate font-mono text-xs">{value}</span>
          ) : (
            <span className="truncate text-muted-foreground">{placeholder}</span>
          )}
          <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-(--radix-popover-trigger-width) min-w-64 p-0"
      >
        <div className="flex items-center gap-2 border-b px-3">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setActive(0)
            }}
            onKeyDown={onKeyDown}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            aria-controls={listId}
            aria-activedescendant={activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
            className="h-9 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        <ul ref={listRef} id={listId} role="listbox" className="max-h-64 overflow-y-auto p-1">
          {loading && (
            <li className="px-2 py-1.5 text-sm text-muted-foreground">読み込み中...</li>
          )}
          {!loading && filtered.length === 0 && (
            <li className="px-2 py-1.5 text-sm text-muted-foreground">{emptyText}</li>
          )}
          {filtered.map((o, i) => (
            <li
              key={o.value}
              id={`${listId}-${i}`}
              data-index={i}
              role="option"
              aria-selected={o.value === value}
              aria-disabled={o.disabled || undefined}
              onMouseMove={() => setActive(i)}
              onClick={() => choose(o)}
              className={cn(
                'flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm',
                i === activeIndex && 'bg-accent text-accent-foreground',
                o.disabled && 'cursor-not-allowed opacity-50',
              )}
            >
              <Check
                className={cn('h-4 w-4 shrink-0', o.value === value ? 'opacity-100' : 'opacity-0')}
                aria-hidden="true"
              />
              <span className="truncate">{o.label}</span>
              {o.detail && (
                <span className="ml-auto min-w-0 truncate font-mono text-xs text-muted-foreground">
                  {o.detail}
                </span>
              )}
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}
