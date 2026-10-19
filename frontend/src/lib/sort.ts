import { useState } from 'react'

export type SortDirection = 'asc' | 'desc'

export interface SortState<K extends string> {
  key: K
  direction: SortDirection
}

/**
 * Column sort state for a table. Clicking the active column flips the
 * direction; clicking another column sorts it ascending.
 */
export function useSort<K extends string>(initial: SortState<K>) {
  const [sort, setSort] = useState<SortState<K>>(initial)
  const toggle = (key: K) =>
    setSort((s) =>
      s.key === key
        ? { key, direction: s.direction === 'asc' ? 'desc' : 'asc' }
        : { key, direction: 'asc' },
    )
  return { sort, toggle }
}

export type SortValue = string | number | null | undefined

const collator = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' })

/** Compares two sort values; null/undefined/'' always sort last. */
export function compareSortValues(a: SortValue, b: SortValue, direction: SortDirection): number {
  const aMissing = a === null || a === undefined || a === ''
  const bMissing = b === null || b === undefined || b === ''
  if (aMissing || bMissing) return aMissing === bMissing ? 0 : aMissing ? 1 : -1
  const c =
    typeof a === 'number' && typeof b === 'number' ? a - b : collator.compare(String(a), String(b))
  return direction === 'asc' ? c : -c
}

/** Returns a sorted copy of `rows`, using `value` to get each row's sort key. */
export function sortRows<T, K extends string>(
  rows: T[],
  sort: SortState<K>,
  value: (row: T, key: K) => SortValue,
): T[] {
  return [...rows].sort((a, b) =>
    compareSortValues(value(a, sort.key), value(b, sort.key), sort.direction),
  )
}

/** Converts an ISO timestamp to epoch millis for sorting (null when absent/invalid). */
export function timeValue(iso: string | null | undefined): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isNaN(t) ? null : t
}
