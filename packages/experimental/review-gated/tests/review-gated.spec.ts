import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import * as Persona from '@deepseek-ai/dsh-persona'
import { describe, expect, it, onTestFinished } from 'vitest'
import * as Role from '../src/role.ts'

async function harness() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjections)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt, { personaPrefix: 'Deployment identity.' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  ctx.systemPrompt.section({ name: 'fixture:guidance', order: 100, text: 'Existing tool guidance.' })
  return ctx
}

describe('RG scoped role contribution', () => {
  it('adds main guidance and four owned tools without replacing Persona or global instructions', async () => {
    expect(Role.inject).toContain('sessions')
    const ctx = await harness()
    const key = { agent: 'rg-main-guidance' }
    const scope = createScope(ctx, key)
    await scope.ctx.plugin(Persona, { prefix: 'Selected PTC persona.' })
    await scope.ctx.plugin(Role, { role: 'main' })
    const assembly = await ctx.systemPrompt.assemble({ scope: key })
    const prompt = renderPrompt(assembly)
    expect(prompt).toContain('Selected PTC persona.')
    expect(prompt).toContain('Existing tool guidance.')
    expect(prompt).toContain('# RG: work and independent review')
    expect(prompt).toContain('machine-counted')
    expect(prompt).toContain('one-shot children')
    expect(assembly.sections.filter(section => section.name === 'review-gated:main')).toHaveLength(1)
    expect(ctx.tools.definitions(key).map(tool => tool.name)).toEqual(['rg_worker', 'rg_reviewer', 'rg_models', 'rg_status'])
    expect(ctx.tools.definitions()).toEqual([])
    expect(renderPrompt(await ctx.systemPrompt.assemble())).toContain('Deployment identity.')
    expect(renderPrompt(await ctx.systemPrompt.assemble())).not.toContain('# RG:')
    const otherKey = { agent: 'other-session' }
    createScope(ctx, otherKey)
    expect(renderPrompt(await ctx.systemPrompt.assemble({ scope: otherKey }))).not.toContain('# RG:')
  })

  it.each(['worker', 'reviewer'] as const)('keeps %s scoped and does not provide delegation tools to that role', async (role) => {
    const ctx = await harness()
    const key = { agent: role }
    const scope = createScope(ctx, key)
    await scope.ctx.plugin(Role, { role })
    const prompt = renderPrompt(await ctx.systemPrompt.assemble({ scope: key }))
    expect(prompt).toContain('one-shot and PTC-only')
    expect(prompt).toContain('tools.structured_output inside run_code')
    expect(prompt).not.toContain('# RG: work and independent review')
    expect(ctx.tools.definitions(key)).toEqual([])
  })

  it('removes all scoped guidance and tools on disposal and supports a fresh mount', async () => {
    const ctx = await harness()
    const key = { agent: 'rg-disposal' }
    const scope = createScope(ctx, key)
    await scope.ctx.plugin(Persona, { prefix: 'Selected persona.' })
    const fiber = await scope.ctx.plugin(Role, { role: 'main' })
    const prompt = async () => renderPrompt(await ctx.systemPrompt.assemble({ scope: key }))
    expect(ctx.tools.definitions(key)).toHaveLength(4)
    await fiber.dispose()
    expect(await prompt()).toContain('Selected persona.')
    expect(await prompt()).not.toContain('# RG:')
    expect(ctx.tools.definitions(key)).toEqual([])
    await scope.ctx.plugin(Role, { role: 'main' })
    expect(ctx.tools.definitions(key)).toHaveLength(4)
    await scope.dispose()
    expect(await prompt()).not.toContain('# RG:')
    expect(ctx.tools.definitions(key)).toEqual([])
  })

  it.each(['rg_worker', 'rg_reviewer', 'rg_models', 'rg_status'])('refuses standalone %s execution without an Agent', async (name) => {
    const ctx = await harness()
    await ctx.plugin(Role, { role: 'main' })
    const input = name === 'rg_models' ? { role: 'worker' } : name === 'rg_status' ? {} : { handoff: {
      objective: 'Inspect a file', acceptance: ['Read the file'], scope: ['file.txt'], constraints: [], facts: [], validation: [],
    } }
    const batch = await ctx.tools.execute({ calls: [{ type: 'tool-call', id: ToolCallId(name), name, arguments: JSON.stringify(input) }], signal: new AbortController().signal })
    expect(batch.results[0]?.result).toMatchObject({ isError: true, error: { info: { code: 'RG_NOT_READY' } } })
  })

  it('denies every workspace-mutating tool to a reviewer scope', async () => {
    const ctx = await harness()
    await ctx.plugin(Role, { role: 'reviewer' })
    const signal = new AbortController().signal
    for (const name of ['write', 'edit', 'apply_patch', 'str_replace_editor']) {
      const batch = await ctx.tools.execute({ calls: [{ type: 'tool-call', id: ToolCallId(name), name, arguments: '{}' }], signal })
      expect(batch.results[0]?.result, name).toMatchObject({ isError: true })
      expect(JSON.stringify(batch.results[0]?.result)).toContain('read-only')
    }
    // Read-only inspection stays available; the guard denies only mutations.
    const read = await ctx.tools.execute({ calls: [{ type: 'tool-call', id: ToolCallId('bash'),
      name: 'bash', arguments: '{"command":"true"}' }], signal })
    expect(JSON.stringify(read.results[0]?.result)).not.toContain('read-only')
  })

  it('keeps the mutation denial scoped to reviewers', async () => {
    const ctx = await harness()
    await ctx.plugin(Role, { role: 'worker' })
    const signal = new AbortController().signal
    const batch = await ctx.tools.execute({ calls: [{ type: 'tool-call', id: ToolCallId('write'),
      name: 'write', arguments: JSON.stringify({ path: 'probe.txt', content: 'x' }) }], signal })
    expect(JSON.stringify(batch.results[0]?.result)).not.toContain('read-only')
  })

  it('reports claim state through the status tool for every availability branch', async () => {
    const ctx = await harness()
    await ctx.plugin(Role, { role: 'main' })
    const input = { calls: [{ type: 'tool-call' as const, id: ToolCallId('rg_status'), name: 'rg_status', arguments: '{}' }],
      signal: new AbortController().signal }
    // No Agent at all is already covered; these branches need one with RG composed.
    const agent = { session: ctx.sessions.create(SessionId('rg-status-agent')), claimProtectionStatus: 'saving' as const,
      claimRecovery: { intentSeq: 1, target: 'next-turn' as const, turn: 1, step: 1, inputs: [] } }
    const reports: unknown[] = []
    let recorded: unknown = null
    const runtime = {
      // The main-role mutation guard reads RG state on every tool call.
      read: () => null,
      claimReport: (_session: unknown, status: unknown, claim: unknown) => {
        reports.push(claim)
        return { claimStatus: status, claim }
      },
      claimOf: () => recorded,
    }
    const child = ctx.extend({})
    child.provide('reviewGated', runtime)
    // The status tool reads only these two Agent capabilities, so a partial
    // stand-in covers the branches without fabricating a full Agent.
    const run = async (target: object) =>
      (await child.tools.execute({ ...input, agent: target as never })).results[0]?.result
    // A live saving claim is reported without consulting the projection.
    expect(JSON.stringify(await run(agent))).toContain('"claimStatus":"saving"')
    // A settled claim with no live recovery reads the projection instead.
    recorded = { intentSeq: 1, target: 'next-turn', turn: 1, step: 1, inputs: [], phase: 'rejected' }
    expect(JSON.stringify(await run({ session: agent.session, claimProtectionStatus: null, claimRecovery: null })))
      .toContain('"claimStatus":null')
    expect(reports).toHaveLength(2)
    // A live recovery without a saving status still takes the recovery branch.
    expect(JSON.stringify(await run({ session: agent.session, claimProtectionStatus: null, claimRecovery: {
      intentSeq: 2, target: 'next-turn', turn: 1, step: 1, inputs: [] } }))).toContain('"claimStatus":null')
    // No live claim and no projection fails closed rather than reporting ready.
    recorded = undefined
    expect(JSON.stringify(await run({ session: agent.session, claimProtectionStatus: null, claimRecovery: null })))
      .toContain('The input claim record is unavailable')
    // A missing protected-claim capability fails closed before any report.
    expect(JSON.stringify(await run({ session: agent.session }))).toContain('Protected input claims are unavailable')
  })

  it.each(['main', 'worker', 'reviewer'] as const)('accepts fixed role %s', (role) => {
    expect(Role.Config({ role })).toEqual({ role })
  })

  it.each<unknown>([undefined, null, '', 'coordinator', 2])('rejects an unrecognized role: %s', (role) => {
    // @ts-expect-error -- a Loader config can contain untyped JSON.
    expect(() => Role.Config({ role })).toThrow()
  })
})
