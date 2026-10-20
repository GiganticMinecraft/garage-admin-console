import type { ReactNode } from 'react'
import { CircleAlert, Search, TriangleAlert, XIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { TableCell, TableRow } from '@/components/ui/table'

interface ListSearchProps {
  value: string
  onChange: (value: string) => void
  placeholder: string
  /** Rows shown after filtering. */
  shown: number
  /** Rows before filtering. */
  total: number
}

/** Search box plus a 「N / M 件を表示」 counter for list pages. */
export function ListSearch({ value, onChange, placeholder, shown, total }: ListSearchProps) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="relative w-full max-w-sm">
        <Search
          className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          type="search"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          aria-label={placeholder}
          className="pl-8 pr-8"
        />
        {value && (
          <button
            type="button"
            onClick={() => onChange('')}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-sm text-muted-foreground hover:text-foreground"
            aria-label="検索をクリア"
          >
            <XIcon className="h-4 w-4" />
          </button>
        )}
      </div>
      <p className="text-sm text-muted-foreground" aria-live="polite">
        {shown.toLocaleString('ja-JP')} / {total.toLocaleString('ja-JP')} 件を表示
      </p>
    </div>
  )
}

/** Error panel for a failed list query, showing the API error message. */
export function ListError({
  title,
  error,
  onRetry,
}: {
  title: string
  error: Error
  onRetry: () => void
}) {
  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-lg border border-destructive/50 bg-destructive/5 p-4 text-sm"
    >
      <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
      <div className="flex-1 space-y-1">
        <p className="font-medium text-destructive">{title}</p>
        <p className="break-all text-muted-foreground">{error.message}</p>
      </div>
      <Button variant="outline" size="sm" onClick={onRetry}>
        再試行
      </Button>
    </div>
  )
}

/** Warning shown when the backend reports the list hit Garage's limit. */
export function ListTruncatedBanner({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      className="flex items-start gap-3 rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm"
    >
      <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
      <p>{children}</p>
    </div>
  )
}

/** Full-width table row for an empty list, with an optional call to action. */
export function ListEmptyRow({
  colSpan,
  message,
  actionLabel,
  onAction,
}: {
  colSpan: number
  message: string
  actionLabel?: string
  onAction?: () => void
}) {
  return (
    <TableRow>
      <TableCell colSpan={colSpan} className="px-4 py-10 text-center text-muted-foreground">
        <div className="flex flex-col items-center gap-3">
          <p>{message}</p>
          {actionLabel && onAction && (
            <Button variant="outline" size="sm" onClick={onAction}>
              {actionLabel}
            </Button>
          )}
        </div>
      </TableCell>
    </TableRow>
  )
}
