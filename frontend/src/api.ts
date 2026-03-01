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
  return res.json()
}

export async function fetchMe(): Promise<{ username: string; avatar_url: string }> {
  return fetchJSON('/auth/me')
}

export async function logout(): Promise<void> {
  await fetchJSON('/auth/logout', { method: 'POST' })
}

// Cluster
export async function getClusterHealth(): Promise<Record<string, unknown>> {
  return fetchJSON('/cluster/health')
}

export async function getClusterStatus(): Promise<Record<string, unknown>> {
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
  accessKeyId: string
  name?: string
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

export async function uploadFile(bucket: string, file: File): Promise<void> {
  const form = new FormData()
  form.append('file', file)
  const res = await fetch(`${BASE}/objects/${bucket}/upload`, {
    method: 'POST',
    headers: { 'X-Requested-With': 'XMLHttpRequest' },
    body: form,
  })
  if (!res.ok) throw new Error(`Upload error: ${res.status}`)
}

export async function deleteObject(bucket: string, key: string): Promise<void> {
  await fetchJSON(`/objects/${bucket}?key=${encodeURIComponent(key)}`, {
    method: 'DELETE',
  })
}

// Workers
export async function listWorkers(): Promise<Record<string, unknown>[]> {
  return fetchJSON('/workers')
}
