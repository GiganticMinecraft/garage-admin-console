import type { AdminToken } from '@/api'
import { Badge } from '@/components/ui/badge'
import { isFullScope, scopeLabel } from '@/lib/admin-scopes'
import { formatDateTime } from '@/lib/format'

/** 「すべて」 badge for `*`, the single endpoint name, or "x/N". */
export function ScopeCell({ scope }: { scope: string[] }) {
  if (isFullScope(scope)) {
    return <Badge variant="outline">すべて</Badge>
  }
  return (
    <span className="tabular-nums text-muted-foreground" title={scope.join(', ')}>
      {scope.length === 1 ? <span className="font-mono text-xs">{scope[0]}</span> : scopeLabel(scope)}
    </span>
  )
}

/** Expiration (∞ when never) plus a 期限切れ badge. */
export function ExpirationCell({ token }: { token: AdminToken }) {
  return (
    <span className="inline-flex items-center gap-2">
      {token.expiration ? (
        <span className="text-muted-foreground" title={token.expiration}>
          {formatDateTime(token.expiration)}
        </span>
      ) : (
        <span className="text-muted-foreground" title="無期限" aria-label="無期限">
          ∞
        </span>
      )}
      {token.expired && <Badge variant="destructive">期限切れ</Badge>}
    </span>
  )
}
