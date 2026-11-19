import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { MaintenanceEpoch } from '@deepseek-ai/dsh-session-persistence'
import { MemoryMediaPool } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { ReferenceProducerGate } from '../src/reference-quiescence.ts'
import type { ScheduleCreateRequest, ScheduleEditRequest } from '../src/types.ts'
import { agentFor, gatedScheduleBackend, harness } from './harness.ts'

const held = { code: 'REFERENCE_PRODUCER_BUSY', reason: 'busy', phase: 'held' }
const request = {
  title: 'A reminder', prompt: 'Remember', timing: { kind: 'after', after_seconds: 1 }, target: { kind: 'new' },
} satisfies ScheduleCreateRequest
const contexts: Awaited<ReturnType<typeof harness>>[] = []
async function setup(options: Parameters<typeof harness>[0] = {}) {
  const h = await harness(options)
  contexts.push(h)
  return h
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-16T00:00:00Z')) })
afterEach(async () => {
  try { await Promise.all(contexts.splice(0).map(({ ctx }) => ctx.fiber.dispose())) }
  finally { vi.useRealTimers(); vi.restoreAllMocks() }
})

it('leaves the default producer paths untracked', async () => {
  const admit = vi.spyOn(ReferenceProducerGate.prototype, 'admit')
  const continuation = vi.spyOn(ReferenceProducerGate.prototype, 'admitContinuation')
  const { service } = await setup()
  expect(service.referenceQuiescenceEnabled()).toBe(false)
  expect(Reflect.get(service, 'referenceGate')).toBeUndefined()
  const fn = vi.fn(async () => {})
  await expect(service.withReferenceQuiescence('disabled', fn))
    .rejects.toMatchObject({ code: 'REFERENCE_QUIESCENCE_DISABLED', reason: 'disabled' })
  expect(fn).not.toHaveBeenCalled()
  const task = await service.create(request)
  expect(await service.edit({ id: task.id, action: 'update', patch: { active: false } })).toMatchObject({ status: 'paused' })
  expect(await service.edit({ id: task.id, action: 'delete' })).toEqual({ id: task.id, deleted: true })
  expect(admit).not.toHaveBeenCalled()
  expect(continuation).not.toHaveBeenCalled()
})

it('refuses all mutation entries and defers a due new-Session delivery until release', async () => {
  const { ctx, service, createSession, resolve } = await setup({ config: { referenceQuiescence: true } })
  const admit = vi.spyOn(ReferenceProducerGate.prototype, 'admit')
  const calls = admit.mock.calls.length
  expect(service.referenceQuiescenceEnabled()).toBe(true)
  expect(admit).toHaveBeenCalledTimes(calls)
  const signal = AbortSignal.abort(new Error('pre-aborted'))
  const callback = vi.fn(async () => {})
  await expect(service.withReferenceQuiescence('cancelled', callback, { signal })).rejects.toBe(signal.reason)
  expect(callback).not.toHaveBeenCalled()
  let deliveryAgent: ReturnType<typeof agentFor> | undefined
  createSession.mockImplementation(async ({ sessionId }) => {
    deliveryAgent = agentFor(ctx, sessionId)
    resolve.mockResolvedValue({ agent: deliveryAgent })
    return { sessionId: deliveryAgent.id }
  })
  const task = await service.create(request)
  await vi.advanceTimersByTimeAsync(0)
  await expect(service.withReferenceQuiescence('maintenance', async ({ holder }) => {
    expect(holder).toBe('maintenance')
    await expect(service.withReferenceQuiescence('competing', callback)).rejects.toMatchObject(held)
    const edits: ScheduleEditRequest[] = [
      { id: task.id, action: 'update', patch: { title: 'Edited' } },
      { id: task.id, action: 'update', patch: { active: false } },
      { id: task.id, action: 'update', patch: { active: true } },
      { id: task.id, action: 'delete' },
    ]
    for (const edit of edits) await expect(service.edit(edit)).rejects.toMatchObject(held)
    await expect(service.create(request)).rejects.toMatchObject(held)
    await expect(service.run({ id: task.id })).rejects.toMatchObject(held)
    await expect(service.deleteInactive()).rejects.toMatchObject(held)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(createSession).not.toHaveBeenCalled()
    expect(resolve).not.toHaveBeenCalled()
    expect(await service.view({ id: task.id })).toMatchObject({ status: 'active', title: request.title })
    throw new Error('callback failed')
  })).rejects.toThrow('callback failed')
  await vi.advanceTimersByTimeAsync(0)
  expect(createSession).toHaveBeenCalledOnce()
  expect(deliveryAgent?.followup).toHaveBeenCalledOnce()
  expect(await service.view({ id: task.id })).toMatchObject({ status: 'ended' })
  expect(await service.deleteInactive()).toEqual({ deleted: 1 })
})

it('drains an already accepted write and its change notice before entering maintenance', async () => {
  const writing = Promise.withResolvers<void>()
  const finishWrite = Promise.withResolvers<void>()
  const notify = Promise.withResolvers<void>()
  const finishNotice = Promise.withResolvers<void>()
  const pool = new MemoryMediaPool()
  const { ctx, service, flush } = await setup({ config: { referenceQuiescence: true }, pool,
    backend: gatedScheduleBackend(pool, { putRecord: async () => { writing.resolve(); await finishWrite.promise } }),
  })
  const target = agentFor(ctx, 'notice-target')
  await ctx.agents.register(target)
  flush.mockImplementationOnce(async () => { notify.resolve(); await finishNotice.promise })
  const create = service.create({ ...request, target: { kind: 'session', sessionId: target.id } })
  const fn = vi.fn(async () => {})
  let maintenance: Promise<void> | undefined
  try {
    await writing.promise
    await expect(service.withReferenceQuiescence('timeout', fn, { drainTimeoutMs: 0 }))
      .rejects.toMatchObject({ ...held, phase: 'drain-timeout' })
    maintenance = service.withReferenceQuiescence('drain', fn)
    finishWrite.resolve()
    await create
    await notify.promise
    await expect(service.withReferenceQuiescence('during-notice', async () => {})).rejects.toMatchObject(held)
    expect(fn).not.toHaveBeenCalled()
    expect(target.inject).toHaveBeenCalledOnce()
  } finally {
    finishWrite.resolve()
    finishNotice.resolve()
    await create
    await maintenance
  }
  expect(fn).toHaveBeenCalledOnce()
})

it('allows archive stop while held and sends its deferred notice once after release', async () => {
  const epoch = brandString<MaintenanceEpoch>('schedule-notice-fixture')
  const { ctx, service } = await setup({
    config: { referenceQuiescence: true }, isMaintenanceEpochActive: candidate => candidate === epoch,
  })
  const editor = agentFor(ctx, 'editor')
  await ctx.agents.register(editor)
  const archived = SessionId('archived')
  const task = await service.create({ ...request, target: { kind: 'session', sessionId: archived } }, editor.id)
  await service.withReferenceQuiescence('archive stop', async () => {
    await ctx.parallel('workspace/session-stop', { sessionId: archived })
    expect(await service.view({ id: task.id })).toEqual({ id: task.id, code: 'schedule_not_found' })
    expect(await service.inspectSessionBindings(epoch, [editor.id])).toEqual({
      state: 'complete', epoch, items: [{ kind: 'in-flight', taskId: task.id, sessionId: editor.id }],
    })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(editor.inject).not.toHaveBeenCalled()
  })
  await vi.advanceTimersByTimeAsync(0)
  expect(editor.inject).toHaveBeenCalledOnce()
  expect(editor.inject.mock.calls[0]?.[0].content).toMatchObject([{ type: 'text', text: expect.stringContaining('change: deleted') }])
})
