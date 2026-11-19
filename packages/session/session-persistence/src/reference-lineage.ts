/** Reverse parent-header traversal over the declared retained corpus. */
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ArtifactHeader, Evidence, ReferenceDescendant } from './maintenance.ts'

/**
 * Return direct and transitive descendants, including trash when the input includes it.
 * Missing parents and cycles make lineage unknown, even in a disconnected component.
 * @param corpus - header evidence from the current exclusive maintenance epoch.
 * @param parent - session whose descendants are requested.
 * @returns descendants with edge distance, or the reason lineage could not be established.
 */
export function referenceDescendants(corpus: Evidence<ArtifactHeader>, parent: SessionId): Evidence<ReferenceDescendant> {
  if (corpus.state === 'unknown') return corpus
  const entries = new Map(corpus.items.map(artifact => [artifact.id, artifact]))
  const children = new Map<SessionId, ArtifactHeader[]>()
  const validated = new Set<SessionId>()
  for (const artifact of corpus.items) {
    if (artifact.parentSession !== undefined) {
      const siblings = children.get(artifact.parentSession) ?? []
      siblings.push(artifact)
      children.set(artifact.parentSession, siblings)
    }
    const chain = new Set<SessionId>()
    let id: SessionId | undefined = artifact.id
    while (id !== undefined && !validated.has(id)) {
      const node = entries.get(id)
      if (node === undefined || chain.has(id)) {
        return { state: 'unknown', reason: { code: 'lineage', detail: node === undefined ? 'missing parent: ' + id : 'parent cycle: ' + id } }
      }
      chain.add(id)
      id = node.parentSession
    }
    for (const ancestor of chain) validated.add(ancestor)
  }
  const items: ReferenceDescendant[] = (children.get(parent) ?? []).map(artifact => ({ artifact, depth: 1 }))
  for (const item of items) {
    for (const artifact of children.get(item.artifact.id) ?? []) items.push({ artifact, depth: item.depth + 1 })
  }
  return { state: 'complete', epoch: corpus.epoch, items }
}
