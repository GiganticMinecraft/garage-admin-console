import { Button } from '@/components/ui/button'

interface GroupByToggleProps<T extends string> {
  options: readonly { value: T; label: string }[]
  value: T
  onChange: (value: T) => void
}

/** 「グループ化:」 button group shared by the node list and the layout tables. */
export function GroupByToggle<T extends string>({ options, value, onChange }: GroupByToggleProps<T>) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm" role="group" aria-label="グループ化">
      <span className="text-muted-foreground">グループ化:</span>
      {options.map((o) => (
        <Button
          key={o.value}
          type="button"
          size="sm"
          variant={value === o.value ? 'default' : 'outline'}
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </Button>
      ))}
    </div>
  )
}
