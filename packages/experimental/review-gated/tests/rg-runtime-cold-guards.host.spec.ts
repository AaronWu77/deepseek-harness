/** Cold-view evidence guards over recorded Session logs and real protected claims. */
import { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import { describe, expect, it } from 'vitest'
import { gitRuntimeFixture } from './fixtures/git-runtime.ts'

class TestQuery extends SessionQueryEngine {
  override searchSessions(): Promise<never> { return Promise.reject(new Error('Search is not used here')) }
  override searchEvents(): Promise<never> { return Promise.reject(new Error('Search is not used here')) }
}

describe('RG cold view guards', { timeout: 120_000 }, () => {
  it('fails closed when a prepared direct task cannot be matched to its claim', async () => {
    const f = await gitRuntimeFixture({ backend: false, noGit: true })
    const handle = await f.task()
    const { agent } = handle
    const state = f.runtime.read(agent.session)
    if (state?.task == null) throw new Error('Expected a task')
    // A prepared direct task whose recorded claim intent no longer exists cannot authorize the task.
    agent.session.append('review-gated/direct-task-prepared', { version: 1, intentSeq: 999_999 as never,
      messageId: state.task.originMessageId, state: { ...state, task: { ...state.task, objective: 'rewritten' } } })
    const id = agent.id
    await handle.dispose()
    await f.ctx.plugin(TestQuery)
    const abort = new AbortController()
    const cold = f.runtime.watchView({ sessionId: id }, abort.signal)[Symbol.asyncIterator]()
    try { expect((await cold.next()).value).toMatchObject({ status: 'unknown' }) }
    finally { abort.abort(); await cold.return?.() }
    expect(f.ctx.agents.get(id)).toBeUndefined()
  })

  it('fails closed while a later rejected claim still names the recorded task input', async () => {
    const f = await gitRuntimeFixture({ backend: false, noGit: true })
    const handle = await f.task()
    const { agent } = handle
    const state = f.runtime.read(agent.session)
    if (state?.task == null) throw new Error('Expected a task')
    const input = agent.session.snapshotEvents().find(event => event.type === 'user/message'
      && event.data.id === state.task?.originMessageId)
    if (input?.type !== 'user/message') throw new Error('Expected the task input')
    // A real human retry carrying the same message is rejected before model entry.
    const refused = Promise.withResolvers<undefined>()
    const off = agent.ctx.on('agent/pre-step', async () => ({ kind: 'reject' as const }))
    try {
      agent.followup(input.data)
      await agent.whenIdle()
      refused.resolve(undefined)
      await refused.promise
    } finally { off() }
    const settled = agent.session.snapshotEvents().filter(event => event.type === 'agent/claim/settled').at(-1)
    expect(settled).toMatchObject({ data: { outcome: 'rejected' } })
    expect(f.runtime.statusOf(agent.session)).toBe('unknown')
  })
})
