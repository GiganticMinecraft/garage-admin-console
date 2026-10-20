import { useTheme } from 'next-themes'

/** Partition kind a chart series belongs to. */
export type PartitionKind = 'data' | 'meta'

/**
 * Theme-dependent colours for ECharts: the neutral "chrome" (axis / label
 * text, grid lines, the surface-coloured gap between segments, tooltip box)
 * and the free-space step of each partition hue. ECharts draws on a canvas
 * and cannot read the Tailwind tokens, so the token-backed values below are
 * hex conversions of index.css. The used-space and warn / crit colours are
 * mid-tone and stay the same in both themes (see storage-charts.tsx).
 */
export interface ChartChrome {
  /** `--muted-foreground`. */
  axisText: string
  /**
   * End-of-bar value labels. Intentionally independent of the tokens: one
   * step stronger than `--muted-foreground` so the numbers stand out from
   * the axis text.
   */
  labelText: string
  /** `--muted-foreground` at 20% alpha. */
  gridLine: string
  /** `--background`, used as the border between touching segments. */
  surface: string
  /**
   * Free-space colour per partition kind: a light step of the hue on the
   * light background, a dark step on the dark one, so free space always
   * reads as secondary to the saturated "used" colour.
   */
  free: Record<PartitionKind, string>
  /** `--popover` / `--border` / `--popover-foreground`. */
  tooltip: {
    backgroundColor: string
    borderColor: string
    textStyle: { color: string }
  }
}

const LIGHT: ChartChrome = {
  axisText: '#737373', // oklch(0.556 0 0)
  labelText: '#525252', // neutral-600
  gridLine: 'rgba(115, 115, 115, 0.2)',
  surface: '#ffffff', // oklch(1 0 0)
  free: { data: '#bfdbfe', meta: '#e9d5ff' }, // blue-200 / purple-200
  tooltip: {
    backgroundColor: '#ffffff', // oklch(1 0 0)
    borderColor: '#e5e5e5', // oklch(0.922 0 0)
    textStyle: { color: '#0a0a0a' }, // oklch(0.145 0 0)
  },
}

const DARK: ChartChrome = {
  axisText: '#a1a1a1', // oklch(0.708 0 0)
  labelText: '#d4d4d4', // neutral-300
  gridLine: 'rgba(161, 161, 161, 0.2)',
  surface: '#0a0a0a', // oklch(0.145 0 0)
  free: { data: '#1e3a8a', meta: '#581c87' }, // blue-900 / purple-900
  tooltip: {
    backgroundColor: '#171717', // oklch(0.205 0 0)
    borderColor: '#2e2e2e', // oklch(1 0 0 / 10%) over the popover
    textStyle: { color: '#fafafa' }, // oklch(0.985 0 0)
  },
}

/**
 * Chrome for next-themes' `resolvedTheme`. Anything other than "dark"
 * (including undefined before the theme is known) falls back to light, the
 * same as the pre-paint script in index.html. Returns one of two stable
 * objects, so it is safe as a memo dependency.
 */
export function chartChrome(resolvedTheme: string | undefined): ChartChrome {
  return resolvedTheme === 'dark' ? DARK : LIGHT
}

/** Chart chrome for the current colour theme. */
export function useChartChrome(): ChartChrome {
  const { resolvedTheme } = useTheme()
  return chartChrome(resolvedTheme)
}
