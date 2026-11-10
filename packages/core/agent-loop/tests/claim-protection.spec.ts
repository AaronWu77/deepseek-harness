import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type AdmissionOwner } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage, LlmError } from '@deepseek-ai/dsh-llm'
import SessionStore, { SESSION_FLUSH_DURABLE, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import { MockAdapter, textResponse } from './mock-adapter.ts'
import { claimProjectionDefinition } from '../src/claim.ts'

const message = (text: string) => createUserMessage({
  content: [{ type: 'text', text }], source: { kind: 'user' },
})

async function setup(root: string, adapter: MockAdapter, resume = false, persistence = true) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  if (persistence) await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  const id = SessionId('claim-protection')
  try {
    const agent = resume
      ? (await ctx.agents.resume({ resumeSessionId: id, agentOptions: { provider: 'mock', model: 'mock' } })).agent
      : await ctx.agentLoop.create(id, { provider: 'mock', model: 'mock' })
    return { ctx, agent }
  } catch (error: unknown) {
    await ctx.fiber.dispose()
    throw error
  }
}

describe('protected claim durability', () => {
  it('stores the exact original input before pre-step and the admitted user before dispatch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-protected-claim-'))
    let logPath = ''
    let atModel = ''
    const adapter = new MockAdapter([() => {
      atModel = readFileSync(logPath, 'utf8')
      return textResponse('done')
    }])
    const { ctx, agent } = await setup(root, adapter)
    try {
      expect('enableClaimProtection' in agent).toBe(true)
      agent.enableClaimProtection!()
      const input = message('precise original')
      let atPreStep = ''
      ctx.on('agent/pre-step', async ({ agent: subject }, next) => {
        if (subject !== agent) return next()
        const paths = (await readdir(root, { recursive: true })).filter(path => path.endsWith('.jsonl'))
        expect(paths).toHaveLength(1)
        logPath = join(root, paths[0]!)
        atPreStep = await readFile(logPath, 'utf8')
        return next()
      })
      agent.followup(input)
      await agent.whenIdle()
      expect(atPreStep).toContain('agent/claim/intent')
      expect(atPreStep).toContain('precise original')
      expect(atPreStep).toContain(input.id)
      expect(atModel).toContain('agent/claim/settled')
      expect(atModel).toContain('user/message')
      expect(adapter.requests).toHaveLength(1)
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reserves the captured batch while allowing unrelated ordered arrivals', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-protected-race-'))
    const { ctx, agent } = await setup(root, new MockAdapter([]))
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const batches: string[][] = []
    try {
      agent.enableClaimProtection!()
      const original = message('original')
      const earlier = message('prepended')
      const other = message('followup')
      const steering = message('steering')
      let flushCount = 0
      ctx.on('session/flush', async (session) => {
        if (session !== agent.session || ++flushCount !== 1) return
        entered.resolve(undefined)
        await release.promise
      })
      ctx.on('agent/pre-step', async ({ agent: subject, messages }, next) => {
        if (subject !== agent) return next()
        batches.push(messages.map(item => item.id))
        return { kind: 'reject' }
      })
      agent.followup(original)
      await entered.promise
      expect(agent.claimProtectionStatus).toBe('saving')
      expect(() => agent.inbox.remove(original.id)).toThrow('reserved')
      expect(() => { agent.inbox.clear() }).toThrow('reserved')
      agent.inbox.prepend('next-turn', earlier)
      agent.followup(other)
      agent.steer(steering)
      release.resolve(undefined)
      await agent.whenIdle()
      expect(batches).toEqual([[original.id]])
      expect(agent.inbox.nextTurn.map(item => item.id)).toEqual([earlier.id, other.id])
      expect(agent.inbox.nextStep.map(item => item.id)).toEqual([steering.id])
      expect(agent.claimProtectionStatus).toBeNull()
    } finally {
      release.resolve(undefined)
      await agent.whenIdle()
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('holds the instance when the actual user-message flush fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-protected-failed-flush-'))
    const adapter = new MockAdapter([textResponse('must not dispatch')])
    const { ctx, agent } = await setup(root, adapter)
    try {
      agent.enableClaimProtection!()
      let flushCount = 0
      ctx.on('session/flush', (session) => {
        if (session === agent.session && ++flushCount === 2) throw new Error('checkpoint failed')
      })
      const input = message('retain on uncertain flush')
      const states: (string | null)[] = []
      ctx.on('agent/claim/status', ({ agent: subject, status }) => { if (subject === agent) states.push(status) })
      agent.followup(input)
      await agent.whenIdle()
      expect(states).toEqual(['saving', 'unknown'])
      expect(agent.claimProtectionStatus).toBe('unknown')
      expect(agent.claimRecovery?.inputs).toEqual([{ target: 'next-turn', message: input }])
      agent.followup(message('other'))
      await agent.whenIdle()
      expect(adapter.requests).toHaveLength(0)
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps saving through assistant flush and parks its pre-dispatch physical prefix', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-protected-output-'))
    const adapter = new MockAdapter([textResponse('one response')])
    const { ctx, agent } = await setup(root, adapter)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    let cut = 0
    try {
      agent.enableClaimProtection!()
      ctx.on('session/event', (session, event) => {
        if (session === agent.session && event.type === 'agent/claim/settled') cut = event.seq + 1
      })
      let flushCount = 0
      ctx.on('session/flush', async (session) => {
        if (session !== agent.session || ++flushCount !== 3) return
        entered.resolve(undefined)
        await release.promise
        throw new Error('assistant checkpoint failed')
      })
      const input = message('dispatch once')
      agent.followup(input)
      await entered.promise
      expect(agent.claimProtectionStatus).toBe('saving')
      expect(agent.claimRecovery?.inputs).toEqual([{ target: 'next-turn', message: input }])
      expect(adapter.requests).toHaveLength(1)
      const reader = await ctx.sessionPersistence.open(agent.id, 'read')
      const prefix = (await reader.read(0, cut)).events
      await reader.close()
      expect(prefix.at(-1)?.type).toBe('agent/claim/settled')
      const restored = await ctx.agents.create({
        sessionId: SessionId('protected-dispatch-cut'), seed: prefix,
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      try {
        expect(restored.agent.claimProtectionStatus).toBe('unknown')
        expect(ctx.sessionProjections.snapshot(restored.agent.session, ['agentClaim']).values.agentClaim)
          .toMatchObject({ phase: 'entered', inputs: [{ target: 'next-turn', message: input }] })
        restored.agent.followup(message('must remain pending'))
        await restored.agent.whenIdle()
        expect(adapter.requests).toHaveLength(1)
      } finally { await restored.dispose() }
      release.resolve(undefined)
      await agent.whenIdle()
      expect(agent.claimProtectionStatus).toBe('unknown')
      agent.followup(message('also pending'))
      await agent.whenIdle()
      expect(adapter.requests).toHaveLength(1)
    } finally {
      release.resolve(undefined)
      await agent.whenIdle()
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each(['enter', 'reject'] as const)('settles %s after a pre-step model call and logged user side effect', async (decision) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-protected-side-effect-'))
    const adapter = new MockAdapter([textResponse('auxiliary'), textResponse('main')])
    const { ctx, agent } = await setup(root, adapter)
    try {
      agent.enableClaimProtection!()
      const input = message('original')
      const sideEffect = message('checkpoint produced by pre-step')
      ctx.on('agent/pre-step', async ({ agent: subject }, next) => {
        if (subject !== agent) return next()
        for await (const _chunk of ctx.llm.stream({ provider: 'mock', model: 'mock', messages: [], purpose: 'compaction' })) {}
        agent.session.append('user/message', sideEffect, { surfaceOp: 'append' })
        return decision === 'reject' ? { kind: 'reject' } : next()
      })
      agent.followup(input)
      await agent.whenIdle()
      const settlement = agent.session.snapshotEvents().find(event => event.type === 'agent/claim/settled')
      expect(settlement?.type).toBe('agent/claim/settled')
      if (settlement?.type !== 'agent/claim/settled') throw new Error('missing settlement')
      expect(settlement.data).toMatchObject({ outcome: decision === 'reject' ? 'rejected' : 'entered', messages: decision === 'reject' ? [] : [input] })
      expect(agent.claimProtectionStatus).toBeNull()
      if (decision === 'reject') {
        expect(ctx.sessionProjections.snapshot(agent.session, ['agentClaim']).values.agentClaim)
          .toMatchObject({ phase: 'rejected', inputs: [{ target: 'next-turn', message: input }] })
      }
      expect(adapter.requests).toHaveLength(decision === 'reject' ? 1 : 2)
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each(['rewrite', 'empty'] as const)('records the actual %s pre-step decision', async (mode) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-protected-decision-'))
    const adapter = new MockAdapter([textResponse('rewritten answer')])
    const { ctx, agent } = await setup(root, adapter)
    try {
      agent.enableClaimProtection!()
      const original = message('original')
      const replacement = message('replacement')
      ctx.on('agent/pre-step', async ({ agent: subject }, next) => {
        if (subject !== agent) return next()
        return { kind: 'enter', messages: mode === 'rewrite' ? [replacement] : [] }
      })
      agent.followup(original)
      await agent.whenIdle()
      const events = agent.session.snapshotEvents()
      const intent = events.find(event => event.type === 'agent/claim/intent')
      const settlement = events.find(event => event.type === 'agent/claim/settled')
      expect(intent?.type === 'agent/claim/intent' && intent.data.inputs).toEqual([{ target: 'next-turn', message: original }])
      expect(settlement?.type === 'agent/claim/settled' && settlement.data).toMatchObject({
        outcome: mode === 'rewrite' ? 'entered' : 'empty', messages: mode === 'rewrite' ? [replacement] : [],
      })
      expect(agent.claimProtectionStatus).toBeNull()
      if (mode === 'empty') {
        const view = ctx.sessionProjections.snapshot(agent.session, ['agentClaim']).values.agentClaim
        expect(view).toMatchObject({ phase: 'empty', inputs: [{ target: 'next-turn', message: original }] })
        const checkpoint = ctx.sessionProjections.checkpoint(agent.session)
        const restored = ctx.sessionProjections.restore(
          checkpoint, [], agent.session.seq, agent.session.header, agent.session.inheritedEventCount,
        )
        expect(restored.snapshot.values.agentClaim).toEqual(view)
      }
      expect(adapter.requests).toHaveLength(mode === 'rewrite' ? 1 : 0)
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects an invalid settlement outcome from a JSONL file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-protected-invalid-jsonl-'))
    const first = await setup(root, new MockAdapter([]))
    try {
      first.agent.enableClaimProtection!()
      first.ctx.on('agent/pre-step', async () => ({ kind: 'reject' }))
      first.agent.followup(message('invalid settlement'))
      await first.agent.whenIdle()
      await first.ctx.fiber.dispose()
      const paths = (await readdir(root, { recursive: true })).filter(path => path.endsWith('.jsonl'))
      expect(paths).toHaveLength(1)
      const file = join(root, paths[0]!)
      const content = await readFile(file, 'utf8')
      const malformed = content.replace('"outcome":"rejected"', '"outcome":"invalid"')
      expect(malformed).not.toBe(content)
      await writeFile(file, malformed)
      await expect(setup(root, new MockAdapter([]), true)).rejects.toThrow()
    } finally {
      await first.ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('retains an empty disposition across JSONL reopen until later input completes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-protected-empty-reopen-'))
    const first = await setup(root, new MockAdapter([]))
    let second: Awaited<ReturnType<typeof setup>> | undefined
    try {
      first.agent.enableClaimProtection!()
      const original = message('not admitted')
      first.ctx.on('agent/pre-step', async () => ({ kind: 'enter', messages: [] }))
      first.agent.followup(original)
      await first.agent.whenIdle()
      await first.ctx.fiber.dispose()
      const adapter = new MockAdapter([textResponse('new input completed')])
      second = await setup(root, adapter, true)
      expect(second.agent.claimProtectionStatus).toBeNull()
      expect(second.ctx.sessionProjections.snapshot(second.agent.session, ['agentClaim']).values.agentClaim)
        .toMatchObject({ phase: 'empty', inputs: [{ target: 'next-turn', message: original }] })
      expect(adapter.requests).toHaveLength(0)
      second.agent.enableClaimProtection!()
      const later = message('new explicit input')
      second.agent.followup(later)
      await second.agent.whenIdle()
      expect(adapter.requests).toHaveLength(1)
      expect(second.ctx.sessionProjections.snapshot(second.agent.session, ['agentClaim']).values.agentClaim).toBeNull()
    } finally {
      await first.ctx.fiber.dispose()
      await second?.ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps a thrown pre-step with an auxiliary model call unknown', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-protected-prestep-throw-'))
    const adapter = new MockAdapter([textResponse('auxiliary')])
    const { ctx, agent } = await setup(root, adapter)
    try {
      agent.enableClaimProtection!()
      const input = message('not replayed')
      ctx.on('agent/pre-step', async ({ agent: subject }, next) => {
        if (subject !== agent) return next()
        for await (const _chunk of ctx.llm.stream({ provider: 'mock', model: 'mock', messages: [], purpose: 'compaction' })) {}
        throw new Error('pre-step failed after auxiliary call')
      })
      agent.followup(input)
      await agent.whenIdle()
      expect(agent.claimProtectionStatus).toBe('unknown')
      expect(agent.claimRecovery?.inputs).toEqual([{ target: 'next-turn', message: input }])
      agent.followup(message('later'))
      await agent.whenIdle()
      expect(adapter.requests).toHaveLength(1)
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('marks an interrupted durability wait unknown before it settles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-protected-cancel-'))
    const { ctx, agent } = await setup(root, new MockAdapter([]))
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const states: (string | null)[] = []
    let preSteps = 0
    try {
      agent.enableClaimProtection!()
      ctx.on('session/flush', async (session) => {
        if (session !== agent.session) return
        entered.resolve(undefined)
        await release.promise
      })
      ctx.on('agent/claim/status', ({ agent: subject, status }) => { if (subject === agent) states.push(status) })
      ctx.on('agent/pre-step', async ({ agent: subject }, next) => { if (subject === agent) preSteps++; return next() })
      const input = message('cancel while saving')
      agent.followup(input)
      await entered.promise
      agent.cancel({ kind: 'user' })
      expect(states).toEqual(['saving', 'unknown'])
      expect(agent.claimRecovery?.inputs).toEqual([{ target: 'next-turn', message: input }])
      expect(agent.inbox.nextTurn).toEqual([input])
      expect(preSteps).toBe(0)
      release.resolve(undefined)
      await agent.whenIdle()
      expect(agent.claimProtectionStatus).toBe('unknown')
      expect(preSteps).toBe(0)
    } finally {
      release.resolve(undefined)
      await agent.whenIdle()
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([0, 1, 2])('holds when durability acknowledgement is absent after %i checkpoints', async (acknowledgedCount) => {
    const adapter = new MockAdapter([textResponse('one')])
    const { ctx, agent } = await setup('', adapter, false, false)
    try {
      let count = 0
      ctx.on('session/flush', () => ++count <= acknowledgedCount ? SESSION_FLUSH_DURABLE : undefined)
      agent.enableClaimProtection!()
      agent.followup(message('must be held'))
      await agent.whenIdle()
      expect(agent.claimProtectionStatus).toBe('unknown')
      expect(adapter.requests).toHaveLength(acknowledgedCount === 2 ? 1 : 0)
    } finally { await ctx.fiber.dispose() }
  })

  it('does not create an intent when the waking input is removed before capture', async () => {
    const { ctx, agent } = await setup('', new MockAdapter([]), false, false)
    try {
      agent.enableClaimProtection!()
      ctx.on('agent/status', ({ agent: subject, status }) => {
        if (subject === agent && status === 'running') agent.inbox.clear()
      })
      agent.followup(message('cleared before claim'))
      await agent.whenIdle()
      expect(agent.session.snapshotEvents().some(event => event.type === 'agent/claim/intent')).toBe(false)
      expect(agent.claimProtectionStatus).toBeNull()
    } finally { await ctx.fiber.dispose() }
  })

  it('retains the same protected claim across a model retry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-protected-retry-'))
    const adapter = new MockAdapter([() => { throw new LlmError('busy', 'RATE_LIMIT') }, textResponse('ok')])
    const { ctx, agent } = await setup(root, adapter)
    try {
      agent.enableClaimProtection!()
      ctx.on('agent/request-error', async () => ({ kind: 'retry' }))
      agent.followup(message('retry once'))
      await agent.whenIdle()
      expect(adapter.requests).toHaveLength(2)
      expect(agent.claimProtectionStatus).toBeNull()
      expect(agent.session.snapshotEvents().filter(event => event.type === 'agent/claim/settled')).toHaveLength(1)
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('holds if a claim callback settles its input before pre-step returns', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-protected-claim-reentry-'))
    const { ctx, agent } = await setup(root, new MockAdapter([]))
    try {
      agent.enableClaimProtection!()
      ctx.on('agent/inbox/claimed', ({ agent: subject }) => {
        if (subject !== agent) return
        const claim = agent.claimRecovery
        if (claim === null || claim === undefined) throw new Error('missing claim')
        agent.session.append('agent/claim/settled', { intentSeq: claim.intentSeq, outcome: 'rejected', messages: [] })
      })
      ctx.on('agent/pre-step', async () => ({ kind: 'reject' }))
      agent.followup(message('settled by callback'))
      await agent.whenIdle()
      expect(agent.claimProtectionStatus).toBe('unknown')
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('contains reentrant status callbacks without changing the captured batch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-protected-status-reentry-'))
    const adapter = new MockAdapter([textResponse('first'), textResponse('second')])
    const { ctx, agent } = await setup(root, adapter)
    try {
      agent.enableClaimProtection!()
      const first = message('first')
      const second = message('from status listener')
      const batches: string[][] = []
      let sent = false
      ctx.on('agent/claim/status', ({ agent: subject, status }) => {
        if (subject !== agent || status !== 'saving' || sent) return
        sent = true
        agent.followup(second)
      })
      ctx.on('agent/pre-step', async ({ agent: subject, messages }, next) => {
        if (subject === agent) batches.push(messages.map(item => item.id))
        return next()
      })
      agent.followup(first)
      await agent.whenIdle()
      expect(batches).toEqual([[first.id], [second.id]])
      expect(adapter.requests).toHaveLength(2)
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('protects the exclusive first claim without consuming other actors input', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-protected-exclusive-'))
    const adapter = new MockAdapter([])
    const { ctx, agent } = await setup(root, adapter)
    try {
      agent.enableClaimProtection!()
      const reserved = message('exclusive')
      const other = message('other')
      const steer = message('steer')
      const batches: string[][] = []
      const admissionAtClaim: (string | undefined)[] = []
      ctx.on('agent/inbox/claimed', ({ agent: subject }) => {
        if (subject === agent) admissionAtClaim.push(agent.exclusiveAdmission?.state)
      })
      ctx.on('agent/pre-step', async ({ agent: subject, messages }, next) => {
        if (subject !== agent) return next()
        batches.push(messages.map(item => item.id))
        return { kind: 'reject' }
      })
      await agent.runExclusiveAdmission!(brandString<AdmissionOwner>('test'), reserved, async () => {
        agent.followup(other)
        agent.steer(steer)
      })
      await agent.whenIdle()
      expect(batches).toEqual([[reserved.id]])
      expect(admissionAtClaim).toEqual(['uncertain'])
      expect(agent.inbox.nextTurn).toEqual([other])
      expect(agent.inbox.nextStep).toEqual([steer])
      expect(adapter.requests).toHaveLength(0)
      const events = agent.session.snapshotEvents()
      expect(events.filter(event => event.type === 'agent/claim/intent')).toHaveLength(1)
      expect(events.filter(event => event.type === 'agent/claim/settled')).toHaveLength(1)
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('protects each queued and running-step batch in order', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-protected-batches-'))
    const adapter = new MockAdapter([textResponse('one'), textResponse('two'), textResponse('three')])
    const { ctx, agent } = await setup(root, adapter)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const batches: string[][] = []
    try {
      agent.enableClaimProtection!()
      const injected = message('queued injection')
      const first = message('first turn')
      const steering = message('running step')
      const second = message('next turn')
      ctx.on('agent/pre-step', async ({ agent: subject, messages }, next) => {
        if (subject !== agent) return next()
        batches.push(messages.map(item => item.id))
        if (batches.length === 1) { entered.resolve(undefined); await release.promise }
        return next()
      })
      agent.inject(injected)
      agent.followup(first)
      await entered.promise
      agent.steer(steering)
      agent.followup(second)
      release.resolve(undefined)
      await agent.whenIdle()
      expect(batches).toEqual([[injected.id, first.id], [steering.id], [second.id]])
      expect(adapter.requests).toHaveLength(3)
      expect(agent.claimProtectionStatus).toBeNull()
      const events = agent.session.snapshotEvents()
      expect(events.filter(event => event.type === 'agent/claim/intent')).toHaveLength(3)
      expect(events.filter(event => event.type === 'agent/claim/settled')).toHaveLength(3)
    } finally {
      release.resolve(undefined)
      await agent.whenIdle()
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects replay of a reordered or duplicated captured batch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-protected-invalid-'))
    const { ctx, agent } = await setup(root, new MockAdapter([]))
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    try {
      agent.enableClaimProtection!()
      ctx.on('agent/pre-step', async ({ agent: subject }, next) => {
        if (subject !== agent) return next()
        entered.resolve(undefined)
        await release.promise
        return { kind: 'reject' }
      })
      agent.inject(message('first steering'))
      agent.inject(message('second steering'))
      agent.followup(message('turn'))
      await entered.promise
      const prefix = agent.session.snapshotEvents()
      const outOfOrder = structuredClone(prefix)
      const intentSeq = outOfOrder.find(event => event.type === 'agent/claim/intent')?.seq
      const removal = outOfOrder.find(event => event.type === 'agent/inbox/spliced'
        && intentSeq !== undefined && event.seq > intentSeq && event.data.removedCount !== undefined)
      if (removal?.type !== 'agent/inbox/spliced') throw new Error('missing claim splice')
      removal.data.start = 1
      await expect(ctx.agents.create({ sessionId: SessionId('out-of-order-claim'), seed: outOfOrder }))
        .rejects.toThrow('claimed out of order')
      for (const mode of ['reordered', 'duplicate'] as const) {
        const seed = structuredClone(prefix)
        const intent = seed.find(event => event.type === 'agent/claim/intent')
        if (intent?.type !== 'agent/claim/intent') throw new Error('missing intent')
        if (mode === 'reordered') intent.data.inputs.reverse()
        else intent.data.inputs.push(intent.data.inputs[0]!)
        await expect(ctx.agents.create({ sessionId: SessionId('invalid-claim-' + mode), seed }))
          .rejects.toThrow('claim intent does not match ordered batch')
      }
    } finally {
      release.resolve(undefined)
      await agent.whenIdle()
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('parks a physical prefix after an auxiliary pre-step model call without replaying it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-protected-prefix-'))
    const adapter = new MockAdapter([textResponse('auxiliary')])
    const { ctx, agent } = await setup(root, adapter)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    try {
      agent.enableClaimProtection!()
      const input = message('inspect after crash')
      ctx.on('agent/pre-step', async ({ agent: subject }, next) => {
        if (subject !== agent) return next()
        for await (const _chunk of ctx.llm.stream({ provider: 'mock', model: 'mock', messages: [], purpose: 'compaction' })) {}
        entered.resolve(undefined)
        await release.promise
        return { kind: 'reject' }
      })
      agent.followup(input)
      await entered.promise
      expect(adapter.requests).toHaveLength(1)
      const reader = await ctx.sessionPersistence.open(agent.id, 'read')
      const prefix = (await reader.read()).events
      await reader.close()
      expect(prefix.some(event => event.type === 'agent/claim/intent')).toBe(true)
      expect(prefix.some(event => event.type === 'agent/claim/settled')).toBe(false)
      const cut = agent.session.seq
      const checkpoint = ctx.sessionProjections.checkpoint(agent.session)
      const invalid = structuredClone(checkpoint.agentClaim?.val)
      const decoded = claimProjectionDefinition.stateSchema.parse(invalid)
      expect(decoded.claim).not.toBeNull()
      if (decoded.claim === null) throw new Error('expected claim checkpoint')
      decoded.claim.remaining = ['not-a-claimed-id']
      expect(claimProjectionDefinition.stateSchema.safeParse(decoded).success).toBe(false)
      agent.followup(message('checkpoint suffix'))
      const replay = ctx.sessionProjections.restore(
        checkpoint, agent.session.snapshotEvents(cut), cut, agent.session.header, agent.session.inheritedEventCount,
      )
      expect(replay.snapshot.values.agentClaim).toEqual(ctx.sessionProjections.snapshot(agent.session, ['agentClaim']).values.agentClaim)
      const fork = ctx.sessions.fork(agent.session, undefined, SessionId('protected-claim-fork'))
      await expect(ctx.agents.create({
        sessionId: SessionId('protected-claim-fork-child'), seed: fork.snapshotEvents(),
        meta: { isSeeded: true }, inheritedEventCount: fork.inheritedEventCount,
      })).rejects.toThrow('cannot fork an unsettled claim')
      const restored = await ctx.agents.create({
        sessionId: SessionId('protected-prefix-restored'), seed: prefix,
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      try {
        expect(restored.agent.claimProtectionStatus).toBe('unknown')
        expect(restored.agent.claimRecovery?.inputs).toEqual([{ target: 'next-turn', message: input }])
        expect(() => restored.agent.runExclusiveAdmission!(brandString<AdmissionOwner>('other'), message('new exclusive'), async () => {}))
          .toThrow('not available')
        expect(ctx.sessionProjections.snapshot(restored.agent.session, ['agentClaim']).values.agentClaim)
          .toMatchObject({ inputs: [{ target: 'next-turn', message: input }] })
        restored.agent.followup(message('other'))
        await restored.agent.whenIdle()
        expect(adapter.requests).toHaveLength(1)
      } finally { await restored.dispose() }
    } finally {
      release.resolve(undefined)
      await agent.whenIdle()
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})
