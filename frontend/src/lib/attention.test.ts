import { describe, expect, it } from 'vitest'
import type {
  AdminToken,
  BucketListItem,
  ClusterHealth,
  ClusterLayout,
  ClusterNode,
  KeyListItem,
  NodeStorageHealth,
} from '@/api'
import { collectAttentionItems, expiryAttention, type AttentionInputs } from './attention'

const NOW = Date.parse('2026-10-20T00:00:00Z')
const DAY = 24 * 60 * 60 * 1000
const ok = <T>(data: T) => ({ data, isError: false })
const failed = { data: undefined, isError: true }

const node = (id: string, over: Partial<ClusterNode> = {}): ClusterNode => ({
  id,
  garageVersion: 'v2.4.1',
  addr: null,
  hostname: id,
  isUp: true,
  lastSeenSecsAgo: null,
  role: { zone: 'z', tags: [], capacity: 100 },
  draining: false,
  ...over,
})

const nodeHealth = (over: Partial<NodeStorageHealth> = {}): NodeStorageHealth => ({
  resyncQueueLen: 0,
  resyncErrors: 0,
  scrubCorruptions: 0,
  scrubLastCompleted: 'never',
  scrub: null,
  ...over,
})

const healthy: ClusterHealth = {
  status: 'healthy',
  knownNodes: 2,
  connectedNodes: 2,
  storageNodes: 2,
  storageNodesUp: 2,
  partitions: 256,
  partitionsQuorum: 256,
  partitionsAllOk: 256,
}

const emptyLayout: ClusterLayout = {
  version: 3,
  roles: [],
  parameters: { zoneRedundancy: 'maximum' },
  partitionSize: 0,
  stagedRoleChanges: [],
  stagedParameters: null,
}

const key = (id: string, over: Partial<KeyListItem> = {}): KeyListItem => ({
  id,
  name: `key-${id}`,
  created: null,
  expiration: null,
  expired: false,
  bucketCount: 0,
  ...over,
})

const token = (over: Partial<AdminToken> = {}): AdminToken => ({
  id: 't1',
  created: null,
  name: 'ops',
  expiration: null,
  expired: false,
  scope: ['*'],
  ...over,
})

const bucket = (id: string, over: Partial<BucketListItem> = {}): BucketListItem => ({
  id,
  globalAliases: [`alias-${id}`],
  localAliases: [],
  created: null,
  objects: 0,
  bytes: 0,
  unfinishedMultipartUploads: 0,
  keyCount: 1,
  keys: [{ accessKeyId: 'GKconsole', read: true, write: true, owner: false }],
  quotas: null,
  ...over,
})

/** Everything loaded and nothing wrong. */
function inputs(over: Partial<AttentionInputs> = {}): AttentionInputs {
  return {
    now: NOW,
    health: ok(healthy),
    status: ok({ layoutVersion: 3, nodes: [node('n1'), node('n2')] }),
    storageHealth: ok({ nodes: { n1: nodeHealth(), n2: nodeHealth() } }),
    corruptionIncreases: {},
    layout: ok(emptyLayout),
    keys: ok({ items: [key('GK1')], truncated: false }),
    adminTokens: ok([token()]),
    buckets: ok({ items: [bucket('b1')], truncated: false }),
    s3Connection: ok({ region: 'garage', endpoint: 'http://s3', publicEndpoint: true, accessKeyId: 'GKconsole' }),
    ...over,
  }
}

const ids = (over: Partial<AttentionInputs>) => collectAttentionItems(inputs(over)).items.map((i) => i.id)

describe('collectAttentionItems', () => {
  it('reports nothing when everything is fine', () => {
    expect(collectAttentionItems(inputs())).toEqual({ items: [], unknown: [], pending: false })
  })

  it('marks loading sources as pending, not as unknown', () => {
    const r = collectAttentionItems(inputs({ keys: { data: undefined, isError: false } }))
    expect(r).toEqual({ items: [], unknown: [], pending: true })
  })

  it('reports failed sources as unknown even when stale data is present', () => {
    const r = collectAttentionItems(
      inputs({
        keys: { data: { items: [key('GK1', { expired: true })], truncated: false }, isError: true },
        adminTokens: failed,
        s3Connection: failed,
      }),
    )
    expect(r.items).toEqual([])
    expect(r.unknown).toEqual(['アクセスキー', '管理トークン', 'コンソールの S3 キー'])
  })

  it('flags a non-healthy cluster (unavailable = danger)', () => {
    const degraded = collectAttentionItems(inputs({ health: ok({ ...healthy, status: 'degraded', storageNodesUp: 1 }) }))
    expect(degraded.items).toMatchObject([{ id: 'health', severity: 'warning' }])
    expect(degraded.items[0].message).toContain('degraded')
    expect(degraded.items[0].message).toContain('1 / 2')
    const down = collectAttentionItems(inputs({ health: ok({ ...healthy, status: 'unavailable' }) }))
    expect(down.items[0].severity).toBe('danger')
  })

  it('flags disconnected and draining storage nodes, not gateways', () => {
    const r = collectAttentionItems(
      inputs({
        status: ok({
          layoutVersion: 3,
          nodes: [
            node('down', { isUp: false, lastSeenSecsAgo: 600 }),
            node('drain', { role: null, draining: true }),
            node('gw', { isUp: false, role: { zone: 'z', tags: [], capacity: null } }),
          ],
        }),
        storageHealth: ok({ nodes: { drain: nodeHealth() } }),
      }),
    )
    expect(r.items).toEqual([
      expect.objectContaining({ id: 'node-down:down', severity: 'danger', link: { to: '/nodes/$id', id: 'down' } }),
      // Role-less nodes have no detail page.
      expect.objectContaining({ id: 'node-draining:drain', severity: 'warning', link: { to: '/layout' } }),
    ])
    expect(r.items[0].message).toContain('最終確認 10分前')
    // The down node not answering storage health is already flagged.
    expect(r.unknown).toEqual([])
  })

  it('flags resync errors (→ /blocks) and corruption rises (→ node page)', () => {
    const r = collectAttentionItems(
      inputs({
        storageHealth: ok({ nodes: { n1: nodeHealth({ resyncErrors: 3 }), n2: nodeHealth({ scrubCorruptions: 5 }) } }),
        corruptionIncreases: { n2: { delta: 2 } },
      }),
    )
    expect(r.items).toEqual([
      expect.objectContaining({ id: 'resync:n1', severity: 'danger', link: { to: '/blocks' } }),
      expect.objectContaining({ id: 'corruption:n2', severity: 'warning', link: { to: '/nodes/$id', id: 'n2' } }),
    ])
    expect(r.items[0].message).toBe('n1 で Resync エラーが 3 件あります')
    expect(r.items[1].message).toContain('2 件増えました')
  })

  it('does not flag a cumulative corruption counter without a rise', () => {
    expect(ids({ storageHealth: ok({ nodes: { n1: nodeHealth({ scrubCorruptions: 9 }), n2: nodeHealth() } }) })).toEqual([])
  })

  it('reports storage health fan-out errors as unknown', () => {
    const fanOut = collectAttentionItems(
      inputs({ storageHealth: ok({ nodes: { n1: nodeHealth({ resyncErrors: null }) }, statsError: 'boom' }) }),
    )
    expect(fanOut.items).toEqual([])
    expect(fanOut.unknown).toEqual(['Storage health(一部のノード)'])
    const perNode = collectAttentionItems(
      inputs({ storageHealth: ok({ nodes: { n1: nodeHealth(), n2: nodeHealth({ resyncErrors: null, error: 'timeout' }) } }) }),
    )
    expect(perNode.unknown).toEqual(['Storage health(一部のノード)'])
  })

  it('ignores nodes present in only one of cluster status and storage health', () => {
    // n2 just joined (not in storage health yet); n3 just left the status.
    const r = collectAttentionItems(
      inputs({ storageHealth: ok({ nodes: { n1: nodeHealth() } }) }),
    )
    expect(r).toEqual({ items: [], unknown: [], pending: false })
    const extra = collectAttentionItems(
      inputs({ storageHealth: ok({ nodes: { n1: nodeHealth(), n2: nodeHealth(), n3: nodeHealth({ resyncErrors: null }) } }) }),
    )
    expect(extra.unknown).toEqual([])
  })

  it('ignores errors of down nodes and gateways (already flagged / irrelevant)', () => {
    const r = collectAttentionItems(
      inputs({
        status: ok({
          layoutVersion: 3,
          nodes: [node('n1', { isUp: false }), node('gw', { role: { zone: 'z', tags: [], capacity: null } })],
        }),
        storageHealth: ok({ nodes: { n1: nodeHealth({ error: 'down' }), gw: nodeHealth({ error: 'x' }) } }),
      }),
    )
    expect(r.items.map((i) => i.id)).toEqual(['node-down:n1'])
    expect(r.unknown).toEqual([])
  })

  it('flags staged layout changes', () => {
    const r = collectAttentionItems(
      inputs({
        layout: ok({
          ...emptyLayout,
          stagedRoleChanges: [{ id: 'n3', remove: true }],
          stagedParameters: { zoneRedundancy: { atLeast: 2 } },
        }),
      }),
    )
    expect(r.items.map((i) => [i.id, i.message])).toEqual([
      ['layout-staged', 'レイアウトに未適用の変更があります(ノード 1 件、パラメータ)'],
    ])
  })

  it('flags expired and soon-to-expire keys and admin tokens', () => {
    const r = collectAttentionItems(
      inputs({
        keys: ok({
          items: [
            key('expired', { expired: true }),
            key('soon', { expiration: new Date(NOW + 3 * DAY - 1).toISOString() }),
            key('later', { expiration: new Date(NOW + 8 * DAY).toISOString() }),
          ],
          truncated: false,
        }),
        adminTokens: ok([
          token({ id: 'past', expiration: new Date(NOW - 1).toISOString() }),
          token({ id: null, name: 'admin_token', expiration: new Date(NOW + DAY / 2).toISOString() }),
        ]),
      }),
    )
    expect(r.items).toEqual([
      expect.objectContaining({ id: 'key:expired', severity: 'danger', link: { to: '/keys/$id', id: 'expired' } }),
      expect.objectContaining({ id: 'token:past', severity: 'danger', link: { to: '/admin-tokens/$id', id: 'past' } }),
      expect.objectContaining({ id: 'key:soon', severity: 'warning', message: 'アクセスキー key-soon: あと 3 日で有効期限が切れます' }),
      // Config-file tokens have no detail page.
      expect.objectContaining({ id: 'token:config-1', severity: 'warning', link: { to: '/admin-tokens' } }),
    ])
  })

  it('reports a truncated key list as unknown', () => {
    expect(collectAttentionItems(inputs({ keys: ok({ items: [], truncated: true }) })).unknown).toEqual([
      'アクセスキー(一覧が上限で打ち切られています)',
    ])
  })

  it('flags buckets with many unfinished multipart uploads', () => {
    expect(
      ids({
        buckets: ok({
          items: [bucket('b9', { unfinishedMultipartUploads: 9 }), bucket('b10', { unfinishedMultipartUploads: 10 })],
          truncated: false,
        }),
      }),
    ).toEqual(['multipart:b10'])
  })

  it('aggregates buckets where the console key lacks read or write into one line', () => {
    const r = collectAttentionItems(
      inputs({
        buckets: ok({
          items: [
            bucket('none', { keys: [] }),
            bucket('ro', { keys: [{ accessKeyId: 'GKconsole', read: true, write: false, owner: false }] }),
            bucket('other', { keys: [{ accessKeyId: 'GKother', read: true, write: true, owner: true }] }),
            bucket('fine'),
          ],
          truncated: false,
        }),
      }),
    )
    expect(r.items).toEqual([
      {
        id: 'console-key',
        severity: 'warning',
        message: expect.stringContaining('権限のないバケットが 3 件'),
        hint: 'alias-none、alias-ro、alias-other',
        link: { to: '/buckets' },
      },
    ])
  })

  it('names only the first 5 buckets without console access', () => {
    const items = Array.from({ length: 7 }, (_, i) => bucket(`b${i}`, { keys: [] }))
    const [item] = collectAttentionItems(inputs({ buckets: ok({ items, truncated: false }) })).items
    expect(item.hint).toBe('alias-b0、alias-b1、alias-b2、alias-b3、alias-b4 ほか 2 件')
  })

  it('skips the console key check when no console key is configured', () => {
    expect(
      ids({
        s3Connection: ok({ region: 'garage', endpoint: 'http://s3', publicEndpoint: false, accessKeyId: '' }),
        buckets: ok({ items: [bucket('none', { keys: [] })], truncated: false }),
      }),
    ).toEqual([])
  })

  it('reports buckets without details as unknown instead of fine', () => {
    const r = collectAttentionItems(
      inputs({ buckets: ok({ items: [bucket('b', { keys: null, unfinishedMultipartUploads: null })], truncated: true }) }),
    )
    expect(r.items).toEqual([])
    expect(r.unknown).toEqual(['バケット(一覧が上限で打ち切られています)', 'バケット(一部の詳細)'])
  })

  it('puts danger before warning', () => {
    expect(
      ids({
        layout: ok({ ...emptyLayout, stagedRoleChanges: [{ id: 'x', remove: true }] }),
        keys: ok({ items: [key('gone', { expired: true })], truncated: false }),
      }),
    ).toEqual(['key:gone', 'layout-staged'])
  })
})

describe('expiryAttention', () => {
  it('distinguishes never, later, within 7 days, within a day and expired', () => {
    expect(expiryAttention(null, false, NOW)).toBeNull()
    expect(expiryAttention(new Date(NOW + 7 * DAY + 1).toISOString(), false, NOW)).toBeNull()
    expect(expiryAttention(new Date(NOW + 7 * DAY).toISOString(), false, NOW)?.text).toBe('あと 7 日で有効期限が切れます')
    expect(expiryAttention(new Date(NOW + 60_000).toISOString(), false, NOW)?.text).toBe('24 時間以内に有効期限が切れます')
    expect(expiryAttention(new Date(NOW).toISOString(), false, NOW)?.severity).toBe('danger')
    expect(expiryAttention(null, true, NOW)?.severity).toBe('danger')
  })
})
