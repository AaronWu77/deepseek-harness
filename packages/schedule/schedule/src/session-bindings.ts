/** Read-only reverse lookup over the full stored Schedule rows, not the catalog projection. */
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Evidence, MaintenanceEpoch } from '@deepseek-ai/dsh-session-persistence'
import type { ScheduleTask } from './storage.ts'
import type { ScheduleId } from './types.ts'

/**
 * A reference to a candidate Session. Only involved and history are nonblocking.
 * A history gap prevents complete evidence; this provider reports it as unknown instead of emitting a row.
 */
export type ScheduleBinding = { readonly taskId: ScheduleId } & (
  | {
    readonly sessionId: SessionId
    /** Ended targets are manually runnable; a last receipt can resume a pending reminder in any status. */
    readonly kind: 'active-dispatchable' | 'paused-dispatchable' | 'ended-dispatchable'
      | 'reservation' | 'in-flight' | 'involved' | 'history'
  }
  | { readonly kind: 'history-gap' }
)

/**
 * Match stored targets, retry reservations, and receipts; the caller holds the mutation FIFO.
 * @param epoch - maintenance epoch validated by the caller.
 * @param candidates - Session identities to match.
 * @param entries - authoritative stored rows, including private pending deliveries.
 * @param items - results for in-flight work; this function appends stored references.
 * @returns stored and in-flight references, or unknown for incomplete coverage.
 */
export function inspectScheduleRows(
  epoch: MaintenanceEpoch, candidates: ReadonlySet<SessionId>,
  entries: Iterable<readonly [ScheduleId, ScheduleTask]>, items: ScheduleBinding[],
): Evidence<ScheduleBinding> {
  for (const [taskId, task] of entries) {
    const { target, pendingDelivery, lastDelivery, deliveryHistory } = task
    if (pendingDelivery !== undefined && target.kind !== 'new') {
      return { state: 'unknown', reason: { code: 'unstable', detail: 'Unexpected reservation for Schedule task ' + taskId } }
    }
    if (candidates.size > 0 && (deliveryHistory.earlierRecordsUnavailable || deliveryHistory.earlierRecordsPruned)) {
      return { state: 'unknown', reason: { code: 'truncated', detail: 'history-gap: Schedule task ' + taskId } }
    }
    const dispatch = new Set<SessionId>()
    if (target.kind !== 'new') dispatch.add(target.sessionId)
    if (lastDelivery !== undefined) dispatch.add(lastDelivery.targetSessionId)
    const kind = task.status === 'active' ? 'active-dispatchable'
      : task.status === 'paused' ? 'paused-dispatchable' : 'ended-dispatchable'
    for (const sessionId of dispatch) {
      if (candidates.has(sessionId)) items.push({ kind, taskId, sessionId })
    }
    if (pendingDelivery !== undefined && candidates.has(pendingDelivery.targetSessionId)) {
      items.push({ kind: 'reservation', taskId, sessionId: pendingDelivery.targetSessionId })
    }
    for (const sessionId of new Set(task.involvedSessionIds)) {
      if (candidates.has(sessionId)) items.push({ kind: 'involved', taskId, sessionId })
    }
    const historicalSessions = new Set(deliveryHistory.records.slice(0, -1).map(receipt => receipt.targetSessionId))
    for (const sessionId of historicalSessions) {
      if (candidates.has(sessionId)) items.push({ kind: 'history', taskId, sessionId })
    }
  }
  return { state: 'complete', epoch, items }
}
