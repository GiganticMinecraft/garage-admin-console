const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']

/** Human-readable binary size, e.g. 1536 -> "1.50 KiB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), UNITS.length - 1)
  const v = bytes / 1024 ** i
  return `${i === 0 ? v : v.toFixed(v < 10 ? 2 : 1)} ${UNITS[i]}`
}

const dateTimeFormat = new Intl.DateTimeFormat('ja-JP', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
})

/** Formats an ISO timestamp as a local "YYYY/MM/DD HH:mm" (or '-' when absent). */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '-'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : dateTimeFormat.format(d)
}

/** Shortens a long hex ID (bucket ID, access key ID) to its first 16 characters + "…". */
export function shortId(id: string): string {
  return id.length > 16 ? `${id.slice(0, 16)}…` : id
}

/** Formats a count with thousands separators (or '-' when unknown). */
export function formatCount(n: number | null | undefined): string {
  return n === null || n === undefined ? '-' : n.toLocaleString('ja-JP')
}
