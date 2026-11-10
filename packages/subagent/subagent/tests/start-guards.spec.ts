/** Start admission applies to every backend before child resources exist. */
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import SubagentRuntime, { SubagentError, type SubagentActivationSpec, type SubagentStartGuard } from '../src/index.ts'
import { mountWorkingDirectoryFixture } from './working-directory-fixture.ts'

async function setup() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await mountWorkingDirectoryFixture(ctx)
  await ctx.plugin(SubagentRuntime)
  const { agent: parent } = await ctx.agents.create({ sessionId: SessionId('guard-parent') })
  let starts = 0
  const prepare = vi.fn(async () => ({}))
  ctx.subagents.registerProvider({
    name: 'local', inheritsParentContext: false,
    capabilities: { agentOptions: true, agentPreset: true, outputSchema: true, depthLimit: true },
    prepareContinuable: prepare,
    prepareLocalOneShot: prepare,
  })
  ctx.subagents.registerProvider({
    name: 'external', inheritsParentContext: false,
    capabilities: { agentOptions: true, agentPreset: false, outputSchema: true, depthLimit: true },
    start: async () => ({
      id: SessionId(`external-guard-child-${++starts}`),
      result: Promise.resolve({ stopReason: 'completed' as const, output: [] }),
      dispose: async () => {},
    }),
  })
  const spec: SubagentActivationSpec = {
    provider: 'external', label: 'guarded work', delivery: 'caller',
    signal: new AbortController().signal,
    request: { parent, prompt: [{ type: 'text', text: 'task' }], agentOptions: { provider: 'llm', model: 'candidate' } },
  }
  return { ctx, parent, spec, prepare, starts: () => starts }
}

describe('subagent start guards', () => {
  it.each(['external', 'continuable', 'one-shot'] as const)('rejects %s starts before provider execution or child publication', async (kind) => {
    const f = await setup()
    const seen: SubagentActivationSpec[] = []
    f.ctx.subagents.guardStarts((spec) => {
      seen.push(spec)
      throw new SubagentError('role model is outside the reserved policy', 'UNAUTHORIZED')
    })
    const spec: SubagentActivationSpec = kind === 'external' ? f.spec : {
      ...f.spec, provider: 'local', lifecycle: kind, childId: SessionId('reserved-guard-child'),
    }
    await expect(f.ctx.subagents.startActivation(spec)).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    expect(seen).toEqual([spec])
    expect(f.prepare).not.toHaveBeenCalled()
    expect(f.starts()).toBe(0)
    expect(f.ctx.agents.list()).toEqual([f.parent])
    expect(f.parent.session.snapshotEvents().filter(event => event.type === 'subagent/catalog')).toEqual([])
  })

  it('lets all current checks inspect the complete route without rewriting it', async () => {
    const f = await setup()
    const check = vi.fn((spec: Readonly<SubagentActivationSpec>) => {
      expect(spec).toBe(f.spec)
      expect(spec.request.parent).toBe(f.parent)
      expect(spec.request.agentOptions).toEqual({ provider: 'llm', model: 'candidate' })
    })
    f.ctx.subagents.guardStarts(check)
    const run = await f.ctx.subagents.startActivation(f.spec)
    await expect(run.result).resolves.toMatchObject({ stopReason: 'completed' })
    expect(check).toHaveBeenCalledOnce()
    expect(f.starts()).toBe(1)
    await run.dispose()
  })

  it('does not let an earlier accepting check bypass a later rejection', async () => {
    const f = await setup()
    const first = vi.fn()
    const last = vi.fn()
    f.ctx.subagents.guardStarts(first)
    f.ctx.subagents.guardStarts(() => { throw new Error('blocked by second policy') })
    f.ctx.subagents.guardStarts(last)
    await expect(f.ctx.subagents.startActivation(f.spec)).rejects.toThrow('blocked by second policy')
    expect(first).toHaveBeenCalledOnce()
    expect(last).not.toHaveBeenCalled()
    expect(f.starts()).toBe(0)
  })

  it('owns repeated registrations of the same callback independently', async () => {
    const f = await setup()
    const check = vi.fn<SubagentStartGuard>()
    const removeFirst = f.ctx.subagents.guardStarts(check)
    const removeSecond = f.ctx.subagents.guardStarts(check)
    f.ctx.subagents.guardStarts(() => { throw new Error('finish observation') })
    await expect(f.ctx.subagents.startActivation(f.spec)).rejects.toThrow('finish observation')
    expect(check).toHaveBeenCalledTimes(2)
    removeFirst()
    await expect(f.ctx.subagents.startActivation(f.spec)).rejects.toThrow('finish observation')
    expect(check).toHaveBeenCalledTimes(3)
    removeSecond()
    await expect(f.ctx.subagents.startActivation(f.spec)).rejects.toThrow('finish observation')
    expect(check).toHaveBeenCalledTimes(3)
  })

  it('withdraws a guard with its owning plugin without revoking an admitted run', async () => {
    const f = await setup()
    const result = Promise.withResolvers<{ stopReason: 'completed'; output: [] }>()
    onTestFinished(() => { result.resolve({ stopReason: 'completed', output: [] }) })
    f.ctx.subagents.registerProvider({
      name: 'pending', inheritsParentContext: false,
      capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
      start: async () => ({ id: SessionId('pending-guard-child'), result: result.promise, dispose: async () => {} }),
    })
    const fiber = await f.ctx.plugin({ name: 'start-policy-owner', inject: ['subagents'], apply(ctx: Context) {
      ctx.subagents.guardStarts((spec) => {
        if (spec.provider !== 'pending') throw new Error('only pending is allowed')
      })
    } })
    const run = await f.ctx.subagents.startActivation({ ...f.spec, provider: 'pending', request: { parent: f.parent, prompt: [] } })
    await expect(f.ctx.subagents.startActivation(f.spec)).rejects.toThrow('only pending is allowed')
    await fiber.dispose()
    const next = await f.ctx.subagents.startActivation(f.spec)
    await next.result
    result.resolve({ stopReason: 'completed', output: [] })
    await expect(run.result).resolves.toMatchObject({ stopReason: 'completed' })
    await next.dispose()
    await run.dispose()
  })
})
