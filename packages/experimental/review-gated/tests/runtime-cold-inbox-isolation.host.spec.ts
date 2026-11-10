/** Cold task views require the original input to be absent from both inbox queues. */
import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import { gitRuntimeFixture } from './fixtures/git-runtime.ts'

class TestQuery extends SessionQueryEngine {
  override searchSessions(): Promise<never> { return Promise.reject(new Error('Search is not used here')) }
  override searchEvents(): Promise<never> { return Promise.reject(new Error('Search is not used here')) }
}

describe('RG cold inbox isolation', () => {
  it.each([
    ['next-turn', true, 'unknown'],
    ['next-step', true, 'unknown'],
    ['next-turn', false, 'ready'],
    ['next-step', false, 'ready'],
  ] as const)('classifies %s with pending origin=%s as %s', async (target, pendingOrigin, expected) => {
    const f = await gitRuntimeFixture({ backend: false, noGit: true })
    const handle = await f.task()
    const { agent } = handle
    const task = f.runtime.read(agent.session)?.task
    if (task == null) throw new Error('Expected a task')
    const origin = agent.session.snapshotEvents().find(event => event.type === 'user/message' && event.data.id === task.originMessageId)
    if (origin?.type !== 'user/message') throw new Error('Expected the recorded task input')
    const inserted = pendingOrigin ? origin.data : createUserMessage({ content: [{ type: 'text', text: 'Unrelated queued input' }], source: { kind: 'user' } })
    agent.session.append('agent/inbox/spliced', { target, start: 0, inserted: [inserted] })
    await f.ctx.sessionPersistence.flush()
    const stored = await f.ctx.sessionPersistence.open(agent.id, 'read')
    const id = SessionId('cold-inbox-isolation')
    const copy = await f.ctx.sessionPersistence.create({ ...stored.header, id })
    try { await copy.append((await stored.read()).events); await copy.flush() }
    finally { await copy.close(); await stored.close() }
    const calls = f.adapter.calls.length
    await handle.dispose()
    await f.ctx.plugin(TestQuery)
    const abort = new AbortController()
    using observation = await f.ctx.sessionQuery.observeSession(id, { signal: abort.signal, projectionMode: 'all' })
    expect(observation.projections?.values.inbox?.[target]).toMatchObject([{ id: inserted.id }])
    const stream = f.runtime.watchView({ sessionId: id }, abort.signal)[Symbol.asyncIterator]()
    try {
      const frame = await stream.next()
      expect(frame.value).toMatchObject({ status: expected, state: { task: { id: task.id } } })
      expect(f.ctx.agents.get(id)).toBeUndefined()
      expect(f.adapter.calls).toHaveLength(calls)
    } finally { abort.abort(); await stream.return?.() }
  })
})
