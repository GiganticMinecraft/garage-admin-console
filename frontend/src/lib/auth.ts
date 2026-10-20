/**
 * URL of the GitHub sign-in endpoint that returns the user to
 * `pathname + search` after login. The backend re-validates `next`
 * (same-origin path, not under /api/), so this only decides what to ask for:
 * the dashboard root and API paths are sent without `next`.
 */
export function loginUrlFor(pathname: string, search: string, base = '/api'): string {
  const login = `${base}/auth/login`
  if (!pathname.startsWith('/') || pathname.startsWith('//')) return login
  if (pathname === base || pathname.startsWith(`${base}/`)) return login
  const next = pathname + search
  if (next === '/') return login
  return `${login}?next=${encodeURIComponent(next)}`
}
