import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { LocalGitDelivery } from '../src/git-delivery.ts'
import { git, gitHandoff, gitRuntimeFixture } from './fixtures/git-runtime.ts'

describe('local Git queued cancellation', { timeout: 120_000 }, () => {
  it('skips a cancelled waiter without allocating and releases the queue for a later owner', async () => {
    const f = await gitRuntimeFixture()
    const first = await f.task()
    const second = await f.task()
    const third = await f.task()
    const signal = new AbortController().signal
    const grant = await f.runtime.authorizeLocalGit(first.agent, ['tracked.txt'], signal)
    await f.runtime.authorizeLocalGit(second.agent, ['tracked.txt'], signal)
    await f.runtime.authorizeLocalGit(third.agent, ['tracked.txt'], signal)
    const index = await readFile(join(f.root, '.git', 'index'))
    const entered = f.gate()
    const release = f.gate()
    const queued = f.gate()
    const provision = f.ctx.worktrees.provision.bind(f.ctx.worktrees)
    let allocations = 0
    const provisionSpy = vi.spyOn(f.ctx.worktrees, 'provision').mockImplementation(async (...args) => {
      allocations++
      if (allocations === 1) { entered.resolve(undefined); await release.promise }
      return provision(...args)
    })
    const prepare = Reflect.get(LocalGitDelivery.prototype, 'prepare')
    const prepareSpy = vi.spyOn(LocalGitDelivery.prototype, 'prepare').mockImplementation(function (this: LocalGitDelivery, parent, task, policy, run, handoff, control) {
      const result = prepare.call(this, parent, task, policy, run, handoff, control)
      if (parent === second.agent) queued.resolve(undefined)
      return result
    })
    const cancelled = new AbortController()
    const reason = new Error('queued delivery cancelled')
    try {
      const startingFirst = f.track(f.runtime.startRole(first.agent, 'worker', gitHandoff, undefined, signal))
      await Promise.race([entered.promise, startingFirst.then(() => { throw new Error('First preparation settled before allocation paused.') })])
      const startingSecond = f.track(f.runtime.startRole(second.agent, 'worker', gitHandoff, undefined, cancelled.signal))
      const secondOutcome = startingSecond.then(() => null, (error: unknown) => error)
      await Promise.race([queued.promise, secondOutcome.then(() => { throw new Error('Second preparation settled before joining the queue.') })])
      cancelled.abort(reason)
      expect(allocations).toBe(1)
      release.resolve(undefined)
      expect(await secondOutcome).toBe(reason)
      await startingFirst
      expect(allocations).toBe(1)
      expect(f.runtime.read(second.agent.session)?.task).toMatchObject({ active: null, workerAttempts: 1 })
      expect(f.runtime.readGit(second.agent.session)).toMatchObject({ status: 'authorized', workspace: null, candidate: null })
      await f.role(third.agent, 'worker')
      expect(allocations).toBe(2)
      const candidate = f.runtime.readGit(third.agent.session)?.candidate
      if (candidate == null) throw new Error('The later owner must complete a verified delivery.')
      expect(await git(candidate.inspection.root, 'show', 'HEAD:tracked.txt')).toBe('worker delivery')
      expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(grant.source.headOid)
      expect(await readFile(join(f.root, '.git', 'index'))).toEqual(index)
      expect(await git(f.root, 'status', '--porcelain')).toBe('')
    } finally {
      release.resolve(undefined)
      prepareSpy.mockRestore()
      provisionSpy.mockRestore()
    }
  })
})
