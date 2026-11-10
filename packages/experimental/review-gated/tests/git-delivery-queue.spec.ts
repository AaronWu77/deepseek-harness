import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { LocalGitDelivery } from '../src/git-delivery.ts'
import { git, gitRuntimeFixture, workerReport } from './fixtures/git-runtime.ts'

describe('local Git shared-repository queue', { timeout: 120_000 }, () => {
  it('refuses to commit a changed grant after waiting behind another owner', async () => {
    const f = await gitRuntimeFixture()
    const first = await f.task()
    const second = await f.task()
    const signal = new AbortController().signal
    const grant = await f.runtime.authorizeLocalGit(first.agent, ['tracked.txt'], signal)
    await f.runtime.authorizeLocalGit(second.agent, ['tracked.txt'], signal)
    const index = await readFile(join(f.root, '.git', 'index'))
    const workerEntered = [f.gate(), f.gate()] as const
    const workerRelease = [f.gate(), f.gate()] as const
    const firstFlush = f.gate()
    const firstFlushRelease = f.gate()
    const secondQueued = f.gate()
    let workers = 0
    f.adapter.worker = async (worker, request) => {
      const slot = workers++
      const entered = workerEntered[slot]
      const release = workerRelease[slot]
      if (entered === undefined || release === undefined) throw new Error('Expected exactly two workers.')
      await f.write(worker, 'tracked.txt', slot === 0 ? 'first delivery\n' : 'second unfinished delivery\n', request.signal)
      entered.resolve(undefined)
      await release.promise
      return workerReport
    }
    let paused = false
    f.ctx.on('session/flush', async (session) => {
      if (session === first.agent.session && !paused && f.runtime.readGit(session)?.status === 'finalizing') {
        paused = true
        firstFlush.resolve(undefined)
        await firstFlushRelease.promise
      }
    })
    const finalize = Reflect.get(LocalGitDelivery.prototype, 'finalize')
    const observer = vi.spyOn(LocalGitDelivery.prototype, 'finalize').mockImplementation(function (this: LocalGitDelivery, parent, runId, policy, report, control) {
      const result = finalize.call(this, parent, runId, policy, report, control)
      if (parent === second.agent) secondQueued.resolve(undefined)
      return result
    })
    try {
      const workingFirst = f.track(f.role(first.agent, 'worker'))
      await workerEntered[0].promise
      const workingSecond = f.track(f.role(second.agent, 'worker'))
      await workerEntered[1].promise
      workerRelease[0].resolve(undefined)
      await firstFlush.promise
      workerRelease[1].resolve(undefined)
      await secondQueued.promise
      const state = f.runtime.readGit(second.agent.session)
      const cwd = state?.workspace?.root
      if (state?.binding == null || cwd === undefined) throw new Error('The second worker must retain its reservation and checkout.')
      expect(state.status).toBe('working')
      second.agent.session.append('review-gated/git-state', { version: 1, state: { ...state, diagnostic: 'Concurrent owner update' } })
      firstFlushRelease.resolve(undefined)
      await Promise.all([workingFirst, workingSecond])
      expect(f.runtime.read(first.agent.session)?.task?.lastWorker?.status).toBe('completed')
      expect(f.runtime.read(second.agent.session)?.task?.lastWorker).toMatchObject({ status: 'failed', report: null,
        diagnostic: 'The local Git grant changed before finalization.' })
      expect(f.runtime.readGit(second.agent.session)).toMatchObject({ status: 'interrupted', candidate: null })
      expect(await git(cwd, 'rev-parse', 'HEAD')).toBe(grant.source.headOid)
      expect(await readFile(join(cwd, 'tracked.txt'), 'utf8')).toBe('second unfinished delivery\n')
      expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(grant.source.headOid)
      expect(await readFile(join(f.root, '.git', 'index'))).toEqual(index)
      expect(await git(f.root, 'status', '--porcelain')).toBe('')
    } finally {
      observer.mockRestore()
      for (const release of workerRelease) release.resolve(undefined)
      firstFlushRelease.resolve(undefined)
    }
  })
})
