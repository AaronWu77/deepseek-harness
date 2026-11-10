/** An obsolete result preparation cannot authorize a parent notification. */
import { describe, expect, it, vi } from 'vitest'
import { gitHandoff, gitRuntimeFixture } from './fixtures/git-runtime.ts'

describe('RG result preparation replacement', () => {
  it('fails closed when a state replacement invalidates the prepared result during its flush', async () => {
    const f = await gitRuntimeFixture({ backend: false, noGit: true })
    const { agent } = await f.task()
    const sent = vi.spyOn(agent, 'followup')
    const entered = f.gate()
    const release = f.gate()
    let intercepted = false
    const off = f.ctx.on('session/flush', async (session) => {
      if (session !== agent.session || intercepted || !session.snapshotEvents().some(event => event.type === 'review-gated/result-prepared')) return
      intercepted = true
      const state = f.runtime.read(session)
      if (state?.task?.active?.status !== 'saving') throw new Error('Expected a saving role')
      session.append('review-gated/state', { version: 1, state })
      entered.resolve(undefined)
      await release.promise
    })
    try {
      await f.runtime.startRole(agent, 'worker', gitHandoff, undefined, new AbortController().signal)
      await entered.promise
      expect(f.runtime.statusOf(agent.session)).toBe('saving')
      const settled = f.until(agent, state => state?.diagnostic?.startsWith('RG_RESULT_SAVE_FAILED:') === true)
      release.resolve(undefined)
      await settled
      expect(sent).not.toHaveBeenCalled()
      expect(f.runtime.statusOf(agent.session)).toBe('unknown')
      const result = f.runtime.read(agent.session)
      expect(result?.diagnostic).toContain('RG_RESULT_SAVE_FAILED:')
      expect(result?.task).toMatchObject({ active: null, reviewStatus: 'inconclusive' })
      await f.ctx.sessionPersistence.flush()
      const stored = await f.ctx.sessionPersistence.open(agent.id, 'read')
      try {
        const events = (await stored.read()).events
        expect(events.some(event => event.type === 'review-gated/result-prepared')).toBe(true)
        expect(events.some(event => event.type === 'review-gated/result-confirmed')).toBe(false)
      } finally { await stored.close() }
    } finally { off(); release.resolve(undefined); sent.mockRestore() }
  })
})
