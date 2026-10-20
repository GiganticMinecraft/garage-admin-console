import { describe, expect, it } from 'vitest'
import { chartChrome } from './chart-theme'

/** Dotted paths of every leaf value, e.g. "tooltip.textStyle.color". */
function leafKeys(o: object): string[] {
  return Object.entries(o)
    .flatMap(([k, v]) => (typeof v === 'object' && v !== null ? leafKeys(v).map((s) => `${k}.${s}`) : [k]))
    .sort()
}

describe('chartChrome', () => {
  it('returns a separate chrome for the dark theme', () => {
    expect(chartChrome('dark')).not.toBe(chartChrome('light'))
  })

  it('falls back to light for unknown or unresolved themes', () => {
    const light = chartChrome('light')
    expect(chartChrome(undefined)).toBe(light)
    expect(chartChrome('system')).toBe(light)
  })

  it('returns stable objects', () => {
    expect(chartChrome('dark')).toBe(chartChrome('dark'))
    expect(chartChrome('light')).toBe(chartChrome('light'))
  })

  it('defines the same non-empty colours in both themes', () => {
    const light = chartChrome('light')
    const dark = chartChrome('dark')
    expect(leafKeys(dark)).toEqual(leafKeys(light))
    expect(Object.keys(light.free).sort()).toEqual(['data', 'meta'])
    for (const c of [light, dark]) {
      for (const key of leafKeys(c)) {
        const v = key.split('.').reduce<unknown>((o, p) => (o as Record<string, unknown>)[p], c)
        expect(typeof v === 'string' && v.length > 0, key).toBe(true)
      }
    }
  })
})
