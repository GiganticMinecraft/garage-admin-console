/**
 * Garage admin API v2 endpoint names that can appear in an admin token's
 * scope, grouped for the scope editor. Taken from Garage's
 * `src/api/admin/router_v2.rs` on main-v2 (post v2.4.1): everything listed
 * exists in v2.4.1 except the entries marked "v2.5+", which a v2.4.1 cluster
 * simply never matches. Garage stores the scope as a plain list of endpoint
 * names, or the special value `*` for every endpoint.
 */
export interface AdminScopeCategory {
  label: string
  endpoints: readonly string[]
}

/** The special scope value granting every admin endpoint. */
export const ALL_SCOPE = '*'

export const ADMIN_SCOPE_CATEGORIES: readonly AdminScopeCategory[] = [
  {
    label: 'Cluster',
    endpoints: ['GetClusterStatus', 'GetClusterHealth', 'GetClusterStatistics', 'ConnectClusterNodes'],
  },
  {
    label: 'Layout',
    endpoints: [
      'GetClusterLayout',
      'GetClusterLayoutHistory',
      'UpdateClusterLayout',
      'PreviewClusterLayoutChanges',
      'ApplyClusterLayout',
      'RevertClusterLayout',
      'ClusterLayoutSkipDeadNodes',
    ],
  },
  {
    label: 'Buckets',
    endpoints: [
      'ListBuckets',
      'ListBucketsInfo', // v2.5+
      'GetBucketInfo',
      'CreateBucket',
      'UpdateBucket',
      'DeleteBucket',
      'CleanupIncompleteUploads',
      'InspectObject',
      'AddBucketAlias',
      'RemoveBucketAlias',
      'AllowBucketKey',
      'DenyBucketKey',
    ],
  },
  {
    label: 'Keys',
    endpoints: [
      'ListKeys',
      'ListKeysInfo', // v2.5+
      'GetKeyInfo',
      'CreateKey',
      'ImportKey',
      'UpdateKey',
      'DeleteKey',
    ],
  },
  {
    label: 'Admin tokens',
    endpoints: [
      'ListAdminTokens',
      'GetAdminTokenInfo',
      'CreateAdminToken',
      'UpdateAdminToken',
      'DeleteAdminToken',
      'GetCurrentAdminTokenInfo',
    ],
  },
  {
    label: 'Nodes & maintenance',
    endpoints: ['GetNodeInfo', 'GetNodeStatistics', 'CreateMetadataSnapshot', 'LaunchRepairOperation'],
  },
  {
    label: 'Blocks',
    endpoints: ['ListBlockErrors', 'GetBlockInfo', 'RetryBlockResync', 'PurgeBlocks'],
  },
  {
    label: 'Workers',
    endpoints: ['ListWorkers', 'GetWorkerInfo', 'GetWorkerVariable', 'SetWorkerVariable'],
  },
  {
    // /metrics accepts an admin token whose scope contains "Metrics".
    label: 'Special',
    endpoints: ['Metrics'],
  },
]

export const ALL_ADMIN_ENDPOINTS: readonly string[] = ADMIN_SCOPE_CATEGORIES.flatMap((c) => c.endpoints)

/** Endpoints that do not exist on Garage v2.4.1 (the production version), with the version that added them. */
export const ENDPOINT_MIN_VERSION: Readonly<Record<string, string>> = {
  ListBucketsInfo: 'v2.5+',
  ListKeysInfo: 'v2.5+',
}

/**
 * Endpoints that let a token mint or widen tokens; Garage documents that
 * granting them is functionally equivalent to `*`.
 */
export const PRIVILEGE_ESCALATION_ENDPOINTS: readonly string[] = ['CreateAdminToken', 'UpdateAdminToken']

export function isFullScope(scope: readonly string[]): boolean {
  return scope.includes(ALL_SCOPE)
}

/** How many of the endpoints this console knows are in an explicit scope. */
export function knownScopeCount(scope: readonly string[]): number {
  return ALL_ADMIN_ENDPOINTS.filter((e) => scope.includes(e)).length
}

/** 「すべて」 for `*`, otherwise "x/N" over the known endpoints. */
export function scopeLabel(scope: readonly string[]): string {
  if (isFullScope(scope)) return 'すべて'
  return `${knownScopeCount(scope)}/${ALL_ADMIN_ENDPOINTS.length}`
}

/** Sort key: `*` ranks above every explicit list. */
export function scopeScore(scope: readonly string[]): number {
  return isFullScope(scope) ? Number.MAX_SAFE_INTEGER : scope.length
}

/** Scope entries Garage holds that this console does not know (kept as-is on save). */
export function unknownScopeEntries(scope: readonly string[]): string[] {
  const known = new Set(ALL_ADMIN_ENDPOINTS)
  return scope.filter((s) => s !== ALL_SCOPE && !known.has(s))
}

/** Order-insensitive scope equality, for dirty tracking. */
export function sameScope(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(a)
  return b.every((s) => set.has(s))
}

/** Heading of the escalation warning shown in the scope editor and on create / update confirmation. */
export const ESCALATION_WARNING = 'このスコープは * と同等の権限になります'

export interface ScopeEscalation {
  escalates: boolean
  /** Why the scope is equivalent to `*` (null when it is not). */
  reason: string | null
  /** The escalating entries present: `*` and / or the PRIVILEGE_ESCALATION_ENDPOINTS. */
  endpoints: string[]
}

/**
 * Whether a scope is (or can make itself) equivalent to `*`: `*` itself, or
 * CreateAdminToken / UpdateAdminToken, with which the token can mint a `*`
 * token or widen its own scope.
 */
export function scopeEscalates(scope: readonly string[]): ScopeEscalation {
  if (isFullScope(scope)) {
    return {
      escalates: true,
      reason: 'すべてのエンドポイント(*)を許可しています。',
      endpoints: [ALL_SCOPE],
    }
  }
  const endpoints = PRIVILEGE_ESCALATION_ENDPOINTS.filter((e) => scope.includes(e))
  if (endpoints.length === 0) return { escalates: false, reason: null, endpoints: [] }
  return {
    escalates: true,
    reason: `${endpoints.join(' / ')} を許可したトークンは、* のトークンを作成したり自分のスコープを広げたりできます。`,
    endpoints,
  }
}

/** `ESCALATION_WARNING` plus the reason, as one message for confirmation dialogs. */
export function escalationMessage(scope: readonly string[]): string | null {
  const { reason } = scopeEscalates(scope)
  return reason === null ? null : `${ESCALATION_WARNING}。${reason}`
}

/**
 * The 「コンソール用スコープ」 preset: what the console backend calls
 * (`GET /api/admin-tokens/console-scope`) minus `*` and the escalation
 * endpoints, so the preset never amounts to `*`. Known endpoints keep the
 * editor's category order; names the editor does not list come last, sorted.
 * A token with this scope cannot create admin tokens or change their settings
 * from the console.
 */
export function consolePresetScope(consoleScope: readonly string[]): string[] {
  const wanted = new Set(
    consoleScope.filter((e) => e !== ALL_SCOPE && !PRIVILEGE_ESCALATION_ENDPOINTS.includes(e)),
  )
  const known = ALL_ADMIN_ENDPOINTS.filter((e) => wanted.has(e))
  const knownSet = new Set(known)
  const rest = [...wanted].filter((e) => !knownSet.has(e)).sort()
  return [...known, ...rest]
}

export interface ConsoleCoverage {
  covers: boolean
  /** Preset endpoints the scope lacks, in preset order. */
  missing: string[]
}

/**
 * Whether a scope grants everything in the console preset
 * (`consolePresetScope(consoleScope)`); `*` always does. The escalation
 * endpoints are not required: the preset leaves them out on purpose.
 */
export function scopeCoversConsole(scope: readonly string[], consoleScope: readonly string[]): ConsoleCoverage {
  if (isFullScope(scope)) return { covers: true, missing: [] }
  const have = new Set(scope)
  const missing = consolePresetScope(consoleScope).filter((e) => !have.has(e))
  return { covers: missing.length === 0, missing }
}

