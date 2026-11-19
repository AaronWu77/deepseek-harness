/** Corroborate retained lineage with each Session's own catalog and descriptor events. */
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ArtifactHeader, Evidence, MaintenanceEpoch, SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { inspectCatalogEntry } from './catalog.ts'
import { foldSubagentDescriptor } from './descriptor.ts'
import type { SubagentCatalogEntry } from './projection-types.ts'

/** A retained direct edge, measured from the requested removal target. */
export interface LineageEdge {
  readonly parentId: SessionId
  readonly childId: SessionId
  readonly depth: number
  readonly kind: 'subagent' | 'fork'
  readonly location: ArtifactHeader['location']
}

function unknownLineage(detail: string): Evidence<never> {
  return { state: 'unknown', reason: { code: 'lineage', detail } }
}

type ReferenceReader = Pick<SessionPersistence, 'isMaintenanceEpochActive' | 'inspectReferenceCorpus'>
  & Partial<Pick<SessionPersistence, 'inspectReferenceLog'>>

const staleEpoch = { state: 'unknown', reason: { code: 'stale-epoch' } } as const

type LogRow = { readonly type: string; readonly seq: number; readonly data?: unknown }
type Catalog = Map<SessionId, SubagentCatalogEntry>

/**
 * Read the target and its descendants without opening Session handles or preparing Agents.
 * @param persistence - backend that owns the supplied epoch and retained artifacts.
 * @param epoch - active exclusive maintenance scope.
 * @param targetId - Session whose descendants to check.
 * @returns corroborated subagent and fork edges, or an unknown result on incomplete evidence.
 */
export async function inspectRemovalLineage(
  persistence: ReferenceReader | undefined,
  epoch: MaintenanceEpoch,
  targetId: SessionId,
): Promise<Evidence<LineageEdge>> {
  if (persistence === undefined) return unknownLineage('Session persistence is unavailable')
  if (!persistence.isMaintenanceEpochActive(epoch)) return staleEpoch
  if (typeof persistence.inspectReferenceLog !== 'function') {
    return unknownLineage('retained Session log inspection is unavailable')
  }
  try {
    const corpus = await persistence.inspectReferenceCorpus({ epoch, includeTrash: true })
    if (!persistence.isMaintenanceEpochActive(epoch)) return staleEpoch
    if (corpus.state === 'unknown') return corpus
    if (corpus.epoch !== epoch) return staleEpoch
    const byId = new Map(corpus.items.map(artifact => [artifact.id, artifact]))
    if (byId.size !== corpus.items.length) return { state: 'unknown', reason: { code: 'duplicate-id' } }
    const target = byId.get(targetId)
    if (target === undefined) return unknownLineage('target is absent from retained corpus: ' + targetId)
    const children = new Map<SessionId, ArtifactHeader[]>()
    const reachable: ArtifactHeader[] = []
    for (const artifact of corpus.items) {
      const parentId = artifact.parentSession
      if (parentId === undefined) {
        if (artifact.origin === 'subagent') return unknownLineage('subagent header has no parent: ' + artifact.id)
        reachable.push(artifact)
        continue
      }
      if (!byId.has(parentId)) return unknownLineage('missing parent: ' + parentId)
      const siblings = children.get(parentId) ?? []
      siblings.push(artifact)
      children.set(parentId, siblings)
    }
    for (const ancestor of reachable) {
      for (const child of children.get(ancestor.id) ?? []) reachable.push(child)
    }
    if (reachable.length !== corpus.items.length) return unknownLineage('cycle in retained parent headers')

    const pending: { artifact: ArtifactHeader; depth: number; catalogRow?: SubagentCatalogEntry }[] = [
      { artifact: target, depth: 0 },
    ]
    const items: LineageEdge[] = []
    for (const { artifact, depth, catalogRow } of pending) {
      const rows: LogRow[] = []
      const body = await persistence.inspectReferenceLog(epoch, artifact, event => {
        if (event.type === 'subagent/catalog' || event.type === 'subagent/descriptor') rows.push(event)
      })
      if (!persistence.isMaintenanceEpochActive(epoch)) return staleEpoch
      if (body.state === 'unknown') return body
      if (body.epoch !== epoch) return staleEpoch
      const summary = body.items[0]
      if (summary === undefined || body.items.length !== 1) return unknownLineage('missing log summary: ' + artifact.id)
      const own = rows.filter(row => row.seq >= summary.inheritedEventCount)
      const descriptors = own.filter(row => row.type === 'subagent/descriptor')
      if (artifact.origin === 'subagent') {
        if (descriptors.length !== 1) {
          return unknownLineage('missing or ambiguous child descriptor: ' + artifact.id)
        }
        let descriptor
        try {
          descriptor = foldSubagentDescriptor(descriptors)
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          return unknownLineage('invalid child descriptor: ' + artifact.id + ': ' + detail)
        }
        if (descriptor === undefined || (catalogRow !== undefined
          && (descriptor.mode !== catalogRow.mode || descriptor.label !== catalogRow.label))) {
          return unknownLineage('child descriptor does not confirm catalog identity: ' + artifact.id)
        }
      } else if (descriptors.length !== 0) {
        return unknownLineage('child descriptor without matching subagent origin: ' + artifact.id)
      }

      const catalog: Catalog = new Map()
      const names = new Set<string>()
      for (const row of own) {
        if (row.type !== 'subagent/catalog') continue
        const entry = inspectCatalogEntry(row.data)
        if (entry === undefined || entry.mode === 'unknown' || catalog.has(entry.id)) {
          return unknownLineage('invalid or ambiguous child catalog: ' + artifact.id)
        }
        if ('name' in entry && entry.name !== undefined) {
          if (names.has(entry.name)) return unknownLineage('duplicate child catalog name: ' + artifact.id)
          names.add(entry.name)
        }
        const child = byId.get(entry.id)
        if (entry.mode === 'external' ? child !== undefined
          : child?.parentSession !== artifact.id || child.origin !== 'subagent') {
          return unknownLineage('catalog child does not match retained lineage: ' + entry.id)
        }
        catalog.set(entry.id, entry)
      }
      for (const child of children.get(artifact.id) ?? []) {
        const row = catalog.get(child.id)
        if (child.origin === 'subagent' && row === undefined) {
          return unknownLineage('missing child catalog row: ' + child.id)
        }
        const childDepth = depth + 1
        pending.push({ artifact: child, depth: childDepth, ...row === undefined ? {} : { catalogRow: row } })
        items.push({ parentId: artifact.id, childId: child.id, depth: childDepth,
          kind: child.origin === 'subagent' ? 'subagent' : 'fork', location: child.location })
      }
    }
    return { state: 'complete', epoch, items }
  } catch (error) {
    if (!persistence.isMaintenanceEpochActive(epoch)) return staleEpoch
    return { state: 'unknown', reason: { code: 'io', detail: error instanceof Error ? error.message : String(error) } }
  }
}
