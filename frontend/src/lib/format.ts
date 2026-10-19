const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']

/** Bytes in one GiB. */
export const GIB = 1024 ** 3

/** Human-readable binary size, e.g. 1536 -> "1.50 KiB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), UNITS.length - 1)
  const v = bytes / 1024 ** i
  return `${i === 0 ? v : v.toFixed(v < 10 ? 2 : 1)} ${UNITS[i]}`
}

/** Used bytes clamped to [0, total], so an over-reporting node never shows more than 100%. */
export function clampUsed(used: number, total: number): number {
  return Math.min(Math.max(used, 0), Math.max(total, 0))
}

/** Usage as a percentage in [0, 100] (0 when total is unknown or zero). */
export function usagePercent(used: number, total: number): number {
  return total > 0 ? (clampUsed(used, total) / total) * 100 : 0
}

/** "132.8 GiB / 3.97 TiB (3.3%)", with used clamped to total. */
export function formatUsage(used: number, total: number): string {
  return `${formatBytes(clampUsed(used, total))} / ${formatBytes(total)} (${usagePercent(used, total).toFixed(1)}%)`
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
