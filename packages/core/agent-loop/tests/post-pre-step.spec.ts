import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type AdmissionOwner } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { brandString } from '@deepseek-ai/dsh-brand'
import LlmRuntime, { createUserMessage, LlmError } from '@deepseek-ai/dsh-llm'
import SessionStore, { SESSION_FLUSH_DURABLE, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { expect, it, onTestFinished, vi } from 'vitest'
import { MockAdapter, textResponse } from './mock-adapter.ts'

const message = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

async function harness(id: string, adapter = new MockAdapter([textResponse('done')])) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId(id), { provider: 'mock', model: 'mock' })
  return { ctx, agent, adapter }
}

it('observes the final outer decision once, protects it across awaits, and runs scoped void listeners in order', async () => {
  const { ctx, agent, adapter } = await harness('post-pre-step-enter')
  const original = message('original')
  const chosen = structuredClone(message('chosen'))
  const chosenMessages = [chosen]
  const called: string[] = []
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  onTestFinished(() => { release.resolve(undefined) })
  ctx.on('agent/pre-step', async (_, next) => {
    await next()
    return { kind: 'enter', messages: chosenMessages }
  })
  agent.ctx.on('agent/post-pre-step', async ({ claimedMessages, admittedMessages, signal, modelSelection, turn, step }) => {
    called.push('first')
    expect(claimedMessages).toEqual([original])
    expect(admittedMessages).toEqual([chosen])
    expect({ turn, step }).toEqual({ turn: 1, step: 1 })
    expect(signal.aborted).toBe(false)
    expect(modelSelection).toEqual({ provider: 'mock', model: 'mock' })
    expect(Object.isFrozen(modelSelection)).toBe(true)
    expect(Object.isFrozen(claimedMessages)).toBe(true)
    expect(Object.isFrozen(admittedMessages)).toBe(true)
    expect(Object.isFrozen(admittedMessages[0]?.content[0])).toBe(true)
    expect(Reflect.set(admittedMessages, '0', original)).toBe(false)
    expect(Reflect.set(modelSelection, 'model', 'changed')).toBe(false)
    const admittedBlock = admittedMessages[0]?.content[0]
    if (admittedBlock !== undefined) expect(Reflect.set(admittedBlock, 'text', 'changed')).toBe(false)
    entered.resolve(undefined)
    await release.promise
    called.push('first:end')
  })
  agent.ctx.on('agent/post-pre-step', () => { called.push('second') })
  const other = await ctx.agentLoop.create(SessionId('post-pre-step-other'), { provider: 'mock', model: 'mock' })
  other.ctx.on('agent/post-pre-step', () => { called.push('wrong-scope') })
  agent.followup(original)
  await entered.promise
  expect(adapter.requests).toHaveLength(0)
  expect(agent.session.snapshotEvents().some(event => event.type === 'user/message')).toBe(false)
  chosenMessages.length = 0
  const block = chosen.content[0]
  if (block?.type === 'text') block.text = 'changed after decision'
  release.resolve(undefined)
  await agent.whenIdle()
  expect(called).toEqual(['first', 'first:end', 'second'])
  expect(adapter.requests).toHaveLength(1)
  expect(agent.session.snapshotEvents().find(event => event.type === 'user/message')).toMatchObject({ data: { content: [{ type: 'text', text: 'chosen' }] } })
})

it('runs for an empty enter without starting a model step', async () => {
  const { ctx, agent, adapter } = await harness('post-pre-step-empty')
  const original = message('removed')
  let calls = 0
  ctx.on('agent/pre-step', async (_, next) => { await next(); return { kind: 'enter', messages: [] } })
  let guardCalls = 0
  ctx.on('agent/post-pre-step', ({ claimedMessages, admittedMessages, addGuard }) => {
    addGuard(() => { guardCalls++; return undefined })
    calls++
    expect(claimedMessages).toEqual([original])
    expect(admittedMessages).toEqual([])
  })
  agent.followup(original)
  await agent.whenIdle()
  expect(calls).toBe(1)
  expect(guardCalls).toBe(0)
  expect(adapter.requests).toHaveLength(0)
})

it('does not run on a final rejection by outer middleware', async () => {
  const { ctx, agent, adapter } = await harness('post-pre-step-reject')
  let called = 0
  ctx.on('agent/pre-step', async (_, next) => { await next(); return { kind: 'reject' } })
  ctx.on('agent/post-pre-step', () => { called++ })
  agent.followup(message('rejected'))
  await agent.whenIdle()
  expect(called).toBe(0)
  expect(adapter.requests).toHaveLength(0)
})

it.each(['throw', 'cancel'] as const)('leaves the protected original unknown and disposes tools on listener %s', async (mode) => {
  const { ctx, agent, adapter } = await harness('post-pre-step-' + mode)
  ctx.on('session/flush', () => SESSION_FLUSH_DURABLE)
  agent.enableClaimProtection!()
  const original = message('protected original')
  const resolve = ctx.tools.resolve.bind(ctx.tools)
  let disposed = 0
  vi.spyOn(ctx.tools, 'resolve').mockImplementation(async (context) => {
    const set = await resolve(context)
    return { view: scope => set.view(scope), dispose: () => { disposed++; set.dispose() } }
  })
  ctx.on('agent/pre-step', async (_, next) => { await next(); return { kind: 'enter', messages: [message('replacement')] } })
  ctx.on('agent/post-pre-step', async ({ signal }) => {
    expect(signal.aborted).toBe(false)
    if (mode === 'throw') throw new Error('listener failure')
    agent.cancel({ kind: 'user' })
    await Promise.resolve()
  })
  agent.followup(original)
  await agent.whenIdle()
  expect(adapter.requests).toHaveLength(0)
  expect(agent.claimProtectionStatus).toBe('unknown')
  expect(agent.claimRecovery?.inputs).toEqual([{ target: 'next-turn', message: original }])
  expect(agent.session.snapshotEvents().some(event => event.type === 'user/message' || event.type === 'agent/claim/settled')).toBe(false)
  expect(disposed).toBe(1)
})



it('runs scoped guards in registration order after async preparation and flushes', async () => {
  const { ctx, agent, adapter } = await harness('post-pre-step-guard-order')
  const other = await ctx.agentLoop.create(SessionId('post-pre-step-guard-other'), { provider: 'mock', model: 'mock' })
  agent.enableClaimProtection!()
  const order: string[] = []
  ctx.on('session/flush', async (): Promise<typeof SESSION_FLUSH_DURABLE> => { await Promise.resolve(); order.push('flush'); return SESSION_FLUSH_DURABLE })
  agent.ctx.on('agent/post-pre-step', ({ addGuard }) => {
    addGuard(() => { order.push('guard-1'); return undefined })
  })
  agent.ctx.on('agent/post-pre-step', async ({ addGuard }) => {
    await Promise.resolve()
    addGuard(() => { order.push('guard-2'); return undefined })
  })
  other.ctx.on('agent/post-pre-step', ({ addGuard }) => {
    addGuard(() => { order.push('wrong-scope'); return undefined })
  })
  agent.followup(message('go'))
  await agent.whenIdle()
  expect(adapter.requests).toHaveLength(1)
  const firstGuard = order.indexOf('guard-1')
  expect(firstGuard).toBeGreaterThanOrEqual(2)
  expect(order.slice(firstGuard, firstGuard + 2)).toEqual(['guard-1', 'guard-2'])
  expect(order.slice(0, firstGuard)).toEqual(['flush', 'flush'])
  expect(order).not.toContain('wrong-scope')
})

it('fails closed after a later listener changes state and keeps the original protected claim', async () => {
  const { ctx, agent, adapter } = await harness('post-pre-step-guard-invalidated')
  ctx.on('session/flush', () => SESSION_FLUSH_DURABLE)
  agent.enableClaimProtection!()
  const input = message('original')
  let active = true
  let disposed = 0
  const resolve = ctx.tools.resolve.bind(ctx.tools)
  vi.spyOn(ctx.tools, 'resolve').mockImplementation(async (context) => {
    const set = await resolve(context)
    return { view: scope => set.view(scope), dispose: () => { disposed++; set.dispose() } }
  })
  agent.ctx.on('agent/post-pre-step', ({ addGuard }) => {
    addGuard(() => { if (!active) throw new Error('authority changed'); return undefined })
  })
  agent.ctx.on('agent/post-pre-step', () => { active = false })
  agent.followup(input)
  await agent.whenIdle()
  expect(adapter.requests).toHaveLength(0)
  expect(agent.claimProtectionStatus).toBe('unknown')
  expect(agent.claimRecovery?.inputs).toEqual([{ target: 'next-turn', message: input }])
  expect(agent.session.snapshotEvents().some(event => event.type === 'agent/claim/settled' && event.data.outcome === 'entered')).toBe(true)
  expect(disposed).toBe(1)
})

it.each(['complete', 'throw', 'cancel'] as const)('closes registration after dispatch %s', async (mode) => {
  const { ctx, agent } = await harness('post-pre-step-guard-close-' + mode)
  let register: ((guard: () => undefined) => void) | undefined
  ctx.on('agent/post-pre-step', ({ addGuard }) => {
    register = addGuard
    if (mode === 'throw') throw new Error('listener failed')
    if (mode === 'cancel') agent.cancel({ kind: 'user' })
  })
  agent.followup(message('go'))
  await agent.whenIdle()
  expect(register).toBeDefined()
  expect(() => { register!(() => undefined) }).toThrow('guard registration is closed')
})

it('rejects an accidentally asynchronous guard and consumes its rejection', async () => {
  const { ctx, agent, adapter } = await harness('post-pre-step-guard-async')
  let failure: unknown
  ctx.on('agent/error', ({ error }) => { failure = error })
  ctx.on('agent/post-pre-step', ({ addGuard }) => {
    Reflect.apply(addGuard, undefined, [async () => { throw new Error('async guard rejection') }])
  })
  agent.followup(message('go'))
  await agent.whenIdle()
  expect(adapter.requests).toHaveLength(0)
  expect(failure).toBeInstanceOf(TypeError)
  expect(String(failure)).toContain('guard must return undefined synchronously')
})

it('stops the chain and model when a guard cancels the turn', async () => {
  const { ctx, agent, adapter } = await harness('post-pre-step-guard-cancel')
  let second = false
  let disposed = 0
  const input = message('protected')
  ctx.on('session/flush', () => SESSION_FLUSH_DURABLE)
  agent.enableClaimProtection!()
  const resolve = ctx.tools.resolve.bind(ctx.tools)
  vi.spyOn(ctx.tools, 'resolve').mockImplementation(async (context) => {
    const set = await resolve(context)
    return { view: scope => set.view(scope), dispose: () => { disposed++; set.dispose() } }
  })
  ctx.on('agent/post-pre-step', ({ addGuard }) => {
    addGuard(() => { agent.cancel({ kind: 'user' }); return undefined })
    addGuard(() => { second = true; return undefined })
  })
  agent.followup(input)
  await agent.whenIdle()
  expect(second).toBe(false)
  expect(adapter.requests).toHaveLength(0)
  expect(agent.claimProtectionStatus).toBe('unknown')
  expect(agent.claimRecovery?.inputs).toEqual([{ target: 'next-turn', message: input }])
  expect(disposed).toBe(1)
})

it.each([false, true])('runs guards again before retry, with invalidation %s', async (invalidate) => {
  const adapter = new MockAdapter([() => { throw new LlmError('busy', 'RATE_LIMIT') }, textResponse('done')])
  const { ctx, agent } = await harness('post-pre-step-guard-retry-' + String(invalidate), adapter)
  let active = true
  let checks = 0
  let registrations = 0
  ctx.on('agent/post-pre-step', ({ addGuard }) => {
    registrations++
    addGuard(() => { checks++; if (!active) throw new Error('authority revoked'); return undefined })
  })
  ctx.on('agent/request-error', async () => {
    if (invalidate) active = false
    return { kind: 'retry' }
  })
  agent.followup(message('go'))
  await agent.whenIdle()
  expect(registrations).toBe(1)
  expect(checks).toBe(2)
  expect(adapter.requests).toHaveLength(invalidate ? 1 : 2)
})

it('retains exclusive first-claim attribution throughout the callback', async () => {
  const { ctx, agent, adapter } = await harness('post-pre-step-exclusive')
  const owner = brandString<AdmissionOwner>('post-pre-step-owner')
  const input = message('exclusive')
  ctx.on('session/flush', () => SESSION_FLUSH_DURABLE)
  let captured: AbortSignal | undefined
  ctx.on('agent/post-pre-step', async ({ claimedMessages, admittedMessages, signal }) => {
    captured = signal
    expect(claimedMessages).toEqual([input])
    expect(admittedMessages).toEqual([input])
    expect(agent.isExclusiveAdmissionClaim!(owner, input.id, signal)).toBe(true)
    await Promise.resolve()
    expect(agent.isExclusiveAdmissionClaim!(owner, input.id, signal)).toBe(true)
  })
  await agent.runExclusiveAdmission!(owner, input, async () => {})
  await agent.whenIdle()
  expect(captured).toBeDefined()
  expect(agent.isExclusiveAdmissionClaim!(owner, input.id, captured!)).toBe(false)
  expect(adapter.requests).toHaveLength(1)
})
