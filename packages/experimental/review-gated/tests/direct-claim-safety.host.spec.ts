/** Direct claim save failures refuse dependent RG and local-Git work. */
import { describe, expect, it, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { gitHandoff, gitRuntimeFixture } from './fixtures/git-runtime.ts'

describe('RG direct input claim safety', () => {
  it('refuses new tasks, Git authorization, role activation, and model requests after an uncertain claim', async () => {
    const f = await gitRuntimeFixture({ backend: false, noGit: true })
    const handle = await f.task()
    const { agent } = handle
    const baseline = agent.session.snapshotEvents().filter(event => event.type === 'agent/claim/settled').length
    let failed = false
    const off = f.ctx.on('session/flush', (session) => {
      if (session === agent.session && !failed
        && session.snapshotEvents().filter(event => event.type === 'agent/claim/settled').length > baseline) {
        failed = true
        throw new Error('claim settlement flush failed')
      }
    })
    const calls = f.adapter.calls.length
    try {
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'An uncertain clarification' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      expect(failed).toBe(true)
      expect(agent.claimProtectionStatus).toBe('unknown')
      expect(agent.inbox.nextTurn).toHaveLength(0)
      expect(agent.inbox.nextStep).toHaveLength(0)
      expect(f.runtime.read(agent.session)?.diagnostic).toBeNull()
      const reservation = vi.spyOn(agent, 'runExclusiveAdmission')
      const authorize = vi.spyOn(f.runtime['git'], 'authorize')
      const activate = vi.spyOn(f.ctx.subagents, 'startActivation')
      try {
        await expect(f.runtime.newTask(agent, 'Do not start')).rejects.toMatchObject({ code: 'review-gated/refused' })
        await expect(f.runtime.authorizeLocalGit(agent, ['tracked.txt'], new AbortController().signal)).rejects.toMatchObject({ code: 'review-gated/refused' })
        await expect(f.runtime.startRole(agent, 'worker', gitHandoff, undefined, new AbortController().signal)).rejects.toMatchObject({ code: 'RG_NOT_READY' })
        const selection = f.runtime.read(agent.session)?.policy?.main.default
        if (selection == null) throw new Error('Expected the main model')
        expect(() => { f.runtime.assertRequest(agent, selection) }).toThrow(/claim/i)
        expect(reservation).not.toHaveBeenCalled()
        expect(authorize).not.toHaveBeenCalled()
        expect(activate).not.toHaveBeenCalled()
        expect(f.adapter.calls).toHaveLength(calls)
      } finally { reservation.mockRestore(); authorize.mockRestore(); activate.mockRestore() }
      off()
      const id = agent.id
      await handle.dispose()
      const resumed = await f.ctx.agents.resume({ resumeSessionId: id,
        setup: async (child) => { await f.ctx.agentPresets.mount(child, 'rg') } })
      try {
        await resumed.agent.whenIdle()
        expect(resumed.agent.claimRecovery).not.toBeNull()
        expect(f.runtime.statusOf(resumed.agent.session)).toBe('unknown')
        await expect(f.runtime.newTask(resumed.agent, 'Do not resume')).rejects.toMatchObject({ code: 'review-gated/refused' })
        await expect(f.runtime.authorizeLocalGit(resumed.agent, ['tracked.txt'], new AbortController().signal))
          .rejects.toMatchObject({ code: 'review-gated/refused' })
        await expect(f.runtime.startRole(resumed.agent, 'worker', gitHandoff, undefined, new AbortController().signal))
          .rejects.toMatchObject({ code: 'RG_NOT_READY' })
        expect(f.adapter.calls).toHaveLength(calls)
      } finally { await resumed.dispose() }
    } finally { off() }
  })
})
