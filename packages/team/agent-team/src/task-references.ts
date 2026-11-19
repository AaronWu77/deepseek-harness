/** Reverse lookup over authoritative retained Lead task logs in the Team mutation FIFO. */
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ArtifactHeader, Evidence, MaintenanceEpoch, SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { TeamJournal } from './journal.ts'
import { inspectTeamProjection } from './projection.ts'
import type { TeamTaskReference } from './types.ts'

type ReferenceReader = Pick<SessionPersistence, 'isMaintenanceEpochActive' | 'inspectReferenceCorpus'>
  & Partial<Pick<SessionPersistence, 'inspectReferenceLog'>>

const staleEpoch = { state: 'unknown', reason: { code: 'stale-epoch' } } as const

type LogRow = { readonly type: string; readonly seq: number; readonly data?: unknown }

/**
 * Read retained Team boards without opening a Session or waking a Lead.
 * @param persistence - backend that owns this epoch and the retained logs.
 * @param journal - transaction queue shared with Team mutations.
 * @param epoch - active exclusive maintenance scope.
 * @param sessionIds - owning Lead or task owner identities to match.
 * @returns nonterminal references and deleted tombstones, or unknown for incomplete evidence.
 */
export async function inspectSessionTaskReferences(
  persistence: ReferenceReader | undefined,
  journal: Pick<TeamJournal, 'transact'>,
  epoch: MaintenanceEpoch,
  sessionIds: readonly SessionId[],
): Promise<Evidence<TeamTaskReference>> {
  if (persistence === undefined) {
    return { state: 'unknown', reason: { code: 'io', detail: 'Session persistence is unavailable' } }
  }
  if (!persistence.isMaintenanceEpochActive(epoch)) return staleEpoch
  if (typeof persistence.inspectReferenceLog !== 'function') {
    return { state: 'unknown', reason: { code: 'io', detail: 'retained Session log inspection is unavailable' } }
  }
  const readLog = persistence.inspectReferenceLog.bind(persistence)
  const candidates = new Set(sessionIds)
  try {
    const corpus = await persistence.inspectReferenceCorpus({ epoch, includeTrash: true })
    if (!persistence.isMaintenanceEpochActive(epoch)) return staleEpoch
    if (corpus.state === 'unknown') return corpus
    if (corpus.epoch !== epoch) return staleEpoch
    const items: TeamTaskReference[] = []
    for (const artifact of corpus.items) {
      const board = await journal.transact(artifact.id, () => inspectBoard(persistence, readLog, epoch, artifact, candidates))
      if (!persistence.isMaintenanceEpochActive(epoch)) return staleEpoch
      if (board.state === 'unknown') return board
      for (const item of board.items) items.push(item)
    }
    return { state: 'complete', epoch, items }
  } catch (error) {
    if (!persistence.isMaintenanceEpochActive(epoch)) return staleEpoch
    return { state: 'unknown', reason: { code: 'io', detail: error instanceof Error ? error.message : String(error) } }
  }
}

async function inspectBoard(
  persistence: ReferenceReader, readLog: SessionPersistence['inspectReferenceLog'], epoch: MaintenanceEpoch,
  artifact: ArtifactHeader, candidates: ReadonlySet<SessionId>,
): Promise<Evidence<TeamTaskReference>> {
  if (!persistence.isMaintenanceEpochActive(epoch)) return staleEpoch
  const rows: LogRow[] = []
  const evidence = await readLog(epoch, artifact, event => {
    if (event.type === 'team/task' || event.type === 'team/mode') rows.push(event)
  })
  if (!persistence.isMaintenanceEpochActive(epoch)) return staleEpoch
  if (evidence.state === 'unknown') return evidence
  if (evidence.epoch !== epoch) return staleEpoch
  const summary = evidence.items[0]
  if (summary === undefined || evidence.items.length !== 1) {
    return { state: 'unknown', reason: { code: 'io', detail: 'missing Team log summary: ' + artifact.id } }
  }
  const board = inspectTeamProjection(artifact.id, summary.inheritedEventCount, rows)
  if (board.failure !== undefined || (artifact.origin === 'subagent' && board.tasks.length !== 0)) {
    const detail = board.failure ?? 'task board belongs to a subagent Session'
    return { state: 'unknown', reason: { code: 'io', detail: 'Team projection for ' + artifact.id + ': ' + detail } }
  }
  const items: TeamTaskReference[] = []
  for (const task of board.tasks) {
    if (!candidates.has(artifact.id) && (task.ownerId === undefined || !candidates.has(task.ownerId))) continue
    const fields = { rootId: artifact.id, taskId: task.id, revision: task.revision,
      ...task.ownerId === undefined ? {} : { ownerId: task.ownerId } }
    if (task.status === 'deleted') items.push({ ...fields, kind: 'tombstone', status: task.status })
    if (task.status === 'pending' || task.status === 'in_progress') {
      items.push({ ...fields, kind: 'reference', status: task.status })
    }
  }
  return { state: 'complete', epoch, items }
}
