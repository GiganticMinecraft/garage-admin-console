import { describe, expect, it } from 'vitest'
import type { ClusterNode } from '@/api'
import { isStorageNode, nodeRoleKind, nonStorageNodeIds } from './nodes'

const n = (id: string, over: Partial<ClusterNode> = {}): ClusterNode => ({
  id,
  garageVersion: null,
  addr: null,
  hostname: null,
  isUp: true,
  lastSeenSecsAgo: null,
  role: { zone: 'z', tags: [], capacity: 100 },
  draining: false,
  ...over,
})

describe('isStorageNode', () => {
  it('is true for a role with capacity or a draining node', () => {
    expect(isStorageNode(n('s'))).toBe(true)
    expect(isStorageNode(n('d', { role: null, draining: true }))).toBe(true)
    expect(isStorageNode(n('g', { role: { zone: 'z', tags: [], capacity: null } }))).toBe(false)
    expect(isStorageNode(n('r', { role: null }))).toBe(false)
  })
})

describe('nodeRoleKind', () => {
  it('distinguishes storage, gateway, draining and unassigned', () => {
    expect(nodeRoleKind(n('s'))).toBe('storage')
    expect(nodeRoleKind(n('g', { role: { zone: 'z', tags: [], capacity: null } }))).toBe('gateway')
    expect(nodeRoleKind(n('d', { role: null, draining: true }))).toBe('draining')
    expect(nodeRoleKind(n('u', { role: null }))).toBe('unassigned')
  })
})

describe('nonStorageNodeIds', () => {
  it('lists gateways and roleless nodes, nothing when status is unknown', () => {
    const nodes = [n('s'), n('g', { role: { zone: 'z', tags: [], capacity: null } }), n('d', { role: null, draining: true })]
    expect([...nonStorageNodeIds(nodes)]).toEqual(['g'])
    expect(nonStorageNodeIds(undefined).size).toBe(0)
  })
})
