import { useId, useState } from 'react'
import { ChevronRight, TriangleAlert } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { useConsoleScope } from '@/hooks/use-console-scope'
import {
  ADMIN_SCOPE_CATEGORIES,
  ALL_ADMIN_ENDPOINTS,
  ALL_SCOPE,
  ENDPOINT_MIN_VERSION,
  ESCALATION_WARNING,
  PRIVILEGE_ESCALATION_ENDPOINTS,
  consolePresetScope,
  isFullScope,
  knownScopeCount,
  sameScope,
  scopeEscalates,
  unknownScopeEntries,
} from '@/lib/admin-scopes'
import type { AdminScopeCategory } from '@/lib/admin-scopes'
import { cn } from '@/lib/utils'

interface AdminScopeEditorProps {
  value: string[]
  onChange: (value: string[]) => void
  disabled?: boolean
  /** Show the 「コンソール用スコープを適用」 button. */
  consolePreset?: boolean
}

/**
 * Admin token scope editor: a 「すべて (*)」 toggle plus a category tree of
 * endpoint checkboxes (category boxes are indeterminate when partially
 * selected, with x/y counters). Scope entries this console does not know are
 * kept untouched so saving never silently drops them.
 */
export function AdminScopeEditor({ value, onChange, disabled, consolePreset }: AdminScopeEditorProps) {
  const id = useId()
  const full = isFullScope(value)
  const selected = new Set(value)
  const unknown = unknownScopeEntries(value)
  const knownCount = knownScopeCount(value)
  const escalation = scopeEscalates(value)

  const setEndpoints = (endpoints: readonly string[], on: boolean) => {
    const next = new Set(value)
    next.delete(ALL_SCOPE)
    for (const e of endpoints) {
      if (on) next.add(e)
      else next.delete(e)
    }
    // Keep the canonical (category) order, then any unknown entries.
    onChange([...ALL_ADMIN_ENDPOINTS.filter((e) => next.has(e)), ...unknownScopeEntries([...next])])
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Checkbox
            id={`${id}-all`}
            checked={full}
            disabled={disabled}
            // Turning 「すべて」 off starts from an empty scope so the operator
            // grants endpoints explicitly instead of trimming full access.
            onCheckedChange={(checked) => onChange(checked === true ? [ALL_SCOPE] : [])}
          />
          <label htmlFor={`${id}-all`} className="text-sm font-medium">
            すべて (<code className="font-mono">*</code>)
          </label>
        </div>
        <span className="text-sm text-muted-foreground tabular-nums">
          {full ? 'すべてのエンドポイント' : `${knownCount} / ${ALL_ADMIN_ENDPOINTS.length} エンドポイント`}
        </span>
      </div>

      {consolePreset && <ConsolePresetButton value={value} onChange={onChange} disabled={disabled} />}

      {escalation.escalates && (
        <div
          role="alert"
          className="flex items-start gap-1.5 rounded-md border border-amber-500/50 bg-amber-500/5 p-2 text-xs text-amber-700 dark:text-amber-400"
        >
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div>
            <p className="font-medium">{ESCALATION_WARNING}</p>
            <p>{escalation.reason}</p>
            {full && <p>今後追加されるものも含め、すべての Admin API エンドポイントを呼び出せます。</p>}
          </div>
        </div>
      )}
      {!full && value.length === 0 && (
        <p className="text-xs text-destructive">エンドポイントが 1 つも選択されていません(どの API も呼び出せません)</p>
      )}

      <div className={cn('grid gap-2 md:grid-cols-2', full && 'opacity-60')}>
        {ADMIN_SCOPE_CATEGORIES.map((category) => (
          <ScopeCategory
            key={category.label}
            category={category}
            selected={selected}
            full={full}
            disabled={disabled || full}
            onToggle={setEndpoints}
          />
        ))}
      </div>

      {unknown.length > 0 && (
        <div className="space-y-1 text-xs text-muted-foreground">
          <p>このコンソールが認識していないエンドポイント(そのまま保持されます):</p>
          <div className="flex flex-wrap gap-1">
            {unknown.map((e) => (
              <Badge key={e} variant="outline" className="font-mono">
                {e}
              </Badge>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * 「コンソール用スコープを適用」: replaces the scope with what the console
 * backend calls, minus CreateAdminToken / UpdateAdminToken (see
 * consolePresetScope).
 */
function ConsolePresetButton({
  value,
  onChange,
  disabled,
}: {
  value: string[]
  onChange: (value: string[]) => void
  disabled?: boolean
}) {
  const consoleScope = useConsoleScope()
  const preset = consoleScope.data ? consolePresetScope(consoleScope.data) : null
  const applied = preset !== null && sameScope(value, preset)
  return (
    <div className="space-y-1 rounded-md border border-dashed p-2 text-xs text-muted-foreground">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled || preset === null || applied}
          onClick={() => preset && onChange(preset)}
        >
          コンソール用スコープを適用
        </Button>
        {consoleScope.isLoading && <span>読み込み中...</span>}
        {consoleScope.isError && (
          <span className="text-destructive">
            コンソールが使うエンドポイントを取得できませんでした: {consoleScope.error.message}
          </span>
        )}
        {applied && <span>適用済み</span>}
      </div>
      <p>
        このコンソールが呼び出すエンドポイント{preset ? `(${preset.length} 件)` : ''}だけを許可します。
        権限昇格になる CreateAdminToken / UpdateAdminToken は含めないため、このスコープのトークンを使うコンソールからは管理トークンの作成と編集ができません。
      </p>
    </div>
  )
}

function ScopeCategory({
  category,
  selected,
  full,
  disabled,
  onToggle,
}: {
  category: AdminScopeCategory
  selected: Set<string>
  full: boolean
  disabled?: boolean
  onToggle: (endpoints: readonly string[], on: boolean) => void
}) {
  const id = useId()
  const [open, setOpen] = useState(true)
  const count = full ? category.endpoints.length : category.endpoints.filter((e) => selected.has(e)).length
  const total = category.endpoints.length
  const state: boolean | 'indeterminate' = count === total ? true : count === 0 ? false : 'indeterminate'

  return (
    <div className="rounded-md border p-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="rounded-sm text-muted-foreground hover:text-foreground"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls={`${id}-list`}
          aria-label={open ? `${category.label} を折りたたむ` : `${category.label} を展開`}
        >
          <ChevronRight className={cn('h-4 w-4 transition-transform', open && 'rotate-90')} />
        </button>
        <Checkbox
          id={`${id}-cat`}
          checked={state}
          disabled={disabled}
          onCheckedChange={() => onToggle(category.endpoints, state !== true)}
        />
        <label htmlFor={`${id}-cat`} className="flex-1 text-sm font-medium">
          {category.label}
        </label>
        <span className="text-xs text-muted-foreground tabular-nums">
          {count}/{total}
        </span>
      </div>
      {open && (
        <ul id={`${id}-list`} className="mt-1 space-y-1 pl-12">
          {category.endpoints.map((endpoint) => (
            <li key={endpoint} className="flex items-center gap-2">
              <Checkbox
                id={`${id}-${endpoint}`}
                checked={full || selected.has(endpoint)}
                disabled={disabled}
                onCheckedChange={(checked) => onToggle([endpoint], checked === true)}
              />
              <label htmlFor={`${id}-${endpoint}`} className="font-mono text-xs">
                {endpoint}
              </label>
              {ENDPOINT_MIN_VERSION[endpoint] && (
                <span className="text-[10px] text-muted-foreground" title="Garage v2.4.1 にはないエンドポイントです">
                  {ENDPOINT_MIN_VERSION[endpoint]}
                </span>
              )}
              {PRIVILEGE_ESCALATION_ENDPOINTS.includes(endpoint) && (
                <TriangleAlert
                  className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400"
                  aria-label="権限昇格が可能"
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
