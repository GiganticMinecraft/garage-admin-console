import type { ClusterNode } from '@/api'

/** Display name for a node: hostname when known, otherwise the ID prefix. */
export function nodeDisplayName(node: Pick<ClusterNode, 'id' | 'hostname'>): string {
  return node.hostname || `${node.id.slice(0, 16)}…`
}

/**
 * Nodes that hold blocks: a current role with capacity, or draining (role
 * removed in a newer layout but still holding data, which is exactly when
 * its resync queue matters).
 */
export function isStorageNode(node: Pick<ClusterNode, 'role' | 'draining'>): boolean {
  return node.role ? node.role.capacity != null : node.draining
}

/**
 * IDs of the nodes known to hold no blocks (gateways, nodes without a role).
 * Their block-level answers do not matter, so a gateway that is down must not
 * leave the block health "partly unchecked" forever. Nodes absent from the
 * cluster status are not in the set: without knowing, they still count.
 */
export function nonStorageNodeIds(nodes: readonly ClusterNode[] | undefined): ReadonlySet<string> {
  return new Set((nodes ?? []).filter((n) => !isStorageNode(n)).map((n) => n.id))
}
