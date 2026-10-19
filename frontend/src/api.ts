const BASE = '/api'

/** Error thrown for non-2xx API responses, carrying the upstream message. */
export class ApiError extends Error {
  status: number
  /** Garage error code such as "BucketNotEmpty", when the upstream returned one. */
  code?: string

  constructor(status: number, message: string, code?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

/**
 * Builds an ApiError from a failed response. Garage Admin API errors are JSON
 * objects like {"code":"BucketNotEmpty","message":"..."}; the Go backend's own
 * errors are either {"error":"..."} or plain text. Fall back to the status.
 */
export async function errorFromResponse(res: Response): Promise<ApiError> {
  let message = ''
  let code: string | undefined
  try {
    const text = await res.text()
    if (text) {
      try {
        const parsed: unknown = JSON.parse(text)
        if (parsed && typeof parsed === 'object') {
          const body = parsed as { code?: unknown; message?: unknown; error?: unknown }
          if (typeof body.message === 'string') message = body.message
          else if (typeof body.error === 'string') message = body.error
          if (typeof body.code === 'string') code = body.code
        } else {
          message = text.trim()
        }
      } catch {
        message = text.trim()
      }
    }
  } catch {
    // body unreadable; keep the status-only message below
  }
  if (!message) message = `API error: ${res.status}`
  return new ApiError(res.status, message, code)
}

/**
 * Shared policy for every API response: a 401 sends the browser to login
 * (the root layout string-matches 'Unauthorized'), any other non-2xx becomes
 * an ApiError with the upstream message.
 */
async function assertOk(res: Response): Promise<void> {
  if (res.status === 401) {
    window.location.href = `${BASE}/auth/login`
    throw new Error('Unauthorized')
  }
  if (!res.ok) throw await errorFromResponse(res)
}

export async function fetchJSON<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  headers.set('X-Requested-With', 'XMLHttpRequest')

  const res = await fetch(`${BASE}${path}`, { ...init, headers })
  await assertOk(res)
  if (res.status === 204 || res.headers.get('Content-Length') === '0') {
    return undefined as T
  }
  const contentType = res.headers.get('Content-Type') ?? ''
  if (contentType.includes('application/json')) {
    return res.json()
  }
  return (await res.text()) as T
}

export async function fetchMe(): Promise<{ username: string; avatar_url: string }> {
  return fetchJSON('/auth/me')
}

export async function logout(): Promise<void> {
  await fetchJSON('/auth/logout', { method: 'POST' })
}

// Cluster
export interface ClusterHealth {
  status: string
  knownNodes: number
  connectedNodes: number
  storageNodes: number
  storageNodesUp: number
  partitions: number
  partitionsQuorum: number
  partitionsAllOk: number
}

export interface PartitionUsage {
  available: number
  total: number
}

// Mirrors Garage's NodeResp: role and hostname are Option<_> upstream and come
// back as null for nodes that are down or have no role assigned yet. The
// partition stats are Option<_> with skip_serializing_if, so the keys are
// omitted entirely (undefined) rather than null. Keep them optional so the UI
// is forced to handle it. `draining` is only ever true when `role` is null
// (the node was removed from the layout but still holds data).
export interface ClusterNode {
  id: string
  garageVersion: string | null
  addr: string | null
  hostname: string | null
  isUp: boolean
  lastSeenSecsAgo: number | null
  role: {
    zone: string
    tags: string[]
    capacity: number | null
  } | null
  draining: boolean
  dataPartition?: PartitionUsage | null
  metadataPartition?: PartitionUsage | null
}

export interface ClusterStatus {
  layoutVersion: number
  nodes: ClusterNode[]
}

export async function getClusterHealth(): Promise<ClusterHealth> {
  return fetchJSON('/cluster/health')
}

export async function getClusterStatus(): Promise<ClusterStatus> {
  return fetchJSON('/cluster/status')
}

// Cluster layout (mirrors Garage's GetClusterLayoutResponse)
export interface LayoutNodeRole {
  id: string
  zone: string
  tags: string[]
  /** null for gateway nodes */
  capacity: number | null
  storedPartitions: number | null
  usableCapacity: number | null
}

export type ZoneRedundancy = 'maximum' | { atLeast: number }

export interface LayoutParameters {
  zoneRedundancy: ZoneRedundancy
}

/** A staged change: either a new/updated role or a removal. */
export type NodeRoleChange =
  | { id: string; remove: true }
  | { id: string; zone: string; tags: string[]; capacity: number | null }

export interface ClusterLayout {
  version: number
  roles: LayoutNodeRole[]
  parameters: LayoutParameters
  partitionSize: number
  stagedRoleChanges: NodeRoleChange[]
  stagedParameters: LayoutParameters | null
}

export interface LayoutPreview {
  message: string[]
  newLayout: ClusterLayout
}

export interface LayoutApplyResult {
  message: string[]
  layout: ClusterLayout
}

export async function getClusterLayout(): Promise<ClusterLayout> {
  return fetchJSON('/cluster/layout')
}

/** Stage role/parameter changes (Garage UpdateClusterLayout). Nothing is applied yet. */
export async function stageLayout(body: {
  roles?: NodeRoleChange[]
  parameters?: LayoutParameters
}): Promise<ClusterLayout> {
  return fetchJSON('/cluster/layout/stage', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

/** Compute what the staged changes would produce, without applying them. */
export async function previewLayout(): Promise<LayoutPreview> {
  const res = await fetchJSON<LayoutPreview | { error: string }>('/cluster/layout/preview', {
    method: 'POST',
    body: '{}',
  })
  // Garage returns 200 with {"error": "..."} when the layout cannot be computed.
  if ('error' in res) throw new ApiError(200, res.error)
  return res
}

/** Commit staged changes. `version` must be the current layout version + 1. */
export async function applyLayout(version: number): Promise<LayoutApplyResult> {
  return fetchJSON('/cluster/layout/apply', {
    method: 'POST',
    body: JSON.stringify({ version }),
  })
}

/** Discard all staged changes. */
export async function revertLayout(): Promise<void> {
  await fetchJSON('/cluster/layout/revert', { method: 'POST', body: '{}' })
}

// Buckets
export interface BucketListItem {
  id: string
  globalAliases?: string[]
  localAliases?: { alias: string; accessKeyId: string }[]
}

export async function listBuckets(): Promise<BucketListItem[]> {
  return fetchJSON('/buckets')
}

export async function getBucket(id: string): Promise<Record<string, unknown>> {
  return fetchJSON(`/buckets/${id}`)
}

export async function createBucket(body: unknown): Promise<Record<string, unknown>> {
  return fetchJSON('/buckets', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function updateBucket(id: string, body: unknown): Promise<Record<string, unknown>> {
  return fetchJSON(`/buckets/${id}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  })
}

export async function deleteBucket(id: string): Promise<void> {
  await fetchJSON(`/buckets/${id}`, { method: 'DELETE' })
}

export async function grantBucketKey(
  bucketId: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  return fetchJSON(`/buckets/${bucketId}/keys`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function revokeBucketKey(bucketId: string, keyId: string): Promise<void> {
  await fetchJSON(`/buckets/${bucketId}/keys/${keyId}`, { method: 'DELETE' })
}

// Keys
export interface KeyListItem {
  id: string
  name: string
  created: string
  expiration: string | null
  expired: boolean
}

export async function listKeys(): Promise<KeyListItem[]> {
  return fetchJSON('/keys')
}

export async function getKey(id: string): Promise<Record<string, unknown>> {
  return fetchJSON(`/keys/${id}`)
}

export async function createKey(body: unknown): Promise<Record<string, unknown>> {
  return fetchJSON('/keys', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function updateKey(id: string, body: unknown): Promise<Record<string, unknown>> {
  return fetchJSON(`/keys/${id}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  })
}

export async function deleteKey(id: string): Promise<void> {
  await fetchJSON(`/keys/${id}`, { method: 'DELETE' })
}

// Objects
export interface ObjectListResult {
  objects: { key: string; size: number; lastModified: string }[]
  prefixes: string[]
  isTruncated: boolean
  nextContinuationToken?: string
}

export async function listObjects(
  bucket: string,
  prefix?: string,
  continuationToken?: string,
): Promise<ObjectListResult> {
  const params = new URLSearchParams()
  if (prefix) params.set('prefix', prefix)
  if (continuationToken) params.set('continuation-token', continuationToken)
  const qs = params.toString()
  return fetchJSON(`/objects/${bucket}/list${qs ? '?' + qs : ''}`)
}

export function downloadObjectUrl(bucket: string, key: string): string {
  return `${BASE}/objects/${bucket}/download?key=${encodeURIComponent(key)}`
}

export function batchDownloadUrl(bucket: string, keys: string[]): string {
  const params = keys.map((k) => `key=${encodeURIComponent(k)}`).join('&')
  return `${BASE}/objects/${bucket}/batch-download?${params}`
}

export async function downloadObjectsZip(bucket: string, keys: string[]): Promise<void> {
  const a = document.createElement('a')
  a.href = batchDownloadUrl(bucket, keys)
  a.download = `${bucket}-files.zip`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}

export async function uploadFile(bucket: string, file: File, prefix?: string): Promise<{ key: string }> {
  const form = new FormData()
  form.append('file', file)
  if (prefix) {
    const keyPrefix = prefix.endsWith('/') ? prefix : `${prefix}/`
    form.append('key', keyPrefix + file.name)
  }
  const res = await fetch(`${BASE}/objects/${bucket}/upload`, {
    method: 'POST',
    headers: { 'X-Requested-With': 'XMLHttpRequest' },
    body: form,
  })
  await assertOk(res)
  return res.json()
}

export async function deleteObject(bucket: string, key: string): Promise<void> {
  await fetchJSON(`/objects/${bucket}?key=${encodeURIComponent(key)}`, {
    method: 'DELETE',
  })
}

// Workers
// Garage's worker state serializes as a string ("idle" / "busy" / "done") for
// simple variants, but throttled is an object: { throttled: "<duration>" }.
export type WorkerState = string | { throttled: string }

export interface Worker {
  id: number
  name: string
  state: WorkerState
  errors: number
  consecutiveErrors: number
  lastError: { message: string; secsAgo: number } | null
  tranquility: number | null
  progress: number | null
  queueLength: number | null
  persistentErrors: number | null
  freeform: string[]
}

export async function listWorkers(): Promise<Worker[]> {
  return fetchJSON('/workers')
}

// Multi-node response wrapper
export interface MultiResponse<T> {
  success: Record<string, T>
  error: Record<string, string>
}

// Blocks
export interface BlockError {
  nodeId: string
  blockHash: string
  refcount: number
  errorCount: number
  lastTrySecsAgo: number
  nextTryInSecs: number
}

export type BlockVersionBacklink =
  | { object: { bucketId: string; key: string } }
  | { upload: {
      bucketId?: string | null
      key?: string | null
      uploadId: string
      uploadDeleted: boolean
      uploadGarbageCollected: boolean
    } }

export interface BlockVersion {
  versionId: string
  refDeleted: boolean
  versionDeleted: boolean
  garbageCollected: boolean
  backlink?: BlockVersionBacklink | null
}

export interface BlockInfo {
  blockHash: string
  refcount: number
  versions: BlockVersion[]
}

export interface PurgeBlocksResult {
  blocksPurged: number
  objectsDeleted: number
  uploadsDeleted: number
  versionsDeleted: number
}

export async function listBlockErrors(): Promise<BlockError[]> {
  return fetchJSON('/blocks/errors')
}

export async function getBlockInfo(blockHash: string): Promise<MultiResponse<BlockInfo>> {
  return fetchJSON('/blocks/info', {
    method: 'POST',
    body: JSON.stringify({ blockHash }),
  })
}

export async function purgeBlocks(blockHashes: string[]): Promise<MultiResponse<PurgeBlocksResult>> {
  return fetchJSON('/blocks/purge', {
    method: 'POST',
    body: JSON.stringify(blockHashes),
  })
}

export async function retryBlockResync(
  body: { all: true } | { blockHashes: string[] },
): Promise<MultiResponse<{ count: number }>> {
  return fetchJSON('/blocks/resync', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

// Repair
export type ScrubCommand = 'start' | 'pause' | 'resume' | 'cancel'

export type RepairType =
  | 'tables'
  | 'blocks'
  | 'versions'
  | 'multipartUploads'
  | 'blockRefs'
  | 'blockRc'
  | 'rebalance'
  | 'aliases'
  | 'clearResyncQueue'
  | { scrub: ScrubCommand }

export async function launchRepair(
  repairType: RepairType,
): Promise<MultiResponse<Record<string, never>>> {
  return fetchJSON('/repair', {
    method: 'POST',
    body: JSON.stringify({ repairType }),
  })
}

// Maintenance metrics (extracted from Garage /metrics)
export interface MaintenanceMetrics {
  resyncQueueLength: number
  resyncErroredBlocks: number
  corruptionCounter: number
}

export async function getMaintenanceMetrics(): Promise<MaintenanceMetrics> {
  return fetchJSON('/metrics')
}
