import { describe, expect, it } from 'vitest'
import { chartChrome } from './chart-theme'

describe('chartChrome', () => {
  it('uses the dark chrome only for the dark theme', () => {
    const dark = chartChrome('dark')
    expect(dark.surface).toBe('#0a0a0a')
    expect(dark.tooltip.backgroundColor).toBe('#171717')
    expect(dark.tooltip.textStyle.color).toBe('#fafafa')
  })

  it('falls back to light for light, unknown or unresolved themes', () => {
    const light = chartChrome('light')
    expect(light.surface).toBe('#ffffff')
    expect(chartChrome(undefined)).toBe(light)
    expect(chartChrome('system')).toBe(light)
  })
})
