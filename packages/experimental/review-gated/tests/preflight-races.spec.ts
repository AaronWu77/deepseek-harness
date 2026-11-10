/** Model resolution cannot carry a role request across a delivery-mode change. */
import { describe, expect, it, vi } from 'vitest'
import { gitHandoff, gitRuntimeFixture } from './fixtures/git-runtime.ts'

describe('role preflight identity', { timeout: 120_000 }, () => {
  it('refuses an old role request after local Git departure finishes during model resolution', async () => {
    const f = await gitRuntimeFixture()
    const { agent } = await f.task()
    await f.runtime.authorizeLocalGit(agent, ['tracked.txt'], new AbortController().signal)
    const entered = f.gate()
    const release = f.gate()
    const resolve = f.ctx.llm.resolveCallConfig.bind(f.ctx.llm)
    const spy = vi.spyOn(f.ctx.llm, 'resolveCallConfig').mockImplementation(async (...args) => {
      entered.resolve(undefined)
      await release.promise
      return resolve(...args)
    })
    const starting = f.track(f.runtime.startRole(agent, 'worker', gitHandoff, undefined, new AbortController().signal))
    const settled = starting.then(value => ({ value }), (error: unknown) => ({ error }))
    await entered.promise
    try { await f.runtime.leaveLocalGit(agent) } finally { spy.mockRestore(); release.resolve(undefined) }
    const result = await settled
    expect(result).toHaveProperty('error')
    expect(f.runtime.read(agent.session)?.task?.workerAttempts).toBe(0)
    expect(f.adapter.calls.some(call => call.model === 'worker')).toBe(false)
    expect(f.runtime.readGit(agent.session)).toBeNull()
  })

  it('refuses an old role request when the task changes during model resolution', async () => {
    const f = await gitRuntimeFixture({ backend: false })
    const { agent } = await f.task()
    const entered = f.gate()
    const release = f.gate()
    const resolve = f.ctx.llm.resolveCallConfig.bind(f.ctx.llm)
    const spy = vi.spyOn(f.ctx.llm, 'resolveCallConfig').mockImplementation(async (...args) => {
      entered.resolve(undefined)
      await release.promise
      return resolve(...args)
    })
    const starting = f.track(f.runtime.startRole(agent, 'worker', gitHandoff, undefined, new AbortController().signal))
    const settled = starting.then(value => ({ value }), (error: unknown) => ({ error }))
    await entered.promise
    try {
      const state = f.runtime.read(agent.session)
      if (state?.task == null) throw new Error('Expected an existing task')
      agent.session.append('review-gated/state', { version: 1, state: { ...state, task: { ...state.task, objective: 'Changed task' } } })
    } finally { spy.mockRestore(); release.resolve(undefined) }
    const result = await settled
    expect(result).toHaveProperty('error')
    expect(f.runtime.read(agent.session)?.task).toMatchObject({ objective: 'Changed task', workerAttempts: 0 })
    expect(f.adapter.calls.some(call => call.model === 'worker')).toBe(false)
  })
})
