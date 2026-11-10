/** Host runtime regressions over real AgentLoop, preset, projection, persistence, and one-shot services. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import Settings from '@deepseek-ai/dsh-settings'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import { initProfile, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import { SessionId, SessionLogOffset, type SessionEvent } from '@deepseek-ai/dsh-session'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SessionWriteLease } from '@deepseek-ai/dsh-session-persistence-jsonl/src/lease.ts'
import { SessionAlreadyOwnedError } from '@deepseek-ai/dsh-session-persistence'
import Subagents from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { createUserMessage, LlmAdapter, ReasoningEffortId, ToolCallId,
  type ContentBlock, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { PeerId, RemoteInvocation } from '@deepseek-ai/dsh-typert-protocol'
import ModelSelectionSettings from '@deepseek-ai/dsh-tool-subagent/model-selection-settings'
import type {} from '@deepseek-ai/dsh-tool-subagent/src/model-selection-state.ts'
import type {} from '@deepseek-ai/dsh-fs'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import { workerOutputSchema } from '../src/report-schema.ts'
import ReviewGated from '../src/runtime.ts'
import * as Role from '../src/role.ts'
import { defaultSettings } from '../src/config.ts'
import { sessionStateSchema } from '../src/schemas.ts'
import type { RgHandoff, RgSessionState, RgSettings } from '../src/types.ts'
import { rgProjectionDefinition } from '../src/projection.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    /** Test-only non-owner caller shared by the access specs. */
    'test-guest': { readonly kind: 'test-guest'; readonly guest: string }
  }
}

const high = ReasoningEffortId('high')
const low = ReasoningEffortId('low')
const main = { provider: 'fixture', model: 'main', reasoningEffort: 'high' }
const worker = { provider: 'fixture', model: 'worker' }
const pool = (route: typeof worker & { reasoningEffort?: string }) => ({
  candidates: [{ ...route }], default: { provider: route.provider, model: route.model },
})
const settings = (): RgSettings => ({ ...defaultSettings(), configured: true, main: pool(main), worker: pool(worker) })
const handoff: RgHandoff = { objective: 'Inspect the requested file', acceptance: ['Read the scoped file'], scope: ['probe.txt'],
  constraints: ['Do not change files'], facts: [], validation: ['Inspect probe.txt'] }
const report = { kind: 'reviewer', verdict: 'pass', summary: 'The inspected file meets the request', inspectedScope: ['probe.txt'],
  findings: [], validation: ['Read probe.txt'], unverified: [] }

function text(value: string): StreamChunk[] {
  return [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text: value },
    { type: 'block-end', index: 0, block: { type: 'text', text: value } }, { type: 'finish', reason: { kind: 'stop' } }]
}
function structured(value: object): StreamChunk[] {
  const args = JSON.stringify(value)
  const id = ToolCallId('formal-report')
  return [{ type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name: 'structured_output', argumentsDelta: args },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'structured_output', arguments: args } },
    { type: 'finish', reason: { kind: 'tool-calls' } }]
}

type Script = (options: GenerateOptions) => StreamChunk[] | Promise<StreamChunk[]>
class ControlledAdapter extends LlmAdapter {
  readonly calls: GenerateOptions[] = []
  script: Script = options => options.model === 'main' || options.model === 'prior' ? text('Main is idle') : structured(
    options.model === 'worker' ? { kind: 'worker', outcome: 'completed', summary: 'Inspected the file', changes: [], validation: [], unverified: [] } : report)

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model, reasoning: { efforts: [{ id: high, name: 'High' }, { id: low, name: 'Low' }], defaultEffort: low } }
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    const chunks = await this.script(options)
    options.signal?.throwIfAborted()
    yield* chunks
  }
}

async function setup(input = settings(),
  options: { readonly modelSelection?: boolean; readonly settings?: boolean; readonly persistence?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-rg-runtime-'))
  const ctx = new Context()
  const releases: (() => void)[] = []
  onTestFinished(async () => {
    for (const release of releases) release()
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  await writeFile(join(root, 'probe.txt'), 'the scoped implementation')
  await ctx.plugin(Loader)
  if (options.settings) {
    const dir = join(root, 'profile')
    await mkdir(dir)
    initProfile(dir, [])
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'rg-settings-installation' }))
    const profile: ProfileContext = { name: 'rg-settings', dir, patchPath: join(dir, 'cordis.patch.yml'),
      installAnchor: join(root, 'package.json'), cwd: root, home: root, startedBundles: [], overlays: [], telemetryDisabledEnv: undefined }
    ctx.provide('profileContext', profile)
    await ctx.plugin(ConfigEditor)
    await ctx.plugin(Settings)
  }
  ctx.loader.builtins.rgRole = Role
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  // The reviewer role enforces its read-only claim through the sandbox policy.
  await ctx.plugin(SandboxPolicy, { mode: 'danger-full-access', workspaceRoot: root })
  const loop = await mountAgentLoopTestHarness(ctx)
  if (options.persistence !== false) await ctx.plugin(Jsonl, { root: join(root, 'sessions'), compression: 'none' })
  await ctx.plugin(AgentPresets, { default: 'standard' })
  for (const [id, role] of [['standard', null], ['rg', 'main'], ['rg-worker', 'worker'], ['rg-reviewer', 'reviewer']] as const) {
    await ctx.plugin({ inject: ['agentPresets'], async *apply(child: Context) {
      yield await child.agentPresets.register({ id, plugins: role === null ? [] : [{ name: 'cordis:rgRole', config: { role } }] })
    } })
  }
  await ctx.plugin(Subagents)
  if (options.modelSelection) await ctx.plugin(ModelSelectionSettings)
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  const adapter = new ControlledAdapter()
  ctx.effect(() => ctx.llm.registerAdapter(['fixture'], adapter))
  ctx.loader.builtins.rgRuntime = ReviewGated
  const runtimeId = await ctx.loader.create({ name: 'cordis:rgRuntime', config: { settings: input } })
  const entry = ctx.loader.resolve(runtimeId)
  if (entry.fiber === undefined) throw new Error('RG runtime entry did not activate')
  const runtimeFiber = entry.fiber
  await runtimeFiber.await()
  const update = async (next: RgSettings) => {
    await entry.update({ config: { settings: next } })
    if (entry.fiber === undefined) throw new Error('RG runtime entry stopped after a settings update')
    await entry.fiber.await()
  }
  const runtime = () => ctx.reviewGated
  let sequence = 0
  const create = async (preset = 'rg', seed?: readonly SessionEvent[],
    agentOptions: AgentOptions = { provider: 'fixture', model: 'prior', reasoningEffort: low }) => {
    const handle = await ctx.agents.create({ sessionId: SessionId('rg-runtime-' + String(++sequence)),
      agentOptions, meta: { cwd: root },
      ...seed === undefined ? {} : { seed }, setup: async (agentCtx, agent) => {
        await ctx.agentPresets.mount(agentCtx, preset)
        if (ctx.agentPresets.presetForSession(agent.session) === null) agent.session.append('agent-preset/selected', { agentPreset: preset })
      } })
    return handle
  }
  const task = async () => {
    const handle = await create()
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Inspect the requested implementation' }], source: { kind: 'user' } }))
    await handle.agent.whenIdle()
    expect(runtime().read(handle.agent.session)?.task?.objective).toBe('Inspect the requested implementation')
    return handle
  }
  const until = (id: SessionId, predicate: (state: RgSessionState | null) => boolean) => {
    const agent = ctx.agents.get(id)
    const current = agent === undefined ? null : runtime().read(agent.session)
    if (predicate(current)) return Promise.resolve(current)
    return new Promise<RgSessionState | null>((resolve) => {
      const off = ctx.on('session/event', (session, event) => {
        if (session.id !== id || (event.type !== 'review-gated/state' && event.type !== 'review-gated/result-confirmed')) return
        const state = runtime().read(session)
        if (predicate(state)) { off(); resolve(state) }
      })
    })
  }
  const gate = () => {
    const deferred = Promise.withResolvers<undefined>()
    releases.push(() => { deferred.resolve(undefined) })
    return deferred
  }
  const call = async (agent: Agent, name: string, input: object = {}) => {
    const batch = await ctx.tools.execute({ agent, signal: new AbortController().signal,
      calls: [{ type: 'tool-call', id: ToolCallId(name), name, arguments: JSON.stringify(input) }] })
    return batch.results[0]!.result
  }
  const notice = (parent: Agent) => {
    const delivered = Promise.withResolvers<string>()
    const off = ctx.on('agent/inbox/claimed', ({ agent, message }) => {
      if (agent === parent && message.source.kind === 'review-gated') {
        off(); delivered.resolve(message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(''))
      }
    })
    return delivered.promise
  }
  const enabled = async (value: boolean) => {
    await entry.update({ disabled: !value })
    if (value) {
      if (entry.fiber === undefined) throw new Error('RG runtime entry did not reenable')
      await entry.fiber.await()
    }
  }
  return { ctx, root, loop, get runtime() { return ctx.reviewGated },
    runtimeFiber, update, enabled, adapter, create, task, until, gate, call, notice }
}

describe('RG Host runtime', () => {
  it('isolates the reserved task from reentrant inbox mutation and competing input', async () => {
    const f = await setup()
    const { agent } = await f.create()
    const other = createUserMessage({ content: [{ type: 'text', text: 'Observer input' }], source: { kind: 'user' } })
    const blocked: string[] = []
    const claimed: string[] = []
    const offInserted = f.ctx.on('agent/inbox/inserted', ({ agent: candidate, message }) => {
      if (candidate !== agent || !message.content.some(block => block.type === 'text' && block.text === 'Reserved task')) return
      for (const [name, mutate] of [['remove', () => agent.inbox.remove(message.id)], ['replace', () => agent.inbox.replace(message.id, other)], ['clear', () =>{  agent.inbox.clear() }]] as const) {
        try { mutate() } catch { blocked.push(name) }
      }
      agent.inbox.prepend('next-turn', other)
    })
    const offClaimed = f.ctx.on('agent/inbox/claimed', ({ agent: candidate, message }) => { if (candidate === agent) claimed.push(message.id) })
    onTestFinished(() => { offInserted(); offClaimed() })
    const task = await f.runtime.newTask(agent, 'Reserved task')
    await agent.whenIdle()
    expect(blocked).toEqual(['remove', 'replace', 'clear'])
    expect(claimed[0]).toBe(task.originMessageId)
    expect(agent.session.snapshotEvents().some(event => event.type === 'agent/admission/confirmed' && event.data.messageId === task.originMessageId)).toBe(true)
  })

  it.each(['runExclusiveAdmission', 'exclusiveAdmission', 'isExclusiveAdmissionClaim'] as const)('refuses task creation without Agent %s capability', async (capability) => {
    const f = await setup()
    const { agent } = await f.create()
    const previous = Object.getOwnPropertyDescriptor(agent, capability)
    Object.defineProperty(agent, capability, { configurable: true, value: undefined })
    try {
      const before = agent.session.snapshotEvents()
      await expect(f.runtime.newTask(agent, 'Unavailable admission')).rejects.toMatchObject({
        code: 'review-gated/refused', details: { reason: 'RG_NOT_READY' },
      })
      expect(agent.session.snapshotEvents()).toEqual(before)
      expect(f.adapter.calls).toHaveLength(0)
    } finally {
      if (previous === undefined) Reflect.deleteProperty(agent, capability)
      else Object.defineProperty(agent, capability, previous)
    }
  })

  it('authorizes only the exact signal-bound first human claim', async () => {
    const f = await setup()
    const { agent } = await f.create()
    let checked = false
    const off = f.ctx.on('agent/pre-step', async ({ agent: candidate, signal, messages, modelSelection }, next) => {
      if (candidate !== agent) return next()
      expect(messages).toHaveLength(1)
      const message = messages[0]!
      const context = { signal, messages }
      expect(f.runtime.read(agent.session)?.diagnostic).toContain('RG_TASK_SAVE_UNCERTAIN')
      expect(() =>{  f.runtime.assertRequest(agent, modelSelection) }).toThrow()
      expect(() =>{  f.runtime.assertRequest(agent, modelSelection, { signal: new AbortController().signal, messages }) }).toThrow()
      expect(() =>{  f.runtime.assertRequest(agent, modelSelection, { signal, messages: [{ ...message, id: createUserMessage({ content: [], source: { kind: 'user' } }).id }] }) }).toThrow()
      expect(() =>{  f.runtime.assertRequest(agent, modelSelection, { signal, messages: [{ ...message, source: { kind: 'system-prompt' } }] }) }).toThrow()
      expect(() =>{  f.runtime.assertRequest(agent, modelSelection, { signal, messages: [{ ...message, content: [{ type: 'text', text: 'Other' }] }] }) }).toThrow()
      expect(() =>{  f.runtime.assertRequest(agent, modelSelection, { signal, messages: [...messages, createUserMessage({ content: [{ type: 'text', text: 'Competing' }], source: { kind: 'user' } })] }) }).toThrow()
      await expect(f.runtime.startRole(agent, 'worker', handoff, undefined, new AbortController().signal)).rejects.toThrow()
      await expect(f.runtime.newTask(agent, 'Competing task')).rejects.toThrow()
      f.runtime.assertRequest(agent, modelSelection, context)
      checked = true
      return next()
    }, { prepend: true })
    onTestFinished(() => { off() })
    const task = await f.runtime.newTask(agent, '  Exact task  ')
    await agent.whenIdle()
    expect(checked).toBe(true)
    expect(f.adapter.calls.filter(call => call.model === 'main')).toHaveLength(1)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.id === task.originMessageId)).toHaveLength(1)
  })

  it('refuses to fork a confirmed task before its first claim without changing the parent', async () => {
    const f = await setup()
    const { agent } = await f.create()
    const entered = Promise.withResolvers<undefined>()
    const release = f.gate()
    const original = f.ctx.sessions.flush.bind(f.ctx.sessions)
    let held = false
    const spy = vi.spyOn(f.ctx.sessions, 'flush').mockImplementation(async (session) => {
      const result = await original(session)
      if (session === agent.session && !held && session.snapshotEvents().some(event => event.type === 'agent/admission/confirmed')) {
        held = true
        entered.resolve(undefined)
        await release.promise
      }
      return result
    })
    onTestFinished(() => { spy.mockRestore() })
    const operation = f.runtime.newTask(agent, 'Forked confirmed task')
    void operation.catch(() => { /* Teardown may interrupt admission after an assertion failure. */ })
    await entered.promise
    const events = agent.session.snapshotEvents()
    expect(events.some(event => event.type === 'agent/admission/confirmed')).toBe(true)
    expect(events.some(event => event.type === 'user/message')).toBe(false)
    await expect(f.ctx.agents.create({ sessionId: SessionId('rg-confirmed-fork'), seed: events,
      inheritedEventCount: SessionLogOffset(events.length), meta: { cwd: f.root, isSeeded: true },
      agentOptions: { provider: 'fixture', model: 'prior', reasoningEffort: low },
      setup: async (child) => { await f.ctx.agentPresets.mount(child, 'rg') } })).rejects.toThrow('cannot fork an outstanding exclusive admission')
    expect(agent.session.snapshotEvents()).toEqual(events)
    expect(f.adapter.calls).toHaveLength(0)
    release.resolve(undefined)
    await operation
    await agent.whenIdle()
  })

  it('quarantines a live task when confirmation flush throws after physical persistence', async () => {
    const f = await setup()
    const { agent } = await f.create()
    const flush = f.ctx.sessions.flush.bind(f.ctx.sessions)
    let failedConfirmation = false
    const spy = vi.spyOn(f.ctx.sessions, 'flush').mockImplementation(async (session) => {
      const accepted = await flush(session)
      if (session === agent.session && !failedConfirmation
        && session.snapshotEvents().some(event => event.type === 'agent/admission/confirmed')) {
        failedConfirmation = true
        throw new Error('confirmation acknowledgement lost')
      }
      return accepted
    })
    onTestFinished(() => { spy.mockRestore() })
    const outcome = await f.runtime.newTask(agent, 'Unknown confirmation').then(() => null, (error: unknown) => error)
    expect(failedConfirmation).toBe(true)
    expect(outcome).toMatchObject({ code: 'review-gated/refused', details: { reason: 'RG_NOT_READY' } })
    expect(f.runtime.read(agent.session)?.diagnostic).toContain('RG_TASK_SAVE_UNCERTAIN')
    await expect(f.runtime.startRole(agent, 'worker', handoff, undefined, new AbortController().signal)).rejects.toMatchObject({ code: 'RG_NOT_READY' })
    expect(f.adapter.calls).toHaveLength(0)
    const stored = await f.ctx.sessionPersistence.open(agent.id, 'read')
    try {
      const events = (await stored.read()).events
      expect(events.some(event => event.type === 'agent/admission/confirmed')).toBe(true)
      const recovered = f.ctx.sessionProjections.restore({}, events, SessionLogOffset(0), stored.header, stored.inheritedEventCount)
      expect(recovered.snapshot.values.reviewGated).toMatchObject({ task: { objective: 'Unknown confirmation' }, diagnostic: null })
    } finally { await stored.close() }
  })

  it('does not trust a physical receipt before its independent confirmation', async () => {
    const f = await setup()
    const { agent } = await f.create()
    await f.runtime.newTask(agent, 'Receipt crash prefix')
    await agent.whenIdle()
    await f.ctx.sessionPersistence.flush()
    const stored = await f.ctx.sessionPersistence.open(agent.id, 'read')
    try {
      const events = (await stored.read()).events
      const receipt = events.findIndex(event => event.type === 'agent/inbox/spliced'
        && event.data.inserted.some(message => message.content.some(block => block.type === 'text' && block.text === 'Receipt crash prefix')))
      expect(receipt).toBeGreaterThanOrEqual(0)
      const cut = receipt + 1
      const prefix = events.slice(0, cut)
      const restored = f.ctx.sessionProjections.restore(
        {}, prefix, SessionLogOffset(0), stored.header, stored.inheritedEventCount)
      expect(restored.snapshot.values.reviewGated).toMatchObject({ task: { objective: 'Receipt crash prefix' } })
      expect(restored.snapshot.values.reviewGated?.diagnostic).toContain('RG_TASK_SAVE_UNCERTAIN')
      const resumed = f.ctx.sessionProjections.restore(
        restored.checkpoint, events.slice(cut), SessionLogOffset(cut), stored.header, stored.inheritedEventCount)
      const full = f.ctx.sessionProjections.restore(
        {}, events, SessionLogOffset(0), stored.header, stored.inheritedEventCount)
      expect(resumed.snapshot.values.reviewGated).toEqual(full.snapshot.values.reviewGated)
    } finally { await stored.close() }
  })

  it('keeps the physical task prefix unusable until the matching independent confirmation', async () => {
    const f = await setup()
    const { agent } = await f.create()
    let lastTaskStateSeq: number | undefined
    let stateBeforeReceipt: number | undefined
    const off = f.ctx.on('session/event', (session, event) => {
      if (session !== agent.session) return
      if (event.type === 'review-gated/task-prepared' && event.data.state.task?.objective === 'Persisted task') lastTaskStateSeq = event.seq
      if (event.type === 'agent/inbox/spliced' && event.data.inserted.some(message => message.source.kind === 'user'
        && message.content.some(block => block.type === 'text' && block.text === 'Persisted task'))) stateBeforeReceipt = lastTaskStateSeq
    })
    try {
      const task = await f.runtime.newTask(agent, 'Persisted task')
      await agent.whenIdle()
      await f.ctx.sessionPersistence.flush()
      const stored = await f.ctx.sessionPersistence.open(agent.id, 'read')
      try {
        const events = (await stored.read()).events
        const receiptIndex = events.findIndex(event => event.type === 'agent/inbox/spliced'
          && event.data.inserted.some(message => message.id === task.originMessageId))
        expect(receiptIndex).toBeGreaterThan(0)
        expect(stateBeforeReceipt).toBeDefined()
        const prefix = events.slice(0, receiptIndex)
        expect(prefix.some(event => event.seq === stateBeforeReceipt && event.type === 'review-gated/task-prepared')).toBe(true)
        const recovered = f.ctx.sessionProjections.restore(
          {}, prefix, SessionLogOffset(0), stored.header, stored.inheritedEventCount)
        expect(recovered.snapshot.values.reviewGated).toMatchObject({ task: { id: task.id } })
        expect(recovered.snapshot.values.reviewGated?.diagnostic).toContain('RG_TASK_SAVE_UNCERTAIN')
        const full = f.ctx.sessionProjections.restore(
          {}, events, SessionLogOffset(0), stored.header, stored.inheritedEventCount)
        expect(full.snapshot.values.reviewGated).toMatchObject({ task: { id: task.id }, diagnostic: null })
        const opened = events.findIndex(event => event.type === 'agent/admission/opened' && event.data.messageId === task.originMessageId)
        const prepared = events.findIndex(event => event.type === 'review-gated/task-prepared' && event.data.messageId === task.originMessageId)
        const confirmed = events.findIndex(event => event.type === 'agent/admission/confirmed' && event.data.messageId === task.originMessageId)
        expect(opened).toBeGreaterThanOrEqual(0)
        expect(prepared).toBeGreaterThan(opened)
        expect(receiptIndex).toBeGreaterThan(prepared)
        expect(confirmed).toBeGreaterThan(receiptIndex)
        for (const index of [opened, prepared, confirmed]) expect(events[index]?.ignorable).toBeUndefined()
        for (let cut = opened + 1; cut <= confirmed; cut++) {
          const partial = f.ctx.sessionProjections.restore(
            {}, events.slice(0, cut), SessionLogOffset(0), stored.header, stored.inheritedEventCount)
          expect(partial.snapshot.values.reviewGated?.diagnostic).toContain('RG_TASK_SAVE_UNCERTAIN')
          const replayed = f.ctx.sessionProjections.restore(
            partial.checkpoint, events.slice(cut), SessionLogOffset(cut), stored.header, stored.inheritedEventCount)
          expect(replayed.snapshot.values.reviewGated).toEqual(full.snapshot.values.reviewGated)
        }
        const resumed = f.ctx.sessionProjections.restore(recovered.checkpoint, events.slice(receiptIndex),
          SessionLogOffset(receiptIndex), stored.header, stored.inheritedEventCount)
        expect(resumed.snapshot.values.reviewGated).toEqual(full.snapshot.values.reviewGated)
        expect(events.filter(event => event.type === 'user/message' && event.data.id === task.originMessageId)).toHaveLength(1)
        expect(f.adapter.calls.filter(call => call.model === 'main')).toHaveLength(1)
      } finally { await stored.close() }
    } finally { off() }
  })

  it('reads the physically persisted task before delivery starts', async () => {
    const f = await setup()
    const { agent } = await f.create()
    const original = f.ctx.sessions.flush.bind(f.ctx.sessions)
    let checked = false
    const flush = vi.spyOn(f.ctx.sessions, 'flush').mockImplementation(async (session) => {
      const accepted = await original(session)
      if (session === agent.session && !checked && session.snapshotEvents().some(event => event.type === 'review-gated/task-prepared')) {
        checked = true
        const stored = await f.ctx.sessionPersistence.open(agent.id, 'read')
        try {
          const events = (await stored.read()).events
          expect(events.some(event => event.type === 'agent/inbox/spliced')).toBe(false)
          const recovered = f.ctx.sessionProjections.restore(
            {}, events, SessionLogOffset(0), stored.header, stored.inheritedEventCount)
          expect(recovered.snapshot.values.reviewGated).toMatchObject({ task: { objective: 'Before delivery' } })
          expect(recovered.snapshot.values.reviewGated?.diagnostic).toContain('RG_TASK_SAVE_UNCERTAIN')
        } finally { await stored.close() }
      }
      return accepted
    })
    onTestFinished(() => { flush.mockRestore() })
    await f.runtime.newTask(agent, 'Before delivery')
    await agent.whenIdle()
    expect(checked).toBe(true)
    expect(f.runtime.read(agent.session)?.diagnostic).toBeNull()
  })

  it('keeps the receipt and confirmation ordered when an inbox observer throws', async () => {
    const f = await setup()
    const { agent } = await f.create()
    let observed = false
    const off = f.ctx.on('agent/inbox/inserted', ({ agent: candidate, message }) => {
      if (candidate === agent && message.content.some(block => block.type === 'text' && block.text === 'Delivery failure')) {
        observed = true
        throw new Error('controlled failure after inbox delivery')
      }
    })
    onTestFinished(() => { off() })
    const task = await f.runtime.newTask(agent, 'Delivery failure')
    await agent.whenIdle()
    expect(observed).toBe(true)
    await f.ctx.sessionPersistence.flush()
    const stored = await f.ctx.sessionPersistence.open(agent.id, 'read')
    try {
      const events = (await stored.read()).events
      const receipt = events.findIndex(event => event.type === 'agent/inbox/spliced'
        && event.data.inserted.some(message => message.id === task.originMessageId))
      const confirmed = events.findIndex(event => event.type === 'agent/admission/confirmed'
        && event.data.messageId === task.originMessageId)
      expect(receipt).toBeGreaterThanOrEqual(0)
      expect(confirmed).toBeGreaterThan(receipt)
      const prefix = f.ctx.sessionProjections.restore(
        {}, events.slice(0, confirmed), SessionLogOffset(0), stored.header, stored.inheritedEventCount)
      expect(prefix.snapshot.values.reviewGated?.diagnostic).toContain('RG_TASK_SAVE_UNCERTAIN')
    } finally { await stored.close() }
  })

  it.each(['next-step', 'next-turn'] as const)('refuses a new task with existing %s input without changing the old task', async (target) => {
    const f = await setup()
    const { agent } = await f.task()
    const old = f.runtime.read(agent.session)
    const input = createUserMessage({ content: [{ type: 'text', text: 'Pending context' }], source: { kind: 'user' } })
    if (target === 'next-step') agent.inject(input)
    else agent.send(input, 'next-turn', false)
    expect(agent.status).toBe('idle')
    const followup = vi.spyOn(agent, 'followup')
    const calls = f.adapter.calls.length
    await expect(f.runtime.newTask(agent, 'Must not overwrite')).rejects.toMatchObject({
      code: 'review-gated/refused', details: { reason: 'RG_BUSY' },
    })
    expect(f.runtime.read(agent.session)).toEqual(old)
    expect((target === 'next-step' ? agent.inbox.nextStep : agent.inbox.nextTurn).map(message => message.id)).toEqual([input.id])
    expect(followup).not.toHaveBeenCalled()
    expect(f.adapter.calls).toHaveLength(calls)
  })

  it('does not deliver a task when context is injected during its save', async () => {
    const f = await setup()
    const { agent } = await f.create()
    const entered = Promise.withResolvers<undefined>()
    const release = f.gate()
    const original = f.ctx.sessions.flush.bind(f.ctx.sessions)
    const flush = vi.spyOn(f.ctx.sessions, 'flush').mockImplementation(async (session) => {
      if (session === agent.session && session.snapshotEvents().some(event => event.type === 'review-gated/task-prepared')) {
        entered.resolve(undefined)
        await release.promise
      }
      return original(session)
    })
    onTestFinished(() => { flush.mockRestore() })
    const followup = vi.spyOn(agent, 'followup')
    const starting = f.runtime.newTask(agent, 'Save with competing context')
    const outcome = starting.then(() => null, (error: unknown) => error)
    await entered.promise
    const input = createUserMessage({ content: [{ type: 'text', text: 'Injected while saving' }], source: { kind: 'user' } })
    agent.inject(input)
    expect(agent.status).toBe('idle')
    expect(agent.inbox.nextStep.map(message => message.id)).toEqual([input.id])
    release.resolve(undefined)
    expect(await outcome).toMatchObject({ code: 'review-gated/refused', details: { reason: 'RG_NOT_READY' } })
    expect(f.runtime.read(agent.session)).toMatchObject({ task: { objective: 'Save with competing context' } })
    expect(f.runtime.read(agent.session)?.diagnostic).toContain('RG_TASK_SAVE_UNCERTAIN')
    expect(followup).not.toHaveBeenCalled()
    expect(f.adapter.calls).toHaveLength(0)
    await f.ctx.sessionPersistence.flush()
    const stored = await f.ctx.sessionPersistence.open(agent.id, 'read')
    try {
      const events = (await stored.read()).events
      const restored = f.ctx.sessionProjections.restore({}, events, SessionLogOffset(0), stored.header, stored.inheritedEventCount)
      expect(restored.snapshot.values.reviewGated?.diagnostic).toContain('RG_TASK_SAVE_UNCERTAIN')
      expect(events.some(event => event.type === 'agent/inbox/spliced'
        && event.data.inserted.some(message => message.id === f.runtime.read(agent.session)?.task?.originMessageId))).toBe(false)
    } finally { await stored.close() }
  })

  it('refuses overlapping task and role admission without blocking another Agent', async () => {
    const f = await setup()
    const { agent } = await f.create()
    const other = await f.create()
    const entered = Promise.withResolvers<undefined>()
    const release = f.gate()
    const original = f.ctx.sessions.flush.bind(f.ctx.sessions)
    const spy = vi.spyOn(f.ctx.sessions, 'flush').mockImplementation(async (session) => {
      if (session === agent.session && session.snapshotEvents().some(event => event.type === 'review-gated/task-prepared')) { entered.resolve(undefined); await release.promise }
      return original(session)
    })
    onTestFinished(() => { spy.mockRestore() })
    const first = f.runtime.newTask(agent, 'Task A')
    await entered.promise
    const before = f.runtime.read(agent.session)?.task
    await expect(f.runtime.newTask(agent, 'Task B')).rejects.toMatchObject({ code: 'review-gated/refused', details: { reason: 'RG_BUSY' } })
    await expect(f.runtime.startRole(agent, 'worker', handoff, undefined, new AbortController().signal)).rejects.toMatchObject({ code: 'RG_BUSY' })
    const unrelated = await f.runtime.newTask(other.agent, 'Other task')
    await other.agent.whenIdle()
    expect(unrelated.objective).toBe('Other task')
    release.resolve(undefined)
    const task = await first
    await agent.whenIdle()
    expect(task.id).toBe(before?.id)
    expect(f.runtime.read(agent.session)?.task).toMatchObject({ id: task.id, objective: 'Task A', workerAttempts: 0 })
    expect(agent.session.snapshotEvents().filter(event => event.type === 'user/message').map(event => event.data.id)).toContain(task.originMessageId)
  })

  it('does not deliver a pending task to an Agent disposed during its flush', async () => {
    const f = await setup()
    const handle = await f.create()
    const { agent } = handle
    const entered = Promise.withResolvers<undefined>()
    const release = f.gate()
    const original = f.ctx.sessions.flush.bind(f.ctx.sessions)
    const spy = vi.spyOn(f.ctx.sessions, 'flush').mockImplementation(async (session) => {
      if (session === agent.session && session.snapshotEvents().some(event => event.type === 'review-gated/task-prepared')) { entered.resolve(undefined); await release.promise }
      return original(session)
    })
    onTestFinished(() => { spy.mockRestore() })
    const followup = vi.spyOn(agent, 'followup')
    const pending = f.runtime.newTask(agent, 'Task during disposal')
    const outcome = pending.then(() => null, (error: unknown) => error)
    await entered.promise
    const disposing = Promise.withResolvers<undefined>()
    agent.ctx.effect(() => () => { disposing.resolve(undefined) })
    const disposed = handle.dispose()
    await disposing.promise
    release.resolve(undefined)
    await disposed
    expect(await outcome).toMatchObject({ code: 'review-gated/refused' })
    expect(followup).not.toHaveBeenCalled()
    expect(agent.session.snapshotEvents().some(event => event.type === 'user/message')).toBe(false)
    const resumed = await f.ctx.agents.resume({ resumeSessionId: agent.id,
      setup: async (childCtx) => { await f.ctx.agentPresets.mount(childCtx, 'rg') } })
    expect(f.runtime.read(resumed.agent.session)?.diagnostic).toContain('RG_TASK_SAVE_UNCERTAIN')
    expect(f.runtime.read(resumed.agent.session)?.task).toMatchObject({ objective: 'Task during disposal', workerAttempts: 0, reviewAttempts: 0 })
    await expect(f.runtime.startRole(resumed.agent, 'worker', handoff, undefined, new AbortController().signal)).rejects.toMatchObject({ code: 'RG_NOT_READY' })
    await resumed.dispose()
  })

  it('fails closed when another message arrives during task persistence', async () => {
    const f = await setup()
    const { agent } = await f.create()
    const entered = Promise.withResolvers<undefined>()
    const release = f.gate()
    const original = f.ctx.sessions.flush.bind(f.ctx.sessions)
    const spy = vi.spyOn(f.ctx.sessions, 'flush').mockImplementation(async (session) => {
      if (session === agent.session && session.snapshotEvents().some(event => event.type === 'review-gated/task-prepared')) { entered.resolve(undefined); await release.promise }
      return original(session)
    })
    onTestFinished(() => { spy.mockRestore() })
    const pending = f.runtime.newTask(agent, 'First objective')
    const outcome = pending.then(() => null, (error: unknown) => error)
    await entered.promise
    const competing = createUserMessage({ content: [{ type: 'text', text: 'Competing objective' }], source: { kind: 'user' } })
    agent.followup(competing)
    expect(agent.inbox.nextTurn.map(message => message.id)).toContain(competing.id)
    release.resolve(undefined)
    expect(await outcome).toMatchObject({ code: 'review-gated/refused' })
    expect(f.runtime.read(agent.session)?.diagnostic).toContain('RG_TASK_SAVE_UNCERTAIN')
    expect(f.runtime.read(agent.session)?.task).toMatchObject({ objective: 'First objective', workerAttempts: 0 })
    expect(f.adapter.calls).toHaveLength(0)
  })

  it('reports an uncertain flush failure and prevents use of the published budget', async () => {
    const f = await setup()
    const { agent } = await f.create()
    const failure = new Error('Controlled task flush failure')
    const spy = vi.spyOn(f.ctx.sessions, 'flush').mockRejectedValueOnce(failure)
    onTestFinished(() => { spy.mockRestore() })
    const followup = vi.spyOn(agent, 'followup')
    const outcome = await f.runtime.newTask(agent, 'Uncertain task').then(() => null, (error: unknown) => error)
    expect(outcome).toMatchObject({ code: 'review-gated/refused' })
    expect(outcome).toBeInstanceOf(Error)
    if (outcome instanceof Error) expect(outcome.message).toMatch(/uncertain|reliab/i)
    expect(followup).not.toHaveBeenCalled()
    expect(f.runtime.read(agent.session)?.diagnostic).toMatch(/uncertain|reliab/i)
    await expect(f.runtime.startRole(agent, 'worker', handoff, undefined, new AbortController().signal)).rejects.toMatchObject({ code: 'RG_NOT_READY' })
    await expect(f.runtime.newTask(agent, 'Another task')).rejects.toMatchObject({ code: 'review-gated/refused', details: { reason: 'RG_NOT_READY' } })
  })

  it('refuses task delivery when the real Session has no durability listener', async () => {
    const f = await setup(settings(), { persistence: false })
    const { agent } = await f.create()
    expect(await f.ctx.sessions.flush(agent.session)).toBe(false)
    const calls = f.adapter.calls.length
    let claimed = false
    const off = f.ctx.on('agent/inbox/claimed', ({ agent: candidate }) => { if (candidate === agent) claimed = true })
    try {
      await expect(f.runtime.newTask(agent, 'A task without durable storage')).rejects.toMatchObject({
        code: 'review-gated/refused', details: { reason: 'RG_NOT_READY' },
      })
      expect(f.runtime.read(agent.session)).toMatchObject({ task: null })
      expect(f.runtime.read(agent.session)?.diagnostic).toContain('RG_TASK_SAVE_UNCERTAIN')
      expect(claimed).toBe(false)
      expect(f.adapter.calls).toHaveLength(calls)
      expect(agent.status).toBe('idle')
      await expect(f.runtime.startRole(agent, 'worker', handoff, undefined, new AbortController().signal)).rejects.toMatchObject({ code: 'RG_NOT_READY' })
    } finally { off() }
  })

  it('bounds the rendered rg_status claim recovery response', async () => {
    const f = await setup({ ...settings(), maxReportChars: 512 }, { persistence: false })
    const { agent } = await f.create()
    const input = '中文\n"\\'.repeat(4000)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: input }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const result = await f.call(agent, 'rg_status')
    expect(result).toMatchObject({ isError: false, value: { claimStatus: 'unknown', rawPayloadTruncated: true } })
    if (result.isError) throw new Error('Expected a bounded status result')
    const output = result.content[0]
    if (output?.type !== 'text') throw new Error('Expected text status output')
    expect(output.text.length).toBeLessThanOrEqual(512)
    expect(output.text).toBe(JSON.stringify(result.value))
    expect(output.text).toContain('do not replay automatically')
    expect(f.adapter.calls).toHaveLength(0)
  })

  it('does not request a model for direct human input without a Session writer', async () => {
    const f = await setup(settings(), { persistence: false })
    const { agent } = await f.create()
    const off = f.ctx.on('session/flush', () => {})
    try {
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Direct unstored task' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      expect(f.runtime.read(agent.session)?.task).toBeNull()
      expect(agent.claimProtectionStatus).toBe('unknown')
      expect(agent.claimRecovery?.inputs[0]?.message).toMatchObject({ content: [{ type: 'text', text: 'Direct unstored task' }] })
      const brokenProjection = vi.spyOn(f.runtime, 'claimOf').mockImplementation(() => { throw new Error('projection unavailable') })
      try {
        expect(await f.call(agent, 'rg_status')).toMatchObject({ isError: false, value: { claimStatus: 'unknown', rawPayloadTruncated: true,
          claim: { textPreview: 'Direct unstored task' } } })
        expect(brokenProjection).not.toHaveBeenCalled()
      } finally { brokenProjection.mockRestore() }
      expect(f.adapter.calls).toHaveLength(0)
    } finally { off() }
  })

  it.each(['task replacement', 'cancellation'] as const)('refuses a model request after %s during its checkpoint', async (change) => {
    const f = await setup()
    const replacement = await f.task()
    const { agent } = await f.create()
    const entered = f.gate()
    const release = f.gate()
    let intercepted = false
    const off = f.ctx.on('session/flush', (session) => {
      if (session === agent.session && !intercepted && f.runtime.read(session)?.task !== null) {
        intercepted = true
        entered.resolve(undefined)
        return release.promise
      }
    })
    try {
      const calls = f.adapter.calls.length
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Task being saved' }], source: { kind: 'user' } }))
      await entered.promise
      if (change === 'cancellation') agent.cancel({ kind: 'parent' })
      else agent.session.append('review-gated/state', { version: 1, state: f.runtime.read(replacement.agent.session) })
      release.resolve(undefined)
      await agent.whenIdle()
      expect(f.adapter.calls).toHaveLength(calls)
      if (change === 'task replacement') expect(() => f.runtime.read(agent.session)).toThrow(/RG_STATE_INVALID/)
    } finally { off(); release.resolve(undefined) }
  })

  it('refuses task delivery when only an unrelated flush listener exists', async () => {
    const f = await setup(settings(), { persistence: false })
    const { agent } = await f.create()
    const off = f.ctx.on('session/flush', () => {})
    try {
      await expect(f.runtime.newTask(agent, 'Unstored task')).rejects.toMatchObject({ code: 'review-gated/refused' })
      expect(f.adapter.calls).toHaveLength(0)
      await expect(f.runtime.startRole(agent, 'worker', handoff, undefined, new AbortController().signal)).rejects.toMatchObject({ code: 'RG_NOT_READY' })
      expect(f.adapter.calls).toHaveLength(0)
    } finally { off() }
  })

  it('refuses a task when JSONL is registered after its Session without a writer', async () => {
    const f = await setup(settings(), { persistence: false })
    const { agent } = await f.create()
    await f.ctx.plugin(Jsonl, { root: join(f.root, 'late-sessions'), compression: 'none' })
    const off = f.ctx.on('session/flush', () => {})
    try {
      expect(await f.ctx.sessions.flush(agent.session)).toBe(false)
      await expect(f.runtime.newTask(agent, 'Task without a writer')).rejects.toMatchObject({ code: 'review-gated/refused' })
      expect(f.adapter.calls).toHaveLength(0)
    } finally { off() }
  })

  it('does not start a worker when its reservation has no Session writer', async () => {
    const source = await setup()
    const original = await source.task()
    const state = source.runtime.read(original.agent.session)
    if (state?.task == null) throw new Error('Expected a real task reservation source')
    const f = await setup(settings(), { persistence: false })
    const { agent } = await f.create()
    agent.session.append('review-gated/state', { version: 1, state })
    const calls = f.adapter.calls.length
    const off = f.ctx.on('session/flush', () => {})
    try {
      await expect(f.runtime.startRole(agent, 'worker', handoff, undefined, new AbortController().signal)).rejects.toThrow()
      expect(f.adapter.calls).toHaveLength(calls)
      expect(f.runtime.read(agent.session)?.diagnostic).toMatch(/uncertain|reliab/i)
    } finally { off() }
  })

  it('keeps an idle parent and its writer owned until saving and terminal flushes finish during parent-only disposal', async () => {
    const f = await setup()
    const parent = await f.task()
    const { agent } = parent
    const runtime = f.runtime
    const entered = Promise.withResolvers<undefined>()
    const original = f.adapter.script
    f.adapter.script = async (options) => {
      if (options.model !== 'worker') return original(options)
      const signal = options.signal
      if (signal === undefined) throw new Error('The worker requires a cancellation signal')
      const stopped = Promise.withResolvers<undefined>()
      const abort = () => { stopped.resolve(undefined) }
      signal.addEventListener('abort', abort, { once: true })
      entered.resolve(undefined)
      try { if (signal.aborted) abort(); await stopped.promise } finally { signal.removeEventListener('abort', abort) }
      return text('cancelled')
    }
    const started = await runtime.startRole(agent, 'worker', handoff, undefined, new AbortController().signal)
    await entered.promise
    expect(agent.status).toBe('idle')
    const saving = f.gate()
    const terminal = f.gate()
    const savingEntered = Promise.withResolvers<undefined>()
    const terminalEntered = Promise.withResolvers<undefined>()
    f.ctx.on('session/flush', async (session) => {
      if (session !== agent.session) return
      const state = runtime.read(session)
      if (state?.task?.active?.status === 'saving') { savingEntered.resolve(undefined); await saving.promise }
      else if (state?.task?.active === null && state.task.lastWorker?.status === 'cancelled') {
        terminalEntered.resolve(undefined); await terminal.promise
      }
    })
    const assertWriterOwned = async () => {
      const refusal = await f.ctx.sessionPersistence.open(agent.id, 'write').then(async (handle) => {
        await handle.close(); return null
      }, (error: unknown) => error)
      expect(refusal).toBeInstanceOf(SessionAlreadyOwnedError)
    }
    let disposed = false
    const shutdown = parent.dispose().then(() => { disposed = true })
    await savingEntered.promise
    expect(disposed).toBe(false)
    expect(f.ctx.agents.get(agent.id)).toBe(agent)
    expect(f.ctx.sessions.get(agent.id)).toBe(agent.session)
    await assertWriterOwned()
    await expect(runtime.startRole(agent, 'worker', handoff, undefined, new AbortController().signal)).rejects.toMatchObject({ code: 'RG_NOT_READY' })
    saving.resolve(undefined)
    await terminalEntered.promise
    expect(disposed).toBe(false)
    expect(f.ctx.agents.get(agent.id)).toBe(agent)
    await assertWriterOwned()
    terminal.resolve(undefined)
    await shutdown
    expect(disposed).toBe(true)
    expect(f.ctx.get('reviewGated') !== undefined).toBe(true)
    expect(f.ctx.agents.get(agent.id)).toBeUndefined()
    expect(f.ctx.sessions.get(agent.id)).toBeUndefined()
    expect(f.ctx.agents.get(started.subagentId)).toBeUndefined()
    expect(runtime.read(agent.session)).toMatchObject({ diagnostic: null, task: { active: null, workerAttempts: 1, lastWorker: { status: 'cancelled', report: null } } })
    await expect(runtime.startRole(agent, 'worker', handoff, undefined, new AbortController().signal)).rejects.toMatchObject({ code: 'RG_NOT_READY' })
    const reopened = await f.ctx.sessionPersistence.open(agent.id, 'write')
    await reopened.close()
    expect(f.adapter.calls.map(call => call.model)).toEqual(['main', 'worker'])
  })

  it('waits for an accepted startup during parent disposal without creating a child after its scope starts closing', async () => {
    const f = await setup()
    const parent = await f.task()
    const runtime = f.runtime
    const entered = Promise.withResolvers<undefined>()
    const release = f.gate()
    f.ctx.on('session/flush', async (session) => {
      if (session === parent.agent.session && runtime.read(session)?.task?.active?.status === 'reserved') {
        entered.resolve(undefined); await release.promise
      }
    })
    const start = runtime.startRole(parent.agent, 'worker', handoff, undefined, new AbortController().signal).then(() => false, () => true)
    await entered.promise
    const closing = Promise.withResolvers<undefined>()
    parent.agent.ctx.effect(() => () => { closing.resolve(undefined) })
    let disposed = false
    const shutdown = parent.dispose().then(() => { disposed = true })
    await closing.promise
    expect(disposed).toBe(false)
    expect(f.ctx.agents.get(parent.agent.id)).toBe(parent.agent)
    await expect(runtime.startRole(parent.agent, 'worker', handoff, undefined, new AbortController().signal)).rejects.toMatchObject({ code: 'RG_NOT_READY' })
    release.resolve(undefined)
    expect(await start).toBe(true)
    await shutdown
    expect(runtime.read(parent.agent.session)?.task).toMatchObject({ active: null, workerAttempts: 1, lastWorker: { status: 'cancelled' } })
    expect(f.adapter.calls.map(call => call.model)).toEqual(['main'])
  })

  it('cancels only the live run owned by the aborted parent when its log names another real parent reservation', async () => {
    const f = await setup({ ...settings(), reviewer: { mode: 'custom', pool: pool({ ...main, model: 'reviewer' }) } })
    const own = await f.task()
    const foreign = await f.task()
    const workerRelease = f.gate()
    const workerEntered = Promise.withResolvers<undefined>()
    const reviewerEntered = Promise.withResolvers<undefined>()
    const reviewerAborted = Promise.withResolvers<undefined>()
    let foreignAborted = false
    let mainRequests = 0
    const original = f.adapter.script
    f.adapter.script = async (options) => {
      if (options.model === 'worker') {
        const abort = () => { foreignAborted = true }
        options.signal?.addEventListener('abort', abort, { once: true })
        workerEntered.resolve(undefined)
        try { await workerRelease.promise } finally { options.signal?.removeEventListener('abort', abort) }
        return original(options)
      }
      if (options.model === 'main') mainRequests++
      if (options.model !== 'reviewer') return original(options)
      const signal = options.signal
      if (signal === undefined) throw new Error('The controlled request requires a cancellation signal')
      const stopped = Promise.withResolvers<undefined>()
      const abort = () => { reviewerAborted.resolve(undefined); stopped.resolve(undefined) }
      signal.addEventListener('abort', abort, { once: true })
      reviewerEntered.resolve(undefined)
      try { if (signal.aborted) abort(); await stopped.promise } finally { signal.removeEventListener('abort', abort) }
      return text('cancelled')
    }
    const foreignDone = f.notice(foreign.agent)
    const foreignRun = await f.runtime.startRole(foreign.agent, 'worker', handoff, undefined, new AbortController().signal)
    await workerEntered.promise
    const ownRun = await f.runtime.startRole(own.agent, 'reviewer', handoff, undefined, new AbortController().signal)
    await reviewerEntered.promise
    const record = foreign.agent.session.snapshotEvents().filter(event => event.type === 'review-gated/state').at(-1)!.data
    own.agent.session.append('review-gated/state', record)
    own.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Cancel my work, not the other parent' }], source: { kind: 'user' } }))
    await reviewerAborted.promise
    const requestCalls = mainRequests
    await own.agent.whenIdle()
    expect(mainRequests).toBe(requestCalls)
    await own.dispose()
    expect(f.runtime.read(own.agent.session)).toEqual(record.state)
    expect(foreignAborted).toBe(false)
    expect(f.ctx.agents.get(ownRun.subagentId)).toBeUndefined()
    expect(f.runtime.read(foreign.agent.session)?.task?.active?.id).toBe(foreignRun.runId)
    workerRelease.resolve(undefined)
    await foreignDone
    await foreign.agent.whenIdle()
    expect(f.runtime.read(foreign.agent.session)?.task?.lastWorker).toMatchObject({ id: foreignRun.runId, status: 'completed' })
  })

  it.each(['parent', 'run', 'task'] as const)('interrupts recovered ownership whose real %s identity does not match the live run', async (mismatch) => {
    const f = await setup({ ...settings(), reviewer: { mode: 'custom', pool: pool({ ...main, model: 'reviewer' }) } })
    const own = await f.task()
    const foreign = await f.task()
    const workerRelease = f.gate()
    const reviewerRelease = f.gate()
    const workerEntered = Promise.withResolvers<undefined>()
    const reviewerEntered = Promise.withResolvers<undefined>()
    const original = f.adapter.script
    f.adapter.script = async (options) => {
      if (options.model === 'worker') { workerEntered.resolve(undefined); await workerRelease.promise }
      if (options.model === 'reviewer') { reviewerEntered.resolve(undefined); await reviewerRelease.promise }
      return original(options)
    }
    const foreignDone = f.notice(foreign.agent)
    const foreignRun = await f.runtime.startRole(foreign.agent, 'worker', handoff, undefined, new AbortController().signal)
    await workerEntered.promise
    const ownRun = await f.runtime.startRole(own.agent, 'reviewer', handoff, undefined, new AbortController().signal)
    await reviewerEntered.promise
    f.runtime.initialize(own.agent)
    expect(f.runtime.read(own.agent.session)?.task?.active?.id).toBe(ownRun.runId)
    const ownState = f.runtime.read(own.agent.session)!
    const foreignState = f.runtime.read(foreign.agent.session)!
    const stored = mismatch === 'parent' ? foreignState : sessionStateSchema.parse({ ...ownState, task: { ...ownState.task,
      ...(mismatch === 'task' ? { id: foreignState.task!.id } : {}),
      active: { ...ownState.task!.active, ...(mismatch === 'run' ? { id: foreignRun.runId } : {}) },
    } })
    own.agent.session.append('review-gated/state', { version: 1, state: stored })
    f.runtime.initialize(own.agent)
    const state = f.runtime.read(own.agent.session)
    expect(state?.task?.active).toBeNull()
    expect(mismatch === 'parent' ? state?.task?.lastWorker?.status : state?.task?.lastReview?.status).toBe('interrupted')
    expect(f.runtime.read(foreign.agent.session)?.task?.active?.id).toBe(foreignRun.runId)
    reviewerRelease.resolve(undefined)
    await own.dispose()
    expect(f.runtime.read(own.agent.session)).toEqual(state)
    workerRelease.resolve(undefined)
    await foreignDone
    await foreign.agent.whenIdle()
    expect(f.runtime.read(foreign.agent.session)?.task?.lastWorker?.status).toBe('completed')
  })

  it('aggregates a real child write-lease close acknowledgement failure after releasing its native lock', async () => {
    const f = await setup()
    const { agent } = await f.task()
    const entered = Promise.withResolvers<undefined>()
    const originalScript = f.adapter.script
    f.adapter.script = async (options) => {
      if (options.model !== 'worker') return originalScript(options)
      const signal = options.signal
      if (signal === undefined) throw new Error('Fixture worker requires its cancellation signal')
      const stopped = Promise.withResolvers<undefined>()
      const abort = () => { stopped.resolve(undefined) }
      signal.addEventListener('abort', abort, { once: true })
      entered.resolve(undefined)
      try { if (signal.aborted) abort(); await stopped.promise } finally { signal.removeEventListener('abort', abort) }
      return text('cancelled')
    }
    const started = await f.runtime.startRole(agent, 'worker', handoff, undefined, new AbortController().signal)
    await entered.promise
    const failure = new Error('Simulated native close acknowledgement failure')
    let injections = 0
    const releaseSpy = vi.spyOn(SessionWriteLease.prototype, 'release').mockImplementationOnce(async function (this: SessionWriteLease) {
      releaseSpy.mockRestore()
      await this.release()
      injections += 1
      throw failure
    })
    const logs = vi.spyOn(f.ctx.logger, 'error')
    onTestFinished(() => { releaseSpy.mockRestore(); logs.mockRestore() })
    const settled = Promise.withResolvers<undefined>()
    f.ctx.on('session/event', (session, event) => {
      if (session === agent.session && event.type === 'review-gated/state'
        && event.data.state?.task?.active === null && event.data.state.task.lastWorker?.status === 'cancelled') settled.resolve(undefined)
    })
    const runtime = f.runtime
    const saving = Promise.withResolvers<undefined>()
    const releaseSaving = f.gate()
    const flushes: string[] = []
    f.ctx.on('session/flush', async (session) => {
      if (session !== agent.session) return
      const state = runtime.read(session)
      const status = state?.task?.active?.status ?? state?.task?.lastWorker?.status
      if (status !== undefined) flushes.push(status)
      if (status === 'saving') { saving.resolve(undefined); await releaseSaving.promise }
    })
    let quiesced = false
    const shutdown = Promise.resolve(f.runtimeFiber.dispose()).then(async () => {
      while (f.runtimeFiber.inertia !== undefined) await f.runtimeFiber.inertia
      quiesced = true
    })
    await saving.promise
    expect(quiesced).toBe(false)
    expect(logs.mock.calls.flat().some(arg => arg instanceof AggregateError)).toBe(false)
    releaseSaving.resolve(undefined)
    await shutdown
    await settled.promise
    expect(quiesced).toBe(true)
    expect(flushes).toEqual(['saving', 'cancelled'])
    expect(injections).toBe(1)
    releaseSpy.mockRestore()
    const aggregates = logs.mock.calls.flatMap(args => args.filter((arg): arg is AggregateError => arg instanceof AggregateError))
    expect(aggregates.some(error => error.message === 'RG role cleanup failed'
      && error.errors.some(item => item instanceof Error && 'code' in item && item.code === 'ACTIVATION_TEARDOWN_FAILED'))).toBe(true)
    expect(f.ctx.agents.get(started.subagentId)).toBeUndefined()
    const state = agent.session.snapshotEvents().filter(event => event.type === 'review-gated/state').at(-1)?.data.state
    expect(state?.task?.active).toBeNull()
    expect(state?.task?.lastWorker).toMatchObject({ status: 'cancelled', report: null })
    expect(state?.task?.lastWorker?.diagnostic).toContain('Inspect the child Session log')
    const reopened = await f.ctx.sessionPersistence.open(started.subagentId, 'write')
    await reopened.close()
  })

  it('refuses to authorize or settle a foreign real reservation copied into the parent Session log', async () => {
    const f = await setup({ ...settings(), reviewer: { mode: 'custom', pool: pool({ ...main, model: 'reviewer' }) } })
    const handle = await f.task()
    const { agent: parent } = handle
    const { agent: foreignParent } = await f.task()
    const workerRelease = f.gate()
    const reviewerRelease = f.gate()
    const workerEntered = Promise.withResolvers<undefined>()
    const reviewerEntered = Promise.withResolvers<undefined>()
    const original = f.adapter.script
    f.adapter.script = async (options) => {
      if (options.model === 'worker') { workerEntered.resolve(undefined); await workerRelease.promise }
      if (options.model === 'reviewer') { reviewerEntered.resolve(undefined); await reviewerRelease.promise }
      return original(options)
    }
    const foreignDone = f.notice(foreignParent)
    const foreignRun = await f.runtime.startRole(foreignParent, 'worker', handoff, undefined, new AbortController().signal)
    await workerEntered.promise
    const ownRun = await f.runtime.startRole(parent, 'reviewer', handoff, undefined, new AbortController().signal)
    await reviewerEntered.promise
    const foreignRecord = foreignParent.session.snapshotEvents().filter(event => event.type === 'review-gated/state').at(-1)!.data
    const foreignState = f.runtime.read(foreignParent.session)!
    parent.session.append('review-gated/state', foreignRecord)
    const ownChild = f.ctx.agents.get(ownRun.subagentId)!
    expect(() => { f.runtime.assertRequest(ownChild, { ...main, model: 'reviewer', reasoningEffort: high }) })
      .toThrow(expect.objectContaining({ code: 'RG_UNAUTHORIZED_START' }))
    expect(f.runtime.read(foreignParent.session)?.task?.active?.id).toBe(foreignRun.runId)
    workerRelease.resolve(undefined)
    await foreignDone
    await foreignParent.whenIdle()
    const mainEntered = Promise.withResolvers<undefined>()
    const aborted = Promise.withResolvers<undefined>()
    const roleScript = f.adapter.script
    f.adapter.script = async (options) => {
      if (options.model !== 'main') return roleScript(options)
      const signal = options.signal
      if (signal === undefined) throw new Error('Fixture main request requires a cancellation signal')
      const stopped = Promise.withResolvers<undefined>()
      const abort = () => { stopped.resolve(undefined) }
      signal.addEventListener('abort', abort, { once: true })
      mainEntered.resolve(undefined)
      try { if (signal.aborted) abort(); await stopped.promise } finally { signal.removeEventListener('abort', abort) }
      return text('cancelled')
    }
    f.ctx.on('session/event', (session, event) => {
      if (session === parent.session && event.type === 'turn/end' && event.data.reason.kind === 'aborted') aborted.resolve(undefined)
    })
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Cancel while the recorded child no longer exists' }], source: { kind: 'user' } }))
    await mainEntered.promise
    parent.cancel({ kind: 'user' })
    await aborted.promise
    reviewerRelease.resolve(undefined)
    await handle.dispose()
    expect(f.ctx.agents.get(ownRun.subagentId)).toBeUndefined()
    expect(f.runtime.read(parent.session)).toEqual(foreignState)
    expect(f.runtime.read(foreignParent.session)?.task?.lastWorker?.id).toBe(foreignRun.runId)
    expect(parent.session.snapshotEvents().some(event => event.type === 'review-gated/state' && event.data.state?.task?.reviewAttempts === 1)).toBe(true)
  })

  it('does not settle a different real human task if its reserved startup log is replaced while flushing', async () => {
    const f = await setup()
    const { agent: parent } = await f.task()
    const { agent: foreignParent } = await f.task()
    const foreignState = f.runtime.read(foreignParent.session)
    if (foreignState === null) throw new Error('The foreign task was not recorded')
    const foreignRecord = { version: 1 as const, state: foreignState }
    const release = f.gate()
    const entered = Promise.withResolvers<undefined>()
    f.ctx.on('session/flush', async (session) => {
      if (session === parent.session && f.runtime.read(session)?.task?.active?.status === 'reserved') {
        entered.resolve(undefined); await release.promise
      }
    })
    const cancel = new AbortController()
    const start = f.runtime.startRole(parent, 'worker', handoff, undefined, cancel.signal).then(() => false, () => true)
    await entered.promise
    parent.session.append('review-gated/state', foreignRecord)
    cancel.abort(new Error('Startup cancelled after a foreign persisted record'))
    release.resolve(undefined)
    expect(await start).toBe(true)
    expect(f.runtime.read(parent.session)).toEqual(foreignState)
    expect(f.ctx.agents.roots().map(agent => agent.id)).toEqual([parent.id, foreignParent.id])
  })

  it.each(['blank', 'cleared'] as const)('does not resurrect a live run when a real %s Session record replaces its ownership', async (kind) => {
    const f = await setup()
    const handle = await f.task()
    const { agent: parent } = handle
    const blank = await f.create()
    if (kind === 'cleared') await f.ctx.agentPresets.select(blank.agent, 'standard')
    const record = blank.agent.session.snapshotEvents().filter(event => event.type === 'review-gated/state').at(-1)!.data
    const release = f.gate()
    const entered = Promise.withResolvers<undefined>()
    const original = f.adapter.script
    f.adapter.script = async (options) => {
      if (options.model === 'worker') { entered.resolve(undefined); await release.promise }
      return original(options)
    }
    const own = await f.runtime.startRole(parent, 'worker', handoff, undefined, new AbortController().signal)
    await entered.promise
    parent.session.append('review-gated/state', record)
    release.resolve(undefined)
    await handle.dispose()
    expect(f.ctx.agents.get(own.subagentId)).toBeUndefined()
    expect(f.runtime.read(parent.session)).toEqual(record.state)
  })

  it('registers its real Settings page policy and releases that registration on disable', async () => {
    const f = await setup(settings(), { settings: true })
    expect(() => f.ctx.settings.configure({ auto: true }, f.runtimeFiber)).toThrow('Settings presentation is already configured')
    await f.enabled(false)
    const remove = f.ctx.settings.configure({ auto: true }, f.runtimeFiber)
    remove()
    await f.enabled(true)
    expect(f.ctx.get('reviewGated')).toBeDefined()
    await f.enabled(false)
  })

  it.each([false, true])('derives the human task only from text alongside an uploaded file (hasText=%s)', async (hasText) => {
    const f = await setup()
    const { agent } = await f.create()
    const bytes = await readFile(join(f.root, 'probe.txt'))
    const file: Extract<ContentBlock, { type: 'file' }> = { type: 'file', attachment: {
      attachmentId: brandString<Extract<ContentBlock, { type: 'file' }>['attachment']['attachmentId']>(`sha256:${createHash('sha256').update(bytes).digest('hex')}`),
      name: 'probe.txt', bytes: bytes.length,
    } }
    agent.followup(createUserMessage({ content: hasText ? [file, { type: 'text', text: 'Inspect the uploaded file' }] : [file], source: { kind: 'user' } }))
    await agent.whenIdle()
    if (hasText) expect(f.runtime.read(agent.session)?.task?.objective).toBe('Inspect the uploaded file')
    else expect(f.runtime.read(agent.session)?.task).toBeNull()
    expect(f.adapter.calls).toHaveLength(1)
    expect(f.adapter.calls[0]?.messages.some(message => message.role === 'user'
      && message.content.some(block => block.type === 'text' && block.text.includes('probe.txt')))).toBe(true)
  })

  it('uses the actionable default refusal when a non-RG parent calls role admission', async () => {
    const f = await setup()
    const { agent } = await f.create('standard')
    await expect(f.runtime.startRole(agent, 'worker', handoff, undefined, new AbortController().signal)).rejects.toMatchObject({
      code: 'RG_NOT_READY', message: 'Only an initialized RG main Agent may start roles.',
    })
    expect(f.ctx.agents.roots().map(candidate => candidate.id)).toEqual([agent.id])
  })

  it('executes the role model, status, worker and reviewer tools through the real registry', async () => {
    const f = await setup({ ...settings(), reviewer: { mode: 'custom', pool: pool({ ...main, model: 'reviewer' }) } })
    const { agent } = await f.task()
    for (const role of ['main', 'worker', 'reviewer'] as const) {
      const result = await f.call(agent, 'rg_models', { role })
      expect(result).toMatchObject({ isError: false, value: f.runtime.read(agent.session)?.policy?.[role] })
      expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(f.runtime.read(agent.session)?.policy?.[role]) }])
    }
    expect(await f.call(agent, 'rg_status')).toMatchObject({ isError: false, value: { task: { workerAttempts: 0 } } })
    for (const role of ['worker', 'reviewer'] as const) {
      const notice = f.notice(agent)
      const selection = role === 'worker' ? {} : { provider: 'fixture', model: 'reviewer' }
      const result = await f.call(agent, `rg_${role}`, { handoff, ...selection })
      expect(result).toMatchObject({ isError: false, value: { kind: 'activation' } })
      if (!result.isError) expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(result.value) }])
      await notice
      await agent.whenIdle()
    }
    expect(await f.call(agent, 'rg_status')).toMatchObject({ isError: false, value: { task: { active: null, workerAttempts: 1, reviewAttempts: 1, reviewStatus: 'reported-pass' } } })
    for (const selection of [{ provider: 'fixture' }, { model: 'worker' }]) {
      expect(await f.call(agent, 'rg_worker', { handoff, ...selection })).toMatchObject({ isError: true })
    }
  })

  it('steers the parent with the findings when the reviewer requests changes', async () => {
    const f = await setup({ ...settings(), reviewer: { mode: 'custom', pool: pool({ ...main, model: 'reviewer' }) } })
    const { agent } = await f.task()
    const changes = { kind: 'reviewer', verdict: 'changes-requested', summary: 'The implementation misses a requirement',
      inspectedScope: ['probe.txt'], findings: [{ location: 'probe.txt', impact: 'The required behavior is missing', evidence: 'The file is unchanged' }],
      validation: ['Read probe.txt'], unverified: [] }
    f.adapter.script = options => options.model === 'worker' || options.model === 'reviewer' ? structured(changes) : text('done')
    const steered: string[] = []
    const off = f.ctx.on('session/event', (session, event) => {
      if (session !== agent.session || event.type !== 'user/message') return
      if (event.data.source.kind !== 'review-gated') return
      steered.push(event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(''))
    })
    try {
      const notice = f.notice(agent)
      expect(await f.call(agent, 'rg_reviewer', { handoff, provider: 'fixture', model: 'reviewer' })).toMatchObject({ isError: false })
      await notice
      await agent.whenIdle()
    } finally { off() }
    expect(f.runtime.read(agent.session)?.task?.reviewStatus).toBe('changes-requested')
    const steer = steered.find(message => message.includes('requested changes'))
    expect(steer).toBeDefined()
    expect(steer).toContain('probe.txt')
    expect(steer).toContain('The required behavior is missing')
    expect(steer).toContain('not a pass')
  })

  it('keeps existing role tools fail-closed while RG is disabled or has no configured policy', async () => {
    const f = await setup()
    const { agent } = await f.task()
    await f.enabled(false)
    for (const name of ['rg_worker', 'rg_reviewer', 'rg_models', 'rg_status']) {
      expect(await f.call(agent, name, name === 'rg_models' ? { role: 'main' } : name === 'rg_status' ? {} : { handoff }))
        .toMatchObject({ isError: true, error: { info: { code: 'RG_NOT_READY' } } })
    }
    const calls = f.adapter.calls.length
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Do not run while disabled' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(f.adapter.calls).toHaveLength(calls)
    const unconfigured = await setup(defaultSettings())
    const blank = await unconfigured.create()
    expect(unconfigured.runtime.read(blank.agent.session)?.policy).toBeNull()
    expect(typeof unconfigured.runtime.read(blank.agent.session)?.diagnostic).toBe('string')
    expect(await unconfigured.call(blank.agent, 'rg_models', { role: 'worker' })).toMatchObject({ isError: true })
    expect(() => { unconfigured.runtime.assertRequest(blank.agent, { ...main, reasoningEffort: high }) }).toThrow(expect.objectContaining({ code: 'RG_NOT_READY' }))
  })

  it('records fresh human tasks, refuses invalid objectives, and requires a task before role admission', async () => {
    const f = await setup({ ...settings(), maxHandoffChars: 300 })
    const { agent } = await f.create()
    await expect(f.runtime.startRole(agent, 'worker', handoff, undefined, new AbortController().signal)).rejects.toMatchObject({ code: 'RG_TASK_REQUIRED' })
    await expect(f.runtime.startRole(agent, 'worker', { ...handoff, facts: ['x'.repeat(301)] }, undefined, new AbortController().signal)).rejects.toMatchObject({ code: 'RG_NOT_READY' })
    await expect(f.runtime.newTask(agent, ' ')).rejects.toMatchObject({ code: 'review-gated/refused' })
    await expect(f.runtime.newTask(agent, 'x'.repeat(301))).rejects.toMatchObject({ code: 'review-gated/refused' })
    const task = await f.runtime.newTask(agent, 'A human-owned task')
    await agent.whenIdle()
    expect(f.runtime.read(agent.session)?.task).toEqual(task)
    expect(agent.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.id === task.originMessageId)).toBe(true)
  })

  it('does not assign a new policy to an old requested Session and rejects an orphan role', async () => {
    const f = await setup()
    const prior = await f.create('standard')
    expect(() => { f.runtime.assertRequest(prior.agent, { ...main, reasoningEffort: high }) }).toThrow(expect.objectContaining({ code: 'RG_NOT_READY' }))
    prior.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Ordinary prior Session' }], source: { kind: 'user' } }))
    await prior.agent.whenIdle()
    // Pre-policy RG Sessions can contain a selected preset and requests without an RG state event.
    const legacy = prior.agent.session.snapshotEvents().map(event => event.type === 'agent-preset/selected'
      ? { ...event, data: { agentPreset: 'rg' } } : event)
    const restored = await f.create('rg', legacy)
    expect(f.runtime.read(restored.agent.session)?.policy).toBeNull()
    expect(f.runtime.read(restored.agent.session)?.diagnostic).toContain('RG_LEGACY_SESSION')
    await expect(f.create('rg-worker')).rejects.toMatchObject({ code: 'RG_UNAUTHORIZED_START' })
    const { agent: mainAgent } = await f.create()
    await expect(f.ctx.agents.create({ sessionId: SessionId('orphan-rg-child'), parentAgent: mainAgent,
      meta: { origin: 'subagent', parentSession: mainAgent.id, cwd: f.root },
      setup: async (childCtx, child) => {
        await f.ctx.agentPresets.mount(childCtx, 'rg-reviewer')
        child.session.append('agent-preset/selected', { agentPreset: 'rg-reviewer' })
      } })).rejects.toMatchObject({ code: 'RG_UNAUTHORIZED_START' })
  })

  it('restores a blank main policy when the log ends between RG initialization and model binding', async () => {
    const f = await setup()
    let prefix: readonly SessionEvent[] | undefined
    const off = f.ctx.on('session/event', (session, event) => {
      if (prefix === undefined && event.type === 'review-gated/state' && event.data.state?.role === 'main') prefix = session.snapshotEvents()
    })
    await f.create()
    off()
    expect(prefix).toBeDefined()
    const restored = await f.create('rg', prefix)
    f.runtime.assertRequest(restored.agent, { ...main, reasoningEffort: high })
    expect(f.ctx.agents.modelPolicyFor(restored.agent)?.allowedSelections).toEqual([{ ...main, reasoningEffort: high }])
  })

  it('contributes the deduplicated frozen role routes to public subagent model discovery', async () => {
    const f = await setup({ ...settings(), reviewer: { mode: 'custom', pool: { candidates: [worker, main], default: { provider: main.provider, model: main.model } } } }, { modelSelection: true })
    const standard = await f.create('standard')
    expect(standard.agent.session.snapshotEvents().some(event => event.type === 'subagent/model-selection-policy')).toBe(false)
    const { agent } = await f.create()
    expect(agent.session.snapshotEvents().find(event => event.type === 'subagent/model-selection-policy')?.data).toEqual({
      allowedModels: [{ provider: 'fixture', model: 'worker' }, { provider: 'fixture', model: 'main' }],
    })
    await f.enabled(false)
    const ordinary = await f.create('standard')
    expect(ordinary.agent.session.snapshotEvents().some(event => event.type === 'subagent/model-selection-policy')).toBe(false)
  })

  it('guards parent mutation during a role and invalidates a pass only after a successful mutation result', async () => {
    const f = await setup({ ...settings(), reviewer: { mode: 'custom', pool: pool({ ...main, model: 'reviewer' }) } })
    let writes = 0
    for (const name of ['write', 'edit', 'read']) f.ctx.effect(() => f.ctx.tools.register({ name, description: 'Fixture operation',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: { schema: {}, render: () => [] }, execute: () => {
        if (name === 'edit') throw new Error('Controlled failed mutation')
        if (name === 'write') writes += 1
        return Promise.resolve({ done: true })
      } }))
    const { agent } = await f.task()
    const release = f.gate()
    const entered = Promise.withResolvers<undefined>()
    const original = f.adapter.script
    f.adapter.script = async (options) => {
      if (options.model !== 'reviewer') return original(options)
      entered.resolve(undefined); await release.promise; return structured(report)
    }
    const notice = f.notice(agent)
    await f.runtime.startRole(agent, 'reviewer', handoff, undefined, new AbortController().signal)
    await entered.promise
    expect(await f.call(agent, 'write')).toMatchObject({ isError: true })
    expect(writes).toBe(0)
    expect(await f.call(agent, 'read')).toMatchObject({ isError: false })
    release.resolve(undefined)
    await notice
    await agent.whenIdle()
    expect(f.runtime.read(agent.session)?.task?.reviewStatus).toBe('reported-pass')
    expect(await f.call(agent, 'edit')).toMatchObject({ isError: true })
    expect(await f.call(agent, 'read')).toMatchObject({ isError: false })
    expect(f.runtime.read(agent.session)?.task?.reviewStatus).toBe('reported-pass')
    expect(await f.call(agent, 'write')).toMatchObject({ isError: false })
    expect(writes).toBe(1)
    expect(f.runtime.read(agent.session)?.task).toMatchObject({ workRevision: 1, reviewStatus: 'stale' })
    expect(await f.call(agent, 'write')).toMatchObject({ isError: false })
    expect(writes).toBe(2)
    expect(f.runtime.read(agent.session)?.task?.workRevision).toBe(1)
    const standalone = await f.ctx.tools.execute({ signal: new AbortController().signal, calls: [
      { type: 'tool-call', id: ToolCallId('standalone-write'), name: 'write', arguments: '{}' },
    ] })
    expect(standalone.results[0]?.result.isError).toBe(false)
  })

  it('marks a pass without scope or a retained Git delivery stale during recheck', async () => {
    const f = await setup({ ...settings(), reviewer: { mode: 'custom', pool: pool({ ...main, model: 'reviewer' }) } })
    const { agent } = await f.task()
    const completed = f.notice(agent)
    await f.runtime.startRole(agent, 'reviewer', handoff, undefined, new AbortController().signal)
    await completed
    await agent.whenIdle()
    const state = f.runtime.read(agent.session)
    const task = state?.task
    const review = task?.lastReview
    if (state === null || state === undefined || task === null || task === undefined || review === null || review === undefined) {
      throw new Error('The fixture must contain a completed reviewer report.')
    }
    // A crash prefix can retain the Git pass after its separate Git-state clearance.
    agent.session.append('review-gated/state', { version: 1, state: { ...state, task: { ...task, lastReview: { ...review, scope: null } } } })
    expect(f.runtime.readGit(agent.session)).toBeNull()
    expect(f.runtime.read(agent.session)?.task?.reviewStatus).toBe('reported-pass')
    expect((await f.runtime.recheck(agent, new AbortController().signal))?.task?.reviewStatus).toBe('stale')
  })

  it('warns the main Agent when a previously reviewed file changes before turn stopping', async () => {
    const f = await setup({ ...settings(), reviewer: { mode: 'custom', pool: pool({ ...main, model: 'reviewer' }) } })
    const { agent } = await f.task()
    const completed = f.notice(agent)
    await f.runtime.startRole(agent, 'reviewer', handoff, undefined, new AbortController().signal)
    await completed
    await agent.whenIdle()
    await writeFile(join(f.root, 'probe.txt'), 'changed after review')
    const warning = f.notice(agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Report the result' }], source: { kind: 'user' } }))
    expect(await warning).toContain('previous reviewer pass is stale')
    await agent.whenIdle()
    expect(f.runtime.read(agent.session)?.task?.reviewStatus).toBe('stale')
  })

  it.each(['changed', 'unverified'] as const)('never reports a pass when reviewer scope becomes %s before completion', async (kind) => {
    const f = await setup({ ...settings(), maxScopeBytes: 32, reviewer: { mode: 'custom', pool: pool({ ...main, model: 'reviewer' }) } })
    const { agent } = await f.task()
    const original = f.adapter.script
    f.adapter.script = async (options) => {
      if (options.model !== 'reviewer') return original(options)
      await writeFile(join(f.root, 'probe.txt'), kind === 'unverified' ? 'x'.repeat(100) : 'changed during review')
      return structured(report)
    }
    const delivered = f.notice(agent)
    await f.runtime.startRole(agent, 'reviewer', handoff, undefined, new AbortController().signal)
    expect(JSON.parse(await delivered)).toMatchObject({ status: 'completed', reviewStatus: 'stale', report })
    await agent.whenIdle()
    const state = f.runtime.read(agent.session)
    expect(state?.task?.lastReview?.diagnostic).not.toBeNull()
    if (kind === 'unverified') expect(state?.task?.lastReview?.scope?.fingerprint).toBeNull()
  })

  it('does not apply an old recheck after the human replaces its task while file inspection is pending', async () => {
    const f = await setup({ ...settings(), reviewer: { mode: 'custom', pool: pool({ ...main, model: 'reviewer' }) } })
    const { agent } = await f.task()
    const delivered = f.notice(agent)
    await f.runtime.startRole(agent, 'reviewer', handoff, undefined, new AbortController().signal)
    await delivered
    await agent.whenIdle()
    const release = f.gate()
    const entered = Promise.withResolvers<undefined>()
    const original = f.ctx.fs.readBytes.bind(f.ctx.fs)
    const spy = vi.spyOn(f.ctx.fs, 'readBytes').mockImplementationOnce(async (...args) => {
      entered.resolve(undefined); await release.promise; return original(...args)
    })
    onTestFinished(() => { spy.mockRestore() })
    const rechecking = f.runtime.recheck(agent, new AbortController().signal)
    await entered.promise
    const replacement = await f.runtime.newTask(agent, 'A new human task')
    await agent.whenIdle()
    release.resolve(undefined)
    expect((await rechecking)?.task?.id).toBe(replacement.id)
    expect(f.runtime.read(agent.session)?.task).toMatchObject({ id: replacement.id, reviewStatus: 'not-reviewed', lastReview: null })
  })

  it('propagates unknown inspection failures instead of converting them to an RG refusal', async () => {
    const f = await setup({ ...settings(), reviewer: { mode: 'custom', pool: pool({ ...main, model: 'reviewer' }) } })
    const { agent } = await f.task()
    const delivered = f.notice(agent)
    await f.runtime.startRole(agent, 'reviewer', handoff, undefined, new AbortController().signal)
    await delivered
    await agent.whenIdle()
    const cancelled = new AbortController()
    const failure = new Error('Controlled inspection cancellation')
    cancelled.abort(failure)
    await expect(f.runtime.recheck(agent, cancelled.signal)).rejects.toBe(failure)
  })

  it('cancels its live child when the parent aborts during a model request', async () => {
    const f = await setup()
    const { agent } = await f.task()
    const entered = Promise.withResolvers<undefined>()
    const workerEntered = Promise.withResolvers<undefined>()
    f.adapter.script = async (options) => {
      const signal = options.signal
      if (signal === undefined) throw new Error('Fixture request requires its cancellation signal')
      const aborted = Promise.withResolvers<undefined>()
      const abort = () => { aborted.resolve(undefined) }
      signal.addEventListener('abort', abort, { once: true })
      if (options.model === 'main') entered.resolve(undefined)
      else workerEntered.resolve(undefined)
      try { if (signal.aborted) abort(); await aborted.promise } finally { signal.removeEventListener('abort', abort) }
      return text('cancelled')
    }
    const started = await f.runtime.startRole(agent, 'worker', handoff, undefined, new AbortController().signal)
    await workerEntered.promise
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Await the worker result' }], source: { kind: 'user' } }))
    await entered.promise
    const cancelled = f.until(agent.id, state => state?.task?.lastWorker?.status === 'cancelled')
    agent.cancel({ kind: 'user' })
    await cancelled
    await agent.whenIdle()
    expect(f.ctx.agents.get(started.subagentId)).toBeUndefined()
    expect(f.runtime.read(agent.session)?.task).toMatchObject({ workerAttempts: 1, active: null })
  })

  it('leaves whitespace-only input without a human task budget', async () => {
    const f = await setup()
    const { agent } = await f.create()
    agent.followup(createUserMessage({ content: [{ type: 'text', text: '   ' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(f.runtime.read(agent.session)?.task).toBeNull()
    const release = f.gate()
    const entered = Promise.withResolvers<undefined>()
    f.adapter.script = async () => { entered.resolve(undefined); await release.promise; return text('done') }
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'A normal human task' }], source: { kind: 'user' } }))
    await entered.promise
    await expect(f.runtime.newTask(agent, 'Reset while requesting')).rejects.toMatchObject({ code: 'review-gated/refused', details: { reason: 'RG_BUSY' } })
    release.resolve(undefined)
    await agent.whenIdle()
  })

  it('treats completion without a formal structured report as a bounded failed attempt', async () => {
    const f = await setup()
    const { agent } = await f.task()
    const original = f.adapter.script
    f.adapter.script = options => options.model === 'worker' ? text('Ordinary progress without a formal report') : original(options)
    const delivered = f.notice(agent)
    await f.runtime.startRole(agent, 'worker', handoff, undefined, new AbortController().signal)
    expect(JSON.parse(await delivered)).toMatchObject({ status: 'failed', report: null })
    await agent.whenIdle()
    expect(f.runtime.read(agent.session)?.task).toMatchObject({ workerAttempts: 1, lastWorker: { status: 'failed', report: null } })
  })

  it('retains a cancelled terminal result when disable interrupts the final review scope inspection', async () => {
    const f = await setup({ ...settings(), reviewer: { mode: 'custom', pool: pool({ ...main, model: 'reviewer' }) } })
    const { agent } = await f.task()
    const release = f.gate()
    const entered = Promise.withResolvers<undefined>()
    const original = f.ctx.fs.readBytes.bind(f.ctx.fs)
    let rechecking = false
    let waiting = false
    // The start resolves after the initial capture, so every read after this
    // point belongs to the final recheck that disable is meant to interrupt.
    const spy = vi.spyOn(f.ctx.fs, 'readBytes').mockImplementation(async (...args) => {
      if (rechecking && !waiting) { waiting = true; entered.resolve(undefined); await release.promise }
      return original(...args)
    })
    onTestFinished(() => { spy.mockRestore() })
    const runtime = f.runtime
    await runtime.startRole(agent, 'reviewer', handoff, undefined, new AbortController().signal)
    rechecking = true
    await entered.promise
    const shutdown = f.enabled(false)
    release.resolve(undefined)
    await shutdown
    const state = agent.session.snapshotEvents().filter(event => event.type === 'review-gated/state').at(-1)?.data.state
    expect(state).toMatchObject({ diagnostic: null, task: { active: null, reviewStatus: 'inconclusive', lastReview: { status: 'cancelled', report: null } } })
  })

  it('waits for a failing owned child disposer and retains a non-pass result on disable', async () => {
    const f = await setup()
    const { agent } = await f.task()
    const release = f.gate()
    const entered = Promise.withResolvers<undefined>()
    let disposals = 0
    f.ctx.on('agent/created', ({ agent: child }) => {
      if (f.runtime.read(child.session)?.role === 'worker') child.ctx.effect(() => () => {
        disposals += 1; throw new Error('Controlled child resource release failure')
      })
    })
    const original = f.adapter.script
    f.adapter.script = async (options) => {
      if (options.model !== 'worker') return original(options)
      entered.resolve(undefined); await release.promise; return structured({ kind: 'worker', outcome: 'completed', summary: 'Done', changes: [], validation: [], unverified: [] })
    }
    await f.runtime.startRole(agent, 'worker', handoff, undefined, new AbortController().signal)
    await entered.promise
    const shutdown = f.enabled(false)
    release.resolve(undefined)
    await shutdown
    expect(disposals).toBe(1)
    expect(f.ctx.agents.roots().map(candidate => candidate.id)).toEqual([agent.id])
    const state = agent.session.snapshotEvents().filter(event => event.type === 'review-gated/state').at(-1)?.data.state
    expect(state?.task?.lastWorker?.status).not.toBe('completed')
    expect(state?.task?.lastWorker?.report).toBeNull()
  })

  it('refuses a prepared Session whose restored checkpoint retains an invalid-state diagnostic', async () => {
    const f = await setup()
    const prepared = f.ctx.sessions.prepare(SessionId('invalid-rg-checkpoint'), { meta: { cwd: f.root } })
    f.ctx.sessionProjections.hydrate(prepared, { reviewGated: { ver: rgProjectionDefinition.stateVersion, seq: -1, val: {
      value: null, hasRequested: false, failure: 'RG_STATE_INVALID: event 0', pending: null, taskAdmission: null, taskInputText: null, directClaim: null,
    } } }, [], SessionLogOffset(0))
    expect(() => f.runtime.read(prepared)).toThrow(expect.objectContaining({ code: 'RG_NOT_READY', message: 'RG_STATE_INVALID: event 0' }))
  })

  it('records no prior model for an unselected fresh Agent and refuses requests with an unfinished policy binding', async () => {
    const f = await setup()
    const { agent } = await f.create('rg', undefined, {})
    expect(f.runtime.read(agent.session)?.priorModel).toBeNull()
    f.ctx.agents.clearModelPolicy(agent)
    expect(() => { f.runtime.assertRequest(agent, { ...main, reasoningEffort: high }) }).toThrow(expect.objectContaining({ code: 'RG_NOT_READY' }))
    f.runtime.initialize(agent)
    f.runtime.assertRequest(agent, { ...main, reasoningEffort: high })
    await f.ctx.agentPresets.select(agent, 'standard')
    expect(f.runtime.read(agent.session)).toBeNull()
  })

  it('refuses a non-owner caller attempting to reset the human task budget', async () => {
    const f = await setup()
    const { agent } = await f.task()
    const invocation: RemoteInvocation = { request: { namespace: 'reviewGated', method: 'newTask', args: {} }, service: 'reviewGated',
      peer: { id: brandString<PeerId>('rg-guest'), ctx: f.ctx, principal: { kind: 'test-guest', guest: 'rg-budget' },
        signal: new AbortController().signal, interactions: 'none', dispose: async () => {} }, signal: new AbortController().signal,
      uplink: <In>(): AsyncIterable<In> => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }) }),
    }
    await expect(f.ctx.extend({ invocation }).reviewGated.newTask(agent, 'Unowned budget')).rejects.toMatchObject({
      code: 'review-gated/refused', details: { reason: 'RG_NOT_READY' },
    })
    expect(f.runtime.read(agent.session)?.task?.objective).toBe('Inspect the requested implementation')
  })

  it('charges a failed startup reservation without retrying or refunding its budget', async () => {
    const f = await setup()
    const { agent } = await f.task()
    let rejected = false
    const failure = new Error('Controlled initial reservation flush failure')
    f.ctx.on('session/flush', (session) => {
      if (session === agent.session && f.runtime.read(session)?.task?.active?.status === 'reserved' && !rejected) {
        rejected = true; throw failure
      }
    })
    await expect(f.runtime.startRole(agent, 'worker', handoff, undefined, new AbortController().signal)).rejects.toThrow(/uncertain outcome/i)
    expect(f.runtime.read(agent.session)?.diagnostic).toContain('RG_RESULT_SAVE_FAILED')
    expect(f.runtime.read(agent.session)?.task).toMatchObject({ workerAttempts: 1, active: null, lastWorker: { status: 'failed' } })
    expect(f.ctx.agents.roots().map(candidate => candidate.id)).toEqual([agent.id])
  })

  it('cancels a materializing child before startActivation returns and waits for creation rollback', async () => {
    const f = await setup()
    const { agent } = await f.task()
    const release = f.gate()
    const entered = Promise.withResolvers<undefined>()
    f.ctx.on('agent/created', async ({ agent: child }) => {
      if (f.runtime.read(child.session)?.role !== 'worker') return undefined
      entered.resolve(undefined); await release.promise; return undefined
    })
    const cancel = new AbortController()
    const start = f.runtime.startRole(agent, 'worker', handoff, undefined, cancel.signal)
    const outcome = start.then(() => false, () => true)
    await entered.promise
    cancel.abort(new Error('Controlled materialization cancellation'))
    release.resolve(undefined)
    expect(await outcome).toBe(true)
    expect(f.runtime.read(agent.session)?.task).toMatchObject({ workerAttempts: 1, active: null, lastWorker: { status: 'cancelled' } })
    expect(f.ctx.agents.roots().map(candidate => candidate.id)).toEqual([agent.id])
    expect(f.adapter.calls.every(call => call.model === 'main')).toBe(true)
  })

  it('permits ordinary child creation outside RG but refuses RG role adoption by a non-RG parent', async () => {
    const f = await setup()
    const { agent } = await f.create('standard')
    const plain = await f.ctx.subagents.startActivation({ provider: 'spawn', lifecycle: 'one-shot', childId: SessionId('ordinary-child'),
      label: 'Ordinary child', delivery: 'caller', signal: new AbortController().signal,
      request: { parent: agent, cwd: f.root, agentPreset: 'standard', prompt: [{ type: 'text', text: 'Ordinary scoped work' }] } })
    await plain.result
    await plain.dispose()
    await expect(f.ctx.subagents.startActivation({ provider: 'spawn', lifecycle: 'one-shot', childId: SessionId('non-rg-parent'),
      label: 'Unowned role', delivery: 'caller', signal: new AbortController().signal,
      request: { parent: agent, cwd: f.root, agentPreset: 'rg-worker', outputSchema: workerOutputSchema,
        prompt: [{ type: 'text', text: 'No RG task owns this role' }] } })).rejects.toMatchObject({ code: 'RG_UNAUTHORIZED_START' })
  })

  it('freezes each Session configuration and restores the prior route when a blank Agent leaves RG', async () => {
    const f = await setup()
    const handle = await f.create('standard')
    const agent = handle.agent
    expect(f.runtime.read(agent.session)).toBeNull()
    expect(agent.model.current()).toMatchObject({ provider: 'fixture', model: 'prior', reasoningEffort: low })
    await f.ctx.agentPresets.select(agent, 'rg')
    const frozen = f.runtime.read(agent.session)!.policy!
    expect(agent.model.current()).toEqual({ ...main, reasoningEffort: high })
    expect(() => { f.runtime.assertRequest(agent, { ...main, reasoningEffort: low }) }).toThrow(expect.objectContaining({ code: 'RG_MODEL_NOT_ALLOWED' }))
    f.runtime.assertRequest(agent, { ...main, reasoningEffort: high })
    const changed = { ...settings(), main: pool({ ...main, model: 'replacement' }), maxWorkerAttempts: 7 }
    await f.update(changed)
    expect(f.runtime.read(agent.session)?.policy).toEqual(frozen)
    const fresh = await f.create()
    expect(f.runtime.read(fresh.agent.session)?.policy).toMatchObject({ main: changed.main, maxWorkerAttempts: 7 })
    await f.ctx.agentPresets.select(agent, 'standard')
    expect(f.runtime.read(agent.session)).toBeNull()
    expect(f.ctx.agents.modelPolicyFor(agent)).toBeNull()
    expect(agent.model.current()).toEqual({ provider: 'fixture', model: 'prior', reasoningEffort: low })
    await f.ctx.agentPresets.select(agent, 'rg')
    expect(f.runtime.read(agent.session)?.policy?.maxWorkerAttempts).toBe(7)
    await f.ctx.agentPresets.select(agent, 'standard')
    expect(agent.model.current()).toEqual({ provider: 'fixture', model: 'prior', reasoningEffort: low })
    expect(f.adapter.calls).toEqual([])
  })

  it('refuses a direct one-shot role start without an owned reservation', async () => {
    const f = await setup()
    const { agent } = await f.task()
    await expect(f.ctx.subagents.startActivation({ provider: 'spawn', lifecycle: 'one-shot', childId: SessionId('unreserved-role'),
      label: 'Unreserved worker', delivery: 'caller', signal: new AbortController().signal,
      request: { parent: agent, cwd: f.root, agentPreset: 'rg-worker', prompt: [{ type: 'text', text: 'Bypass the reservation' }] } })).rejects.toMatchObject({ code: 'RG_UNAUTHORIZED_START' })
    expect(f.ctx.agents.roots()).toEqual([agent])
    expect(f.runtime.read(agent.session)?.task?.workerAttempts).toBe(0)
  })

  it('keeps a reviewer pass staged and holds parent turn stopping and new work until its flush completes', async () => {
    const f = await setup({ ...settings(), reviewer: { mode: 'custom', pool: pool({ ...main, model: 'reviewer' }) } })
    const { agent: parent } = await f.task()
    const flush = f.gate()
    const terminalFlush = f.gate()
    const entered = Promise.withResolvers<undefined>()
    const terminalEntered = Promise.withResolvers<undefined>()
    let intercepted = false
    let terminalIntercepted = false
    f.ctx.on('session/flush', (session) => {
      if (session !== parent.session) return
      const task = f.runtime.read(session)?.task
      if (task?.active?.status === 'saving' && !intercepted) {
        intercepted = true; entered.resolve(undefined); return flush.promise
      }
      if (task?.active === null && task.reviewStatus === 'reported-pass' && !terminalIntercepted) {
        terminalIntercepted = true; terminalEntered.resolve(undefined); return terminalFlush.promise
      }
    })
    const started = await f.runtime.startRole(parent, 'reviewer', handoff, undefined, new AbortController().signal)
    await entered.promise
    expect(f.runtime.read(parent.session)?.task).toMatchObject({ reviewAttempts: 1, reviewStatus: 'reviewing', active: { status: 'saving' } })
    expect(f.ctx.agents.get(started.subagentId)).toBeUndefined()
    await expect(f.runtime.startRole(parent, 'worker', handoff, undefined, new AbortController().signal)).rejects.toMatchObject({ code: 'RG_BUSY' })
    await expect(f.runtime.newTask(parent, 'A different task')).rejects.toMatchObject({ code: 'review-gated/refused', details: { reason: 'RG_BUSY' } })
    const stopping = Promise.withResolvers<undefined>()
    f.ctx.on('agent/turn-stopping', ({ agent: candidate }) => { if (candidate === parent) stopping.resolve(undefined) }, { prepend: true })
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Report the current status' }], source: { kind: 'user' } }))
    await stopping.promise
    expect(parent.status).not.toBe('idle')
    expect(f.runtime.read(parent.session)?.task?.reviewStatus).not.toBe('reported-pass')
    flush.resolve(undefined)
    await terminalEntered.promise
    expect(parent.status).not.toBe('idle')
    await expect(f.runtime.startRole(parent, 'worker', handoff, undefined, new AbortController().signal)).rejects.toMatchObject({ code: 'RG_BUSY' })
    await expect(f.runtime.newTask(parent, 'Task during terminal flush')).rejects.toMatchObject({
      code: 'review-gated/refused', details: { reason: 'RG_BUSY' },
    })
    terminalFlush.resolve(undefined)
    await parent.whenIdle()
    expect(f.runtime.read(parent.session)?.task).toMatchObject({ reviewStatus: 'reported-pass', active: null, lastReview: { status: 'completed', report } })
    expect(f.ctx.agents.roots()).toEqual([parent])
  })

  it.each(['saving', 'terminal'] as const)('does not publish a role notice when the %s flush returns false', async (phase) => {
    const f = await setup({ ...settings(), reviewer: { mode: 'custom', pool: pool({ ...main, model: 'reviewer' }) } })
    const { agent } = await f.task()
    const flush = f.ctx.sessions.flush.bind(f.ctx.sessions)
    let refused = false
    const spy = vi.spyOn(f.ctx.sessions, 'flush').mockImplementation(async (session) => {
      const task = f.runtime.read(session)?.task
      const target = phase === 'saving' ? task?.active?.status === 'saving' : task?.active === null && task.lastReview !== null
      if (session === agent.session && target && !refused) { refused = true; return false }
      return flush(session)
    })
    const followup = vi.spyOn(agent, 'followup')
    try {
      const failed = f.until(agent.id, state => state?.diagnostic?.startsWith('RG_RESULT_SAVE_FAILED:') === true)
      await f.runtime.startRole(agent, 'reviewer', handoff, undefined, new AbortController().signal)
      await failed
      await agent.whenIdle()
      expect(refused).toBe(true)
      expect(f.runtime.read(agent.session)?.task?.reviewStatus).toBe('inconclusive')
      expect(followup).not.toHaveBeenCalled()
      await expect(f.runtime.startRole(agent, 'worker', handoff, undefined, new AbortController().signal)).rejects.toMatchObject({ code: 'RG_NOT_READY' })
    } finally { spy.mockRestore(); followup.mockRestore() }
  })

  it.each(['saving', 'terminal'] as const)('exposes an untrusted result after the %s flush fails and refuses further work', async (phase) => {
    const f = await setup({ ...settings(), reviewer: { mode: 'custom', pool: pool({ ...main, model: 'reviewer' }) } })
    const { agent } = await f.task()
    const flush = f.gate()
    const entered = Promise.withResolvers<undefined>()
    let intercepted = false
    f.ctx.on('session/flush', (session) => {
      if (session !== agent.session || intercepted) return
      const task = f.runtime.read(session)?.task
      const selected = phase === 'saving' ? task?.active?.status === 'saving' : task?.active === null && task.lastReview !== null
      if (selected) { intercepted = true; entered.resolve(undefined); return flush.promise }
    })
    const started = await f.runtime.startRole(agent, 'reviewer', handoff, undefined, new AbortController().signal)
    await entered.promise
    const failed = f.until(agent.id, state => state?.diagnostic?.startsWith('RG_RESULT_SAVE_FAILED:') === true)
    flush.reject(new Error('controlled storage failure'.repeat(5000)))
    await failed
    await agent.whenIdle()
    const state = f.runtime.read(agent.session)
    expect(state?.diagnostic).toContain('RG_RESULT_SAVE_FAILED:')
    expect(state?.diagnostic?.length).toBeLessThan(200)
    expect(state?.diagnostic).not.toContain('controlled storage failure')
    expect(state?.task).toMatchObject({ active: null, reviewStatus: 'inconclusive' })
    expect(() => { f.runtime.assertRequest(agent, { ...main, reasoningEffort: high }) }).toThrow(expect.objectContaining({ code: 'RG_NOT_READY' }))
    await expect(f.runtime.startRole(agent, 'worker', handoff, undefined, new AbortController().signal)).rejects.toMatchObject({ code: 'RG_NOT_READY' })
    await expect(f.runtime.newTask(agent, 'Retry without acknowledging storage')).rejects.toMatchObject({
      code: 'review-gated/refused', details: { reason: 'RG_NOT_READY' },
    })
    expect(f.ctx.agents.get(started.subagentId)).toBeUndefined()
  })

  it('charges a cancelled worker attempt and does not let the model reset its exhausted budget', async () => {
    const f = await setup({ ...settings(), maxWorkerAttempts: 1 })
    const { agent } = await f.task()
    const original = f.adapter.script
    f.adapter.script = async (options) => {
      if (options.model !== 'worker') return original(options)
      const signal = options.signal
      if (signal === undefined) throw new Error('worker request is missing its cancellation signal')
      const aborted = Promise.withResolvers<undefined>()
      const abort = () => { aborted.resolve(undefined) }
      signal.addEventListener('abort', abort, { once: true })
      try { if (signal.aborted) abort(); await aborted.promise } finally { signal.removeEventListener('abort', abort) }
      return text('cancelled')
    }
    const started = await f.runtime.startRole(agent, 'worker', handoff, undefined, new AbortController().signal)
    const stopping = Promise.withResolvers<undefined>()
    f.ctx.on('agent/turn-stopping', ({ agent: candidate }) => { if (candidate === agent) stopping.resolve(undefined) }, { prepend: true })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Wait for the worker' }], source: { kind: 'user' } }))
    await stopping.promise
    const cancelled = f.until(agent.id, state => state?.task?.lastWorker?.status === 'cancelled')
    agent.cancel({ kind: 'user' })
    await cancelled
    await agent.whenIdle()
    expect(f.runtime.read(agent.session)?.task).toMatchObject({ workerAttempts: 1, active: null, lastWorker: { status: 'cancelled', report: null } })
    await expect(f.runtime.startRole(agent, 'worker', handoff, undefined, new AbortController().signal)).rejects.toMatchObject({ code: 'RG_BUDGET_EXHAUSTED' })
    expect(f.ctx.agents.get(started.subagentId)).toBeUndefined()
  })

  it('marks a recovered active attempt interrupted without restarting its child', async () => {
    const f = await setup()
    const { agent } = await f.task()
    const original = f.adapter.script
    const entered = Promise.withResolvers<undefined>()
    f.adapter.script = async (options) => {
      if (options.model !== 'worker') return original(options)
      const signal = options.signal
      if (signal === undefined) throw new Error('worker request is missing its cancellation signal')
      const aborted = Promise.withResolvers<undefined>()
      const abort = () => { aborted.resolve(undefined) }
      signal.addEventListener('abort', abort, { once: true })
      entered.resolve(undefined)
      try { if (signal.aborted) abort(); await aborted.promise } finally { signal.removeEventListener('abort', abort) }
      return text('cancelled')
    }
    await f.runtime.startRole(agent, 'worker', handoff, undefined, new AbortController().signal)
    await entered.promise
    // The captured persisted inputs represent a process interruption before any terminal result.
    const seed = agent.session.snapshotEvents()
    await f.runtimeFiber.dispose()
    expect(f.ctx.agents.roots()).toEqual([agent])
    const restored = await setup()
    const handle = await restored.create('rg', seed)
    expect(restored.runtime.read(handle.agent.session)?.task).toMatchObject({ active: null, workerAttempts: 1,
      lastWorker: { status: 'interrupted', report: null } })
    expect(typeof restored.runtime.read(handle.agent.session)?.task?.lastWorker?.diagnostic).toBe('string')
    expect(restored.adapter.calls).toEqual([])
    expect(restored.ctx.agents.roots()).toEqual([handle.agent])
  })

  it('waits for a reserved startup flush during RG teardown and never publishes an abandoned child', async () => {
    const f = await setup()
    const { agent } = await f.task()
    const flush = f.gate()
    const entered = Promise.withResolvers<undefined>()
    const off = f.ctx.on('session/flush', (session) => {
      if (session === agent.session && f.runtime.read(session)?.task?.active?.status === 'reserved') {
        entered.resolve(undefined); return flush.promise
      }
    })
    const starting = f.runtime.startRole(agent, 'worker', handoff, undefined, new AbortController().signal)
    const outcome = starting.then(value => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }))
    await entered.promise
    off()
    const disposing = Promise.withResolvers<undefined>()
    f.runtimeFiber.ctx.effect(() => () => { disposing.resolve(undefined) })
    let stopped = false
    const shutdown = f.runtimeFiber.dispose().then(() => { stopped = true })
    await disposing.promise
    expect(stopped).toBe(false)
    flush.resolve(undefined)
    expect((await outcome).ok).toBe(false)
    await shutdown
    expect(stopped).toBe(true)
    expect(f.ctx.agents.roots()).toEqual([agent])
    expect(f.adapter.calls.every(call => call.model === 'main')).toBe(true)
    const state = agent.session.snapshotEvents().filter(event => event.type === 'review-gated/state').at(-1)?.data.state
    expect(state).toMatchObject({ diagnostic: null, task: { active: null, workerAttempts: 1, lastWorker: { status: 'cancelled' } } })
  })

  it.each(['worker', 'reviewer'] as const)('pins a %s to its reserved route while main retains its entire pool', async (role) => {
    const alternateMain = { ...main, model: 'main-alternate' }
    const chosen = { ...worker, model: `${role}-chosen` }
    const other = { ...worker, model: `${role}-other` }
    const rolePool = { candidates: [other, chosen], default: { provider: other.provider, model: other.model } }
    const f = await setup({ ...settings(), main: { ...pool(main), candidates: [main, alternateMain] }, worker: rolePool,
      reviewer: { mode: 'custom', pool: rolePool } })
    const { agent: parent } = await f.task()
    const release = f.gate()
    const entered = Promise.withResolvers<undefined>()
    const original = f.adapter.script
    f.adapter.script = async (options) => {
      if (options.model !== chosen.model) return original(options)
      entered.resolve(undefined)
      await release.promise
      return structured(role === 'reviewer' ? report
        : { kind: 'worker', outcome: 'completed', summary: 'Inspected the file', changes: [], validation: [], unverified: [] })
    }
    let checkedBeforeReturn = false
    f.ctx.on('agent/created', ({ agent }) => {
      if (f.runtime.read(agent.session)?.role !== role) return
      expect(f.runtime.read(parent.session)?.task?.active?.status).toBe('reserved')
      f.runtime.assertRequest(agent, chosen)
      checkedBeforeReturn = true
    })
    const started = await f.runtime.startRole(parent, role, handoff, chosen, new AbortController().signal)
    expect(checkedBeforeReturn).toBe(true)
    await entered.promise
    const child = f.ctx.agents.get(started.subagentId)!
    expect(f.ctx.agents.modelPolicyFor(child)?.allowedSelections).toEqual([chosen])
    child.model.select(other)
    expect(() => { f.ctx.agents.assertModelSelectionAllowed(child, other) }).toThrow()
    expect(() => { f.runtime.assertRequest(child, child.model.current()!) }).toThrow(expect.objectContaining({ code: 'RG_MODEL_NOT_ALLOWED' }))
    child.model.select(chosen)
    f.runtime.assertRequest(child, chosen)
    parent.model.select({ ...alternateMain, reasoningEffort: high })
    f.runtime.assertRequest(parent, { ...alternateMain, reasoningEffort: high })
    parent.model.select({ ...main, reasoningEffort: high })
    expect(f.runtime.read(parent.session)?.task?.active?.selection).toEqual(chosen)
    release.resolve(undefined)
    await f.until(parent.id, state => state?.task?.active === null)
    expect(f.adapter.calls.filter(call => call.model === other.model)).toEqual([])
    expect(f.adapter.calls.filter(call => call.model === chosen.model)).toHaveLength(1)
  })

  it('denies a publicly selected alternate child route before any model request', async () => {
    const alternate = { ...worker, model: 'worker-alternate' }
    const f = await setup({ ...settings(), worker: { ...pool(worker), candidates: [worker, alternate] } })
    const { agent: parent } = await f.task()
    const notice = Promise.withResolvers<undefined>()
    f.ctx.on('agent/inbox/claimed', ({ agent, message }) => {
      if (agent === parent && message.source.kind === 'review-gated') notice.resolve(undefined)
    })
    f.ctx.on('agent/created', ({ agent }) => {
      if (f.runtime.read(agent.session)?.role === 'worker') agent.model.select(alternate)
    })
    await f.runtime.startRole(parent, 'worker', handoff, undefined, new AbortController().signal)
    await notice.promise
    await parent.whenIdle()
    expect(f.adapter.calls.every(call => call.model === 'main')).toBe(true)
    expect(f.runtime.read(parent.session)?.task).toMatchObject({ workerAttempts: 1, active: null,
      lastWorker: { selection: worker, status: 'failed', report: null } })
  })

  it('refuses another request from a publicly resumed completed one-shot child without granting a new budget', async () => {
    const f = await setup()
    const { agent: parent } = await f.task()
    const notice = Promise.withResolvers<undefined>()
    f.ctx.on('agent/inbox/claimed', ({ agent, message }) => {
      if (agent === parent && message.source.kind === 'review-gated') notice.resolve(undefined)
    })
    const started = await f.runtime.startRole(parent, 'worker', handoff, undefined, new AbortController().signal)
    await notice.promise
    await parent.whenIdle()
    const before = f.adapter.calls.length
    const resumed = await f.ctx.agents.resume({ resumeSessionId: started.subagentId, parentAgent: parent,
      setup: async (childCtx) => { await f.ctx.agentPresets.mount(childCtx, 'rg-worker') } })
    expect(() => { f.runtime.assertRequest(resumed.agent, worker) }).toThrow(expect.objectContaining({ code: 'RG_UNAUTHORIZED_START' }))
    resumed.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Perform unbudgeted work' }], source: { kind: 'user' } }))
    await resumed.agent.whenIdle()
    expect(f.adapter.calls).toHaveLength(before)
    expect(f.runtime.read(parent.session)?.task).toMatchObject({ workerAttempts: 1, active: null })
    expect(resumed.agent.session.snapshotEvents().filter(event => event.type === 'request/header')).toHaveLength(1)
    await resumed.dispose()
  })

  it('durably cancels an accepted child on clean disable and permits work after reenabling the same policy', async () => {
    const f = await setup()
    const { agent: parent } = await f.task()
    const runtime = f.runtime
    const original = f.adapter.script
    const entered = Promise.withResolvers<undefined>()
    f.adapter.script = async (options) => {
      if (options.model !== 'worker') return original(options)
      const signal = options.signal
      if (signal === undefined) throw new Error('worker request is missing its cancellation signal')
      const aborted = Promise.withResolvers<undefined>()
      const abort = () => { aborted.resolve(undefined) }
      signal.addEventListener('abort', abort, { once: true })
      entered.resolve(undefined)
      try { if (signal.aborted) abort(); await aborted.promise } finally { signal.removeEventListener('abort', abort) }
      return text('cancelled')
    }
    const started = await runtime.startRole(parent, 'worker', handoff, undefined, new AbortController().signal)
    await entered.promise
    const flushed: string[] = []
    f.ctx.on('session/flush', (session) => {
      if (session !== parent.session) return
      const state = runtime.read(session)
      const status = state?.task?.active?.status ?? state?.task?.lastWorker?.status
      if (status !== undefined) flushed.push(status)
    })
    await f.enabled(false)
    expect(f.ctx.get('reviewGated')).toBeUndefined()
    const state = parent.session.snapshotEvents().filter(event => event.type === 'review-gated/state').at(-1)?.data.state
    expect(state).toMatchObject({ diagnostic: null, task: { workerAttempts: 1, active: null, lastWorker: { status: 'cancelled', report: null } } })
    expect(flushed).toContain('saving')
    expect(flushed).toContain('cancelled')
    expect(f.ctx.agents.get(started.subagentId)).toBeUndefined()
    await expect(runtime.startRole(parent, 'worker', handoff, undefined, new AbortController().signal)).rejects.toThrow()
    f.adapter.script = original
    await f.enabled(true)
    f.runtime.assertRequest(parent, { ...main, reasoningEffort: high })
    const notice = Promise.withResolvers<undefined>()
    f.ctx.on('agent/inbox/claimed', ({ agent, message }) => {
      if (agent === parent && message.source.kind === 'review-gated') notice.resolve(undefined)
    })
    await f.runtime.startRole(parent, 'worker', handoff, undefined, new AbortController().signal)
    await notice.promise
    await parent.whenIdle()
    expect(f.runtime.read(parent.session)).toMatchObject({ diagnostic: null, task: { workerAttempts: 2, active: null, lastWorker: { status: 'completed' } } })
  })

  it.each(['raw-oversize', 'wrapper-oversize', 'invalid', 'tiny'] as const)('bounds the complete %s report and never publishes a pass', async (kind) => {
    const value = kind === 'invalid' ? { ...report, validation: Array<string>(500).fill(' ') }
      : kind === 'raw-oversize' ? { ...report, summary: 'x'.repeat(4000) } : report
    const maxReportChars = kind === 'tiny' ? 1 : kind === 'wrapper-oversize' ? JSON.stringify(value).length : 3000
    const f = await setup({ ...settings(), maxReportChars, reviewer: { mode: 'custom', pool: pool({ ...main, model: 'reviewer' }) } })
    const { agent: parent } = await f.task()
    const original = f.adapter.script
    f.adapter.script = options => options.model === 'reviewer' ? structured(value) : original(options)
    const notice = Promise.withResolvers<string>()
    f.ctx.on('agent/inbox/claimed', ({ agent, message }) => {
      if (agent === parent && message.source.kind === 'review-gated') {
        notice.resolve(message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(''))
      }
    })
    const first = parent.session.snapshotEvents().length
    await f.runtime.startRole(parent, 'reviewer', handoff, undefined, new AbortController().signal)
    const notification = await notice.promise
    await parent.whenIdle()
    expect(notification.length).toBeLessThanOrEqual(maxReportChars)
    const state = f.runtime.read(parent.session)
    expect(state).toMatchObject({ diagnostic: null, task: { reviewAttempts: 1, active: null, reviewStatus: 'inconclusive', lastReview: { status: 'failed', report: null } } })
    expect(state?.task?.lastReview?.diagnostic?.length).toBeLessThanOrEqual(Math.min(300, maxReportChars))
    expect(sessionStateSchema.safeParse(state).success).toBe(true)
    expect(notification).not.toContain('reported-pass')
    expect(notification).not.toContain('ZodError')
    const published = parent.session.snapshotEvents().slice(first).filter(event => event.type === 'review-gated/state')
    for (const event of published) {
      expect(event.data.state?.task?.active?.report ?? event.data.state?.task?.lastReview?.report ?? null).toBeNull()
      expect(event.data.state?.task?.active?.diagnostic?.length ?? 0).toBeLessThan(300)
      expect(event.data.state?.task?.reviewStatus).not.toBe('reported-pass')
    }
    if (kind !== 'tiny') expect(JSON.parse(notification)).toMatchObject({ status: 'failed', report: null, reviewStatus: 'inconclusive', diagnostic: state?.task?.lastReview?.diagnostic })
  })
})
