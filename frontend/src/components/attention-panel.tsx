import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { ChevronRight, CircleAlert, CircleCheck, CircleHelp, TriangleAlert } from 'lucide-react'
import type { AttentionItem, AttentionLink, AttentionResult } from '@/lib/attention'
import { Button } from '@/components/ui/button'

/** Items shown before the rest is folded behind 「すべて表示」. */
const COLLAPSED_COUNT = 8

const LINK_CLASS = 'flex min-w-0 flex-1 items-center gap-1 hover:underline'

function ItemLink({ link, children }: { link: AttentionLink; children: React.ReactNode }) {
  switch (link.to) {
    case '/nodes/$id':
      return <Link to="/nodes/$id" params={{ id: link.id }} className={LINK_CLASS}>{children}</Link>
    case '/keys/$id':
      return <Link to="/keys/$id" params={{ id: link.id }} className={LINK_CLASS}>{children}</Link>
    case '/admin-tokens/$id':
      return <Link to="/admin-tokens/$id" params={{ id: link.id }} className={LINK_CLASS}>{children}</Link>
    case '/buckets/$id':
      return <Link to="/buckets/$id" params={{ id: link.id }} className={LINK_CLASS}>{children}</Link>
    default:
      return <Link to={link.to} className={LINK_CLASS}>{children}</Link>
  }
}

function ItemRow({ item }: { item: AttentionItem }) {
  const danger = item.severity === 'danger'
  const Icon = danger ? CircleAlert : TriangleAlert
  const text = <span className="min-w-0 break-words">{item.message}</span>
  return (
    <li className="flex items-start gap-2 py-1.5 text-sm">
      <Icon
        className={`mt-0.5 h-4 w-4 shrink-0 ${danger ? 'text-destructive' : 'text-amber-600 dark:text-amber-400'}`}
        aria-label={danger ? '危険' : '警告'}
      />
      {item.link ? (
        <ItemLink link={item.link}>
          {text}
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        </ItemLink>
      ) : (
        text
      )}
    </li>
  )
}

/**
 * 「要注意」: everything on the dashboard's data that needs attention, one
 * line each with a link to the page to act on. Sources that could not be
 * fetched are listed as undecidable rather than counted as fine.
 */
export function AttentionPanel({ result }: { result: AttentionResult }) {
  const [expanded, setExpanded] = useState(false)
  const { items, unknown, pending } = result
  const hasDanger = items.some((i) => i.severity === 'danger')

  if (items.length === 0 && unknown.length === 0) {
    if (pending) return null
    return (
      <p className="flex items-center gap-2 rounded-lg border px-4 py-3 text-sm text-muted-foreground">
        <CircleCheck className="h-4 w-4 text-green-600" aria-hidden />
        注意が必要な項目はありません
      </p>
    )
  }

  const shown = expanded ? items : items.slice(0, COLLAPSED_COUNT)
  const border = hasDanger
    ? 'border-destructive/60'
    : items.length > 0
      ? 'border-amber-300 dark:border-amber-700'
      : ''
  return (
    <section className={`rounded-lg border px-4 py-3 ${border}`} aria-labelledby="attention-heading">
      <h2 id="attention-heading" className="font-semibold">
        要注意{items.length > 0 && <span className="ml-1 text-muted-foreground">({items.length})</span>}
      </h2>
      {items.length > 0 && (
        <ul className="divide-y">
          {shown.map((item) => (
            <ItemRow key={item.id} item={item} />
          ))}
        </ul>
      )}
      {items.length > COLLAPSED_COUNT && (
        <Button variant="link" size="sm" className="h-auto px-0" onClick={() => setExpanded((v) => !v)}>
          {expanded ? '折りたたむ' : `すべて表示 (残り ${items.length - COLLAPSED_COUNT} 件)`}
        </Button>
      )}
      {unknown.length > 0 && (
        <p className="flex items-start gap-2 pt-1.5 text-sm text-muted-foreground">
          <CircleHelp className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>取得できなかったため判定できない項目があります: {unknown.join('、')}</span>
        </p>
      )}
    </section>
  )
}
