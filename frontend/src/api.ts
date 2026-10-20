import { loginUrlFor } from '@/lib/auth'

const BASE = '/api'

let redirectingToLogin = false

/**
 * Send the browser to GitHub sign-in, asking to come back to the current
 * page. Concurrent 401s (several queries expiring together) navigate once.
 */
function redirectToLogin(): void {
  if (redirectingToLogin) return
  const { pathname, search } = window.location
  redirectingToLogin = true
  window.location.href = loginUrlFor(pathname, search, BASE)
}

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
    redirectToLogin()
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

/** One entry of Garage's ConnectClusterNodesResponse, at the position of the peer it answers for. */
export interface ConnectNodeResult {
  success: boolean
  error: string | null
}

/**
 * Ask Garage to connect to `<node_id>@<addr:port>` peers (ConnectClusterNodes).
 * A 200 does not mean every connection succeeded: check each entry.
 */
export async function connectClusterNodes(nodes: string[]): Promise<ConnectNodeResult[]> {
  return fetchJSON('/cluster/connect', {
    method: 'POST',
    body: JSON.stringify({ nodes }),
  })
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
  // capacity: null or absent means a gateway node (NodeAssignedRole in the v2 spec).
  | { id: string; zone: string; tags: string[]; capacity?: number | null }

export interface ClusterLayout {
  version: number
  roles: LayoutNodeRole[]
  parameters: LayoutParameters
  partitionSize: number
  stagedRoleChanges: NodeRoleChange[]
  stagedParameters: LayoutParameters | null
}

/** Per-node statistics of a layout computation (Garage ComputationStatNode). */
export interface LayoutStatNode {
  id: string
  tags: string[]
  /** Partitions replicated on this node in the new layout. */
  storedPartitions: number
  /** Partitions this node newly receives (to be transferred). */
  newPartitions: number
  totalCapacity: number
  usableCapacity: number
}

/** Per-zone statistics of a layout computation (Garage ComputationStatZone). */
export interface LayoutStatZone {
  name: string
  nodes: LayoutStatNode[]
  totalReplicatedPartitions: number
  uniquePartitions: number
  totalCapacity: number
  usableCapacity: number
}

/**
 * Structured result of a layout computation (Garage ComputationStat, v2.4.0+).
 * Older Garage versions omit it and only return the plain-text `message`.
 */
export interface LayoutStatistics {
  replicationFactor: number
  effectiveZoneRedundancy: number
  partitionSize: number
  previousPartitionSize: number | null
  lowPartitionSize: boolean
  usableCapacity: number
  totalCapacity: number
  effectiveCapacity: number
  lowUsableCapacity: boolean
  totalMovedPartitions: number | null
  zones: LayoutStatZone[]
}

/**
 * Garage PreviewClusterLayoutChangesResponse is an untagged enum: HTTP 200 with
 * either {"error": "..."} (the layout cannot be computed) or the computation result.
 */
export type LayoutPreview =
  | { error: string }
  | {
      message: string[]
      statistics?: LayoutStatistics | null
      newLayout?: ClusterLayout
    }

/**
 * ApplyClusterLayoutResponse is a plain struct; computation failures come
 * back as a non-2xx Garage error and surface as ApiError.
 */
export interface LayoutApplyResult {
  message: string[]
  statistics?: LayoutStatistics | null
  layout: ClusterLayout
}

// Layout history / update trackers (mirrors Garage GetClusterLayoutHistoryResponse)
export type LayoutVersionStatus = 'Current' | 'Draining' | 'Historical'

export interface LayoutVersionInfo {
  version: number
  status: LayoutVersionStatus
  storageNodes: number
  gatewayNodes: number
}

/** Highest layout version each node has acknowledged / synced / seen everyone sync. */
export interface NodeUpdateTrackers {
  ack: number
  sync: number
  syncAck: number
}

export interface LayoutHistory {
  currentVersion: number
  minAck: number
  versions: LayoutVersionInfo[]
  /** Only present while more than one layout version is live. */
  updateTrackers: Record<string, NodeUpdateTrackers> | null
}

export async function getLayoutHistory(): Promise<LayoutHistory> {
  return fetchJSON('/cluster/layout/history')
}

export interface SkipDeadNodesResult {
  /** Nodes whose ack tracker was advanced to the requested version. */
  ackUpdated: string[]
  /** With allowMissingData: nodes whose sync tracker was advanced. */
  syncUpdated: string[]
}

/**
 * Force a stuck layout update forward (Garage ClusterLayoutSkipDeadNodes).
 * `allowMissingData` also marks every node as synced and can lose data.
 */
export async function skipDeadNodes(body: {
  version: number
  allowMissingData: boolean
}): Promise<SkipDeadNodesResult> {
  return fetchJSON('/cluster/layout/skip-dead-nodes', {
    method: 'POST',
    body: JSON.stringify(body),
  })
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
  const res = await fetchJSON<LayoutPreview>('/cluster/layout/preview', {
    method: 'POST',
    body: '{}',
  })
  // Garage returns 200 with {"error": "..."} when the layout cannot be computed;
  // that variant is returned as-is so the page can show it next to the staged changes.
  if (!res || typeof res !== 'object') throw new ApiError(200, 'プレビュー結果が空でした')
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
/**
 * One row of GET /api/buckets. The stats are null when the backend could not
 * fetch this bucket's info from Garage.
 */
export interface BucketListItem {
  id: string
  globalAliases: string[]
  localAliases: { alias: string; accessKeyId: string }[]
  created: string | null
  objects: number | null
  bytes: number | null
  unfinishedMultipartUploads: number | null
  keyCount: number | null
  /** Every key with permissions on the bucket; null like the stats. */
  keys: { accessKeyId: string; read: boolean; write: boolean; owner: boolean }[] | null
  quotas: { maxSize: number | null; maxObjects: number | null } | null
}

/** Body of GET /api/buckets and GET /api/keys. */
export interface ListResult<T> {
  items: T[]
  /** true when Garage's list limit was reached and entries may be missing. */
  truncated: boolean
}

/** Garage quotas; null means unlimited. */
export interface BucketQuotas {
  maxSize: number | null
  maxObjects: number | null
}

/**
 * S3-style rules are passed through as Garage serialises them (PascalCase XML
 * field names such as "AllowedOrigin"); the console edits them as raw JSON.
 */
export type BucketCorsRule = Record<string, unknown>
export type BucketLifecycleRule = Record<string, unknown>

/**
 * Garage website.RoutingRule (S3 RoutingRule, Garage >= v2.3). Condition may
 * be absent or null (unconditional rule); Garage fills HttpRedirectCode
 * (default 302) in its responses.
 */
export interface BucketRoutingRule {
  Condition?: {
    KeyPrefixEquals?: string | null
    HttpErrorCodeReturnedEquals?: number | null
  } | null
  Redirect: {
    HostName?: string | null
    Protocol?: string | null
    HttpRedirectCode?: number | null
    ReplaceKeyPrefixWith?: string | null
    ReplaceKeyWith?: string | null
  }
}

/** Body of GET /api/buckets/{id} (Garage GetBucketInfoResponse). */
export interface BucketDetail {
  id: string
  created?: string
  globalAliases?: string[]
  websiteAccess: boolean
  /** Absent (or null) when website access is disabled. */
  websiteConfig?: {
    indexDocument: string
    errorDocument: string | null
    /** Absent on Garage < v2.3. */
    routingRules?: BucketRoutingRule[]
  } | null
  /** Absent when the bucket has no CORS configuration. */
  corsRules?: BucketCorsRule[] | null
  /** Absent when the bucket has no lifecycle configuration. */
  lifecycleRules?: BucketLifecycleRule[] | null
  keys?: {
    accessKeyId: string
    name: string
    permissions: { read: boolean; write: boolean; owner: boolean }
    bucketLocalAliases?: string[]
  }[]
  objects?: number
  bytes?: number
  unfinishedUploads?: number
  unfinishedMultipartUploads?: number
  unfinishedMultipartUploadParts?: number
  unfinishedMultipartUploadBytes?: number
  quotas?: BucketQuotas | null
}

/**
 * Body of PUT /api/buckets/{id} (Garage UpdateBucketRequestBody). Omitted
 * fields are left unchanged; an empty corsRules / lifecycleRules array
 * deletes that configuration.
 */
export interface UpdateBucketBody {
  websiteAccess?: {
    enabled: boolean
    indexDocument?: string
    errorDocument?: string | null
    routingRules?: BucketRoutingRule[]
  }
  quotas?: BucketQuotas
  corsRules?: BucketCorsRule[]
  lifecycleRules?: BucketLifecycleRule[]
}

export async function getBucket(id: string): Promise<BucketDetail> {
  return fetchJSON(`/buckets/${id}`)
}

/** Deletes unfinished multipart uploads started more than olderThanSecs ago. */
export async function cleanupIncompleteUploads(
  bucketId: string,
  olderThanSecs: number,
): Promise<{ uploadsDeleted: number }> {
  return fetchJSON(`/buckets/${bucketId}/cleanup-uploads`, {
    method: 'POST',
    body: JSON.stringify({ olderThanSecs }),
  })
}

export async function createBucket(body: unknown): Promise<Record<string, unknown>> {
  return fetchJSON('/buckets', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function updateBucket(id: string, body: UpdateBucketBody): Promise<BucketDetail> {
  return fetchJSON(`/buckets/${id}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  })
}

export async function deleteBucket(id: string): Promise<void> {
  await fetchJSON(`/buckets/${id}`, { method: 'DELETE' })
}

/**
 * New grant (the key holds no permission on the bucket yet): POST →
 * AllowBucketKey. Editing an existing grant goes through
 * setBucketKeyPermissions (PUT), which also removes unchecked flags.
 */
export async function grantBucketKey(
  bucketId: string,
  body: { accessKeyId: string; permissions: BucketKeyPermissions },
): Promise<BucketDetail> {
  return fetchJSON(`/buckets/${bucketId}/keys`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function revokeBucketKey(bucketId: string, keyId: string): Promise<void> {
  await fetchJSON(`/buckets/${bucketId}/keys/${keyId}`, { method: 'DELETE' })
}

// Keys
/** One row of GET /api/keys. bucketCount is null when it could not be fetched. */
export interface KeyListItem {
  id: string
  name: string
  created: string | null
  expiration: string | null
  expired: boolean
  bucketCount: number | null
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

/**
 * Body of Garage CreateKey / UpdateKey (UpdateKeyRequestBody). `expiration`
 * is RFC 3339; Garage rejects `expiration` together with `neverExpires`.
 */
export interface KeySettingsRequest {
  name?: string
  expiration?: string
  neverExpires?: boolean
  allow?: { createBucket: boolean }
  deny?: { createBucket: boolean }
}

export async function createKey(body: KeySettingsRequest): Promise<KeyDetail> {
  return fetchJSON('/keys', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

/**
 * Imports an existing access key / secret pair (Garage ImportKey). The
 * response is the key's info without the secret.
 */
export async function importKey(body: {
  accessKeyId: string
  secretAccessKey: string
  name: string | null
}): Promise<KeyDetail> {
  return fetchJSON('/keys/import', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function updateKey(id: string, body: KeySettingsRequest): Promise<KeyDetail> {
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

/** One data block of an object version (Garage InspectObjectBlock). */
export interface InspectObjectBlock {
  /** Part number of the part containing this block (multipart uploads). */
  partNumber: number
  /** Offset of this block within its part. */
  offset: number
  /** blake2 hash of the block's data, hex. */
  hash: string
  size: number
}

/**
 * One version of an object (Garage InspectObjectVersion). Exactly one of
 * uploading / aborted / deleteMarker is set for a non-complete version;
 * none for a complete one. `headers` and `blocks` are omitted when empty.
 */
export interface InspectObjectVersion {
  uuid: string
  timestamp: string
  /** Created with SSE-C encryption. */
  encrypted: boolean
  uploading: boolean
  aborted: boolean
  deleteMarker: boolean
  /** Data stored inline in the metadata (small objects): no blocks. */
  inline: boolean
  size?: number | null
  etag?: string | null
  headers?: [string, string][]
  blocks?: InspectObjectBlock[]
}

export interface InspectObjectResponse {
  bucketId: string
  key: string
  versions: InspectObjectVersion[]
}

/** GET /api/buckets/{id}/objects/inspect: Garage InspectObject (bucket ID only, not alias). */
export async function inspectObject(bucketId: string, key: string): Promise<InspectObjectResponse> {
  return fetchJSON(`/buckets/${encodeURIComponent(bucketId)}/objects/inspect?key=${encodeURIComponent(key)}`)
}

export function downloadObjectUrl(bucket: string, key: string): string {
  return `${BASE}/objects/${bucket}/download?key=${encodeURIComponent(key)}`
}

// Batch ZIP download. The key list is POSTed (no URL length limit) in
// exchange for a short-lived single-use token; the ZIP itself is then fetched
// with a plain GET so the browser's download manager streams it to disk
// instead of buffering it in JS memory. `name` is the bucket alias used for
// the ZIP filename; `bucket` is the ID used for the S3 request.
export const MAX_BATCH_DOWNLOAD_KEYS = 1000

export async function downloadObjectsZip(bucket: string, keys: string[], name?: string): Promise<void> {
  const { token } = await fetchJSON<{ token: string }>(`/objects/${bucket}/batch-download`, {
    method: 'POST',
    body: JSON.stringify({ keys, name }),
  })
  const a = document.createElement('a')
  a.href = `${BASE}/objects/${bucket}/batch-download?token=${encodeURIComponent(token)}`
  a.download = `${name || bucket}-files.zip`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}

/** Same parsing as errorFromResponse, for a status and body read off an XHR. */
function apiErrorFromText(status: number, text: string): ApiError {
  let message = ''
  let code: string | undefined
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
  if (!message) message = `API error: ${status}`
  return new ApiError(status, message, code)
}

export interface UploadObjectOptions {
  /** Full object key. */
  key: string
  /** When false, the server answers 409 (ApiError.status) if the key exists. */
  overwrite?: boolean
  onProgress?: (loaded: number, total: number) => void
}

/**
 * Uploads one file with XMLHttpRequest so upload progress can be reported
 * (fetch has no upload progress events). The key travels in the query
 * string, which lets the server reject an existing key with 409 before the
 * body is read.
 */
export function uploadObject(
  bucket: string,
  file: File,
  { key, overwrite = true, onProgress }: UploadObjectOptions,
): Promise<{ key: string }> {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({ key })
    if (!overwrite) params.set('overwrite', 'false')
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${BASE}/objects/${bucket}/upload?${params.toString()}`)
    xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest')
    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(e.loaded, e.total)
      }
    }
    xhr.onload = () => {
      // Built straight from the XHR fields: a Response object cannot carry
      // statuses like 204 with a body (it throws), which would leave this
      // promise pending forever.
      try {
        if (xhr.status === 401) {
          redirectToLogin()
          reject(new Error('Unauthorized'))
          return
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(JSON.parse(xhr.responseText) as { key: string })
          } catch {
            resolve({ key })
          }
          return
        }
        reject(apiErrorFromText(xhr.status, xhr.responseText))
      } catch (e) {
        reject(e instanceof Error ? e : new ApiError(xhr.status, String(e)))
      }
    }
    xhr.onerror = () => reject(new ApiError(0, 'ネットワークエラーによりアップロードが中断されました'))
    xhr.onabort = () => reject(new ApiError(0, 'アップロードが中断されました'))
    const form = new FormData()
    form.append('key', key)
    form.append('file', file)
    xhr.send(form)
  })
}

export async function deleteObject(bucket: string, key: string): Promise<void> {
  await fetchJSON(`/objects/${bucket}?key=${encodeURIComponent(key)}`, {
    method: 'DELETE',
  })
}

// Workers
// Garage's worker state serializes as a string ("idle" / "busy" / "done") for
// simple variants, but throttled is an object (Garage WorkerStateResp::Throttled
// { duration_secs: f32 }): { throttled: { durationSecs: number } }.
export type WorkerState = string | { throttled: { durationSecs: number } }

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
  /** Garage's own text (e.g. "12.34%"); the v2.4.1 spec types it as a string. */
  progress: string | null
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

/**
 * GET /api/blocks/errors. `items` holds the block errors of every node that
 * answered; `checkedNodes` the nodes whose answer was read completely;
 * `nodeErrors` maps each node that did not answer (or answered something
 * unreadable) to the reason. Empty items mean "no block errors" only when
 * nodeErrors is empty and checkedNodes is not.
 */
export interface BlockErrorsResponse {
  items: BlockError[]
  checkedNodes: string[]
  nodeErrors: Record<string, string>
}

export async function listBlockErrors(): Promise<BlockErrorsResponse> {
  return normalizeBlockErrors(await fetchJSON<unknown>('/blocks/errors'))
}

/**
 * Accepts the pre-#400 bare array as well, so a new bundle served by an old
 * backend during a rollout still renders. The array says nothing about which
 * nodes were checked, so checkedNodes stays empty (the UI then refuses to
 * call it "no errors").
 */
export function normalizeBlockErrors(data: unknown): BlockErrorsResponse {
  if (Array.isArray(data)) return { items: data as BlockError[], checkedNodes: [], nodeErrors: {} }
  const d = (data ?? {}) as Partial<BlockErrorsResponse>
  return { items: d.items ?? [], checkedNodes: d.checkedNodes ?? [], nodeErrors: d.nodeErrors ?? {} }
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

// Enriched bucket / key lists (#380)
/**
 * All buckets with usage stats. Returns `{ items, truncated }`, NOT a bare
 * array (changed in #380): read `.items` for the rows; `truncated` is true when
 * Garage's list limit was hit and some buckets may be missing.
 */
export async function listBuckets(): Promise<ListResult<BucketListItem>> {
  return fetchJSON('/buckets')
}

/**
 * All access keys with expiration and bucket counts. Returns
 * `{ items, truncated }`, NOT a bare array (changed in #380): read `.items`.
 */
export async function listKeys(): Promise<ListResult<KeyListItem>> {
  return fetchJSON('/keys')
}

// Nodes (per-node detail page). The backend unwraps Garage's MultiResponse for
// the read endpoints; mutating endpoints return it as-is because they can
// also target every node (allNodes).
//
// GetNodeInfo: hostname/addr/isUp/role/draining/partitions need Garage >= v2.4.0
// and are omitted (undefined) by older nodes, so they are all optional.
export interface NodeInfo {
  nodeId: string
  hostname?: string | null
  garageVersion: string
  garageFeatures: string[] | null
  rustVersion: string
  dbEngine: string
  addr?: string | null
  isUp?: boolean | null
  role?: {
    zone: string
    tags: string[]
    capacity: number | null
  } | null
  draining?: boolean | null
  dataPartition?: PartitionUsage | null
  metadataPartition?: PartitionUsage | null
}

export interface NodeTableStats {
  tableName: string
  items: number
  merkleItems: number
  merkleQueueLen: number
  insertQueueLen: number
  gcQueueLen: number
}

export interface NodeBlockManagerStats {
  rcEntries: number
  resyncQueueLen: number
  resyncErrors: number
}

/** tableStats / blockManagerStats need Garage >= v2.3.0; freeform is always present. */
export interface NodeStatistics {
  freeform: string
  tableStats?: NodeTableStats[] | null
  blockManagerStats?: NodeBlockManagerStats | null
}

/** Background variables of one node; all values are strings (e.g. "2", "never"). */
export type WorkerVariables = Record<string, string>

function nodePath(id: string, suffix = ''): string {
  return `/nodes/${encodeURIComponent(id)}${suffix}`
}

export async function getNode(id: string): Promise<NodeInfo> {
  return fetchJSON(nodePath(id))
}

export async function getNodeStats(id: string): Promise<NodeStatistics> {
  return fetchJSON(nodePath(id, '/stats'))
}

export async function getNodeWorkerVariables(id: string): Promise<WorkerVariables> {
  return fetchJSON(nodePath(id, '/worker-variables'))
}

export async function setNodeWorkerVariable(
  id: string,
  body: { variable: string; value: string; allNodes?: boolean },
): Promise<MultiResponse<{ variable: string; value: string }>> {
  return fetchJSON(nodePath(id, '/worker-variables'), {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function launchNodeRepair(
  id: string,
  repairType: RepairType,
): Promise<MultiResponse<null>> {
  return fetchJSON(nodePath(id, '/repair'), {
    method: 'POST',
    body: JSON.stringify({ repairType }),
  })
}

export async function createMetadataSnapshot(
  id: string,
  allNodes = false,
): Promise<MultiResponse<null>> {
  return fetchJSON(nodePath(id, '/snapshot'), {
    method: 'POST',
    body: JSON.stringify({ allNodes }),
  })
}

export async function listNodeWorkers(id: string): Promise<WorkersResponse> {
  return fetchJSON(nodePath(id, '/workers'))
}

// Bulk object deletion (#381)
export interface BatchDeleteResult {
  deleted: number
  errors: { key: string; code?: string; message: string }[]
  /** Prefix delete only: the per-call cap was hit and objects remain. */
  truncated: boolean
}

export async function deleteObjects(bucket: string, keys: string[]): Promise<BatchDeleteResult> {
  return fetchJSON(`/objects/${bucket}/batch`, {
    method: 'DELETE',
    body: JSON.stringify({ keys }),
  })
}

export interface PrefixSummary {
  count: number
  bytes: number
  /** Counting stopped at the server's cap; the real count is higher. */
  truncated: boolean
}

export async function getPrefixSummary(bucket: string, prefix: string): Promise<PrefixSummary> {
  return fetchJSON(`/objects/${bucket}/prefix-summary?prefix=${encodeURIComponent(prefix)}`)
}

export async function deletePrefix(bucket: string, prefix: string): Promise<BatchDeleteResult> {
  return fetchJSON(`/objects/${bucket}/prefix?prefix=${encodeURIComponent(prefix)}`, {
    method: 'DELETE',
  })
}

// Dashboard (#379)
/**
 * GET /api/cluster/statistics (Garage GetClusterStatistics, structured since
 * v2.3.0). totalObjectCount / totalObjectBytes are omitted when the cluster
 * has more than 1000 buckets. incompleteAvailInfo is true when some storage
 * nodes did not report their free space, so dataAvail / metadataAvail are
 * lower bounds.
 */
export interface ClusterStatistics {
  freeform: string
  dataAvail?: number | null
  metadataAvail?: number | null
  incompleteAvailInfo?: boolean
  bucketCount?: number | null
  totalObjectCount?: number | null
  totalObjectBytes?: number | null
}

export async function getClusterStatistics(): Promise<ClusterStatistics> {
  return fetchJSON('/cluster/statistics')
}

/**
 * Per-node block health from GET /api/cluster/storage-health. Metrics are
 * null when the node did not answer (then `error` says why) or its Garage
 * does not report them. scrubLastCompleted is Garage's string ("never" or an
 * RFC 3339 timestamp). scrubCorruptions is a lifetime counter Garage persists
 * and never resets: only an increase is news.
 */
export interface NodeStorageHealth {
  resyncQueueLen: number | null
  resyncErrors: number | null
  scrubCorruptions: number | null
  scrubLastCompleted: string | null
  /** The node's "Block scrub worker", or null when ListWorkers did not report it. */
  scrub: ScrubWorkerStatus | null
  /** Every problem of the node, joined and prefixed by fan-out. */
  error?: string
  /** The same problems split by source: resync stats (GetNodeStatistics). */
  statsError?: string
  /** Scrub variables (GetWorkerVariable). */
  varsError?: string
  /** Scrub worker state (ListWorkers). */
  workersError?: string
}

/**
 * Live scrub worker state. state is Garage's WorkerStateResp as-is (decode
 * with describeState from lib/workers); progress is Garage's percentage
 * string ("42.00%"), present while a scrub runs or is paused.
 */
export interface ScrubWorkerStatus {
  state: WorkerState
  progress?: string
  tranquility?: number
}

/**
 * GET /api/cluster/storage-health. `nodes` is keyed by full node ID (join it
 * with GetClusterStatus); statsError / varsError are set when a whole
 * fan-out (GetNodeStatistics / GetWorkerVariable) failed. Cached ~10 s
 * server-side.
 */
export interface StorageHealth {
  nodes: Record<string, NodeStorageHealth>
  statsError?: string
  varsError?: string
  /** ListWorkers fan-out failed; every node's scrub is null (unknown, not idle). */
  workersError?: string
}

export async function getStorageHealth(): Promise<StorageHealth> {
  return fetchJSON('/cluster/storage-health')
}

// Bucket-key permissions (#377)
export interface BucketKeyPermissions {
  read: boolean
  write: boolean
  owner: boolean
}

export interface SetBucketKeyPermissionsResult {
  bucketId: string
  accessKeyId: string
  permissions: BucketKeyPermissions
  /** false when the permissions were already as requested. */
  changed: boolean
}

/**
 * Sets one key's permissions on one bucket to exactly `permissions`. The
 * backend diffs against the current state and sends AllowBucketKey for newly
 * granted flags and DenyBucketKey for removed ones. At least one flag must be
 * true; use revokeBucketKey to remove all of them.
 */
export async function setBucketKeyPermissions(
  bucketId: string,
  keyId: string,
  permissions: BucketKeyPermissions,
): Promise<SetBucketKeyPermissionsResult> {
  return fetchJSON(`/buckets/${bucketId}/keys/${encodeURIComponent(keyId)}`, {
    method: 'PUT',
    body: JSON.stringify(permissions),
  })
}

/** Region / endpoint for S3 clients (GET /api/s3/connection). */
export interface S3Connection {
  region: string
  endpoint: string
  /** false when GARAGE_S3_PUBLIC_ENDPOINT is unset and `endpoint` may be cluster-internal. */
  publicEndpoint: boolean
  /**
   * Access key ID of the console's own S3 key (GARAGE_S3_ACCESS_KEY), which
   * the object browser uses. Empty when not configured. The secret is never
   * returned.
   */
  accessKeyId?: string
}

export async function getS3Connection(): Promise<S3Connection> {
  return fetchJSON('/s3/connection')
}

/**
 * Grants read + write on the bucket to the console's own S3 key (the one the
 * object browser uses). The backend always uses its configured key; no key ID
 * is sent. `changed` is false when the key already had both.
 */
export async function grantConsoleAccess(bucketId: string): Promise<SetBucketKeyPermissionsResult> {
  return fetchJSON(`/buckets/${encodeURIComponent(bucketId)}/console-access`, { method: 'POST' })
}

// Admin API tokens
/**
 * Garage GetAdminTokenInfoResponse. Tokens from the daemon configuration
 * (admin_token / metrics_token) have id and created null and cannot be
 * edited or deleted through the API.
 */
export interface AdminToken {
  id: string | null
  created: string | null
  name: string
  expiration: string | null
  expired: boolean
  /** Admin endpoint names, or ["*"] for every endpoint. */
  scope: string[]
}

/** CreateAdminToken answer: the token info plus the secret, returned only once. */
export interface CreatedAdminToken extends AdminToken {
  secretToken: string
}

/** Body for create / update. Garage rejects expiration together with neverExpires. */
export interface AdminTokenBody {
  name?: string
  expiration?: string
  neverExpires?: boolean
  scope?: string[]
}

export async function listAdminTokens(): Promise<AdminToken[]> {
  return fetchJSON('/admin-tokens')
}

/** The token this console itself authenticates to Garage with. */
export async function getCurrentAdminToken(): Promise<AdminToken> {
  return fetchJSON('/admin-tokens/current')
}

/**
 * Garage Admin API v2 endpoint names the console backend calls, sorted. It
 * includes CreateAdminToken / UpdateAdminToken; see consolePresetScope for the
 * non-escalating preset built from it.
 */
export async function getConsoleScope(): Promise<string[]> {
  return fetchJSON('/admin-tokens/console-scope')
}

export async function getAdminToken(id: string): Promise<AdminToken> {
  return fetchJSON(`/admin-tokens/${encodeURIComponent(id)}`)
}

export async function createAdminToken(body: AdminTokenBody): Promise<CreatedAdminToken> {
  return fetchJSON('/admin-tokens', {
    method: 'POST',
    body: JSON.stringify(body),
    cache: 'no-store',
  })
}

export async function updateAdminToken(id: string, body: AdminTokenBody): Promise<AdminToken> {
  return fetchJSON(`/admin-tokens/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  })
}

export async function deleteAdminToken(id: string): Promise<void> {
  await fetchJSON(`/admin-tokens/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

// Bucket aliases (#378)
/** A global alias, or a local alias in one key's namespace (body of POST /api/buckets/{id}/aliases). */
export type BucketAliasTarget =
  | { globalAlias: string }
  | { localAlias: string; accessKeyId: string }

/** Adds a global alias or a local alias in a key's namespace (Garage AddBucketAlias). */
export async function addBucketAlias(bucketId: string, target: BucketAliasTarget): Promise<BucketDetail> {
  return fetchJSON(`/buckets/${bucketId}/aliases`, {
    method: 'POST',
    body: JSON.stringify(target),
  })
}

/**
 * Removes a global or local alias (Garage RemoveBucketAlias). The target is
 * in the URL: DELETE /buckets/{id}/aliases/{alias}[?accessKeyId=GK...].
 * Garage refuses to remove a bucket's very last alias.
 */
export async function removeBucketAlias(bucketId: string, target: BucketAliasTarget): Promise<BucketDetail> {
  const path =
    'globalAlias' in target
      ? `/buckets/${bucketId}/aliases/${encodeURIComponent(target.globalAlias)}`
      : `/buckets/${bucketId}/aliases/${encodeURIComponent(target.localAlias)}?accessKeyId=${encodeURIComponent(target.accessKeyId)}`
  return fetchJSON(path, { method: 'DELETE' })
}
