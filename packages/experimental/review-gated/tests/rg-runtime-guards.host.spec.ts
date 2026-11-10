/** RG runtime guards exercised through real Agent lifecycles and real Session event sequences. */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { gitRuntimeFixture, gitHandoff } from './fixtures/git-runtime.ts'

const refused = (reason: string) => ({ code: 'review-gated/refused', details: { reason } })

describe('RG runtime guard coverage', { timeout: 120_000 }, () => {
  it('refuses model entry when the RG projection is poisoned', async () => {
    const f = await gitRuntimeFixture({ backend: false, noGit: true })
    const handle = await f.create()
    const { agent } = handle
    const calls = f.adapter.calls.length
    // A malformed durable record is committed before the input arrives; the fold reports a failure.
    agent.session.append('review-gated/state', { version: 1, state: { role: 'main' } } as never)
    expect(() => f.runtime.read(agent.session)).toThrow(/RG_STATE_INVALID/)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Poisoned entry' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(() => f.runtime.read(agent.session)).toThrow(/RG_STATE_INVALID/)
    expect(f.adapter.calls).toHaveLength(calls)
    expect(f.runtime.statusOf(agent.session)).toBe('unknown')
    await expect(f.runtime.startRole(agent, 'worker', gitHandoff, undefined, new AbortController().signal))
      .rejects.toMatchObject({ code: 'RG_NOT_READY' })
    expect(f.adapter.calls).toHaveLength(calls)
  })

  it('refuses a new task while another admission is still being persisted', async () => {
    const f = await gitRuntimeFixture({ backend: false, noGit: true })
    const { agent } = await f.task()
    const entered = f.gate()
    const release = f.gate()
    const flush = f.ctx.sessions.flush.bind(f.ctx.sessions)
    let held = false
    const spy = vi.spyOn(f.ctx.sessions, 'flush').mockImplementation(async (session) => {
      const result = await flush(session)
      if (session === agent.session && !held && session.snapshotEvents().some(event => event.type === 'review-gated/task-prepared')) {
        held = true
        entered.resolve(undefined)
        await release.promise
      }
      return result
    })
    try {
      const pending = f.runtime.newTask(agent, 'Concurrent task').then(() => null, (error: unknown) => error)
      await entered.promise
      await expect(f.runtime.newTask(agent, 'Second concurrent task')).rejects.toMatchObject(refused('RG_BUSY'))
      release.resolve(undefined)
      await pending
    } finally { release.resolve(undefined); spy.mockRestore() }
  })

  it('refuses a role start when the prepared Git checkout is no longer bound', async () => {
    const f = await gitRuntimeFixture()
    const { agent } = await f.task()
    await f.runtime.authorizeLocalGit(agent, ['tracked.txt'], new AbortController().signal)
    const prepare = f.runtime['git'].prepare.bind(f.runtime['git'])
    const spy = vi.spyOn(f.runtime['git'], 'prepare').mockImplementation(async (...args) => {
      const workspace = await prepare(...args)
      if (workspace === null) return workspace
      const state = f.runtime.read(agent.session)
      if (state === null) return workspace
      // Replace the binding after the checkout was allocated.
      agent.session.append('review-gated/git-state', { version: 1, state: { ...f.runtime.readGit(agent.session)!, binding: null } } as never)
      return workspace
    })
    try {
      await expect(f.runtime.startRole(agent, 'worker', gitHandoff, undefined, new AbortController().signal))
        .rejects.toThrow(/RG_GIT_CHANGED|no longer bound/)
      expect(f.adapter.calls.filter(call => call.model === 'worker')).toHaveLength(0)
    } finally { spy.mockRestore() }
  })

  it('reports an unknown view when the claim projection cannot be read', async () => {
    const f = await gitRuntimeFixture({ backend: false, noGit: true })
    const { agent } = await f.task()
    const snapshot = vi.spyOn(f.ctx.sessionProjections, 'snapshot').mockImplementation(() => { throw new Error('snapshot unavailable') })
    try {
      expect(f.runtime.statusOf(agent.session)).toBe('unknown')
    } finally { snapshot.mockRestore() }
    expect(f.runtime.statusOf(agent.session)).toBe('ready')
  })

  it('refuses authorized work after the Git grant changes during a role start', async () => {
    const f = await gitRuntimeFixture()
    const { agent } = await f.task()
    await f.runtime.authorizeLocalGit(agent, ['tracked.txt'], new AbortController().signal)
    const prepare = f.runtime['git'].prepare.bind(f.runtime['git'])
    const spy = vi.spyOn(f.runtime['git'], 'prepare').mockImplementation(async (...args) => {
      const workspace = await prepare(...args)
      if (workspace !== null) f.runtime['git'].clear(agent.session)
      return workspace
    })
    try {
      await expect(f.runtime.startRole(agent, 'worker', gitHandoff, undefined, new AbortController().signal))
        .rejects.toThrow(/no longer bound|RG_GIT_CHANGED/)
      expect(f.adapter.calls.filter(call => call.model === 'worker')).toHaveLength(0)
    } finally { spy.mockRestore() }
  })

  it('keeps an unknown status while a canceled claim is still open', async () => {
    const f = await gitRuntimeFixture({ backend: false, noGit: true })
    const { agent } = await f.task()
    const state = f.runtime.read(agent.session)
    if (state?.task == null) throw new Error('Expected a task')
    agent.session.append('review-gated/state', { version: 1, state: { ...state, diagnostic: 'uncertain' } })
    expect(f.runtime.statusOf(agent.session)).toBe('unknown')
    expect(f.runtime.statusOf(agent.session)).not.toBe('saving')
  })

  it('counts a direct task only when its intent, message and settlement agree', async () => {
    const f = await gitRuntimeFixture({ backend: false, noGit: true })
    const { agent } = await f.create()
    const input = createUserMessage({ content: [{ type: 'text', text: 'Direct objective' }], source: { kind: 'user' } })
    agent.followup(input)
    await agent.whenIdle()
    const state = f.runtime.read(agent.session)
    expect(state?.task).toMatchObject({ objective: 'Direct objective' })
    const events = agent.session.snapshotEvents()
    expect(events.some(event => event.type === 'agent/claim/intent')).toBe(true)
    expect(SessionSeq(events.length - 1)).toBe(events.at(-1)?.seq)
  })

  it('refuses to leave Git while an authorization inspection is still in flight', async () => {
    const f = await gitRuntimeFixture()
    const { agent } = await f.task()
    const authorize = f.runtime['git'].authorize.bind(f.runtime['git'])
    const entered = f.gate()
    const release = f.gate()
    const spy = vi.spyOn(f.runtime['git'], 'authorize').mockImplementation(async (...args) => {
      entered.resolve(undefined)
      await release.promise
      return authorize(...args)
    })
    try {
      const pending = f.runtime.authorizeLocalGit(agent, ['tracked.txt'], new AbortController().signal)
        .then(() => null, (error: unknown) => error)
      await entered.promise
      // The task is still eligible for authorization, but departure waits for the same Git owner.
      await expect(f.runtime.leaveLocalGit(agent)).resolves.toBeUndefined()
      release.resolve(undefined)
      expect(await pending).toBeNull()
    } finally { release.resolve(undefined); spy.mockRestore() }
  })

  it('refuses a role start after the Git grant disappears during checkout preparation', async () => {
    const f = await gitRuntimeFixture()
    const { agent } = await f.task()
    await f.runtime.authorizeLocalGit(agent, ['tracked.txt'], new AbortController().signal)
    const prepare = f.runtime['git'].prepare.bind(f.runtime['git'])
    const spy = vi.spyOn(f.runtime['git'], 'prepare').mockImplementation(async (...args) => {
      const workspace = await prepare(...args)
      // A concurrent clear lands between allocation and the reservation read.
      f.runtime['git'].clear(agent.session)
      return workspace
    })
    try {
      await expect(f.runtime.startRole(agent, 'worker', gitHandoff, undefined, new AbortController().signal))
        .rejects.toThrow(/no longer bound|RG_GIT_CHANGED/)
      expect(f.adapter.calls.filter(call => call.model === 'worker')).toHaveLength(0)
    } finally { spy.mockRestore() }
  })

  it('refuses an idle task whose reservation already has role attempts', async () => {
    const f = await gitRuntimeFixture({ backend: false, noGit: true })
    const { agent } = await f.task()
    const state = f.runtime.read(agent.session)
    if (state?.task == null) throw new Error('Expected a task')
    agent.session.append('review-gated/state', { version: 1,
      state: { ...state, task: { ...state.task, workerAttempts: 1 } } })
    await expect(f.runtime.authorizeLocalGit(agent, ['tracked.txt'], new AbortController().signal))
      .rejects.toMatchObject(refused('RG_BUSY'))
    await expect(f.runtime.leaveLocalGit(agent)).resolves.toBeUndefined()
  })

  it('refuses a second task while the previous budget is still active', async () => {
    const f = await gitRuntimeFixture({ backend: false, noGit: true })
    const { agent } = await f.task()
    const state = f.runtime.read(agent.session)
    if (state?.task == null) throw new Error('Expected a task')
    const running = { id: 'rg-run-active' as never, childId: 'rg-child-active' as never, role: 'worker' as const,
      workRevision: 1, selection: { provider: 'fixture', model: 'worker' }, status: 'running' as const,
      report: null, diagnostic: null, scope: null }
    agent.session.append('review-gated/state', { version: 1, state: { ...state, task: { ...state.task, active: running } } })
    await expect(f.runtime.newTask(agent, 'Overlapping budget')).rejects.toMatchObject(refused('RG_BUSY'))
    await expect(f.runtime.leaveLocalGit(agent)).rejects.toMatchObject(refused('RG_BUSY'))
  })
})
