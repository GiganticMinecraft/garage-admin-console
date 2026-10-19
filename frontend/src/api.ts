const BASE = '/api'

export async function fetchJSON<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  headers.set('X-Requested-With', 'XMLHttpRequest')

  const res = await fetch(`${BASE}${path}`, { ...init, headers })
  if (res.status === 401) {
    window.location.href = `${BASE}/auth/login`
    throw new Error('Unauthorized')
  }
  if (!res.ok) throw new Error(`API error: ${res.status}`)
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

export interface ClusterNode {
  id: string
  garageVersion: string
  addr: string
  hostname: string
  isUp: boolean
  lastSeenSecsAgo: number | null
  role: {
    zone: string
    tags: string[]
    capacity: number
  }
  draining: boolean
  dataPartition: { available: number; total: number }
  metadataPartition: { available: number; total: number }
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

export async function getClusterLayout(): Promise<Record<string, unknown>> {
  return fetchJSON('/cluster/layout')
}

export async function applyLayout(body: unknown): Promise<Record<string, unknown>> {
  return fetchJSON('/cluster/layout', {
    method: 'POST',
    body: JSON.stringify(body),
  })
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

export interface KeyDetail {
  accessKeyId: string
  name: string
  created: string
  expiration: string | null
  expired: boolean
  /** Only present when requested with showSecretKey (or right after creation). */
  secretAccessKey?: string
  permissions: { createBucket: boolean }
  buckets: {
    id: string
    globalAliases: string[]
    localAliases: string[]
    permissions: { read: boolean; write: boolean; owner: boolean }
  }[]
}

export async function getKey(id: string, opts?: { showSecretKey?: boolean }): Promise<KeyDetail> {
  const qs = opts?.showSecretKey ? '?showSecretKey=true' : ''
  return fetchJSON(`/keys/${id}${qs}`)
}

export async function createKey(body: { name: string }): Promise<KeyDetail> {
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

export function batchDownloadUrl(bucket: string, keys: string[], name?: string): string {
  const params = keys.map((k) => `key=${encodeURIComponent(k)}`)
  if (name) params.push(`name=${encodeURIComponent(name)}`)
  return `${BASE}/objects/${bucket}/batch-download?${params.join('&')}`
}

// `name` is the bucket alias used for the ZIP filename; `bucket` is the ID
// used for the S3 request.
export async function downloadObjectsZip(bucket: string, keys: string[], name?: string): Promise<void> {
  const a = document.createElement('a')
  a.href = batchDownloadUrl(bucket, keys, name)
  a.download = `${name || bucket}-files.zip`
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
  if (!res.ok) throw new Error(`Upload error: ${res.status}`)
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
  /** ID of the node this worker runs on (worker ids are per-node counters). */
  nodeId: string
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

export interface WorkersResponse {
  workers: Worker[]
  /** Nodes that failed to answer ListWorkers, keyed by node ID. */
  errors: Record<string, string>
}

export async function listWorkers(): Promise<WorkersResponse> {
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

// Maintenance metrics for the repair page.
// resyncQueueLength / resyncErroredBlocks are summed over every node that
// answered GetNodeStatistics; `nodes` has the breakdown and `nodeErrors` the
// nodes that could not be reached. corruptionCounter comes from the admin
// endpoint node's /metrics only and is null when unavailable.
export interface MaintenanceMetrics {
  resyncQueueLength: number
  resyncErroredBlocks: number
  corruptionCounter: number | null
  nodes: { nodeId: string; resyncQueueLen: number; resyncErrors: number }[]
  nodeErrors: Record<string, string>
}

export async function getMaintenanceMetrics(): Promise<MaintenanceMetrics> {
  return fetchJSON('/metrics')
}
