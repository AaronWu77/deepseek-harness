import { appendRecord, recordsOf } from './records.ts'
/** Cold reads of a real direct human task exercise the recorded-claim evidence guards. */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import { describe, expect, it } from 'vitest'
import { gitRuntimeFixture } from './fixtures/git-runtime.ts'

class TestQuery extends SessionQueryEngine {
  override searchSessions(): Promise<never> { return Promise.reject(new Error('Search is not used here')) }
  override searchEvents(): Promise<never> { return Promise.reject(new Error('Search is not used here')) }
}

describe('RG direct task cold evidence', { timeout: 120_000 }, () => {
  it('trusts a normally admitted direct task after cold reopening', async () => {
    const f = await gitRuntimeFixture({ backend: false, noGit: true })
    const handle = await f.create()
    const { agent } = handle
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Direct human task' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(f.runtime.read(agent.session)?.task).toMatchObject({ objective: 'Direct human task' })
    const id = agent.id
    await handle.dispose()
    await f.ctx.plugin(TestQuery)
    const abort = new AbortController()
    const cold = f.runtime.watchView({ sessionId: id }, abort.signal)[Symbol.asyncIterator]()
    try {
      const frame = await cold.next()
      expect(frame.value).toMatchObject({ status: 'ready', state: { task: { objective: 'Direct human task' } } })
    } finally { abort.abort(); await cold.return?.() }
  })

  it('rejects a cold direct task whose recorded objective differs from the claim text', async () => {
    const f = await gitRuntimeFixture({ backend: false, noGit: true })
    const handle = await f.create()
    const { agent } = handle
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Original direct text' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const state = f.runtime.read(agent.session)
    if (state?.task == null) throw new Error('Expected a direct task')
    const prepared = recordsOf(agent.session.snapshotEvents()).find(event => event.type === 'plugin:review-gated/direct-task-prepared')
    if (prepared?.type !== 'plugin:review-gated/direct-task-prepared') throw new Error('Expected a prepared direct task')
    // Re-record the same prepared claim with an objective that no longer matches the human text.
    appendRecord(agent.session, 'plugin:review-gated/direct-task-prepared', { version: 1, intentSeq: prepared.data.intentSeq,
      messageId: prepared.data.messageId, state: { ...state, task: { ...state.task, objective: 'rewritten objective' },
        diagnostic: null } })
    const id = agent.id
    await handle.dispose()
    await f.ctx.plugin(TestQuery)
    const abort = new AbortController()
    const cold = f.runtime.watchView({ sessionId: id }, abort.signal)[Symbol.asyncIterator]()
    try { expect((await cold.next()).value).toMatchObject({ status: 'unknown' }) }
    finally { abort.abort(); await cold.return?.() }
  })

  it('does not trust a settlement that admitted the input more than once', async () => {
    const f = await gitRuntimeFixture({ backend: false, noGit: true })
    const handle = await f.create()
    const { agent } = handle
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Duplicated admission' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const origin = f.runtime.read(agent.session)?.task?.originMessageId
    if (origin === undefined) throw new Error('Expected the admitted message identity')
    // A second recorded user message with the same identity makes the admission ambiguous.
    agent.session.append('user/message',
      { ...createUserMessage({ content: [{ type: 'text', text: 'Duplicated admission' }], source: { kind: 'user' } }), id: origin },
      { surfaceOp: 'append' })
    const id = agent.id
    await handle.dispose()
    await f.ctx.plugin(TestQuery)
    const abort = new AbortController()
    const cold = f.runtime.watchView({ sessionId: id }, abort.signal)[Symbol.asyncIterator]()
    try { expect((await cold.next()).value).toMatchObject({ status: 'unknown' }) }
    finally { abort.abort(); await cold.return?.() }
  })
})
