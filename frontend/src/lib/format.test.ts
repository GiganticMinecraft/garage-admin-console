import { describe, expect, it } from 'vitest'
import { formatBytes, formatCount, formatUsage, shortId } from './format'

describe('formatBytes', () => {
  it('renders bytes with binary units', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.50 KiB')
    expect(formatBytes(132.7 * 1024 ** 3)).toBe('132.7 GiB')
  })

  it('treats negative and non-finite input as zero', () => {
    expect(formatBytes(-1)).toBe('0 B')
    expect(formatBytes(Number.NaN)).toBe('0 B')
  })
})

describe('formatUsage', () => {
  it('clamps used to total so a node never exceeds 100%', () => {
    expect(formatUsage(2048, 1024)).toBe('1.00 KiB / 1.00 KiB (100.0%)')
  })

  it('reports 0% when total is unknown', () => {
    expect(formatUsage(10, 0)).toBe('0 B / 0 B (0.0%)')
  })
})

describe('shortId', () => {
  it('truncates long hex IDs to 16 characters', () => {
    expect(shortId('3ee8c1b72abe1971ccf6f6bc6ac890d7')).toBe('3ee8c1b72abe1971…')
    expect(shortId('5bc3f0bc926151c5')).toBe('5bc3f0bc926151c5')
  })
})

describe('formatCount', () => {
  it('adds thousands separators and renders unknown as "-"', () => {
    expect(formatCount(1145231)).toBe('1,145,231')
    expect(formatCount(null)).toBe('-')
  })
})
