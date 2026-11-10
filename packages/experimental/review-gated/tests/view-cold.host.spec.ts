/** Passive RG views observe real persisted Sessions without activating an Agent. */
import { describe, expect, it, vi } from 'vitest'
import { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { gitRuntimeFixture, gitSettings } from './fixtures/git-runtime.ts'

class TestQuery extends SessionQueryEngine {
  override searchSessions(): Promise<never> { return Promise.reject(new Error('Search is not used here')) }
  override searchEvents(): Promise<never> { return Promise.reject(new Error('Search is not used here')) }
}

describe('RG cold views', () => {
  it('keeps only the latest replacement while a reader is stalled', async () => {
    const f = await gitRuntimeFixture({ backend: false, noGit: true })
    const { agent } = await f.task()
    const state = f.runtime.read(agent.session)
    if (state?.task == null) throw new Error('Expected a managed task')
    const abort = new AbortController()
    const stream = f.runtime.watchView({ sessionId: agent.id }, abort.signal)[Symbol.asyncIterator]()
    expect((await stream.next()).value).toMatchObject({ status: 'ready' })
    try {
      for (let index = 0; index < 1000; index++) {
        agent.session.append('review-gated/state', { version: 1,
          state: { ...state, task: { ...state.task, objective: 'replacement ' + String(index) } } })
      }
      agent.session.append('review-gated/state', { version: 1, state: { ...state, diagnostic: 'outcome uncertain' } })
      expect((await stream.next()).value).toMatchObject({ status: 'unknown', state: null })
      agent.session.append('review-gated/state', { version: 1, state })
      agent.session.append('review-gated/state', { version: 1, state: { ...state, diagnostic: 'still uncertain' } })
      expect((await stream.next()).value).toMatchObject({ status: 'unknown', state: null })
    } finally { abort.abort(); await stream.return?.() }
  })

  it('bounds the complete claim summary with escaped and non-text input', async () => {
    const f = await gitRuntimeFixture({ backend: false, noGit: true, settings: { ...gitSettings(), maxReportChars: 512 } })
    const { agent } = await f.task()
    const text = '汉字\n"\\\ud800'.repeat(2000)
    const claim = { intentSeq: SessionSeq(1), target: 'next-turn' as const, turn: 1, step: 1,
      inputs: [{ target: 'next-turn' as const, message: { id: 'raw', role: 'user', source: { kind: 'user' },
        content: [null, { type: 'file', name: 'retained' }, { type: 'text', text }] } }] }
    const result = f.runtime.claimReport(agent.session, 'unknown', claim)
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(512)
    expect(result).toMatchObject({ claimStatus: 'unknown', rawPayloadTruncated: true,
      claim: { phase: 'unsettled', inputCount: 1, otherContent: true } })
    if (result.claim === null) throw new Error('Expected claim preview')
    expect(text.startsWith(result.claim.textPreview)).toBe(true)
    expect(result.claim.textPreview.length).toBeLessThan(text.length)
    const expanded = { ...result, claim: { ...result.claim, textPreview: text.slice(0, result.claim.textPreview.length + 1) } }
    expect(JSON.stringify(expanded).length).toBeGreaterThan(512)
    const broken = vi.spyOn(f.runtime['projection'], 'stateOf').mockImplementationOnce(() => { throw new Error('unreadable projection') })
    try { expect(JSON.stringify(f.runtime.claimReport(agent.session, 'unknown', claim)).length).toBeLessThanOrEqual(512) }
    finally { broken.mockRestore() }
  })

  it('refuses a claim summary when the configured wrapper budget is too small', async () => {
    const f = await gitRuntimeFixture({ backend: false, noGit: true, settings: { ...gitSettings(), maxReportChars: 1 } })
    const { agent } = await f.task()
    expect(() => f.runtime.claimReport(agent.session, 'unknown', null)).toThrow(/report limit/)
  })

  it('does not trust a cold cut when a live replacement comes and goes during opening', async () => {
    const f = await gitRuntimeFixture({ backend: false, noGit: true })
    const handle = await f.task()
    const id = handle.agent.id
    await handle.dispose()
    await f.ctx.plugin(TestQuery)
    const entered = f.gate()
    const release = f.gate()
    const original = f.ctx.sessionQuery.observeSession.bind(f.ctx.sessionQuery)
    const spy = vi.spyOn(f.ctx.sessionQuery, 'observeSession').mockImplementation(async (...args) => {
      const observation = await original(...args)
      entered.resolve(undefined)
      await release.promise
      return observation
    })
    const abort = new AbortController()
    const stream = f.runtime.watchView({ sessionId: id }, abort.signal)[Symbol.asyncIterator]()
    const opening = stream.next()
    try {
      await entered.promise
      const resumed = await f.ctx.agents.resume({ resumeSessionId: id,
        setup: async (child) => { await f.ctx.agentPresets.mount(child, 'rg') } })
      const state = f.runtime.read(resumed.agent.session)
      if (state?.task == null) throw new Error('Expected a recovered task')
      resumed.agent.session.append('review-gated/state', { version: 1, state: { ...state, task: { ...state.task, objective: 'replacement completed' } } })
      await resumed.dispose()
      expect(f.ctx.sessions.get(id)).toBeUndefined()
      release.resolve(undefined)
      expect((await opening).value).toMatchObject({ status: 'unknown', state: null })
    } finally { release.resolve(undefined); abort.abort(); await stream.return?.(); spy.mockRestore() }
  })

  it('keeps a durable uncertain RG task unknown after reopening', async () => {
    const f = await gitRuntimeFixture({ backend: false, noGit: true })
    const handle = await f.task()
    const state = f.runtime.read(handle.agent.session)
    if (state === null) throw new Error('Expected an RG task')
    handle.agent.session.append('review-gated/state', { version: 1,
      state: { ...state, diagnostic: 'RG_RESULT_SAVE_FAILED: inspect the retained result' } })
    const id = handle.agent.id
    await handle.dispose()
    await f.ctx.plugin(TestQuery)
    const abort = new AbortController()
    const stream = f.runtime.watchView({ sessionId: id }, abort.signal)[Symbol.asyncIterator]()
    try {
      expect((await stream.next()).value).toMatchObject({ status: 'unknown', state: { diagnostic: 'RG_RESULT_SAVE_FAILED: inspect the retained result' } })
      expect(f.ctx.agents.get(id)).toBeUndefined()
    } finally { abort.abort(); await stream.return?.() }
  })

  it('closes a live view and releases its subscription when RG stops', async () => {
    const f = await gitRuntimeFixture({ backend: false, noGit: true })
    const { agent } = await f.task()
    const runtime = f.runtime
    const abort = new AbortController()
    const stream = runtime.watchView({ sessionId: agent.id }, abort.signal)[Symbol.asyncIterator]()
    await stream.next()
    const pending = stream.next()
    await f.enabled(false)
    expect((await pending).done).toBe(true)
    expect(runtime['viewListeners'].has(agent.id)).toBe(false)
    abort.abort()
  })

  it('contains a failing subscriber without dropping another subscriber update', async () => {
    const f = await gitRuntimeFixture({ backend: false, noGit: true })
    const { agent } = await f.task()
    const abort = new AbortController()
    const stream = f.runtime.watchView({ sessionId: agent.id }, abort.signal)[Symbol.asyncIterator]()
    await stream.next()
    const listeners = f.runtime['viewListeners'].get(agent.id)
    if (listeners === undefined) throw new Error('Missing live view subscribers')
    const bad = vi.fn(() => { throw new Error('subscriber failed') })
    listeners.add(bad)
    try {
      const state = f.runtime.read(agent.session)
      if (state === null) throw new Error('Missing RG state')
      agent.session.append('review-gated/state', { version: 1, state: { ...state, diagnostic: 'view update' } })
      expect((await stream.next()).value).toMatchObject({ status: 'unknown', state: null })
      expect(bad).toHaveBeenCalledOnce()
    } finally { listeners.delete(bad); abort.abort(); await stream.return?.() }
  })

  it.each(['rejected', 'empty'] as const)('retains %s input disposition in live and cold views', async (phase) => {
    const f = await gitRuntimeFixture({ backend: false, noGit: true })
    const handle = await f.task()
    const { agent } = handle
    const stop = agent.ctx.on('agent/pre-step', async () => phase === 'rejected'
      ? { kind: 'reject' as const } : { kind: 'enter' as const, messages: [] })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: '原始 input to inspect' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    stop()
    const abort = new AbortController()
    const live = f.runtime.watchView({ sessionId: agent.id }, abort.signal)[Symbol.asyncIterator]()
    try { expect((await live.next()).value).toMatchObject({ status: 'ready', claim: { phase, text: '原始 input to inspect' } }) }
    finally { await live.return?.() }
    const id = agent.id
    await handle.dispose()
    await f.ctx.plugin(TestQuery)
    const cold = f.runtime.watchView({ sessionId: id }, abort.signal)[Symbol.asyncIterator]()
    try { expect((await cold.next()).value).toMatchObject({ status: 'ready', claim: { phase, text: '原始 input to inspect' } }) }
    finally { abort.abort(); await cold.return?.() }
  })

  it('requires a query service and does not activate a persisted Session', async () => {
    const f = await gitRuntimeFixture({ backend: false, noGit: true })
    const handle = await f.task()
    const id = handle.agent.id
    await handle.dispose()
    expect(f.ctx.sessions.get(id)).toBeUndefined()
    const abort = new AbortController()
    const noQuery = f.runtime.watchView({ sessionId: id }, abort.signal)[Symbol.asyncIterator]()
    try { expect((await noQuery.next()).value).toMatchObject({ status: 'unknown' }) }
    finally { await noQuery.return?.() }
    await f.ctx.plugin(TestQuery)
    const cold = f.runtime.watchView({ sessionId: id }, abort.signal)[Symbol.asyncIterator]()
    try {
      const frame = await cold.next()
      expect(frame.value).toMatchObject({ status: 'ready', state: { task: { objective: 'Deliver the scoped implementation' } } })
      expect(f.ctx.agents.get(id)).toBeUndefined()
      expect(f.ctx.sessions.get(id)).toBeUndefined()
    } finally { abort.abort(); await cold.return?.() }
  })

  it('rechecks the live instance after a cold observation is acquired', async () => {
    const f = await gitRuntimeFixture({ backend: false, noGit: true })
    const handle = await f.task()
    const id = handle.agent.id
    await handle.dispose()
    await f.ctx.plugin(TestQuery)
    const entered = f.gate()
    const release = f.gate()
    const original = f.ctx.sessionQuery.observeSession.bind(f.ctx.sessionQuery)
    const spy = vi.spyOn(f.ctx.sessionQuery, 'observeSession').mockImplementation(async (...args) => {
      const observation = await original(...args)
      entered.resolve(undefined)
      await release.promise
      return observation
    })
    const abort = new AbortController()
    const stream = f.runtime.watchView({ sessionId: id }, abort.signal)[Symbol.asyncIterator]()
    const opening = stream.next()
    try {
      await entered.promise
      const resumed = await f.ctx.agents.resume({ resumeSessionId: id,
        setup: async (child) => { await f.ctx.agentPresets.mount(child, 'rg') } })
      const state = f.runtime.read(resumed.agent.session)
      if (state?.task == null) throw new Error('Expected a recovered task')
      resumed.agent.session.append('review-gated/state', { version: 1, state: { ...state, task: { ...state.task, objective: 'live replacement' } } })
      release.resolve(undefined)
      expect((await opening).value).toMatchObject({ state: { task: { objective: 'live replacement' } } })
      await resumed.dispose()
    } finally { release.resolve(undefined); abort.abort(); await stream.return?.(); spy.mockRestore() }
  })
})
