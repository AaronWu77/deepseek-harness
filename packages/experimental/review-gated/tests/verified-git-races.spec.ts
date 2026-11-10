/** Verified local Git identities must survive result preparation. */
import { describe, expect, it, vi } from 'vitest'
import { gitHandoff, gitRuntimeFixture } from './fixtures/git-runtime.ts'

describe('verified Git result preparation', { timeout: 120_000 }, () => {
  it('does not confirm a candidate whose grant changed during the prepared flush', async () => {
    const f = await gitRuntimeFixture()
    const { agent } = await f.task()
    const other = await f.task()
    await f.runtime.authorizeLocalGit(agent, ['tracked.txt'], new AbortController().signal)
    const replacement = await f.runtime.authorizeLocalGit(other.agent, ['tracked.txt'], new AbortController().signal)
    const entered = f.gate()
    const release = f.gate()
    const sent = vi.spyOn(agent, 'followup')
    let intercepted = false
    const off = f.ctx.on('session/flush', async (session) => {
      if (session !== agent.session || intercepted || !session.snapshotEvents().some(event => event.type === 'review-gated/result-prepared')) return
      intercepted = true
      session.append('review-gated/git-state', { version: 1, state: replacement })
      entered.resolve(undefined)
      await release.promise
    })
    try {
      const activation = await f.runtime.startRole(agent, 'worker', gitHandoff, undefined, new AbortController().signal)
      await entered.promise
      const completion = f.runtime['runs'].get(activation.subagentId)?.completion
      if (completion === undefined) throw new Error('Expected the owned role completion')
      release.resolve(undefined)
      await completion
      expect(sent).not.toHaveBeenCalled()
      expect(f.runtime.readGit(agent.session)).toEqual(replacement)
      expect(f.runtime.read(agent.session)).toMatchObject({ task: { reviewStatus: 'inconclusive' } })
      expect(f.runtime.read(agent.session)?.diagnostic).toContain('RG_RESULT_SAVE_FAILED')
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
