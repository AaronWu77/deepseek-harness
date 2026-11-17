/** Test access to ignorable RG records without treating plugin payloads as core events. */
import { appendPluginRecord, pluginRecordOf, Session, SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { PluginRecordMap, PluginRecordType } from '@deepseek-ai/dsh-session/types'
import { scanLog, toHeaderLine } from '@deepseek-ai/dsh-session-persistence-jsonl/src/format'
import { claimRecordSchema, claimSettledRecordSchema, directPreparedRecordSchema, resultConfirmedRecordSchema, resultPreparedRecordSchema, stateRecordSchema, taskPreparedRecordSchema } from '../src/records.ts'
import { gitStateRecordSchema } from '../src/git-projection.ts'

/** Append using the public record writer and return the committed event for a fold fixture.
 * @param session - fixture Session.
 * @param type - registered plugin record name.
 * @param data - registered record payload.
 * @returns the committed event carrying the ignorable envelope.
 */
export function appendRecord<K extends Extract<keyof PluginRecordMap, PluginRecordType>>(
  session: Session, type: K, data: NoInfer<PluginRecordMap[K]>,
): SessionEvent {
  const seq = appendPluginRecord(session, type, data)
  const event = session.snapshotEvents().find(event => event.seq === seq)
  if (event === undefined) throw new Error('Expected the appended plugin record')
  return event
}

/** Validate an RG record before a test inspects its durable payload.
 * @param event - committed event from a live or replayed Session.
 * @returns the known RG record, or undefined for an unrelated event.
 */
export function recordOf(event: SessionEvent) {
  const record = pluginRecordOf(event)
  switch (record?.type) {
    case 'plugin:review-gated/claim': return { ...record, type: record.type, data: claimRecordSchema.parse(record.data) }
    case 'plugin:review-gated/claim-settled': return { ...record, type: record.type, data: claimSettledRecordSchema.parse(record.data) }
    case 'plugin:review-gated/state': return { ...record, type: record.type, data: stateRecordSchema.parse(record.data) }
    case 'plugin:review-gated/task-prepared': return { ...record, type: record.type, data: taskPreparedRecordSchema.parse(record.data) }
    case 'plugin:review-gated/direct-task-prepared': return { ...record, type: record.type, data: directPreparedRecordSchema.parse(record.data) }
    case 'plugin:review-gated/git-state': return { ...record, type: record.type, data: gitStateRecordSchema.parse(record.data) }
    case 'plugin:review-gated/result-prepared': return { ...record, type: record.type, data: resultPreparedRecordSchema.parse(record.data) }
    case 'plugin:review-gated/result-confirmed': return { ...record, type: record.type, data: resultConfirmedRecordSchema.parse(record.data) }
    default: return undefined
  }
}

/** Collect validated RG payloads without losing their committed sequence positions.
 * @param events - live or replayed events.
 * @returns only the recognized RG records.
 */
export function recordsOf(events: readonly SessionEvent[]) { return events.map(recordOf).filter(record => record !== undefined) }

/** Parse malformed test records through durable JSON ingress rather than casting core event types.
 * @param rows - JSON log rows, including deliberately invalid plugin data.
 * @returns decoded Session events with opaque plugin data.
 */
export function durableEvents<T extends { readonly seq: number }>(rows: readonly T[]): readonly SessionEvent[] {
  const session = Session.create(SessionId('rg-record-jsonl'), [])
  const log = [JSON.stringify(toHeaderLine(session.header)), ...rows.map((row, seq) => JSON.stringify({ ...row, seq })), ''].join('\n')
  const events = scanLog(Buffer.from(log)).events
  if (events.length !== rows.length) throw new Error('The fixture did not decode every durable record')
  return events.map((event, index) => ({ ...event, seq: SessionSeq(rows[index]!.seq) }))
}
