import type { ClusterNode } from '@/api'

/** Display name for a node: hostname when known, otherwise the ID prefix. */
export function nodeDisplayName(node: Pick<ClusterNode, 'id' | 'hostname'>): string {
  return node.hostname || `${node.id.slice(0, 16)}…`
}
