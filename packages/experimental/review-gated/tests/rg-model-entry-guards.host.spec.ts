import { SessionSeq } from '@deepseek-ai/dsh-session'
import { appendRecord, recordsOf } from './records.ts'
/** Model-entry and request guards reached through durable RG claims and Agent lifecycles. */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { gitRuntimeFixture, gitHandoff } from './fixtures/git-runtime.ts'

describe('RG model entry guards', { timeout: 120_000 }, () => {
  it('refuses model entry after the Session projection fails', async () => {
    const f = await gitRuntimeFixture({ backend: false, noGit: true })
    const { agent } = await f.task()
    const calls = f.adapter.calls.length
    const selection = f.runtime.read(agent.session)?.policy?.main.default
    if (selection == null) throw new Error('Expected the frozen main model')
    // A settlement without an outstanding intent invalidates the durable projection.
    appendRecord(agent.session, 'plugin:review-gated/claim-settled', {
      version: 1, phase: 'settled', intentSeq: SessionSeq(agent.session.seq), outcome: 'rejected', messages: [],
    })
    expect(() => { f.runtime.read(agent.session) }).toThrow(expect.objectContaining({ code: 'RG_NOT_READY', message: expect.stringContaining('RG_STATE_INVALID') }))
    expect(f.ctx.sessionProjections.snapshot(agent.session, ['reviewGated']).values.reviewGated).toMatchObject({ state: null, failed: true, ready: false })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Poisoned follow-up' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(f.adapter.calls).toHaveLength(calls)
    expect(f.runtime.statusOf(agent.session)).toBe('unknown')
    expect(() => { f.runtime.assertRequest(agent, selection) }).toThrow(expect.objectContaining({ code: 'RG_NOT_READY' }))
    const refused = (() => {
      try { f.runtime.assertRequest(agent, selection); return null } catch (error: unknown) { return error }
    })()
    if (!(refused instanceof Error)) throw new Error('Expected a typed refusal')
    expect(refused).toMatchObject({ code: 'RG_NOT_READY' })
  })

  it('refuses a new claim while another message owns an unsettled durable intent', async () => {
    const f = await gitRuntimeFixture({ backend: false, noGit: true })
    const { agent } = await f.create()
    const calls = f.adapter.calls.length
    const original = createUserMessage({ content: [{ type: 'text', text: 'Original unsettled input' }], source: { kind: 'user' } })
    agent.session.append('turn/start', { turn: 1 })
    const intent = appendRecord(agent.session, 'plugin:review-gated/claim', {
      version: 1, phase: 'intent', turn: 1, step: 1, inputs: [{ message: original }],
    })
    expect(f.ctx.sessionProjections.snapshot(agent.session, ['reviewGated']).values.reviewGated).toMatchObject({
      state: { task: null }, failed: false, ready: false, taskReceipt: 'none', claim: { phase: 'unsettled', intentSeq: intent.seq, text: 'Original unsettled input' },
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Mismatched recovery' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(() => f.runtime.read(agent.session)).toThrow(expect.objectContaining({ code: 'RG_NOT_READY' }))
    expect(f.ctx.sessionProjections.snapshot(agent.session, ['reviewGated']).values.reviewGated).toMatchObject({
      state: null, failed: true, ready: false, taskReceipt: 'none', claim: null,
    })
    expect(recordsOf(agent.session.snapshotEvents()).filter(record => record.type === 'plugin:review-gated/direct-task-prepared')).toHaveLength(0)
    expect(recordsOf(agent.session.snapshotEvents()).find(record => record.seq === intent.seq))
      .toMatchObject({ data: { inputs: [{ message: original }] } })
    expect(f.adapter.calls).toHaveLength(calls)
  })

  it('refuses direct work without a durable frozen policy', async () => {
    const f = await gitRuntimeFixture({ backend: false, noGit: true })
    const { agent } = await f.create()
    const state = f.runtime.read(agent.session)
    const selection = state?.policy?.main.default
    if (state == null || selection == null) throw new Error('Expected the frozen main model')
    appendRecord(agent.session, 'plugin:review-gated/state', { version: 1, state: { ...state, policy: null } })
    expect(f.runtime.read(agent.session)?.policy).toBeNull()
    expect(() => { f.runtime.assertRequest(agent, selection) }).toThrow(expect.objectContaining({ code: 'RG_NOT_READY' }))
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Work without a policy' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(f.adapter.calls).toHaveLength(0)
  })

  it('refuses an unpublished parent that asks for a role start', async () => {
    const f = await gitRuntimeFixture({ backend: false, noGit: true })
    const handle = await f.task()
    const { agent } = handle
    const published = f.ctx.agents.get(agent.id)
    if (published === undefined) throw new Error('Expected a published Agent')
    await handle.dispose()
    const signal = new AbortController().signal
    await expect(f.runtime.startRole(published, 'worker', gitHandoff, undefined, signal)).rejects.toMatchObject({
      code: 'RG_NOT_READY',
    })
  })
})
