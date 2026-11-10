/** Composition-owned authorization is captured once by the existing policy producer. */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import SubagentModelSelectionConfig from '../src/model-selection-settings.ts'
import { subagentModelSelectionPolicy, subagentModelSelectionProjectionDefinition } from '../src/model-selection-state.ts'

const GLOBAL = [{ provider: 'global', model: 'default' }]
const SCOPED = [{ provider: 'scoped', model: 'worker' }]

async function setup(enabled = false) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentModelSelectionConfig, { enabled, allowedModels: GLOBAL })
  const handle = await ctx.sessionProjections.register(subagentModelSelectionProjectionDefinition)
  const create = async (name: string) => (await ctx.agents.create({ sessionId: SessionId(name) })).agent
  return { ctx, create, read: (agent: Agent) => subagentModelSelectionPolicy(handle, agent.session) }
}

describe('composition model authorization sources', () => {
  it('records one matching source without changing unrelated Sessions or global preferences', async () => {
    const f = await setup()
    f.ctx.subagentModelSelection.registerSource({
      name: 'role-policy',
      resolve: agent => agent.id === 'chosen' ? SCOPED : undefined,
    })
    const chosen = await f.create('chosen')
    expect(f.read(chosen)).toEqual(SCOPED)
    expect(chosen.session.snapshotEvents().filter(event => event.type === 'subagent/model-selection-policy'))
      .toHaveLength(1)
    expect(f.read(await f.create('ordinary'))).toBeUndefined()
  })

  it('falls back to global preferences only when every source abstains', async () => {
    const f = await setup(true)
    f.ctx.subagentModelSelection.registerSource({ name: 'other', resolve: () => undefined })
    expect(f.read(await f.create('global-fallback'))).toEqual(GLOBAL)
    f.ctx.subagentModelSelection.registerSource({ name: 'matching', resolve: () => SCOPED })
    expect(f.read(await f.create('source-overrides-global'))).toEqual(SCOPED)
  })

  it('awaits a source before publishing its recorded authorization', async () => {
    const f = await setup()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    onTestFinished(() => { release.resolve(undefined) })
    f.ctx.subagentModelSelection.registerSource({ name: 'async', resolve: async () => {
      entered.resolve(undefined)
      await release.promise
      return SCOPED
    } })
    const creation = f.create('async-source')
    await entered.promise
    release.resolve(undefined)
    expect(f.read(await creation)).toEqual(SCOPED)
  })

  it('rejects source removal during resolution rather than granting a stale decision', async () => {
    const f = await setup(true)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    onTestFinished(() => { release.resolve(undefined) })
    const remove = f.ctx.subagentModelSelection.registerSource({ name: 'removed', resolve: async () => {
      entered.resolve(undefined)
      await release.promise
      return SCOPED
    } })
    const creation = f.create('removed-source')
    const rejection = expect(creation).rejects.toThrow('sources changed during Agent creation')
    await entered.promise
    remove()
    release.resolve(undefined)
    await rejection
    expect(f.ctx.agents.get(SessionId('removed-source'))).toBeUndefined()
    expect(f.read(await f.create('after-source-removal'))).toEqual(GLOBAL)
  })

  it('removes a contribution with its registering plugin and permits replacement', async () => {
    const f = await setup()
    const fiber = await f.ctx.plugin({ name: 'authorization-owner', inject: ['subagentModelSelection'], apply(ctx: Context) {
      ctx.subagentModelSelection.registerSource({ name: 'owned', resolve: () => SCOPED })
    } })
    const before = await f.create('owned-before-disposal')
    expect(f.read(before)).toEqual(SCOPED)
    await fiber.dispose()
    expect(f.read(await f.create('owned-after-disposal'))).toBeUndefined()
    expect(f.read(before)).toEqual(SCOPED)
    f.ctx.subagentModelSelection.registerSource({ name: 'owned', resolve: () => GLOBAL })
    expect(f.read(await f.create('owned-replacement'))).toEqual(GLOBAL)
  })

  it('rejects duplicate names, overlapping matches and empty authorization', async () => {
    const f = await setup()
    const remove = f.ctx.subagentModelSelection.registerSource({ name: 'first', resolve: () => SCOPED })
    expect(() => f.ctx.subagentModelSelection.registerSource({ name: 'first', resolve: () => GLOBAL }))
      .toThrow('already registered')
    const removeOther = f.ctx.subagentModelSelection.registerSource({ name: 'second', resolve: () => GLOBAL })
    await expect(f.create('overlap')).rejects.toThrow('both match the Agent')
    remove()
    removeOther()
    const removeEmpty = f.ctx.subagentModelSelection.registerSource({ name: 'empty', resolve: () => [] })
    await expect(f.create('empty-source')).rejects.toThrow('requires at least one route')
    removeEmpty()
    f.ctx.subagentModelSelection.registerSource({ name: 'duplicates', resolve: () => [...SCOPED, ...SCOPED] })
    await expect(f.create('duplicate-routes')).rejects.toThrow('repeats route')
  })

  it('propagates source failures without publishing an Agent', async () => {
    const f = await setup(true)
    f.ctx.subagentModelSelection.registerSource({ name: 'failed', resolve: () => { throw new Error('configuration unavailable') } })
    await expect(f.create('failed-source')).rejects.toThrow('configuration unavailable')
    expect(f.ctx.agents.get(SessionId('failed-source'))).toBeUndefined()
  })

  it('inherits recorded routes for children and never resamples seeded Sessions', async () => {
    const f = await setup()
    const resolve = vi.fn(() => SCOPED)
    f.ctx.subagentModelSelection.registerSource({ name: 'once', resolve })
    const parent = await f.create('source-parent')
    const child = (await f.ctx.agents.create({ sessionId: SessionId('source-child'),
      meta: { origin: 'subagent', parentSession: parent.id } })).agent
    expect(f.read(child)).toEqual(SCOPED)
    const inherited = (await f.ctx.agents.create({ sessionId: SessionId('source-fork'), seed: parent.session.snapshotEvents() })).agent
    expect(f.read(inherited)).toEqual(SCOPED)
    const old = (await f.ctx.agents.create({ sessionId: SessionId('source-old-empty'), seed: [] })).agent
    expect(f.read(old)).toBeUndefined()
    const stored = Session.create(SessionId('stored'))
    stored.append('subagent/model-selection-policy', { allowedModels: GLOBAL })
    const restored = (await f.ctx.agents.create({ sessionId: SessionId('source-restored'), seed: stored.snapshotEvents() })).agent
    expect(f.read(restored)).toEqual(GLOBAL)
    expect(resolve).toHaveBeenCalledTimes(1)
  })
})
