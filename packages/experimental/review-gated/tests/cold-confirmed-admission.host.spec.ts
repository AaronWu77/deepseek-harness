/** Cold and resumed views of an unacknowledged exclusive admission. */
import { describe, expect, it, vi } from 'vitest'
import { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { RgTaskId } from '../src/types.ts'
import { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import { gitRuntimeFixture } from './fixtures/git-runtime.ts'

class TestQuery extends SessionQueryEngine {
  override searchSessions(): Promise<never> { return Promise.reject(new Error('Search is not used here')) }
  override searchEvents(): Promise<never> { return Promise.reject(new Error('Search is not used here')) }
}

describe('RG cold confirmed admission', () => {
  it('does not return facts from an observation of a different Session', async () => {
    const f = await gitRuntimeFixture({ backend: false, noGit: true })
    const first = await f.task()
    const second = await f.task()
    const firstId = first.agent.id
    const secondId = second.agent.id
    await first.dispose()
    await second.dispose()
    await f.ctx.plugin(TestQuery)
    const original = f.ctx.sessionQuery.observeSession.bind(f.ctx.sessionQuery)
    const wrong = vi.spyOn(f.ctx.sessionQuery, 'observeSession').mockImplementation((_id, options) => original(secondId, options))
    const abort = new AbortController()
    const stream = f.runtime.watchView({ sessionId: firstId }, abort.signal)[Symbol.asyncIterator]()
    try { expect((await stream.next()).value).toMatchObject({ status: 'unknown', state: null, git: null, claim: null }) }
    finally { abort.abort(); await stream.return?.(); wrong.mockRestore() }
  })

  it('fails closed when the origin identity is still pending despite an earlier matching message', async () => {
    const f = await gitRuntimeFixture({ backend: false, noGit: true })
    const handle = await f.task()
    const { agent } = handle
    const state = f.runtime.read(agent.session)
    if (state?.task == null) throw new Error('Missing completed task')
    const message = agent.session.snapshotEvents().find(event => event.type === 'user/message' && event.data.id === state.task?.originMessageId)
    if (message?.type !== 'user/message') throw new Error('Missing task input')
    agent.session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [message.data] })
    await f.ctx.sessionPersistence.flush()
    const stored = await f.ctx.sessionPersistence.open(agent.id, 'read')
    const prefix = await stored.read()
    const id = SessionId('pending-origin-cold-prefix')
    const copy = await f.ctx.sessionPersistence.create({ ...stored.header, id })
    try { await copy.append(prefix.events); await copy.flush() } finally { await copy.close(); await stored.close() }
    await handle.dispose()
    await f.ctx.plugin(TestQuery)
    const abort = new AbortController()
    using observed = await f.ctx.sessionQuery.observeSession(id, { signal: abort.signal, projectionMode: 'all' })
    expect(observed.projections?.values.inbox?.['next-turn']).toMatchObject([{ id: message.data.id }])
    const cold = f.runtime.watchView({ sessionId: id }, abort.signal)[Symbol.asyncIterator]()
    try { expect((await cold.next()).value).toMatchObject({ status: 'unknown' }) }
    finally { abort.abort(); await cold.return?.() }
  })

  it('fails closed when an observation has no inbox projection', async () => {
    const f = await gitRuntimeFixture({ backend: false, noGit: true })
    const handle = await f.task()
    const id = handle.agent.id
    await handle.dispose()
    await f.ctx.plugin(TestQuery)
    const original = f.ctx.sessionQuery.observeSession.bind(f.ctx.sessionQuery)
    const missing = vi.spyOn(f.ctx.sessionQuery, 'observeSession').mockImplementation(async (...args) => {
      const observation = await original(...args)
      if (observation.projections === undefined) throw new Error('Expected projection snapshot')
      const values = { ...observation.projections.values }
      delete values.inbox
      return { source: observation.source, header: observation.header, inheritedEventCount: observation.inheritedEventCount,
        events: observation.events, cursor: observation.cursor, projections: { ...observation.projections, values },
        retain: () => observation.retain(), [Symbol.dispose]: () => { observation[Symbol.dispose]() } }
    })
    const abort = new AbortController()
    const cold = f.runtime.watchView({ sessionId: id }, abort.signal)[Symbol.asyncIterator]()
    try { expect((await cold.next()).value).toMatchObject({ status: 'unknown' }) }
    finally { abort.abort(); await cold.return?.(); missing.mockRestore() }
  })

  it.each(['content', 'source'] as const)('refuses later matching ids with mismatched %s', async (mismatch) => {
    const f = await gitRuntimeFixture({ backend: false, noGit: true })
    const handle = await f.task()
    const { agent } = handle
    const state = f.runtime.read(agent.session)
    if (state?.task == null) throw new Error('Missing completed task')
    const previous = agent.session.snapshotEvents().find(event => event.type === 'user/message' && event.data.id === state.task?.originMessageId)
    if (previous?.type !== 'user/message') throw new Error('Missing old task message')
    agent.session.append('review-gated/state', { version: 1, state: { ...state,
      task: { ...state.task, id: brandString<RgTaskId>('new-task-' + mismatch) } } })
    agent.session.append('user/message', mismatch === 'content'
      ? { ...previous.data, content: [{ type: 'text', text: 'unrelated input' }] }
      : { ...previous.data, source: { kind: 'system-prompt' } }, { surfaceOp: 'append' })
    const id = agent.id
    await handle.dispose()
    await f.ctx.plugin(TestQuery)
    const abort = new AbortController()
    const cold = f.runtime.watchView({ sessionId: id }, abort.signal)[Symbol.asyncIterator]()
    try { expect((await cold.next()).value).toMatchObject({ status: 'unknown' }) }
    finally { abort.abort(); await cold.return?.() }
  })

  it('does not use an older message with the same identity as evidence for a newer task', async () => {
    const f = await gitRuntimeFixture({ backend: false, noGit: true })
    const handle = await f.task()
    const { agent } = handle
    const state = f.runtime.read(agent.session)
    if (state?.task == null) throw new Error('Missing completed task')
    const previous = agent.session.snapshotEvents().find(event => event.type === 'user/message' && event.data.id === state.task?.originMessageId)
    if (previous?.type !== 'user/message') throw new Error('Missing old task message')
    agent.session.append('review-gated/state', { version: 1, state: { ...state,
      task: { ...state.task, id: brandString<RgTaskId>('reused-origin-new-task'), originMessageId: previous.data.id } } })
    const id = agent.id
    await handle.dispose()
    await f.ctx.plugin(TestQuery)
    const abort = new AbortController()
    const cold = f.runtime.watchView({ sessionId: id }, abort.signal)[Symbol.asyncIterator]()
    try { expect((await cold.next()).value).toMatchObject({ status: 'unknown' }) }
    finally { abort.abort(); await cold.return?.() }
    expect(f.ctx.agents.get(id)).toBeUndefined()
  })

  it('keeps a physically recorded but unacknowledged pending input unknown across cold, resume and fork', async () => {
    const f = await gitRuntimeFixture({ backend: false, noGit: true })
    const handle = await f.create()
    const { agent } = handle
    const original = f.ctx.sessions.flush.bind(f.ctx.sessions)
    let failed = false
    const flush = vi.spyOn(f.ctx.sessions, 'flush').mockImplementation(async (session) => {
      const result = await original(session)
      if (session === agent.session && !failed && session.snapshotEvents().some(event => event.type === 'agent/admission/confirmed')) {
        failed = true
        throw new Error('confirmation acknowledged physically, response lost')
      }
      return result
    })
    try {
      await expect(f.runtime.newTask(agent, 'Pending cold admission')).rejects.toMatchObject({ code: 'review-gated/refused' })
      expect(failed).toBe(true)
      expect(f.adapter.calls).toHaveLength(0)
      const stored = await f.ctx.sessionPersistence.open(agent.id, 'read')
      let events
      try { events = (await stored.read()).events } finally { await stored.close() }
      const confirmation = events.find(event => event.type === 'agent/admission/confirmed')
      if (confirmation?.type !== 'agent/admission/confirmed') throw new Error('Missing durable confirmation')
      expect(events.some(event => event.type === 'user/message' && event.data.id === confirmation.data.messageId)).toBe(false)
      expect(events.some(event => event.type === 'agent/claim/intent')).toBe(false)
      const id = agent.id
      flush.mockRestore()
      await handle.dispose()
      await f.ctx.plugin(TestQuery)
      const abort = new AbortController()
      const cold = f.runtime.watchView({ sessionId: id }, abort.signal)[Symbol.asyncIterator]()
      try { expect((await cold.next()).value).toMatchObject({ status: 'unknown' }) }
      finally { abort.abort(); await cold.return?.() }
      expect(f.ctx.agents.get(id)).toBeUndefined()
      expect(f.adapter.calls).toHaveLength(0)
      const resumed = await f.ctx.agents.resume({ resumeSessionId: id,
        setup: async (child) => { await f.ctx.agentPresets.mount(child, 'rg') } })
      try {
        await resumed.agent.whenIdle()
        expect(f.adapter.calls).toHaveLength(0)
        expect(f.runtime.statusOf(resumed.agent.session)).toBe('unknown')
        const rejected = f.ctx.agents.create({ sessionId: SessionId('fork-pending-cold-admission'), seed: events,
          inheritedEventCount: SessionLogOffset(events.length), meta: { cwd: f.root, isSeeded: true },
          agentOptions: { provider: 'fixture', model: 'prior' },
          setup: async (child) => { await f.ctx.agentPresets.mount(child, 'rg') } })
        await expect(rejected).rejects.toThrow('cannot fork an outstanding exclusive admission')
        expect(f.adapter.calls).toHaveLength(0)
      } finally { await resumed.dispose() }
    } finally { flush.mockRestore() }
  })

  it('trusts a normally admitted and completed input after cold reopening', async () => {
    const f = await gitRuntimeFixture({ backend: false, noGit: true })
    const handle = await f.create()
    const { agent } = handle
    const task = await f.runtime.newTask(agent, 'Completed admission')
    await agent.whenIdle()
    const events = agent.session.snapshotEvents()
    expect(events.some(event => event.type === 'user/message' && event.data.id === task.originMessageId)).toBe(true)
    const calls = f.adapter.calls.length
    const id = agent.id
    await handle.dispose()
    await f.ctx.plugin(TestQuery)
    const abort = new AbortController()
    const cold = f.runtime.watchView({ sessionId: id }, abort.signal)[Symbol.asyncIterator]()
    try { expect((await cold.next()).value).toMatchObject({ status: 'ready', state: { task: { id: task.id } } }) }
    finally { abort.abort(); await cold.return?.() }
    const resumed = await f.ctx.agents.resume({ resumeSessionId: id,
      setup: async (child) => { await f.ctx.agentPresets.mount(child, 'rg') } })
    try {
      await resumed.agent.whenIdle()
      expect(f.runtime.statusOf(resumed.agent.session)).toBe('ready')
      expect(f.adapter.calls).toHaveLength(calls)
    } finally { await resumed.dispose() }
    const fork = await f.ctx.agents.create({ sessionId: SessionId('fork-completed-admission'), seed: events,
      inheritedEventCount: SessionLogOffset(events.length), meta: { cwd: f.root, isSeeded: true },
      agentOptions: { provider: 'fixture', model: 'prior' },
      setup: async (child) => { await f.ctx.agentPresets.mount(child, 'rg') } })
    try {
      await fork.agent.whenIdle()
      expect(f.runtime.statusOf(fork.agent.session)).toBe('ready')
      expect(f.adapter.calls).toHaveLength(calls)
    } finally { await fork.dispose() }
  })
})
