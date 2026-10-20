import type { BucketRoutingRule } from '@/api'
import { parseRulesJson } from './rules-json'

/**
 * Validation for the website routing rules editor (Garage >= v2.3,
 * UpdateBucketWebsiteAccess.routingRules). The checks mirror what Garage
 * v2.4.1 enforces in src/api/common/xml/website.rs (RoutingRule::validate),
 * so the console reports problems per rule before Garage rejects the whole
 * request with a single "Bad XML: ..." message.
 */

/** HttpRedirectCode values Garage accepts: redirects, plus 200 / 404 rewrites. */
export const REDIRECT_CODES = [301, 302, 303, 307, 308] as const
export const REWRITE_CODES = [200, 404] as const

const CONDITION_KEYS = ['KeyPrefixEquals', 'HttpErrorCodeReturnedEquals'] as const
const REDIRECT_KEYS = ['HostName', 'Protocol', 'HttpRedirectCode', 'ReplaceKeyPrefixWith', 'ReplaceKeyWith'] as const

export const ROUTING_RULES_EXAMPLE: BucketRoutingRule[] = [
  {
    Condition: { KeyPrefixEquals: 'old/' },
    Redirect: { ReplaceKeyPrefixWith: 'new/', HttpRedirectCode: 301 },
  },
  {
    Condition: { KeyPrefixEquals: 'docs/' },
    Redirect: { HostName: 'docs.example.com', Protocol: 'https', HttpRedirectCode: 302 },
  },
]

export type RoutingRulesParseResult = { rules: BucketRoutingRule[] } | { errors: string[] }

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** Absent and null are equivalent for Garage's Option<> fields. */
function present(obj: Record<string, unknown>, key: string): boolean {
  return obj[key] !== undefined && obj[key] !== null
}

function unknownKeys(obj: Record<string, unknown>, allowed: readonly string[]): string[] {
  return Object.keys(obj).filter((k) => !allowed.includes(k))
}

function validateRule(rule: unknown, prefix: string): string[] {
  if (!isObject(rule)) return [`${prefix}: オブジェクトではありません`]
  const errors: string[] = []

  for (const k of unknownKeys(rule, ['Condition', 'Redirect'])) {
    errors.push(`${prefix}: 不明なキー "${k}" があります (Condition / Redirect のみ指定できます)`)
  }

  const cond = rule.Condition
  if (cond !== undefined && cond !== null) {
    if (!isObject(cond)) {
      errors.push(`${prefix}: Condition はオブジェクトで指定してください`)
    } else {
      for (const k of unknownKeys(cond, CONDITION_KEYS)) {
        errors.push(`${prefix}: Condition に不明なキー "${k}" があります`)
      }
      if (present(cond, 'KeyPrefixEquals') && typeof cond.KeyPrefixEquals !== 'string') {
        errors.push(`${prefix}: Condition.KeyPrefixEquals は文字列で指定してください`)
      }
      if (present(cond, 'HttpErrorCodeReturnedEquals') && cond.HttpErrorCodeReturnedEquals !== 404) {
        errors.push(`${prefix}: Condition.HttpErrorCodeReturnedEquals は 404 のみ指定できます`)
      }
    }
  }

  const redirect = rule.Redirect
  if (redirect === undefined || redirect === null) {
    errors.push(`${prefix}: Redirect は必須です`)
    return errors
  }
  if (!isObject(redirect)) {
    errors.push(`${prefix}: Redirect はオブジェクトで指定してください`)
    return errors
  }

  for (const k of unknownKeys(redirect, REDIRECT_KEYS)) {
    errors.push(`${prefix}: Redirect に不明なキー "${k}" があります`)
  }
  for (const k of ['HostName', 'Protocol', 'ReplaceKeyPrefixWith', 'ReplaceKeyWith'] as const) {
    if (present(redirect, k) && typeof redirect[k] !== 'string') {
      errors.push(`${prefix}: Redirect.${k} は文字列で指定してください`)
    }
  }
  if (typeof redirect.Protocol === 'string' && redirect.Protocol !== 'http' && redirect.Protocol !== 'https') {
    errors.push(`${prefix}: Redirect.Protocol は "http" か "https" で指定してください`)
  }
  if (present(redirect, 'ReplaceKeyPrefixWith') && present(redirect, 'ReplaceKeyWith')) {
    errors.push(`${prefix}: Redirect.ReplaceKeyPrefixWith と ReplaceKeyWith は同時に指定できません`)
  }

  if (present(redirect, 'HttpRedirectCode')) {
    const code = redirect.HttpRedirectCode
    // Type errors on these fields are reported above; only count well-typed ones.
    const hasHost = typeof redirect.HostName === 'string'
    const hasProtocol = typeof redirect.Protocol === 'string'
    if ((REDIRECT_CODES as readonly unknown[]).includes(code)) {
      if (hasProtocol && !hasHost) {
        errors.push(`${prefix}: Redirect.Protocol を指定する場合は HostName も指定してください`)
      }
    } else if ((REWRITE_CODES as readonly unknown[]).includes(code)) {
      if (hasHost || hasProtocol) {
        errors.push(`${prefix}: HttpRedirectCode が ${String(code)} のときは HostName / Protocol を指定できません`)
      }
    } else {
      errors.push(
        `${prefix}: Redirect.HttpRedirectCode は ${REDIRECT_CODES.join(' / ')} (リダイレクト) か ` +
          `${REWRITE_CODES.join(' / ')} (書き換え) で指定してください`,
      )
    }
  }

  return errors
}

/**
 * Parses the routing rules textarea. Blank text means "no rules" ([]).
 * Returns every problem found, one message per line, so the user can fix
 * them all at once. Garage's admin UpdateBucket checks each rule but sets no
 * limit on their number (that limit is only on the S3 PutBucketWebsite path),
 * so the console does not limit it either.
 */
export function parseRoutingRules(text: string): RoutingRulesParseResult {
  const parsed = parseRulesJson(text)
  if ('error' in parsed) return { errors: [parsed.error] }
  const errors = parsed.rules.flatMap((rule, i) => validateRule(rule, `${i + 1} 番目のルール`))
  return errors.length > 0 ? { errors } : { rules: parsed.rules as unknown as BucketRoutingRule[] }
}
