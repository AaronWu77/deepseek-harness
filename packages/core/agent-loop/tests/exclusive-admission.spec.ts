import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import AgentRegistry, { type AdmissionOwner, type PreStepDecision } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SESSION_FLUSH_DURABLE, Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { admissionProjectionDefinition } from '../src/admission.ts'
import { ReactLoopInbox } from '../src/inbox.ts'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { MockAdapter, textResponse } from './mock-adapter.ts'

const owner = brandString<AdmissionOwner>('test-owner')
const message = (text: string) => createUserMessage({
  content: [{ type: 'text', text }], source: { kind: 'user' },
})

async function harness(id: string, root?: string, adapter = new MockAdapter([])) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  if (root !== undefined) await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId(id), { provider: 'mock', model: 'mock' })
  return { ctx, agent }
}

describe('exclusive input admission', () => {
  it('holds waking input through both durable checkpoints and claims only the reserved message first', async () => {
    const { ctx, agent } = await harness('exclusive-admission-order')
    const firstFlush = Promise.withResolvers<typeof SESSION_FLUSH_DURABLE>()
    const enteredFlush = Promise.withResolvers<undefined>()
    const preparation = Promise.withResolvers<undefined>()
    const prepared = Promise.withResolvers<undefined>()
    let flushes = 0
    ctx.on('session/flush', () => {
      if (++flushes === 1) {
        enteredFlush.resolve(undefined)
        return firstFlush.promise
      }
      return SESSION_FLUSH_DURABLE
    })
    const claimed: string[][] = []
    ctx.on('agent/pre-step', async ({ messages }): Promise<PreStepDecision> => {
      claimed.push(messages.map(item => item.id))
      return { kind: 'reject' }
    })
    const reserved = message('reserved')
    const turn = message('followup')
    const step = message('steer')
    const injected = message('injected')
    const operation = agent.runExclusiveAdmission!(owner, reserved, async () => {
      prepared.resolve(undefined)
      await preparation.promise
      return 'prepared'
    })
    await enteredFlush.promise
    agent.followup(turn)
    agent.steer(step)
    agent.inject(injected)
    expect(agent.status).toBe('idle')
    expect(claimed).toEqual([])
    expect(agent.session.snapshotEvents()[0]?.type).toBe('agent/admission/opened')
    expect(agent.inbox.nextTurn.map(item => item.id)).toEqual([turn.id])
    expect(agent.inbox.nextStep.map(item => item.id)).toEqual([step.id, injected.id])
    firstFlush.resolve(SESSION_FLUSH_DURABLE)
    await prepared.promise
    expect(claimed).toEqual([])
    preparation.resolve(undefined)
    expect(await operation).toBe('prepared')
    await agent.whenIdle()
    expect(claimed).toEqual([[reserved.id]])
    expect(agent.inbox.nextTurn.map(item => item.id)).toEqual([turn.id])
    expect(agent.inbox.nextStep.map(item => item.id)).toEqual([step.id, injected.id])
    expect(flushes).toBe(2)
    const types = agent.session.snapshotEvents().map(event => event.type)
    expect(types.indexOf('agent/admission/opened')).toBeLessThan(types.indexOf('agent/admission/confirmed'))
    expect(types.indexOf('agent/admission/confirmed')).toBeLessThan(types.indexOf('turn/start'))
  })

  it.each(['fresh restore', 'fork prefix'] as const)(
    'keeps an unconfirmed open fail-closed through %s', async (mode) => {
      const { ctx, agent } = await harness('exclusive-admission-parent-' + mode)
      const flushEntered = Promise.withResolvers<undefined>()
      const flushRelease = Promise.withResolvers<typeof SESSION_FLUSH_DURABLE>()
      ctx.on('session/flush', (session) => {
        if (session !== agent.session) return SESSION_FLUSH_DURABLE
        flushEntered.resolve(undefined)
        return flushRelease.promise
      })
      const reserved = message('reserved')
      const operation = agent.runExclusiveAdmission!(owner, reserved, async () => {
        throw new Error('stop parent preparation')
      })
      const settled = operation.catch(() => undefined)
      await flushEntered.promise
      const fork = mode === 'fork prefix'
        ? ctx.sessions.fork(agent.session, undefined, SessionId('exclusive-seed-' + mode))
        : undefined
      const seed = (fork ?? agent.session).snapshotEvents()
      const restoring = ctx.agents.create({
        sessionId: SessionId('exclusive-restored-' + mode),
        seed,
        agentOptions: { provider: 'mock', model: 'mock' },
        ...(fork === undefined ? {} : {
          meta: { isSeeded: true }, inheritedEventCount: fork.inheritedEventCount,
        }),
      })
      if (fork !== undefined) {
        await expect(restoring).rejects.toThrow('cannot fork an outstanding exclusive admission')
        flushRelease.resolve(SESSION_FLUSH_DURABLE)
        await settled
        return
      }
      const restored = await restoring
      const other = message('other actor')
      restored.agent.followup(other)
      await restored.agent.whenIdle()
      expect(restored.agent.inbox.nextTurn.map(item => item.id)).toEqual([other.id])
      expect(restored.agent.session.snapshotEvents().some(event => event.type === 'turn/start')).toBe(false)
      expect(restored.agent.exclusiveAdmission).toMatchObject({ owner, messageId: reserved.id, state: 'open' })
      flushRelease.resolve(SESSION_FLUSH_DURABLE)
      await settled
      await restored.dispose()
    },
  )

  it('parks a restored confirmed prefix and retains its pending inputs', async () => {
    const { ctx, agent } = await harness('exclusive-admission-confirmed-parent')
    const confirmationFlush = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<typeof SESSION_FLUSH_DURABLE>()
    let flushes = 0
    ctx.on('session/flush', (session) => {
      if (session !== agent.session) return SESSION_FLUSH_DURABLE
      if (++flushes !== 2) return SESSION_FLUSH_DURABLE
      confirmationFlush.resolve(undefined)
      return release.promise
    })
    const reserved = message('reserved')
    const other = message('other actor')
    const operation = agent.runExclusiveAdmission!(owner, reserved, async () => {
      agent.followup(other)
    })
    await confirmationFlush.promise
    const prefix = agent.session.snapshotEvents()
    const fork = ctx.sessions.fork(agent.session, undefined, SessionId('exclusive-confirmed-fork'))
    await expect(ctx.agents.create({
      sessionId: SessionId('exclusive-confirmed-fork-child'), seed: fork.snapshotEvents(),
      meta: { isSeeded: true }, inheritedEventCount: fork.inheritedEventCount,
    })).rejects.toThrow('cannot fork an outstanding exclusive admission')
    const claims: string[][] = []
    ctx.on('agent/pre-step', async ({ agent: subject, messages }, next): Promise<PreStepDecision> => {
      if (subject.id !== SessionId('exclusive-confirmed-restored')) return next()
      claims.push(messages.map(item => item.id))
      return { kind: 'reject' }
    })
    const restored = await ctx.agents.create({
      sessionId: SessionId('exclusive-confirmed-restored'), seed: prefix,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    await restored.agent.whenIdle()
    expect(claims).toEqual([])
    expect(restored.agent.exclusiveAdmission?.state).toBe('uncertain')
    expect(restored.agent.inbox.nextTurn.map(item => item.id)).toEqual([other.id, reserved.id])
    release.resolve(SESSION_FLUSH_DURABLE)
    await operation
    await agent.whenIdle()
    await restored.dispose()
  })

  it('keeps a confirmed append uncertain when its flush throws after another listener acknowledges', async () => {
    const { ctx, agent } = await harness('exclusive-admission-confirm-unknown')
    const reserved = message('reserved')
    const other = message('other actor')
    let flushes = 0
    ctx.on('session/flush', () => SESSION_FLUSH_DURABLE)
    ctx.on('session/flush', () => {
      if (++flushes === 2) {
        agent.followup(other)
        throw new Error('observer failed after possible durable commit')
      }
    })
    await expect(agent.runExclusiveAdmission!(owner, reserved, async () => 'ready')).rejects.toThrow()
    await agent.whenIdle()
    expect(agent.exclusiveAdmission).toMatchObject({ owner, messageId: reserved.id, state: 'uncertain' })
    expect(agent.inbox.nextTurn.map(item => item.id)).toEqual([reserved.id, other.id])
    expect(agent.session.snapshotEvents().some(event => event.type === 'agent/admission/confirmed')).toBe(true)
    expect(agent.session.snapshotEvents().some(event => event.type === 'turn/start')).toBe(false)
  })

  it('prevents a reentrant inbox observer from removing or replacing the reserved message', async () => {
    const { ctx, agent } = await harness('exclusive-admission-observer')
    const reserved = message('reserved')
    const replacement = message('replacement')
    const failures: string[] = []
    ctx.on('session/flush', () => SESSION_FLUSH_DURABLE)
    ctx.on('agent/inbox/inserted', ({ message: inserted }) => {
      if (inserted.id !== reserved.id) return
      for (const [name, mutate] of [
        ['remove', () => agent.inbox.remove(reserved.id)],
        ['replace', () => agent.inbox.replace(reserved.id, replacement)],
        ['clear', () => { agent.inbox.clear() }],
      ] as const) {
        try { mutate() } catch { failures.push(name) }
      }
    })
    ctx.on('agent/pre-step', async (): Promise<PreStepDecision> => ({ kind: 'reject' }))
    await agent.runExclusiveAdmission!(owner, reserved, async () => {})
    await agent.whenIdle()
    expect(failures).toEqual(['remove', 'replace', 'clear'])
  })

  it('parks all other input after preparation rejects', async () => {
    const { ctx, agent } = await harness('exclusive-admission-prepare-throw')
    ctx.on('session/flush', () => SESSION_FLUSH_DURABLE)
    const other = message('other actor')
    const reserved = message('reserved')
    await expect(agent.runExclusiveAdmission!(owner, reserved, async () => {
      agent.steer(other)
      throw new Error('preparation failed')
    })).rejects.toThrow('preparation failed')
    await agent.whenIdle()
    expect(agent.inbox.nextStep.map(item => item.id)).toEqual([other.id])
    expect(agent.session.snapshotEvents().some(event => event.type === 'turn/start')).toBe(false)
  })

  it('cancels preparation without consuming concurrent work or waiting forever for an uncooperative callback', async () => {
    const { ctx, agent } = await harness('exclusive-admission-cancel')
    ctx.on('session/flush', () => SESSION_FLUSH_DURABLE)
    const entered = Promise.withResolvers<undefined>()
    const never = Promise.withResolvers<undefined>()
    const reserved = message('reserved')
    const other = message('other actor')
    const operation = agent.runExclusiveAdmission!(owner, reserved, async () => {
      entered.resolve(undefined)
      await never.promise
    })
    const settled = operation.catch(() => undefined)
    await entered.promise
    agent.followup(other)
    agent.cancel({ kind: 'user' })
    await settled
    await agent.whenIdle()
    expect(agent.inbox.nextTurn.map(item => item.id)).toEqual([other.id])
    expect(agent.session.snapshotEvents().some(event => event.type === 'turn/start')).toBe(false)
  })

  it('rejects concurrent admissions and pending duplicate identities synchronously', async () => {
    const { ctx, agent } = await harness('exclusive-admission-concurrent')
    const pending = message('already pending')
    agent.inject(pending)
    expect(() => agent.runExclusiveAdmission!(owner, pending, async () => {})).toThrow('not available')
    expect(() => (agent.inbox as ReactLoopInbox).claimReserved(message('missing').id, 1)).toThrow('input is missing')
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    ctx.on('session/flush', () => SESSION_FLUSH_DURABLE)
    const operation = agent.runExclusiveAdmission!(owner, message('reserved'), async () => { entered.resolve(undefined); await release.promise })
    await entered.promise
    expect(() => agent.runExclusiveAdmission!(owner, message('second'), async () => {})).toThrow('not available')
    agent.cancel({ kind: 'user' })
    release.resolve(undefined)
    await expect(operation).rejects.toBeDefined()
  })

  it('holds uncertain when confirmation lacks a writer acknowledgement', async () => {
    const { ctx, agent } = await harness('exclusive-confirm-no-ack')
    let count = 0
    ctx.on('session/flush', () => ++count === 1 ? SESSION_FLUSH_DURABLE : undefined)
    await expect(agent.runExclusiveAdmission!(owner, message('reserved'), async () => {})).rejects.toThrow('confirmation was not acknowledged')
    expect(agent.exclusiveAdmission?.state).toBe('uncertain')
    await agent.whenIdle()
  })

  it('exposes only the exact live first claim during pre-step dispatch', async () => {
    const { ctx, agent } = await harness('exclusive-claim-capability')
    const reserved = message('reserved')
    const other = message('other')
    let captured: AbortSignal | undefined
    ctx.on('session/flush', () => SESSION_FLUSH_DURABLE)
    ctx.on('agent/pre-step', async ({ signal, messages }): Promise<PreStepDecision> => {
      captured = signal
      expect(messages.map(item => item.id)).toEqual([reserved.id])
      expect(agent.exclusiveAdmission?.state).toBe('uncertain')
      expect(agent.isExclusiveAdmissionClaim!(owner, reserved.id, signal)).toBe(true)
      expect(agent.isExclusiveAdmissionClaim!(brandString<AdmissionOwner>('wrong'), reserved.id, signal)).toBe(false)
      expect(agent.isExclusiveAdmissionClaim!(owner, other.id, signal)).toBe(false)
      expect(agent.isExclusiveAdmissionClaim!(owner, reserved.id, new AbortController().signal)).toBe(false)
      agent.cancel({ kind: 'user' })
      expect(agent.isExclusiveAdmissionClaim!(owner, reserved.id, signal)).toBe(false)
      return { kind: 'reject' }
    })
    await agent.runExclusiveAdmission!(owner, reserved, async () => {})
    await agent.whenIdle()
    expect(captured).toBeDefined()
    expect(agent.isExclusiveAdmissionClaim!(owner, reserved.id, captured!)).toBe(false)
  })

  it('keeps the writer alive until an in-flight flush settles during disposal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-exclusive-dispose-'))
    const { ctx, agent } = await harness('exclusive-dispose-flush', root)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const cancelled = Promise.withResolvers<undefined>()
    const cancel = agent.cancel.bind(agent)
    vi.spyOn(agent, 'cancel').mockImplementation((...args) => { cancel(...args); cancelled.resolve(undefined) })
    ctx.on('session/flush', async () => { entered.resolve(undefined); await release.promise })
    const operation = agent.runExclusiveAdmission!(owner, message('reserved'), async () => { throw new Error('must not prepare') })
    const settled = operation.catch(() => undefined)
    try {
      await entered.promise
      const disposing = ctx.fiber.dispose()
      await cancelled.promise
      expect(ctx.sessions.get(agent.id)).toBe(agent.session)
      release.resolve(undefined)
      await disposing
      await settled
      expect(agent.session.snapshotEvents().some(event => event.type === 'agent/admission/confirmed')).toBe(false)
    } finally {
      release.resolve(undefined)
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('replays a claimed uncertain reservation from a checkpoint and suffix', async () => {
    const { ctx, agent } = await harness('exclusive-checkpoint')
    ctx.on('session/flush', () => SESSION_FLUSH_DURABLE)
    ctx.on('agent/pre-step', async (): Promise<PreStepDecision> => ({ kind: 'reject' }))
    const reserved = message('checkpoint')
    let cut = SessionLogOffset(0)
    let rows: ReturnType<typeof ctx.sessionProjections.checkpoint> = {}
    await agent.runExclusiveAdmission!(owner, reserved, async () => {
      cut = agent.session.seq
      rows = ctx.sessionProjections.checkpoint(agent.session)
    })
    await agent.whenIdle()
    const suffix = agent.session.snapshotEvents(cut)
    const restored = ctx.sessionProjections.restore(rows, suffix, cut, agent.session.header, agent.session.inheritedEventCount)
    expect(restored.checkpoint.agentAdmission?.val).toEqual(ctx.sessionProjections.checkpoint(agent.session).agentAdmission?.val)
    expect(restored.checkpoint.agentAdmission?.val).toMatchObject({ owner, messageId: reserved.id, confirmed: true, index: null })
    const resume = await ctx.agents.create({
      sessionId: SessionId('exclusive-claimed-restore'), seed: agent.session.snapshotEvents(),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    await resume.agent.whenIdle()
    expect(resume.agent.exclusiveAdmission).toMatchObject({ owner, messageId: reserved.id, state: 'uncertain' })
    expect(resume.agent.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(1)
    await resume.dispose()
  })

  it('rejects reentrant delivery from a synchronous session observer without changing the log', async () => {
    const { ctx, agent } = await harness('exclusive-session-observer')
    const other = message('not accepted')
    let failure: unknown
    let before = -1
    let after = -1
    ctx.on('session/flush', () => SESSION_FLUSH_DURABLE)
    ctx.on('session/event', (session, event) => {
      if (session !== agent.session || event.type !== 'agent/admission/opened') return
      before = session.seq
      try { agent.followup(other) } catch (error: unknown) { failure = error }
      after = session.seq
    })
    ctx.on('agent/pre-step', async (): Promise<PreStepDecision> => ({ kind: 'reject' }))
    await agent.runExclusiveAdmission!(owner, message('reserved'), async () => {})
    await agent.whenIdle()
    expect(failure).toBeInstanceOf(Error)
    expect(String(failure)).toContain('cannot reenter')
    expect(after).toBe(before)
    expect(agent.inbox.nextTurn.some(item => item.id === other.id)).toBe(false)
    expect(agent.session.snapshotEvents().some(event => event.type === 'agent/inbox/spliced'
      && event.data.inserted.some(item => item.id === other.id))).toBe(false)
  })

  it('cancels during inserted notification without releasing concurrent input', async () => {
    const { ctx, agent } = await harness('exclusive-observer-cancel')
    const reserved = message('reserved')
    const other = message('preserved')
    ctx.on('session/flush', () => SESSION_FLUSH_DURABLE)
    ctx.on('agent/inbox/inserted', ({ message: inserted }) => {
      if (inserted.id !== reserved.id) return
      agent.followup(other)
      agent.cancel({ kind: 'user' })
      throw new Error('observer failure')
    })
    await expect(agent.runExclusiveAdmission!(owner, reserved, async () => {})).rejects.toBeDefined()
    await agent.whenIdle()
    expect(agent.inbox.nextTurn.map(item => item.id)).toEqual([reserved.id, other.id])
    expect(agent.session.snapshotEvents().some(event => event.type === 'agent/admission/confirmed')).toBe(false)
    expect(agent.session.snapshotEvents().some(event => event.type === 'turn/start')).toBe(false)
  })

  it('rejects malformed admission replay and tracks shifted reservations', () => {
    const session = Session.create(SessionId('exclusive-projection-cases'))
    const reserved = message('reserved')
    const other = message('other')
    const open = session.append('agent/admission/opened', { owner, messageId: reserved.id })
    const confirmed = session.append('agent/admission/confirmed', { owner, messageId: reserved.id })
    const different = session.append('agent/admission/confirmed', { owner, messageId: other.id })
    const inserted = session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [reserved] })
    const before = session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [other] })
    const after = session.append('agent/inbox/spliced', { target: 'next-turn', start: 1, inserted: [other] })
    const deleteBefore = session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })
    const malformed = session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' })
    const claim = session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })
    const otherUser = session.append('user/message', other, { surfaceOp: 'append' })
    const ownUser = session.append('user/message', reserved, { surfaceOp: 'append' })
    const apply = (...args: Parameters<typeof admissionProjectionDefinition.apply>) => admissionProjectionDefinition.apply(...args)
    const opened = apply(null, open)!
    expect(() => apply(opened, open)).toThrow('overlapping exclusive admissions')
    expect(() => apply(null, confirmed)).toThrow('invalid exclusive admission confirmation')
    expect(() => apply(opened, confirmed)).toThrow('invalid exclusive admission confirmation')
    const pending = apply(opened, inserted)!
    expect(() => apply(pending, different)).toThrow('invalid exclusive admission confirmation')
    expect(() => apply(pending, claim)).toThrow('unconfirmed admission input was removed')
    const ready = apply(pending, confirmed)!
    expect(() => apply(ready, confirmed)).toThrow('invalid exclusive admission confirmation')
    expect(() => apply(ready, malformed)).toThrow('invalid exclusive admission claim')
    expect(apply(ready, after)).toBe(ready)
    const shifted = apply(ready, before)!
    expect(shifted.index).toBe(1)
    expect(apply(shifted, deleteBefore)?.index).toBe(0)
    const claimed = apply(ready, claim)!
    expect(() => apply(claimed, inserted)).toThrow('claimed admission input was reinserted')
    expect(apply(claimed, otherUser)).toBe(claimed)
    expect(apply(claimed, ownUser)).toBeNull()
  })

  it('flushes physical claim and user message before invoking the model', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-exclusive-'))
    let logPath = ''
    let atModel = ''
    const adapter = new MockAdapter([() => {
      atModel = readFileSync(logPath, 'utf8')
      return textResponse('done')
    }])
    const { ctx, agent } = await harness('exclusive-physical', root, adapter)
    try {
      const reserved = message('reserved physical')
      await agent.runExclusiveAdmission!(owner, reserved, async () => {
        const paths = (await readdir(root, { recursive: true })).filter(path => path.endsWith('.jsonl'))
        expect(paths).toHaveLength(1)
        logPath = join(root, paths[0]!)
        const opened = await readFile(logPath, 'utf8')
        expect(opened).toContain('agent/admission/opened')
        expect(opened).not.toContain('agent/admission/confirmed')
      })
      await agent.whenIdle()
      expect(adapter.requests).toHaveLength(1)
      expect(atModel).toContain('agent/admission/confirmed')
      expect(atModel).toContain('agent/inbox/spliced')
      expect(atModel).toContain('user/message')
      expect(atModel).toContain(reserved.id)
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('parks real JSONL confirmed and claimed prefixes without execution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-exclusive-resume-'))
    const adapter = new MockAdapter([textResponse('once')])
    const { ctx } = await harness('exclusive-resume-controller', root, adapter)
    try {
      const reserved = message('recover')
      const seed = async (id: string, claimed: boolean): Promise<void> => {
        const session = Session.create(SessionId(id))
        session.append('agent/admission/opened', { owner, messageId: reserved.id })
        session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [reserved] })
        session.append('agent/admission/confirmed', { owner, messageId: reserved.id })
        if (claimed) {
          session.append('turn/start', { turn: 1 })
          session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })
        }
        const handle = await ctx.sessionPersistence.create(session.header)
        await handle.append(session.snapshotEvents())
        await handle.close()
      }
      await seed('exclusive-physical-claimed', true)
      const claimed = await ctx.agents.resume({ resumeSessionId: SessionId('exclusive-physical-claimed'), agentOptions: { provider: 'mock', model: 'mock' } })
      await claimed.agent.whenIdle()
      expect(claimed.agent.exclusiveAdmission).toMatchObject({ owner, messageId: reserved.id, state: 'uncertain' })
      expect(adapter.requests).toHaveLength(0)
      await claimed.dispose()
      await seed('exclusive-physical-confirmed', false)
      const confirmed = await ctx.agents.resume({ resumeSessionId: SessionId('exclusive-physical-confirmed'), agentOptions: { provider: 'mock', model: 'mock' } })
      await confirmed.agent.whenIdle()
      expect(confirmed.agent.exclusiveAdmission?.state).toBe('uncertain')
      expect(confirmed.agent.inbox.nextTurn).toEqual([reserved])
      expect(adapter.requests).toHaveLength(0)
      await confirmed.dispose()
      const again = await ctx.agents.resume({ resumeSessionId: SessionId('exclusive-physical-confirmed'), agentOptions: { provider: 'mock', model: 'mock' } })
      await again.agent.whenIdle()
      expect(again.agent.exclusiveAdmission?.state).toBe('uncertain')
      expect(adapter.requests).toHaveLength(0)
      await again.dispose()
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each(['missing', 'throw'] as const)('stops the model when first-claim flush has %s acknowledgement', async (failure) => {
    const adapter = new MockAdapter([textResponse('must not run')])
    const { ctx, agent } = await harness('exclusive-claim-flush-failure-' + failure, undefined, adapter)
    let flushes = 0
    ctx.on('session/flush', () => {
      if (++flushes === 3) {
        if (failure === 'throw') throw new Error('claim durability unknown')
        return undefined
      }
      return SESSION_FLUSH_DURABLE
    })
    const reserved = message('reserved')
    await agent.runExclusiveAdmission!(owner, reserved, async () => {})
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(0)
    expect(agent.exclusiveAdmission).toMatchObject({ owner, messageId: reserved.id, state: 'uncertain' })
    const next = message('preserved')
    agent.followup(next)
    await agent.whenIdle()
    expect(agent.inbox.nextTurn.map(item => item.id)).toEqual([next.id])
  })

  it.each(['missing acknowledgement', 'throwing observer'] as const)(
    'keeps concurrent input parked when flush has %s', async (failure) => {
      const { ctx, agent } = await harness('exclusive-admission-' + failure)
      const pending = message('other actor')
      const reserved = message('reserved')
      ctx.on('session/flush', () => {
        agent.followup(pending)
        if (failure === 'throwing observer') throw new Error('flush failed after a possible write')
      })
      let prepared = false
      await expect(agent.runExclusiveAdmission!(owner, reserved, async () => {
        prepared = true
      })).rejects.toThrow()
      expect(prepared).toBe(false)
      await agent.whenIdle()
      expect(agent.inbox.nextTurn.map(item => item.id)).toEqual([pending.id])
      expect(agent.session.snapshotEvents().some(event => event.type === 'turn/start')).toBe(false)
    },
  )
})
