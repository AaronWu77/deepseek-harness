import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { git, gitHandoff, gitRuntimeFixture } from './fixtures/git-runtime.ts'

const signal = () => new AbortController().signal

describe('local Git grant publication and task replacement', { timeout: 120_000 }, () => {
  it('refuses a grant replaced while its authorization is flushed', async () => {
    const f = await gitRuntimeFixture()
    const { agent } = await f.task()
    const other = await f.task()
    const replacement = await f.runtime.authorizeLocalGit(other.agent, ['tracked.txt'], signal())
    const index = await readFile(join(f.root, '.git', 'index'))
    const entered = f.gate()
    const release = f.gate()
    let paused = false
    f.ctx.on('session/flush', async (session) => {
      if (session === agent.session && !paused && f.runtime.readGit(session)?.status === 'authorized') {
        paused = true
        entered.resolve(undefined)
        await release.promise
      }
    })
    const authorization = f.track(f.runtime.authorizeLocalGit(agent, ['tracked.txt'], signal()))
    const outcome = authorization.then(() => null, (error: unknown) => error)
    await entered.promise
    agent.session.append('review-gated/git-state', { version: 1, state: replacement })
    release.resolve(undefined)
    expect(await outcome).toMatchObject({ code: 'review-gated/refused', details: { reason: 'RG_GIT_CHANGED' } })
    expect(f.runtime.readGit(agent.session)).toEqual(replacement)
    expect(f.runtime.readGit(other.agent.session)).toEqual(replacement)
    expect(await readFile(join(f.root, '.git', 'index'))).toEqual(index)
    expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(replacement.source.headOid)
    expect(await git(f.root, 'status', '--porcelain')).toBe('')
  })

  it('does not launch a worker when the same reservation changes during allocation', async () => {
    const f = await gitRuntimeFixture()
    const { agent } = await f.task()
    const grant = await f.runtime.authorizeLocalGit(agent, ['tracked.txt'], signal())
    const entered = f.gate()
    const release = f.gate()
    const provision = f.ctx.worktrees.provision.bind(f.ctx.worktrees)
    let checkout = ''
    vi.spyOn(f.ctx.worktrees, 'provision').mockImplementation(async (...args) => {
      const allocated = await provision(...args)
      checkout = allocated.path
      entered.resolve(undefined)
      await release.promise
      return allocated
    })
    const starting = f.track(f.runtime.startRole(agent, 'worker', gitHandoff, undefined, signal()))
    const outcome = starting.then(() => null, (error: unknown) => error)
    await entered.promise
    const state = f.runtime.readGit(agent.session)
    if (state?.binding == null) throw new Error('Allocation requires an owned reservation.')
    agent.session.append('review-gated/git-state', { version: 1, state: { ...state, diagnostic: 'Concurrent owner update' } })
    release.resolve(undefined)
    expect(await outcome).toMatchObject({ code: 'RG_GIT_CHANGED' })
    expect(f.runtime.readGit(agent.session)).toMatchObject({ status: 'failed', binding: null,
      diagnostic: 'The local Git grant changed during checkout preparation.' })
    expect(f.adapter.calls.some(call => call.model === 'worker')).toBe(false)
    expect(await git(checkout, 'rev-parse', 'HEAD')).toBe(grant.source.headOid)
    expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(grant.source.headOid)
    expect(await git(f.root, 'status', '--porcelain')).toBe('')
  })

  it.each(['task', 'policy'] as const)('refuses a grant bound to a different %s before allocating a role', async (mismatch) => {
    const f = await gitRuntimeFixture()
    const { agent } = await f.task()
    const other = await f.task()
    const grant = await f.runtime.authorizeLocalGit(agent, ['tracked.txt'], signal())
    const otherGrant = await f.runtime.authorizeLocalGit(other.agent, ['tracked.txt'], signal())
    const replacement = mismatch === 'task' ? otherGrant : { ...grant, configurationHash: otherGrant.configurationHash + '-previous' }
    const index = await readFile(join(f.root, '.git', 'index'))
    agent.session.append('review-gated/git-state', { version: 1, state: replacement })
    const provision = vi.spyOn(f.ctx.worktrees, 'provision')
    await expect(f.runtime.startRole(agent, 'worker', gitHandoff, undefined, signal()))
      .rejects.toMatchObject({ code: 'RG_GIT_AUTH_REQUIRED' })
    expect(provision).not.toHaveBeenCalled()
    expect(f.adapter.calls.some(call => call.model === 'worker')).toBe(false)
    expect(f.runtime.readGit(agent.session)).toEqual(replacement)
    expect(f.runtime.read(agent.session)?.task).toMatchObject({ id: grant.taskId, active: null, workerAttempts: 0 })
    expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(grant.source.headOid)
    expect(await readFile(join(f.root, '.git', 'index'))).toEqual(index)
    expect(await git(f.root, 'status', '--porcelain')).toBe('')
  })

  it('starts a new task without deleting the previous verified checkout or commit', async () => {
    const f = await gitRuntimeFixture()
    const { agent } = await f.task()
    const grant = await f.runtime.authorizeLocalGit(agent, ['tracked.txt'], signal())
    const index = await readFile(join(f.root, '.git', 'index'))
    await f.role(agent, 'worker')
    const previous = f.runtime.readGit(agent.session)?.candidate
    if (previous == null) throw new Error('A verified candidate must have been committed.')
    const next = await f.runtime.newTask(agent, 'Start a separate task')
    await agent.whenIdle()
    expect(next.id).not.toBe(grant.taskId)
    expect(f.runtime.readGit(agent.session)).toBeNull()
    expect(f.runtime.read(agent.session)?.task).toMatchObject({ id: next.id, workerAttempts: 0, reviewAttempts: 0 })
    expect(await git(previous.inspection.root, 'rev-parse', 'HEAD')).toBe(previous.headOid)
    expect(await git(previous.inspection.root, 'show', 'HEAD:tracked.txt')).toBe('worker delivery')
    expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(grant.source.headOid)
    expect(await readFile(join(f.root, '.git', 'index'))).toEqual(index)
    expect(await git(f.root, 'status', '--porcelain')).toBe('')
  })
})
