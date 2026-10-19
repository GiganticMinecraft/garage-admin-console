/**
 * Key-expiration form state: either 「無期限」 or a local date + time
 * (the values of <input type="date"> / <input type="time">).
 */
export interface ExpirationValue {
  neverExpires: boolean
  date: string // YYYY-MM-DD
  time: string // HH:mm
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** Form state for an existing expiration (null = never expires). */
export function expirationFromIso(iso: string | null | undefined): ExpirationValue {
  if (!iso) return { neverExpires: true, ...defaultLocalParts() }
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return { neverExpires: true, ...defaultLocalParts() }
  return {
    neverExpires: false,
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  }
}

/** Default date / time offered when switching off 「無期限」: 30 days from now, 00:00 local. */
function defaultLocalParts(): { date: string; time: string } {
  const d = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
  return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: '00:00' }
}

/** The local Date the form describes, or null when never-expiring or incomplete. */
export function expirationDate(v: ExpirationValue): Date | null {
  if (v.neverExpires || !v.date) return null
  // "YYYY-MM-DDTHH:mm" without an offset is parsed as local time.
  const d = new Date(`${v.date}T${v.time || '00:00'}`)
  return Number.isNaN(d.getTime()) ? null : d
}

/** RFC 3339 (UTC) string sent to Garage, or null. */
export function expirationIso(v: ExpirationValue): string | null {
  return expirationDate(v)?.toISOString() ?? null
}

/** e.g. "Asia/Tokyo (UTC+09:00)" for the given instant (DST-aware). */
export function describeTimeZone(at: Date = new Date()): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  const offset = -at.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const abs = Math.abs(offset)
  return `${tz} (UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)})`
}

/** Whether the form is complete enough to submit. */
export function expirationValid(v: ExpirationValue): boolean {
  return v.neverExpires || expirationDate(v) !== null
}

export function sameExpiration(a: ExpirationValue, b: ExpirationValue): boolean {
  if (a.neverExpires || b.neverExpires) return a.neverExpires === b.neverExpires
  return a.date === b.date && a.time === b.time
}
