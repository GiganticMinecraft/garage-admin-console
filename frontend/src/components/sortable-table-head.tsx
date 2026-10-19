import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react'
import { TableHead } from '@/components/ui/table'
import type { SortState } from '@/lib/sort'
import { cn } from '@/lib/utils'

interface SortableTableHeadProps<K extends string> {
  label: string
  sortKey: K
  sort: SortState<K>
  onSort: (key: K) => void
  className?: string
  /** Right-align the label (numeric columns). */
  alignRight?: boolean
}

/** Table header cell that sorts its column on click and exposes aria-sort. */
export function SortableTableHead<K extends string>({
  label,
  sortKey,
  sort,
  onSort,
  className,
  alignRight,
}: SortableTableHeadProps<K>) {
  const active = sort.key === sortKey
  const ariaSort = active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'
  const Icon = !active ? ArrowUpDown : sort.direction === 'asc' ? ArrowUp : ArrowDown
  return (
    <TableHead aria-sort={ariaSort} className={cn('px-4', alignRight && 'text-right', className)}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={cn(
          'inline-flex items-center gap-1 rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          alignRight && 'flex-row-reverse',
          active ? 'text-foreground' : 'text-muted-foreground',
        )}
      >
        {label}
        <Icon className={cn('h-3.5 w-3.5', !active && 'opacity-50')} aria-hidden="true" />
      </button>
    </TableHead>
  )
}
