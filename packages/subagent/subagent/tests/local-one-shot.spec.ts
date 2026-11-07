/** Real local AgentLoop one-shot admission, teardown and terminal catalog records. */
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import SubagentRuntime from '../src/index.ts'
import { ChildLock } from '../src/activation.ts'
import type { LocalOneShotCreateRequest, LocalOneShotCreateSpec } from '../src/index.ts'
import { mountLocalActivations } from './local-activation.ts'
import { TestSessionQuery } from './test-session-query.ts'

async function setup(script: ConstructorParameters<typeof MockAdapter>[0] = [textResponse('done')], prepared: LocalOneShotCreateSpec = {}) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  await mountLocalActivations(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(SubagentRuntime)
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const parentHandle = await ctx.agents.create({ sessionId: SessionId('parent'), agentOptions: { provider: 'mock', model: 'mock' } })
  const parent = parentHandle.agent
  const prepare = vi.fn(async (_request: LocalOneShotCreateRequest, _managedSignal: AbortSignal) => prepared)
  ctx.subagents.registerProvider({ name: 'once', inheritsParentContext: false,
    capabilities: { agentOptions: false, depthLimit: true, agentPreset: false, outputSchema: false },
    prepareLocalOneShot: prepare })
  const spec = { provider: 'once', lifecycle: 'one-shot' as const, childId: SessionId('child'), label: 'one task', delivery: 'caller' as const,
    signal: new AbortController().signal, request: { parent, maxDepth: 1, prompt: [{ type: 'text' as const, text: 'task' }] } }
  return { ctx, parent, parentHandle, adapter, spec, prepare }
}

describe('local one-shot activation', () => {
  it('returns real child identity, output and one-shot logs after child cleanup', async () => {
    const f = await setup()
    const run = await f.ctx.subagents.startActivation(f.spec)
    expect(run.childId).toBe(f.spec.childId)
    expect(run.messageId).toBeDefined()
    expect(run).not.toHaveProperty('localAgent')
    await expect(run.result).resolves.toEqual({ stopReason: 'completed', output: [{ type: 'text', text: 'done' }] })
    expect(f.ctx.agents.get(run.childId)).toBeUndefined()
    expect(f.ctx.agents.roots()).toEqual([f.parent])
    expect(f.parent.session.snapshotEvents().filter(e => e.type === 'subagent/catalog').map(e => e.data)).toEqual([
      expect.objectContaining({ mode: 'one-shot', childId: run.childId, label: 'one task' }),
    ])
    const stored = await f.ctx.sessionPersistence.open(run.childId, 'read')
    try {
      const log = await stored.read()
      expect(stored.header.parentSession).toBe(f.parent.id)
      expect(log.events.filter(e => e.type === 'subagent/descriptor').map(e => e.data)).toEqual([
        expect.objectContaining({ mode: 'one-shot', provider: 'once', label: 'one task' }),
      ])
    } finally { await stored.close() }
    await expect(f.ctx.subagents.sendMessage(f.parent, run.childId, [], { signal: f.spec.signal })).rejects.toMatchObject({ code: 'NOT_RESUMABLE' })
    await run.dispose()
  })

  it('seeds captured permissions and directory before trusted hooks despite later parent changes', async () => {
    const { default: SandboxPolicy, setSandboxMode } = await import('@deepseek-ai/dsh-sandbox-policy')
    const { default: ApprovalService } = await import('@deepseek-ai/dsh-user-approval')
    const { resolve } = await import('node:path')
    const f = await setup()
    await f.ctx.plugin(SandboxPolicy, { mode: 'read-only' })
    await f.ctx.plugin(ApprovalService, { policy: 'ask' })
    setSandboxMode(f.parent.session, 'workspace-write')
    const expectedDirectory = resolve(f.ctx.workingDirectory.get(f.parent.session), 'one-shot-origin')
    const observed: string[] = []
    const inspect = (child: import('@deepseek-ai/dsh-agent').Agent): void => {
      expect(f.ctx.sandboxPolicy.overrideOf(child.session)).toBe('workspace-write')
      expect(f.ctx.workingDirectory.get(child.session)).toBe(expectedDirectory)
      expect(child.session.header.cwd).toBe(expectedDirectory)
      expect(child.session.snapshotEvents().filter(event => event.type === 'approval/policy'))
        .toMatchObject([{ data: { policy: 'never', source: 'delegation' } }])
    }
    f.prepare.mockImplementation(async (request) => {
      expect(request.cwd).toBe(expectedDirectory)
      setSandboxMode(f.parent.session, 'read-only')
      await f.ctx.workingDirectory.set(f.parent, 'later-parent-directory')
      return {
        setup: async (_ctx, child) => { inspect(child); observed.push('setup') },
        preflight: async (child) => { inspect(child); observed.push('preflight') },
      }
    })
    const run = await f.ctx.subagents.startActivation({ ...f.spec, request: { ...f.spec.request, cwd: 'one-shot-origin' } })
    await run.result
    expect(observed).toEqual(['setup', 'preflight'])
    expect(f.ctx.sandboxPolicy.overrideOf(f.parent.session)).toBe('read-only')
    expect(f.ctx.agents.get(run.childId)).toBeUndefined()
    await run.dispose()
  })

  it('rejects a stale parent, depth and unsupported permission options before preparation', async () => {
    const f = await setup()
    await expect(f.ctx.subagents.startActivation({ ...f.spec, request: { ...f.spec.request, parent: { ...f.parent } } })).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    await expect(f.ctx.subagents.startActivation({ ...f.spec, request: { ...f.spec.request, maxDepth: 0 } })).rejects.toThrow('depth')
    await expect(f.ctx.subagents.startActivation({ ...f.spec, request: { ...f.spec.request, agentPreset: 'unsupported' } })).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' })
    expect(f.prepare).not.toHaveBeenCalled()
    expect(f.ctx.agents.roots()).toEqual([f.parent])
  })

  it('rejects duplicate ids before another hook and rejects live follow-up input', async () => {
    const f = await setup(['hang'])
    const run = await f.ctx.subagents.startActivation(f.spec)
    await expect(f.ctx.subagents.startActivation(f.spec)).rejects.toMatchObject({ code: 'DUPLICATE_CHILD' })
    expect(f.prepare).toHaveBeenCalledTimes(1)
    await expect(f.ctx.subagents.sendMessage(f.parent, run.childId, [], { signal: f.spec.signal })).rejects.toMatchObject({ code: 'NOT_CONTINUABLE' })
    await run.dispose()
    expect((await run.result).stopReason).toBe('aborted')
    expect(f.ctx.agents.get(run.childId)).toBeUndefined()
    await expect(f.ctx.subagents.startActivation(f.spec)).rejects.toMatchObject({ code: 'DUPLICATE_CHILD' })
    await run.dispose()
  })

  it.each(['setup', 'preflight'] as const)('rolls back a throwing %s hook without leaked Agents', async (hook) => {
    const f = await setup([], { [hook]: async () => { throw new Error('hook failed') } })
    await expect(f.ctx.subagents.startActivation(f.spec)).rejects.toThrow('hook failed')
    expect(f.ctx.agents.get(f.spec.childId)).toBeUndefined()
    expect(f.ctx.agents.roots()).toEqual([f.parent])
    expect(f.adapter.requests).toEqual([])
    expect(f.parent.session.snapshotEvents().filter(e => e.type === 'subagent/catalog')).toEqual([])
  })

  it('drains cancellation from the request signal after publication', async () => {
    const f = await setup(['hang'])
    const entered = Promise.withResolvers<true>()
    f.ctx.on('agent/assistant-stream', ({ agent, frame }) => { if (agent.id === f.spec.childId && frame.type === 'start') entered.resolve(true) })
    const controller = new AbortController()
    const run = await f.ctx.subagents.startActivation({ ...f.spec, signal: controller.signal })
    await entered.promise
    controller.abort(new Error('parent cancelled'))
    expect((await run.result).stopReason).toBe('aborted')
    expect(f.ctx.agents.get(run.childId)).toBeUndefined()
    await run.dispose()
  })

  it('settles model failure as an error after cleanup', async () => {
    const f = await setup([() => { throw new Error('model failed') }])
    const run = await f.ctx.subagents.startActivation(f.spec)
    expect((await run.result).stopReason).toBe('error')
    expect(f.ctx.agents.get(run.childId)).toBeUndefined()
    await run.dispose()
  })

  it.each(['descendant drain', 'parent handle disposal'] as const)('joins pending preparation during %s', async (teardown) => {
    const f = await setup([])
    const entered = Promise.withResolvers<true>()
    const release = Promise.withResolvers<true>()
    onTestFinished(() => { release.resolve(true) })
    let observedSignal: AbortSignal | undefined
    let stopped = false
    f.prepare.mockImplementation(async (request, managedSignal) => {
      expect(request.signal).toBe(f.spec.signal)
      observedSignal = managedSignal
      entered.resolve(true)
      try {
        await new Promise<void>((resolve, reject) => {
          observedSignal?.throwIfAborted()
          observedSignal?.addEventListener('abort', () => reject(observedSignal?.reason), { once: true })
          void release.promise.then(() => resolve())
        })
        return {}
      } finally { stopped = true }
    })
    const startup = f.ctx.subagents.startActivation(f.spec)
    const observed = startup.then(() => undefined, error => error)
    await entered.promise
    if (teardown === 'descendant drain') await f.ctx.subagents.drainDescendants([f.parent])
    else await f.parentHandle.dispose()
    expect(observedSignal?.aborted).toBe(true)
    expect(await observed).toBeInstanceOf(Error)
    expect(stopped).toBe(true)
    expect(f.spec.signal.aborted).toBe(false)
    expect(f.ctx.agents.get(f.spec.childId)).toBeUndefined()
    expect(f.parent.session.snapshotEvents().filter(event => event.type === 'subagent/catalog')).toEqual([])
    expect(f.adapter.requests).toEqual([])
  })

  it('drains startup during directory resolution before acquiring the child lock', async () => {
    const f = await setup([])
    const entered = Promise.withResolvers<true>()
    let directorySignal: AbortSignal | undefined
    const ensure = vi.spyOn(f.ctx.workingDirectory, 'ensure').mockImplementation(async (_agent, signal) => {
      directorySignal = signal
      entered.resolve(true)
      return await new Promise<string>((_resolve, reject) => {
        signal?.throwIfAborted()
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    })
    onTestFinished(() => { ensure.mockRestore() })
    const observed = f.ctx.subagents.startActivation(f.spec).then(() => undefined, error => error)
    await entered.promise
    await f.ctx.subagents.drainDescendants([f.parent])
    expect(directorySignal?.aborted).toBe(true)
    expect(await observed).toBeInstanceOf(Error)
    expect(f.prepare).not.toHaveBeenCalled()
    expect(f.ctx.agents.get(f.spec.childId)).toBeUndefined()
    expect(f.spec.signal.aborted).toBe(false)
  })

  it('joins a resident parent ownership hold through preparation rollback', async () => {
    const f = await setup(['hang'])
    f.ctx.subagents.registerProvider({ name: 'resident', inheritsParentContext: false,
      capabilities: { agentOptions: false, depthLimit: true, agentPreset: false, outputSchema: false },
      prepareContinuable: async () => ({}) })
    const resident = await f.ctx.subagents.startActivation({ ...f.spec, provider: 'resident', lifecycle: 'continuable', childId: SessionId('resident') })
    const parent = f.ctx.agents.get(resident.childId)!
    const entered = Promise.withResolvers<true>()
    let preparationSignal: AbortSignal | undefined
    let stopped = false
    f.prepare.mockImplementation(async (_request, managedSignal) => {
      preparationSignal = managedSignal
      entered.resolve(true)
      try {
        await new Promise<void>((_resolve, reject) => {
          managedSignal.throwIfAborted()
          managedSignal.addEventListener('abort', () => reject(managedSignal.reason), { once: true })
        })
        return {}
      } finally { stopped = true }
    })
    const observed = f.ctx.subagents.startActivation({ ...f.spec, request: { ...f.spec.request, parent, maxDepth: 2 } })
      .then(() => undefined, error => error)
    await entered.promise
    await resident.dispose()
    expect(preparationSignal?.aborted).toBe(true)
    expect(stopped).toBe(true)
    expect(await observed).toBeInstanceOf(Error)
    expect(f.ctx.agents.get(resident.childId)).toBeUndefined()
    expect(f.ctx.agents.get(f.spec.childId)).toBeUndefined()
    expect(parent.session.snapshotEvents().filter(event => event.type === 'subagent/catalog')).toEqual([])
    await resident.dispose()
  })

  it('cancels a queued child lock without releasing the preceding operation or bypassing its tail', async () => {
    const lock = new ChildLock()
    const entered = Promise.withResolvers<true>()
    const release = Promise.withResolvers<true>()
    onTestFinished(() => { release.resolve(true) })
    const first = lock.run(SessionId('ordered'), async () => { entered.resolve(true); await release.promise; return 1 })
    await entered.promise
    const controller = new AbortController()
    const cancelledCallback = vi.fn(async () => 2)
    const second = lock.run(SessionId('ordered'), cancelledCallback, controller.signal).then(() => undefined, error => error)
    const laterCallback = vi.fn(async () => 3)
    const later = lock.run(SessionId('ordered'), laterCallback)
    controller.abort(new Error('cancel queued startup'))
    expect(await second).toBeInstanceOf(Error)
    expect(cancelledCallback).not.toHaveBeenCalled()
    expect(laterCallback).not.toHaveBeenCalled()
    release.resolve(true)
    expect(await first).toBe(1)
    expect(await later).toBe(3)
    expect(cancelledCallback).not.toHaveBeenCalled()
    expect(laterCallback).toHaveBeenCalledOnce()
  })

  it('aborts pending native preflight when the real parent handle is disposed', async () => {
    const entered = Promise.withResolvers<true>()
    let probeSignal: AbortSignal | undefined
    let stopped = false
    const f = await setup([], { preflight: async (_child, signal) => {
      probeSignal = signal
      entered.resolve(true)
      try {
        await new Promise<void>((_resolve, reject) => {
          signal.throwIfAborted()
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      } finally { stopped = true }
    } })
    const startup = f.ctx.subagents.startActivation(f.spec)
    const observed = startup.then(() => undefined, error => error)
    await entered.promise
    expect(f.ctx.agents.get(f.spec.childId)).toBeDefined()
    await f.parentHandle.dispose()
    expect(probeSignal?.aborted).toBe(true)
    expect(await observed).toBeInstanceOf(Error)
    expect(stopped).toBe(true)
    expect(f.spec.signal.aborted).toBe(false)
    expect(f.ctx.agents.get(f.spec.childId)).toBeUndefined()
    expect(f.ctx.agents.roots()).toEqual([])
    expect(f.parent.session.snapshotEvents().filter(event => event.type === 'subagent/catalog')).toEqual([])
    expect(f.adapter.requests).toEqual([])
  })

  it('removes the one-shot child when its real parent handle is disposed', async () => {
    const f = await setup(['hang'])
    const run = await f.ctx.subagents.startActivation(f.spec)
    await f.parentHandle.dispose()
    expect((await run.result).stopReason).toBe('aborted')
    expect(f.ctx.agents.get(run.childId)).toBeUndefined()
    expect(f.ctx.agents.roots()).toEqual([])
    await run.dispose()
  })

  it('waits for live one-shot cleanup before parent handle disposal resolves', async () => {
    const cleaning = Promise.withResolvers<true>()
    const release = Promise.withResolvers<true>()
    const f = await setup(['hang'], { setup: async childCtx => {
      childCtx.effect(() => async () => {
        cleaning.resolve(true)
        await release.promise
      }, 'test one-shot cleanup')
    } })
    const run = await f.ctx.subagents.startActivation(f.spec)
    const disposal = f.parentHandle.dispose()
    await cleaning.promise
    let parentDisposed = false
    void disposal.then(() => { parentDisposed = true })
    await Promise.resolve()
    expect(parentDisposed).toBe(false)
    expect(f.ctx.agents.get(run.childId)).toBeDefined()
    release.resolve(true)
    await disposal
    expect((await run.result).stopReason).toBe('aborted')
    expect(f.ctx.agents.get(run.childId)).toBeUndefined()
    expect(f.ctx.agents.roots()).toEqual([])
    await run.dispose()
  })

  it('drains a parent teardown with its live one-shot child', async () => {
    const f = await setup(['hang'])
    const run = await f.ctx.subagents.startActivation(f.spec)
    await f.ctx.subagents.drainDescendants([f.parent])
    expect((await run.result).stopReason).toBe('aborted')
    expect(f.ctx.agents.get(run.childId)).toBeUndefined()
    await run.dispose()
  })
})
