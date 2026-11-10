/** Controlled persistence interleavings for RG admission and completion notices. */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'
import { gitHandoff, gitRuntimeFixture } from './fixtures/git-runtime.ts'

describe('RG persistence admission races', { timeout: 120_000 }, () => {
  it('refuses dependent work until a failed Git departure settles', async () => {
    const f = await gitRuntimeFixture()
    const { agent } = await f.task()
    await f.runtime.authorizeLocalGit(agent, ['tracked.txt'], new AbortController().signal)
    const entered = f.gate()
    const release = f.gate()
    let intercepted = false
    const off = f.ctx.on('session/flush', async (session) => {
      if (session !== agent.session || intercepted || f.runtime.readGit(session) !== null) return
      intercepted = true
      entered.resolve(undefined)
      await release.promise
      throw new Error('controlled departure failure')
    })
    const leaving = f.track(f.runtime.leaveLocalGit(agent))
    const rejection = leaving.catch((error: unknown) => error)
    await entered.promise
    try {
      await expect(f.runtime.newTask(agent, 'Another task')).rejects.toThrow()
      await expect(f.runtime.startRole(agent, 'worker', gitHandoff, undefined, new AbortController().signal)).rejects.toThrow()
      await expect(f.runtime.authorizeLocalGit(agent, ['tracked.txt'], new AbortController().signal)).rejects.toThrow()
      await expect(f.runtime.leaveLocalGit(agent)).rejects.toThrow()
      const calls = f.adapter.calls.length
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Please continue' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      expect(f.adapter.calls).toHaveLength(calls)
    } finally { off(); release.resolve(undefined) }
    expect(await rejection).toBeInstanceOf(Error)
    expect(f.runtime.read(agent.session)?.diagnostic).toContain('departure may not be saved')
    await expect(f.runtime.newTask(agent, 'Another task')).rejects.toThrow()
  })

  it('marks a changed Git grant untrusted without retracting a confirmed result', async () => {
    const f = await gitRuntimeFixture()
    const { agent } = await f.task()
    const other = await f.task()
    await f.runtime.authorizeLocalGit(agent, ['tracked.txt'], new AbortController().signal)
    const replacement = await f.runtime.authorizeLocalGit(other.agent, ['tracked.txt'], new AbortController().signal)
    const sent = vi.spyOn(agent, 'followup')
    const entered = f.gate()
    const release = f.gate()
    let intercepted = false
    const off = f.ctx.on('session/flush', async (session) => {
      if (session !== agent.session || intercepted || !session.snapshotEvents().some(event => event.type === 'review-gated/result-confirmed')) return
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
      expect(f.runtime.read(agent.session)).toMatchObject({ task: { lastWorker: { status: 'completed' } } })
      expect(f.runtime.read(agent.session)?.diagnostic).toContain('Git delivery changed')
      await f.ctx.sessionPersistence.flush()
      const stored = await f.ctx.sessionPersistence.open(agent.id, 'read')
      try { expect((await stored.read()).events.some(event => event.type === 'review-gated/result-confirmed')).toBe(true) }
      finally { await stored.close() }
    } finally { off(); release.resolve(undefined); sent.mockRestore() }
  })

  it('marks a confirmed review stale if Git delivery changes before its notice', async () => {
    const f = await gitRuntimeFixture()
    const { agent } = await f.task()
    const other = await f.task()
    const replacement = await f.runtime.authorizeLocalGit(other.agent, ['tracked.txt'], new AbortController().signal)
    const sent = vi.spyOn(agent, 'followup')
    const entered = f.gate()
    const release = f.gate()
    let intercepted = false
    const off = f.ctx.on('session/flush', async (session) => {
      if (session !== agent.session || intercepted || !session.snapshotEvents().some(event => event.type === 'review-gated/result-confirmed')) return
      intercepted = true
      session.append('review-gated/git-state', { version: 1, state: replacement })
      entered.resolve(undefined)
      await release.promise
    })
    try {
      const activation = await f.runtime.startRole(agent, 'reviewer', gitHandoff, undefined, new AbortController().signal)
      await entered.promise
      const completion = f.runtime['runs'].get(activation.subagentId)?.completion
      if (completion === undefined) throw new Error('Expected the owned role completion')
      release.resolve(undefined)
      await completion
      expect(sent).not.toHaveBeenCalled()
      expect(f.runtime.statusOf(agent.session)).toBe('unknown')
      expect(f.runtime.read(agent.session)).toMatchObject({ task: { reviewStatus: 'stale',
        lastReview: { status: 'completed', report: { verdict: 'pass' } } } })
      expect(f.runtime.read(agent.session)?.diagnostic).toContain('Git delivery changed')
      expect(f.runtime.readGit(agent.session)).toEqual(replacement)
    } finally { off(); release.resolve(undefined); sent.mockRestore() }
  })

  it('does not notify a parent disposed during the confirmation flush', async () => {
    const f = await gitRuntimeFixture({ backend: false })
    const parent = await f.task()
    const { agent } = parent
    const sent = vi.spyOn(agent, 'followup')
    const entered = f.gate()
    const release = f.gate()
    let intercepted = false
    const off = f.ctx.on('session/flush', async (session) => {
      if (session !== agent.session || intercepted || !session.snapshotEvents().some(event => event.type === 'review-gated/result-confirmed')) return
      intercepted = true
      entered.resolve(undefined)
      await release.promise
    })
    try {
      await f.runtime.startRole(agent, 'worker', gitHandoff, undefined, new AbortController().signal)
      await entered.promise
      const closing = Promise.withResolvers<undefined>()
      agent.ctx.effect(() => () => { closing.resolve(undefined) })
      const disposing = parent.dispose()
      await closing.promise
      off(); release.resolve(undefined)
      await disposing
      expect(sent).not.toHaveBeenCalled()
      const stored = await f.ctx.sessionPersistence.open(agent.id, 'read')
      try { expect((await stored.read()).events.some(event => event.type === 'review-gated/result-confirmed')).toBe(true) }
      finally { await stored.close() }
    } finally { off(); release.resolve(undefined); sent.mockRestore() }
  })

  it('does not send a completion notice after the confirmed task changes during flush', async () => {
    const f = await gitRuntimeFixture({ backend: false })
    const { agent } = await f.task()
    const sent = vi.spyOn(agent, 'followup')
    const entered = f.gate()
    const release = f.gate()
    let intercepted = false
    const off = f.ctx.on('session/flush', async (session) => {
      if (session !== agent.session || intercepted || !session.snapshotEvents().some(event => event.type === 'review-gated/result-confirmed')) return
      intercepted = true
      const state = f.runtime.read(session)
      if (state?.task == null) throw new Error('Expected confirmed task')
      session.append('review-gated/state', { version: 1, state: { ...state, task: { ...state.task, objective: 'A changed task' } } })
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
      await f.ctx.sessionPersistence.flush()
      const stored = await f.ctx.sessionPersistence.open(agent.id, 'read')
      try { expect((await stored.read()).events.some(event => event.type === 'review-gated/result-confirmed')).toBe(true) }
      finally { await stored.close() }
      expect(f.runtime.read(agent.session)?.task?.objective).toBe('A changed task')
      expect(f.runtime.statusOf(agent.session)).toBe('unknown')
    } finally { off(); release.resolve(undefined); sent.mockRestore() }
  })
})
