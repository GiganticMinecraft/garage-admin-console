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

