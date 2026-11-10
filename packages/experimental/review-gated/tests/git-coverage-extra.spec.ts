import { describe, expect, it, vi } from 'vitest'
import { repository } from '../../worktree/tests/harness.ts'
import { git, gitHandoff, gitRuntimeFixture } from './fixtures/git-runtime.ts'

const signal = () => new AbortController().signal

describe('local Git delivery source and cancellation', { timeout: 120_000 }, () => {
  it('refuses a worker when the owner changes to another repository after authorization', async () => {
    const f = await gitRuntimeFixture()
    const otherRoot = await repository(f.base)
    const { agent } = await f.task()
    const grant = await f.runtime.authorizeLocalGit(agent, ['tracked.txt'], signal())
    const otherHead = await git(otherRoot, 'rev-parse', 'HEAD')
    await f.ctx.workingDirectory.set(agent, otherRoot)
    const provision = vi.spyOn(f.ctx.worktrees, 'provision')

    await expect(f.runtime.startRole(agent, 'worker', gitHandoff, undefined, signal()))
      .rejects.toMatchObject({ code: 'RG_GIT_CHANGED' })
    expect(provision).not.toHaveBeenCalled()
    expect(f.adapter.calls.some(call => call.model === 'worker')).toBe(false)
    expect(f.runtime.readGit(agent.session)).toEqual(grant)
    expect(f.runtime.read(agent.session)?.task).toMatchObject({ workerAttempts: 1, active: null })
    expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(grant.source.headOid)
    expect(await git(otherRoot, 'rev-parse', 'HEAD')).toBe(otherHead)
    expect(await git(f.root, 'status', '--porcelain')).toBe('')
    expect(await git(otherRoot, 'status', '--porcelain')).toBe('')
  })

  it('does not retain a pre-cancelled authorization and accepts a later grant', async () => {
    const f = await gitRuntimeFixture()
    const { agent } = await f.task()
    const control = new AbortController()
    const reason = new Error('authorization cancelled')
    control.abort(reason)
    await expect(f.runtime.authorizeLocalGit(agent, ['tracked.txt'], control.signal)).rejects.toBe(reason)
    expect(f.runtime.readGit(agent.session)).toBeNull()
    const grant = await f.runtime.authorizeLocalGit(agent, ['tracked.txt'], signal())
    expect(grant.status).toBe('authorized')
    expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(grant.source.headOid)
    expect(await git(f.root, 'status', '--porcelain')).toBe('')
  })
})
