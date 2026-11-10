/** The Git grant remains exclusively owned through its durable departure. */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'
import { gitHandoff, gitRuntimeFixture } from './fixtures/git-runtime.ts'

const signal = () => new AbortController().signal

describe('local Git departure fencing', { timeout: 120_000 }, () => {
  it('blocks main and role work during authorization and preserves a replacement grant during departure', async () => {
    const f = await gitRuntimeFixture()
    const { agent } = await f.task()
    const other = await f.task()
    const replacement = await f.runtime.authorizeLocalGit(other.agent, ['tracked.txt'], signal())
    const entered = f.gate()
    const release = f.gate()
    const spawn = f.ctx.subprocess.spawn.bind(f.ctx.subprocess)
    const spy = vi.spyOn(f.ctx.subprocess, 'spawn').mockImplementation((spec) => {
      const child = spawn(spec)
      return spec.argv.includes('symbolic-ref') ? { ...child, done: child.done.then(async (outcome) => {
        entered.resolve(undefined); await release.promise; return outcome
      }), terminate: () =>{  child.terminate() }, waitForExit: () => child.waitForExit() } : child
    })
    const authorizing = f.track(f.runtime.authorizeLocalGit(agent, ['tracked.txt'], signal()))
    await entered.promise
    try {
      await expect(f.runtime.startRole(agent, 'worker', gitHandoff, undefined, signal())).rejects.toThrow()
      await expect(f.runtime.newTask(agent, 'Another task')).rejects.toThrow()
      const calls = f.adapter.calls.length
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      expect(f.adapter.calls).toHaveLength(calls)
    } finally { release.resolve(undefined); spy.mockRestore() }
    await authorizing
    const departing = f.gate()
    const finish = f.gate()
    let intercepted = false
    const off = f.ctx.on('session/flush', async (session) => {
      if (session !== agent.session || intercepted || f.runtime.readGit(session) !== null) return
      intercepted = true
      departing.resolve(undefined)
      await finish.promise
    })
    const leaving = f.track(f.runtime.leaveLocalGit(agent))
    const rejected = leaving.catch((error: unknown) => error)
    await departing.promise
    try {
      await expect(f.runtime.recheck(agent, signal())).resolves.toBeDefined()
      agent.session.append('review-gated/git-state', { version: 1, state: replacement })
    } finally { off(); finish.resolve(undefined) }
    expect(await rejected).toBeInstanceOf(Error)
    expect(f.runtime.readGit(agent.session)).toEqual(replacement)
    expect(f.runtime.read(agent.session)?.diagnostic).toContain('departure may not be saved')
  })

  it('keeps a changed task and reports an uncertain departure', async () => {
    const f = await gitRuntimeFixture({ backend: false })
    const { agent } = await f.task()
    const entered = f.gate()
    const release = f.gate()
    let intercepted = false
    const off = f.ctx.on('session/flush', async (session) => {
      if (session !== agent.session || intercepted) return
      intercepted = true
      entered.resolve(undefined)
      await release.promise
    })
    const leaving = f.track(f.runtime.leaveLocalGit(agent))
    const rejected = leaving.catch((error: unknown) => error)
    await entered.promise
    try {
      const state = f.runtime.read(agent.session)
      if (state?.task == null) throw new Error('Expected an existing task')
      agent.session.append('review-gated/state', { version: 1, state: { ...state, task: { ...state.task, objective: 'Changed objective' } } })
    } finally { off(); release.resolve(undefined) }
    expect(await rejected).toBeInstanceOf(Error)
    expect(f.runtime.read(agent.session)).toMatchObject({ task: { objective: 'Changed objective' } })
    expect(f.runtime.read(agent.session)?.diagnostic).toContain('departure may not be saved')
  })

  it('does not restore a cleared RG state when departure fails', async () => {
    const f = await gitRuntimeFixture({ backend: false })
    const { agent } = await f.task()
    const entered = f.gate()
    const release = f.gate()
    let intercepted = false
    const off = f.ctx.on('session/flush', async (session) => {
      if (session !== agent.session || intercepted) return
      intercepted = true
      entered.resolve(undefined)
      await release.promise
      throw new Error('controlled departure failure')
    })
    const leaving = f.track(f.runtime.leaveLocalGit(agent))
    const rejected = leaving.catch((error: unknown) => error)
    await entered.promise
    try { agent.session.append('review-gated/state', { version: 1, state: null }) }
    finally { off(); release.resolve(undefined) }
    expect(await rejected).toBeInstanceOf(Error)
    expect(f.runtime.read(agent.session)).toBeNull()
  })

  it('refuses requests from a disposed parent', async () => {
    const f = await gitRuntimeFixture({ backend: false })
    const parent = await f.task()
    const selection = parent.agent.model.current()
    if (selection === undefined) throw new Error('Expected the configured main route')
    const runtime = f.runtime
    await parent.dispose()
    expect(() =>{  runtime.assertRequest(parent.agent, selection) }).toThrow('current live Agent')
  })

  it('keeps the Session alive until a pending departure flush settles', async () => {
    const f = await gitRuntimeFixture()
    const parent = await f.task()
    const { agent } = parent
    await f.runtime.authorizeLocalGit(agent, ['tracked.txt'], signal())
    const entered = f.gate()
    const release = f.gate()
    let intercepted = false
    const off = f.ctx.on('session/flush', async (session) => {
      if (session !== agent.session || intercepted || f.runtime.readGit(session) !== null) return
      intercepted = true
      entered.resolve(undefined)
      await release.promise
    })
    const leaving = f.track(f.runtime.leaveLocalGit(agent))
    await entered.promise
    const closing = Promise.withResolvers<undefined>()
    agent.ctx.effect(() => () => { closing.resolve(undefined) })
    let disposed = false
    const disposing = parent.dispose().then(() => { disposed = true })
    await closing.promise
    expect(disposed).toBe(false)
    try { off(); release.resolve(undefined); await leaving; await disposing }
    finally { off(); release.resolve(undefined) }
    expect(disposed).toBe(true)
    const stored = await f.ctx.sessionPersistence.open(agent.id, 'read')
    try {
      const events = (await stored.read()).events
      expect(events.filter(event => event.type === 'review-gated/git-state').at(-1)).toMatchObject({ data: { state: null } })
    } finally { await stored.close() }
  })
})
