import { brandString } from '@deepseek-ai/dsh-brand'
import { MessageId } from '@deepseek-ai/dsh-llm/brand'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { MaintenanceEpoch } from '@deepseek-ai/dsh-session-persistence'
import { expect, it, onTestFinished } from 'vitest'
import { createEveryScheduleRecord, ScheduleId } from '../src/domain.ts'
import type { ScheduleDeliveryReceipt } from '../src/types.ts'
import { agentFor, harness, seededTask, seedTasks } from './harness.ts'

const epoch = brandString<MaintenanceEpoch>('schedule-evidence')
const candidate = SessionId('schedule-candidate')
const other = SessionId('schedule-other')
const future = Date.parse('2099-09-01T00:00:00.000Z')
const record = (id: string) => createEveryScheduleRecord(ScheduleId(id), 'reminder', 60, future, 'fixture')
const receipt = (id: string, targetSessionId: SessionId): ScheduleDeliveryReceipt => ({
  targetSessionId, messageId: MessageId(id), scheduledAt: '2000-01-01T00:00:00.000Z', deliveredAt: '2000-01-01T00:00:01.000Z',
})

async function fixture(...tasks: Parameters<typeof seedTasks>[1]) {
  let valid = true
  const f = await harness({
    beforeService: (_ctx, facility) => seedTasks(facility, tasks),
    isMaintenanceEpochActive: provided => valid && provided === epoch,
  })
  onTestFinished(() => f.ctx.fiber.dispose())
  return { ...f, inspect: () => f.service.inspectSessionBindings(epoch, [candidate]), expire: () => { valid = false } }
}

it.each(['active', 'paused', 'ended'] as const)('blocks a %s task with a dispatchable current target', async status => {
  const task = seededTask(record(status), { kind: 'session', sessionId: candidate }, { status })
  const f = await fixture(task)
  expect(await f.inspect()).toEqual({ state: 'complete', epoch, items: [
    { kind: status + '-dispatchable', taskId: task.record.id, sessionId: candidate },
    { kind: 'involved', taskId: task.record.id, sessionId: candidate },
  ] })
  expect(f.resolve).not.toHaveBeenCalled()
})

it('blocks the last recovery destination of an ended task without waking its Session', async () => {
  const lastDelivery = receipt('latest', candidate)
  const task = seededTask(record('retargeted'), { kind: 'session', sessionId: other }, {
    status: 'ended', lastDelivery, deliveryHistory: { records: [lastDelivery], earlierRecordsUnavailable: false, earlierRecordsPruned: false },
  })
  const f = await fixture(task)
  expect(await f.inspect()).toEqual({ state: 'complete', epoch, items: [
    { kind: 'ended-dispatchable', taskId: task.record.id, sessionId: candidate },
  ] })
  expect(f.resolve).not.toHaveBeenCalled()
})

it('retains involved and older receipt links without treating them as dispatchable', async () => {
  const lastDelivery = receipt('latest', other)
  const task = seededTask(record('history'), { kind: 'session', sessionId: other }, {
    status: 'ended', involvedSessionIds: [candidate], lastDelivery,
    deliveryHistory: { records: [receipt('old', candidate), lastDelivery], earlierRecordsUnavailable: false, earlierRecordsPruned: false },
  })
  const f = await fixture(task)
  expect(await f.inspect()).toEqual({ state: 'complete', epoch, items: [
    { kind: 'involved', taskId: task.record.id, sessionId: candidate },
    { kind: 'history', taskId: task.record.id, sessionId: candidate },
  ] })
})

it('reads a new-delivery reservation absent from the public catalog and rejects an expired epoch', async () => {
  const task = seededTask(record('reservation'), { kind: 'new', create: {} }, { pendingDelivery: { targetSessionId: candidate } })
  const f = await fixture(task)
  expect((await f.service.catalog())[0]).not.toHaveProperty('pendingDelivery')
  expect(await f.inspect()).toEqual({ state: 'complete', epoch, items: [
    { kind: 'reservation', taskId: task.record.id, sessionId: candidate },
  ] })
  f.expire()
  expect(await f.inspect()).toEqual({ state: 'unknown', reason: { code: 'stale-epoch' } })
})

it('fails closed when an inconsistent reservation cannot be interpreted', async () => {
  const task = seededTask(record('inconsistent'), { kind: 'session', sessionId: other }, { pendingDelivery: { targetSessionId: candidate } })
  const f = await fixture(task)
  expect(await f.inspect()).toMatchObject({ state: 'unknown', reason: { code: 'unstable' } })
})

it.each([true, false])('fails closed on unavailable history (pruned=%s)', async pruned => {
  const task = seededTask(record('gap'), { kind: 'new', create: {} }, {
    status: 'ended', deliveryHistory: { records: [], earlierRecordsUnavailable: true, earlierRecordsPruned: pruned },
  })
  const f = await fixture(task)
  expect(await f.inspect()).toMatchObject({ state: 'unknown', reason: { code: 'truncated', detail: 'history-gap: Schedule task gap' } })
})

it('observes an in-flight fresh delivery after its FIFO write commits and until the target goes idle', async () => {
  const task = seededTask(record('flight'), { kind: 'new', create: {} }, {
    status: 'ended', pendingDelivery: { targetSessionId: candidate },
  })
  const f = await fixture(task)
  const agent = agentFor(f.ctx, candidate)
  const idle = Promise.withResolvers<void>()
  const atFlush = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  agent.whenIdle = () => idle.promise
  f.resolve.mockResolvedValue({ agent })
  f.flush.mockImplementationOnce(() => { atFlush.resolve(); return release.promise })
  const delivery = f.service.run({ id: task.record.id })
  try {
    await atFlush.promise
    const inspection = f.inspect()
    release.resolve()
    await delivery
    expect(await inspection).toMatchObject({ state: 'complete', items: expect.arrayContaining([
      { kind: 'in-flight', taskId: task.record.id, sessionId: candidate },
    ]) })
    idle.resolve()
    await idle.promise
    expect(await f.inspect()).toEqual({ state: 'complete', epoch, items: [
      { kind: 'ended-dispatchable', taskId: task.record.id, sessionId: candidate },
    ] })
  } finally {
    release.resolve()
    idle.resolve()
    await delivery
  }
})
