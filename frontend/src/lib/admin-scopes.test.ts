import { describe, expect, it } from 'vitest'
// Golden copy of the backend's consoleScope (kept in sync by
// TestConsoleScopeGolden), so the tests below run against the list
// GET /api/admin-tokens/console-scope actually serves.
import backendConsoleScope from './console-scope.golden.json'
import {
  ALL_ADMIN_ENDPOINTS,
  ESCALATION_WARNING,
  PRIVILEGE_ESCALATION_ENDPOINTS,
  SCOPE_EXEMPT_ENDPOINTS,
  consolePresetScope,
  escalationMessage,
  scopeCoversConsole,
  scopeEscalates,
} from './admin-scopes'

describe('scopeEscalates', () => {
  it('flags *', () => {
    const r = scopeEscalates(['*'])
    expect(r.escalates).toBe(true)
    expect(r.endpoints).toEqual(['*'])
    expect(r.reason).toContain('*')
  })

  it.each(['CreateAdminToken', 'UpdateAdminToken'])('flags %s', (endpoint) => {
    const r = scopeEscalates(['ListBuckets', endpoint])
    expect(r.escalates).toBe(true)
    expect(r.endpoints).toEqual([endpoint])
    expect(r.reason).toContain(endpoint)
  })

  it('names both escalation endpoints when both are present', () => {
    const r = scopeEscalates(['UpdateAdminToken', 'CreateAdminToken'])
    expect(r.endpoints).toEqual(['CreateAdminToken', 'UpdateAdminToken'])
    expect(r.reason).toContain('CreateAdminToken / UpdateAdminToken')
  })

  it('does not flag other admin token endpoints or an empty scope', () => {
    for (const scope of [[], ['ListAdminTokens', 'GetAdminTokenInfo', 'DeleteAdminToken'], ['Metrics']]) {
      expect(scopeEscalates(scope)).toEqual({ escalates: false, reason: null, endpoints: [] })
    }
  })
})

describe('escalationMessage', () => {
  it('prefixes the shared warning to the reason', () => {
    const msg = escalationMessage(['CreateAdminToken'])
    expect(msg?.startsWith(`${ESCALATION_WARNING}。`)).toBe(true)
    expect(msg).toContain('CreateAdminToken')
  })

  it('is null for a non-escalating scope', () => {
    expect(escalationMessage(['ListBuckets'])).toBeNull()
  })
})

describe('consolePresetScope', () => {
  it('drops scope-exempt GetCurrentAdminTokenInfo', () => {
    expect(consolePresetScope(['GetCurrentAdminTokenInfo', 'ListAdminTokens'])).toEqual(['ListAdminTokens'])
  })

  it('drops * and the escalation endpoints and keeps the editor order', () => {
    expect(consolePresetScope(['UpdateAdminToken', 'ListBuckets', '*', 'GetClusterStatus', 'CreateAdminToken'])).toEqual([
      'GetClusterStatus',
      'ListBuckets',
    ])
  })

  it('appends endpoints the editor does not list, sorted', () => {
    expect(consolePresetScope(['ZNew', 'ListBuckets', 'ANew'])).toEqual(['ListBuckets', 'ANew', 'ZNew'])
  })

  describe('with the backend console scope', () => {
    const backend: string[] = backendConsoleScope
    const preset = consolePresetScope(backend)

    it('reads a non-trivial list from the backend golden file', () => {
      expect(backend.length).toBeGreaterThan(10)
      expect(backend).toContain('GetClusterHealth')
    })

    it('never contains an escalating entry', () => {
      for (const e of [...PRIVILEGE_ESCALATION_ENDPOINTS, '*']) expect(preset).not.toContain(e)
      expect(scopeEscalates(preset).escalates).toBe(false)
    })

    it('keeps every other backend endpoint', () => {
      const dropped = backend.filter((e) => !preset.includes(e))
      expect(dropped.sort()).toEqual([...PRIVILEGE_ESCALATION_ENDPOINTS, ...SCOPE_EXEMPT_ENDPOINTS].sort())
    })

    it('only uses endpoints the scope editor can show', () => {
      // An unlisted name would sit in the 「認識していないエンドポイント」 box.
      expect(preset.filter((e) => !ALL_ADMIN_ENDPOINTS.includes(e))).toEqual([])
    })

    it('covers the console', () => {
      expect(scopeCoversConsole(preset, backend)).toEqual({ covers: true, missing: [] })
    })
  })
})

describe('scopeCoversConsole', () => {
  const consoleScope = ['GetClusterHealth', 'ListBuckets', 'CreateAdminToken', 'UpdateAdminToken']

  it('treats * as covering', () => {
    expect(scopeCoversConsole(['*'], consoleScope)).toEqual({ covers: true, missing: [] })
  })

  it('does not require GetCurrentAdminTokenInfo', () => {
    expect(scopeCoversConsole(['ListBuckets', 'GetClusterHealth'], [...consoleScope, 'GetCurrentAdminTokenInfo']).covers).toBe(true)
  })

  it('does not require the escalation endpoints', () => {
    expect(scopeCoversConsole(['ListBuckets', 'GetClusterHealth'], consoleScope)).toEqual({ covers: true, missing: [] })
  })

  it('lists missing endpoints in preset order', () => {
    expect(scopeCoversConsole(['ListBuckets'], consoleScope)).toEqual({ covers: false, missing: ['GetClusterHealth'] })
    expect(scopeCoversConsole([], consoleScope)).toEqual({
      covers: false,
      missing: ['GetClusterHealth', 'ListBuckets'],
    })
  })

  it('ignores extra entries in the scope', () => {
    expect(scopeCoversConsole(['ListBuckets', 'GetClusterHealth', 'PurgeBlocks'], consoleScope).covers).toBe(true)
  })
})
