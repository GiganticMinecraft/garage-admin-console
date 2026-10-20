import { describe, expect, it } from 'vitest'
import { loginUrlFor } from './auth'

describe('loginUrlFor', () => {
  it('omits next for the dashboard root', () => {
    expect(loginUrlFor('/', '')).toBe('/api/auth/login')
  })

  it('keeps the path and query', () => {
    expect(loginUrlFor('/buckets/abc123', '?tab=settings')).toBe(
      '/api/auth/login?next=%2Fbuckets%2Fabc123%3Ftab%3Dsettings',
    )
  })

  it('round-trips a Japanese path as the browser reports it', () => {
    // location.pathname is already percent-encoded; the server decodes the
    // query once and gets the same encoded path back.
    const pathname = new URL('http://x/buckets/日本語のバケット').pathname
    const search = '?tab=objects&prefix=写真/'
    const url = loginUrlFor(pathname, search)
    const next = new URL(url, 'http://x').searchParams.get('next')
    expect(next).toBe(pathname + search)
    expect(url.startsWith('/api/auth/login?next=%2Fbuckets%2F%25E6')).toBe(true)
  })

  it('does not ask to return to an API path', () => {
    expect(loginUrlFor('/api/auth/login', '?next=%2F')).toBe('/api/auth/login')
    expect(loginUrlFor('/api', '')).toBe('/api/auth/login')
  })

  it('honours a different base', () => {
    expect(loginUrlFor('/keys', '', '/backend')).toBe('/backend/auth/login?next=%2Fkeys')
  })
})
