/** Model-entry and request guards reached through real protected claims and Agent lifecycles. */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'
import { gitRuntimeFixture, gitHandoff } from './fixtures/git-runtime.ts'

describe('RG model entry guards', { timeout: 120_000 }, () => {
  it('refuses model entry when the Session projection fails during the pre-step', async () => {
    const f = await gitRuntimeFixture({ backend: false, noGit: true })
    const { agent } = await f.task()
    const calls = f.adapter.calls.length
    const selection = f.runtime.read(agent.session)?.policy?.main.default
    if (selection == null) throw new Error('Expected the frozen main model')
    // A later invalid durable record poisons the projection before the next model step is authorized.
    agent.session.append('review-gated/state', { version: 1, state: { role: 'main' } } as never)
    expect(() => { f.runtime.read(agent.session) }).toThrow(/RG_STATE_INVALID/)
    const poisoned = (() => {
      try { f.runtime.read(agent.session); return null } catch (error: unknown) { return error }
    })()
    if (!(poisoned instanceof Error)) throw new Error('Expected a typed refusal')
    expect(poisoned.message).toContain('RG_NOT_READY'.length > 0 ? 'RG_STATE_INVALID' : '')
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Poisoned follow-up' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(f.adapter.calls).toHaveLength(calls)
    expect(f.runtime.statusOf(agent.session)).toBe('unknown')
    expect(() => { f.runtime.assertRequest(agent, selection) }).toThrow(/RG_STATE_INVALID|RG_NOT_READY/)
    const refused = (() => {
      try { f.runtime.assertRequest(agent, selection); return null } catch (error: unknown) { return error }
    })()
    if (!(refused instanceof Error)) throw new Error('Expected a typed refusal')
    expect(refused.message).toMatch(/RG_STATE_INVALID|RG_NOT_READY/)
  })

  it('refuses a claim whose admitted message no longer matches the recorded claim', async () => {
    const f = await gitRuntimeFixture({ backend: false, noGit: true })
    const { agent } = await f.create()
    const calls = f.adapter.calls.length
    // The pre-step sees the claimed input; the recorded claim belongs to another message.
    const replace = vi.spyOn(agent, 'claimRecovery', 'get').mockReturnValue({
      intentSeq: agent.session.seq as never, target: 'next-turn', turn: 1, step: 1, inputs: [],
    })
    try {
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Mismatched recovery' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      expect(f.runtime.read(agent.session)?.task).toBeNull()
      expect(f.adapter.calls).toHaveLength(calls)
    } finally { replace.mockRestore() }
  })

  it('refuses direct work while the model policy binding is incomplete', async () => {
    const f = await gitRuntimeFixture({ backend: false, noGit: true })
    const { agent } = await f.create()
    const modelPolicyFor = vi.spyOn(f.ctx.agents, 'modelPolicyFor').mockReturnValue(null)
    const selection = f.runtime.read(agent.session)?.policy?.main.default
    if (selection == null) throw new Error('Expected the frozen main model')
    try {
      expect(() => { f.runtime.assertRequest(agent, selection) }).toThrow(/model policy|not fully initialized/i)
    } finally { modelPolicyFor.mockRestore() }
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
