import { describe, expect, it } from 'vitest'
import { MAX_ROUTING_RULES, ROUTING_RULES_EXAMPLE, parseRoutingRules } from './website-routing-rules'

function errorsOf(value: unknown): string[] {
  const r = parseRoutingRules(JSON.stringify(value))
  return 'errors' in r ? r.errors : []
}

describe('parseRoutingRules', () => {
  it('treats blank text as no rules', () => {
    expect(parseRoutingRules('')).toEqual({ rules: [] })
    expect(parseRoutingRules('  \n')).toEqual({ rules: [] })
    expect(parseRoutingRules('[]')).toEqual({ rules: [] })
  })

  it('accepts the inserted example', () => {
    expect(parseRoutingRules(JSON.stringify(ROUTING_RULES_EXAMPLE))).toEqual({ rules: ROUTING_RULES_EXAMPLE })
  })

  it('accepts what Garage returns (null Condition, filled HttpRedirectCode)', () => {
    const rules = [
      { Condition: null, Redirect: { ReplaceKeyWith: 'index.html', HttpRedirectCode: 302 } },
      { Condition: { KeyPrefixEquals: 'a/' }, Redirect: { ReplaceKeyPrefixWith: 'b/', HttpRedirectCode: 302 } },
    ]
    expect(parseRoutingRules(JSON.stringify(rules))).toEqual({ rules })
  })

  it('allows Condition to be omitted and HttpRedirectCode to be absent', () => {
    expect(errorsOf([{ Redirect: { ReplaceKeyWith: 'x.html' } }])).toEqual([])
    expect(errorsOf([{ Condition: {}, Redirect: {} }])).toEqual([])
  })

  it('reports JSON syntax errors', () => {
    const r = parseRoutingRules('[{')
    expect('errors' in r && r.errors[0]).toMatch(/^JSON の構文エラー/)
  })

  it('requires an array', () => {
    expect(errorsOf({ Redirect: {} })).toEqual(['ルーティングルールは JSON 配列 ([...]) で指定してください'])
  })

  it('requires each element to be an object with Redirect', () => {
    expect(errorsOf([1, null, {}, { Redirect: 'x' }])).toEqual([
      '1 番目のルール: オブジェクトではありません',
      '2 番目のルール: オブジェクトではありません',
      '3 番目のルール: Redirect は必須です',
      '4 番目のルール: Redirect はオブジェクトで指定してください',
    ])
  })

  it('rejects unknown keys (typos would be silently dropped by Garage)', () => {
    expect(
      errorsOf([{ Conditon: {}, Condition: { KeyPrefix: 'a/' }, Redirect: { HostName: 'h', Hostname: 'h' } }]),
    ).toEqual([
      '1 番目のルール: 不明なキー "Conditon" があります (Condition / Redirect のみ指定できます)',
      '1 番目のルール: Condition に不明なキー "KeyPrefix" があります',
      '1 番目のルール: Redirect に不明なキー "Hostname" があります',
    ])
  })

  it('checks Condition fields', () => {
    expect(errorsOf([{ Condition: [], Redirect: {} }])).toEqual([
      '1 番目のルール: Condition はオブジェクトで指定してください',
    ])
    expect(errorsOf([{ Condition: { KeyPrefixEquals: 1, HttpErrorCodeReturnedEquals: 403 }, Redirect: {} }])).toEqual([
      '1 番目のルール: Condition.KeyPrefixEquals は文字列で指定してください',
      '1 番目のルール: Condition.HttpErrorCodeReturnedEquals は 404 のみ指定できます',
    ])
    expect(errorsOf([{ Condition: { HttpErrorCodeReturnedEquals: 404 }, Redirect: {} }])).toEqual([])
  })

  it('checks Protocol', () => {
    expect(errorsOf([{ Redirect: { HostName: 'h', Protocol: 'ftp' } }])).toEqual([
      '1 番目のルール: Redirect.Protocol は "http" か "https" で指定してください',
    ])
    expect(errorsOf([{ Redirect: { HostName: 'h', Protocol: 'http' } }])).toEqual([])
  })

  it('checks string fields', () => {
    expect(errorsOf([{ Redirect: { HostName: 1, ReplaceKeyWith: true } }])).toEqual([
      '1 番目のルール: Redirect.HostName は文字列で指定してください',
      '1 番目のルール: Redirect.ReplaceKeyWith は文字列で指定してください',
    ])
  })

  it('rejects ReplaceKeyPrefixWith together with ReplaceKeyWith', () => {
    expect(errorsOf([{ Redirect: { ReplaceKeyPrefixWith: 'a/', ReplaceKeyWith: 'b' } }])).toEqual([
      '1 番目のルール: Redirect.ReplaceKeyPrefixWith と ReplaceKeyWith は同時に指定できません',
    ])
  })

  it('checks HttpRedirectCode', () => {
    for (const code of [301, 302, 303, 307, 308, 200, 404]) {
      expect(errorsOf([{ Redirect: { HttpRedirectCode: code } }])).toEqual([])
    }
    for (const code of [300, 304, 305, 500, '301', 301.5]) {
      expect(errorsOf([{ Redirect: { HttpRedirectCode: code } }])).toEqual([
        '1 番目のルール: Redirect.HttpRedirectCode は 301 / 302 / 303 / 307 / 308 (リダイレクト) か 200 / 404 (書き換え) で指定してください',
      ])
    }
  })

  it('requires HostName with Protocol on a redirect code', () => {
    expect(errorsOf([{ Redirect: { Protocol: 'https', HttpRedirectCode: 301 } }])).toEqual([
      '1 番目のルール: Redirect.Protocol を指定する場合は HostName も指定してください',
    ])
  })

  it('forbids HostName / Protocol on a rewrite code', () => {
    expect(errorsOf([{ Redirect: { HostName: 'h', HttpRedirectCode: 200 } }])).toEqual([
      '1 番目のルール: HttpRedirectCode が 200 のときは HostName / Protocol を指定できません',
    ])
  })

  it('collects errors across rules', () => {
    expect(errorsOf([{ Redirect: {} }, {}, { Redirect: { Protocol: 'ftp', HostName: 'h' } }])).toEqual([
      '2 番目のルール: Redirect は必須です',
      '3 番目のルール: Redirect.Protocol は "http" か "https" で指定してください',
    ])
  })

  it('limits the number of rules', () => {
    const rules = Array.from({ length: MAX_ROUTING_RULES + 1 }, () => ({ Redirect: {} }))
    expect(errorsOf(rules)).toEqual([`ルーティングルールは ${MAX_ROUTING_RULES} 件までです (現在 ${MAX_ROUTING_RULES + 1} 件)`])
  })
})
