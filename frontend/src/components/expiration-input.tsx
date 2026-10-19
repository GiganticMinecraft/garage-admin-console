import { useId, useState } from 'react'
import { Info } from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { describeTimeZone, expirationDate } from '@/lib/expiration'
import type { ExpirationValue } from '@/lib/expiration'

interface ExpirationInputProps {
  value: ExpirationValue
  onChange: (value: ExpirationValue) => void
  disabled?: boolean
}

/**
 * 「無期限」 toggle plus local date + time inputs. The info tooltip shows the
 * browser's time zone and the exact ISO 8601 (UTC) string sent to Garage.
 */
export function ExpirationInput({ value, onChange, disabled }: ExpirationInputProps) {
  const id = useId()
  const date = expirationDate(value)
  const iso = date?.toISOString() ?? null
  // "Now" as of mounting is precise enough for a past-date warning.
  const [now] = useState(() => Date.now())
  const inPast = date !== null && date.getTime() <= now

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Checkbox
          id={`${id}-never`}
          checked={value.neverExpires}
          disabled={disabled}
          onCheckedChange={(checked) => onChange({ ...value, neverExpires: checked === true })}
        />
        <label htmlFor={`${id}-never`} className="text-sm">
          無期限
        </label>
      </div>
      {!value.neverExpires && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="date"
              aria-label="有効期限の日付"
              className="w-auto"
              value={value.date}
              disabled={disabled}
              required
              onChange={(e) => onChange({ ...value, date: e.target.value })}
            />
            <Input
              type="time"
              aria-label="有効期限の時刻"
              className="w-auto"
              value={value.time}
              disabled={disabled}
              onChange={(e) => onChange({ ...value, time: e.target.value })}
            />
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground"
                  aria-label="タイムゾーンと送信値"
                >
                  <Info className="h-4 w-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs text-left">
                <p>タイムゾーン: {describeTimeZone(date ?? undefined)}</p>
                <p className="font-mono">送信値: {iso ?? '(日付が未入力)'}</p>
              </TooltipContent>
            </Tooltip>
          </div>
          <p className="text-xs text-muted-foreground">
            ローカル時刻 ({describeTimeZone(date ?? undefined)}) で入力します
          </p>
          {!date && <p className="text-xs text-destructive">日付を入力してください</p>}
          {inPast && (
            <p className="text-xs text-destructive">
              過去の日時です。保存するとキーはすぐに期限切れになります
            </p>
          )}
        </>
      )}
    </div>
  )
}
