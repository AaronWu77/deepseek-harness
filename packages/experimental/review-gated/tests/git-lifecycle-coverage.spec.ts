import { describe, expect, it, vi } from 'vitest'
import { git, gitHandoff, gitRuntimeFixture } from './fixtures/git-runtime.ts'

const signal = () => new AbortController().signal

// Each test owns its scratch repository, managed processes, and fixture teardown.
describe('local Git lifecycle refusals', { timeout: 120_000 }, () => {
  it('refuses to leave while authorization inspection is still in flight', async () => {
    const f = await gitRuntimeFixture()
    const { agent } = await f.task()
    const entered = f.gate()
    const release = f.gate()
    const spawn = f.ctx.subprocess.spawn.bind(f.ctx.subprocess)
    vi.spyOn(f.ctx.subprocess, 'spawn').mockImplementation((spec) => {
      const child = spawn(spec)
      return spec.argv.includes('symbolic-ref') ? { ...child, done: child.done.then(async (outcome) => {
        entered.resolve(undefined); await release.promise; return outcome
      }), terminate: () => { child.terminate() }, waitForExit: () => child.waitForExit() } : child
    })
    const authorization = f.track(f.runtime.authorizeLocalGit(agent, ['tracked.txt'], signal()))
    await entered.promise
    await expect(f.runtime.leaveLocalGit(agent)).rejects.toMatchObject({ code: 'review-gated/refused', details: { reason: 'RG_BUSY' } })
    expect(f.runtime.readGit(agent.session)).toBeNull()
    release.resolve(undefined)
    expect((await authorization).status).toBe('authorized')
    await f.runtime.leaveLocalGit(agent)
    expect(f.runtime.readGit(agent.session)).toBeNull()
  })

  it('rejects an allocated checkout result that points to the source rather than a linked worktree', async () => {
    const f = await gitRuntimeFixture()
    const { agent } = await f.task()
    const grant = await f.runtime.authorizeLocalGit(agent, ['tracked.txt'], signal())
    const provision = f.ctx.worktrees.provision.bind(f.ctx.worktrees)
    let retained = ''
    vi.spyOn(f.ctx.worktrees, 'provision').mockImplementation(async (...args) => {
      const allocated = await provision(...args)
      retained = allocated.path
      return { ...allocated, path: f.root }
    })
    await expect(f.runtime.startRole(agent, 'worker', gitHandoff, undefined, signal())).rejects.toMatchObject({ code: 'RG_GIT_CHANGED' })
    expect(f.adapter.calls.some(call => call.model === 'worker')).toBe(false)
    expect(f.runtime.readGit(agent.session)).toMatchObject({ status: 'failed', candidate: null, binding: null })
    expect(f.runtime.read(agent.session)?.task).toMatchObject({ workerAttempts: 1, active: null })
    expect(retained).not.toBe('')
    expect(await git(retained, 'rev-parse', 'HEAD')).toBe(grant.source.headOid)
    expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(grant.source.headOid)
  })

  it('refuses a retained checkout whose branch changes after candidate verification', async () => {
    const f = await gitRuntimeFixture()
    const { agent } = await f.task()
    await f.runtime.authorizeLocalGit(agent, ['tracked.txt'], signal())
    await f.role(agent, 'worker')
    const candidate = f.runtime.readGit(agent.session)?.candidate
    if (candidate == null) throw new Error('The completed worker must retain a candidate.')
    const entered = f.gate()
    const release = f.gate()
    const spawn = f.ctx.subprocess.spawn.bind(f.ctx.subprocess)
    let ignoredChecks = 0
    vi.spyOn(f.ctx.subprocess, 'spawn').mockImplementation((spec) => {
      const child = spawn(spec)
      if (spec.argv.includes('ls-files') && spec.argv.includes('--ignored') && ++ignoredChecks === 3) {
        return { ...child, done: child.done.then(async (outcome) => {
          entered.resolve(undefined); await release.promise; return outcome
        }), terminate: () => { child.terminate() }, waitForExit: () => child.waitForExit() }
      }
      return child
    })
    const next = f.track(f.runtime.startRole(agent, 'worker', gitHandoff, undefined, signal()))
    await entered.promise
    await git(candidate.inspection.root, 'switch', '-c', 'externally-changed-branch')
    release.resolve(undefined)
    await expect(next).rejects.toMatchObject({ code: 'RG_GIT_CHANGED' })
    expect(f.runtime.readGit(agent.session)).toMatchObject({ status: 'failed', candidate: null, binding: null })
    expect(f.runtime.read(agent.session)?.task).toMatchObject({ workerAttempts: 2, active: null })
    expect(await git(candidate.inspection.root, 'rev-parse', 'HEAD')).toBe(candidate.headOid)
    expect(await git(candidate.inspection.root, 'branch', '--show-current')).toBe('externally-changed-branch')
    expect(f.adapter.calls.filter(call => call.model === 'worker')).toHaveLength(1)
  })
})
