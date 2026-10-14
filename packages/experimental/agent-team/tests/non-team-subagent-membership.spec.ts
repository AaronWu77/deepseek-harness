/** Source YAML composition covers Team tool installation at child publication. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import * as sessions from '@deepseek-ai/dsh-session'
import { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import * as projections from '@deepseek-ai/dsh-session-projection'
import * as llm from '@deepseek-ai/dsh-llm'
import * as prompt from '@deepseek-ai/dsh-system-prompt'
import * as tools from '@deepseek-ai/dsh-tools'
import * as agents from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as loop from '@deepseek-ai/dsh-agent-loop'
import * as persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as query from '@deepseek-ai/dsh-session-query-sqlite'
import * as subagents from '@deepseek-ai/dsh-subagent'
import * as spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as fs from '@deepseek-ai/dsh-fs-local'
import * as directory from '@deepseek-ai/dsh-working-directory'
import * as team from '../src/index.ts'
import * as teamTools from '../../tool-agent-team/src/index.ts'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

const contexts: Context[] = []
const roots: string[] = []
const SIGNAL = new AbortController().signal
const ROUTE = { provider: 'mock', model: 'mock' }

afterEach(async () => {
  try {
    for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  } finally {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  }
})

async function boot(script: ConstructorParameters<typeof MockAdapter>[0] = [], existingRoot?: string) {
  const root = existingRoot ?? await mkdtemp(join(tmpdir(), 'dsh-team-loader-'))
  if (existingRoot === undefined) roots.push(root)
  const yaml = await readFile(new URL('./fixtures/non-team-subagents.yml', import.meta.url), 'utf8')
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, yaml.replaceAll('{{root}}', root.replaceAll('\\', '/')))
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  // Static imports resolve through tsconfig source paths, never linked package artifacts.
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-session', sessions],
    ['@deepseek-ai/dsh-session-projection', projections],
    ['@deepseek-ai/dsh-llm', llm],
    ['@deepseek-ai/dsh-system-prompt', prompt],
    ['@deepseek-ai/dsh-tools', tools],
    ['@deepseek-ai/dsh-agent', agents],
    ['@deepseek-ai/dsh-agent-loop', loop],
    ['@deepseek-ai/dsh-session-persistence-jsonl', persistence],
    ['@deepseek-ai/dsh-session-query-sqlite', query],
    ['@deepseek-ai/dsh-subagent', subagents],
    ['@deepseek-ai/dsh-subagent-spawn-in-process', spawn],
    ['@deepseek-ai/dsh-fs-local', fs],
    ['@deepseek-ai/dsh-working-directory', directory],
    ['@deepseek-ai/dsh-experimental-agent-team', team],
    ['@deepseek-ai/dsh-experimental-tool-agent-team', teamTools],
  ])
  const unsupported = (): never => { throw new Error('Unexpected Node module loader operation') }
  const internal: ModuleLoaderV2 = {
    version: 'v2', loadCache: new Map(),
    import(specifier) {
      if (!modules.has(specifier)) throw new Error('Unexpected Loader import: ' + specifier)
      return Promise.resolve(modules.get(specifier))
    },
    register: unsupported, getOrCreateModuleJob: unsupported, resolveSync: unsupported, load: unsupported,
  }
  ctx.loader.internal = internal
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  ctx.subagents.registerProvider({ name: 'once', inheritsParentContext: false,
    capabilities: { agentOptions: false, depthLimit: true, persona: false, toolFilter: false, outputSchema: false },
    prepareLocalOneShot: async () => ({}) })
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  return { ctx, root, adapter }
}

async function assembly(ctx: Context, agent: Agent) {
  return ctx.systemPrompt.assemble({ scope: agent, agent })
}

async function expectNonmember(ctx: Context, agent: Agent) {
  expect(ctx.agentTeams.tryMembership(agent)?.role).toBeUndefined()
  expect(() => ctx.agentTeams.listMembers(agent)).toThrow('is not a member of an active Agent Team')
  const assembled = await assembly(ctx, agent)
  expect(assembled.sections.some(section => section.name === 'team:policy')).toBe(false)
  expect(assembled.tools).toEqual([])
}

describe('non-Team subagents in a globally mounted Team YAML composition', () => {
  it('excludes a real local one-shot child at publication and from its model request', async () => {
    const { ctx, adapter } = await boot([textResponse('one-shot result')])
    const lead = (await ctx.agents.create({ sessionId: SessionId('lead'), agentOptions: ROUTE })).agent
    let published: Agent | undefined
    let publicationRole: string | undefined
    let hadDescriptor: boolean | undefined
    let publicationTools: string[] | undefined
    let publicationPolicy: boolean | undefined
    ctx.on('agent/created', async ({ agent }) => {
      if (agent.session.header.parentSession !== lead.id) return
      published = agent
      publicationRole = ctx.agentTeams.tryMembership(agent)?.role
      hadDescriptor = agent.session.snapshotEvents().some(event => event.type === 'subagent/descriptor')
      const assembled = await assembly(ctx, agent)
      publicationTools = assembled.tools.map(tool => tool.name)
      publicationPolicy = assembled.sections.some(section => section.name === 'team:policy')
    })
    const run = await ctx.subagents.startActivation({ provider: 'once', lifecycle: 'one-shot', label: 'one-shot task', delivery: 'caller', signal: SIGNAL,
      request: { parent: lead, prompt: [{ type: 'text', text: 'one-shot task' }] },
    })
    try {
      expect(published?.id).toBe(run.childId)
      expect(published?.session.header.origin).toBe('subagent')
      expect(hadDescriptor).toBe(true)
      expect(publicationRole).toBeUndefined()
      expect(publicationTools).toEqual([])
      expect(publicationPolicy).toBe(false)
      await expect(run.result).resolves.toMatchObject({ stopReason: 'completed' })
      expect(adapter.requests).toHaveLength(1)
      expect(adapter.requests[0]?.tools ?? []).toEqual([])
      expect(JSON.stringify(adapter.requests[0]?.messages)).not.toContain('Agent Teams is available')
      expect(ctx.agentTeams.listMembers(lead)).toHaveLength(1)
      expect(lead.session.snapshotEvents().some(event => event.type.startsWith('team/'))).toBe(false)
    } finally {
      await run.dispose()
    }
  })

  it.each(['live', 'absent'] as const)('excludes a descriptorless nonrostered child with a %s parent', async (parentState) => {
    const { ctx } = await boot()
    const parent = await ctx.agents.create({ sessionId: SessionId('parent'), agentOptions: ROUTE })
    if (parentState === 'absent') await parent.dispose()
    const child = (await ctx.agents.create({
      sessionId: SessionId('nonrostered'), agentOptions: ROUTE,
      meta: { parentSession: parent.agent.id, origin: 'subagent' },
    })).agent
    expect(child.session.snapshotEvents().some(event => event.type === 'subagent/descriptor')).toBe(false)
    await expectNonmember(ctx, child)
    if (parentState === 'live') {
      await parent.dispose()
      await expectNonmember(ctx, child)
    }
  })

  it('keeps a descriptorless origin=subagent Session excluded after a cold resume', async () => {
    const first = await boot()
    const childId = SessionId('descriptorless-resume')
    const child = await first.ctx.agents.create({
      sessionId: childId, agentOptions: ROUTE,
      meta: { parentSession: SessionId('absent-parent'), origin: 'subagent' },
    })
    await first.ctx.sessions.flush(child.agent.session)
    await child.dispose()
    await first.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(first.ctx), 1)
    const second = await boot([], first.root)
    const resumed = await second.ctx.agents.resume({ resumeSessionId: childId, agentOptions: ROUTE })
    expect(resumed.agent.session.header.origin).toBe('subagent')
    expect(resumed.agent.session.snapshotEvents().some(event => event.type === 'subagent/descriptor')).toBe(false)
    await expectNonmember(second.ctx, resumed.agent)
  })

  it('keeps ordinary host forks as independent Leads without copying a provider origin', async () => {
    const { ctx } = await boot([textResponse('source child result')])
    const lead = (await ctx.agents.create({ sessionId: SessionId('fork-parent'), agentOptions: ROUTE })).agent
    let source: Agent | undefined
    ctx.on('agent/created', ({ agent }) => { if (agent.session.header.parentSession === lead.id) source = agent })
    const run = await ctx.subagents.startActivation({ provider: 'spawn', label: 'source task', delivery: 'caller', signal: SIGNAL,
      request: { parent: lead, prompt: [{ type: 'text', text: 'source task' }] },
    })
    try {
      await run.result
      if (source === undefined) throw new Error('In-process source child is missing')
      const seed = source.session.snapshotEvents()
      expect(seed.some(event => event.type === 'subagent/descriptor')).toBe(true)
      // Host fork metadata is explicit; inherited descriptors are outside the fork's own suffix.
      const fork = (await ctx.agents.create({
        sessionId: SessionId('host-fork'), seed, inheritedEventCount: SessionLogOffset(seed.length),
        meta: { parentSession: source.id, isSeeded: true }, agentOptions: ROUTE,
      })).agent
      expect(fork.session.header.origin).toBeUndefined()
      const membership = ctx.agentTeams.membership(fork)
      expect([membership.root.id, membership.role, membership.name]).toEqual([fork.id, 'lead', 'lead'])
      expect((await assembly(ctx, fork)).sections.some(section => section.name === 'team:policy')).toBe(true)
      await run.dispose()
      expect(ctx.agentTeams.membership(fork).role).toBe('lead')
    } finally {
      await run.dispose()
    }
  })

  it('recognizes a real spawned roster teammate during provisioning and after activation', async () => {
    const { ctx } = await boot(['hang'])
    const lead = (await ctx.agents.create({ sessionId: SessionId('roster-lead'), agentOptions: ROUTE })).agent
    let child: Agent | undefined
    let publicationRole: string | undefined
    let publicationPhase: string | undefined
    let publicationPolicy: boolean | undefined
    ctx.on('agent/created', async ({ agent }) => {
      if (agent.session.header.parentSession !== lead.id) return
      child = agent
      publicationRole = ctx.agentTeams.tryMembership(agent)?.role
      publicationPhase = ctx.agentTeams.listMembers(lead).find(member => member.id === agent.id)?.status
      publicationPolicy = (await assembly(ctx, agent)).sections.some(section => section.name === 'team:policy')
    })
    const started = await ctx.agentTeams.spawnTeammate(lead, {
      name: 'worker', description: 'rostered worker', prompt: [{ type: 'text', text: 'worker task' }],
      context: 'fresh', provider: 'spawn', signal: SIGNAL,
    })
    expect(child?.id).toBe(started.member.id)
    expect(child?.session.header.origin).toBe('subagent')
    expect(publicationRole).toBe('teammate')
    expect(publicationPhase).toBe('provisioning')
    expect(publicationPolicy).toBe(true)
    const teammate = child
    if (teammate === undefined) throw new Error('Roster child is missing')
    const membership = ctx.agentTeams.membership(teammate)
    expect([membership.root.id, membership.role, membership.name]).toEqual([lead.id, 'teammate', 'worker'])
    await vi.waitFor(() => { expect(teammate.status).toBe('running') })
    expect(ctx.agentTeams.listMembers(lead).find(member => member.id === teammate.id)?.status).toBe('running')
    ctx.agentTeams.interrupt(lead, 'worker')
  })
})
