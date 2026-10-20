/**
 * Neutral "chrome" colours for ECharts (axis / label text, grid lines, the
 * surface-coloured gap between segments, tooltip box) per colour theme.
 * ECharts draws on a canvas, so it cannot read the Tailwind tokens; these
 * mirror the values in index.css (`--background`, `--popover`, `--border`,
 * `--muted-foreground`). Series colours (used / free / warn / crit) are
 * mid-tone and shared by both themes.
 */
export interface ChartChrome {
  axisText: string
  labelText: string
  gridLine: string
  /** Page background behind the chart, used as the segment border. */
  surface: string
  tooltip: {
    backgroundColor: string
    borderColor: string
    textStyle: { color: string }
  }
}

const LIGHT: ChartChrome = {
  axisText: '#71717a', // zinc-500
  labelText: '#52525b', // zinc-600
  gridLine: 'rgba(113, 113, 122, 0.2)',
  surface: '#ffffff', // --background (light)
  tooltip: {
    backgroundColor: '#ffffff', // --popover (light)
    borderColor: '#e5e5e5', // --border (light)
    textStyle: { color: '#171717' },
  },
}

const DARK: ChartChrome = {
  axisText: '#a1a1aa', // zinc-400
  labelText: '#d4d4d8', // zinc-300
  gridLine: 'rgba(161, 161, 170, 0.2)',
  surface: '#0a0a0a', // --background (dark)
  tooltip: {
    backgroundColor: '#171717', // --popover (dark)
    borderColor: '#2e2e2e', // --border (dark, 10% white over popover)
    textStyle: { color: '#fafafa' },
  },
}

/**
 * Chrome for next-themes' `resolvedTheme`. Anything other than "dark"
 * (including undefined before the theme is known) falls back to light, the
 * same as the pre-paint script in index.html.
 */
export function chartChrome(resolvedTheme: string | undefined): ChartChrome {
  return resolvedTheme === 'dark' ? DARK : LIGHT
}
