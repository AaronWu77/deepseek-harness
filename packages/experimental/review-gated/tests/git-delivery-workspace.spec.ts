import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { LocalGitDelivery } from '../src/git-delivery.ts'
import { gitProjectionDefinition } from '../src/git-projection.ts'
import { git, gitHandoff, gitRuntimeFixture, workerReport } from './fixtures/git-runtime.ts'

/** Wait until the delivery owner published its optional Git backend.
 * @param delivery - owner whose backend arrives through its injected child context.
 */
async function waitForBackend(delivery: LocalGitDelivery): Promise<void> {
  for (;;) {
    const backend: unknown = Reflect.get(delivery, 'backend')
    if (backend !== undefined) return
    await Promise.resolve()
  }
}

describe('local Git owner in workspace mode', { timeout: 120_000 }, () => {
  it('refuses to finalize a reviewer reservation as a worker without changing the reservation', async () => {
    const f = await gitRuntimeFixture()
    const { agent } = await f.task()
    const grant = await f.runtime.authorizeLocalGit(agent, ['tracked.txt'], new AbortController().signal)
    await f.role(agent, 'worker')
    const candidate = f.runtime.readGit(agent.session)?.candidate
    const policy = f.runtime.read(agent.session)?.policy
    if (candidate == null || policy == null) throw new Error('The reviewer requires a committed candidate and policy.')
    const entered = f.gate()
    const release = f.gate()
    f.adapter.reviewer = async () => { entered.resolve(undefined); await release.promise; throw new Error('Controlled review failure') }
    const notice = f.notice(agent)
    const reviewer = await f.runtime.startRole(agent, 'reviewer', gitHandoff, undefined, new AbortController().signal)
    await entered.promise
    const projection = await f.ctx.sessionProjections.register(gitProjectionDefinition)
    const delivery = new LocalGitDelivery(f.ctx, { gitCommand: 'git', timeoutMs: 60_000, graceMs: 1_000,
      maxOutputBytes: 1_000_000 }, projection, async () => {})
    await waitForBackend(delivery)
    try {
      const spawn = vi.spyOn(f.ctx.subprocess, 'spawn')
      await expect(delivery.finalize(agent, reviewer.runId, policy, workerReport, new AbortController().signal))
        .rejects.toMatchObject({ code: 'RG_GIT_CHANGED' })
      expect(spawn).not.toHaveBeenCalled()
      expect(f.runtime.readGit(agent.session)).toMatchObject({ status: 'reviewing', candidate: { id: candidate.id },
        binding: { runId: reviewer.runId, role: 'reviewer' } })
      spawn.mockRestore()
      release.resolve(undefined)
      await f.until(agent, state => state?.task?.active === null && state.task.lastReview?.id === reviewer.runId)
      await notice
      await agent.whenIdle()
      expect(f.runtime.read(agent.session)?.task).toMatchObject({ reviewStatus: 'inconclusive', lastReview: { status: 'failed' } })
      expect(await git(candidate.inspection.root, 'rev-parse', 'HEAD')).toBe(candidate.headOid)
      expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(grant.source.headOid)
      expect(await git(f.root, 'status', '--porcelain')).toBe('')
    } finally {
      release.resolve(undefined)
      await delivery.close()
      await projection.dispose()
    }
  })

  it('leaves ordinary workspace results alone without a Git grant', async () => {
    const f = await gitRuntimeFixture()
    const { agent } = await f.task()
    const head = await git(f.root, 'rev-parse', 'HEAD')
    const index = await readFile(join(f.root, '.git', 'index'))
    const worker = await f.role(agent, 'worker')
    const reviewer = await f.role(agent, 'reviewer')
    const policy = f.runtime.read(agent.session)?.policy
    if (policy == null) throw new Error('The main task must retain its frozen policy.')
    const projection = await f.ctx.sessionProjections.register(gitProjectionDefinition)
    const delivery = new LocalGitDelivery(f.ctx, { gitCommand: 'git', timeoutMs: 60_000, graceMs: 1_000,
      maxOutputBytes: 1_000_000 }, projection, async () => {})
    await waitForBackend(delivery)
    try {
      const spawn = vi.spyOn(f.ctx.subprocess, 'spawn')
      const signal = new AbortController().signal
      await delivery.finalize(agent, worker.runId, policy, workerReport, signal)
      expect(await delivery.verifyReview(agent, reviewer.runId, policy, signal)).toBe(false)
      expect(spawn).not.toHaveBeenCalled()
      expect(f.runtime.readGit(agent.session)).toBeNull()
      expect(f.runtime.read(agent.session)?.task).toMatchObject({ lastWorker: { status: 'completed' },
        lastReview: { status: 'completed' } })
      expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(head)
      expect(await readFile(join(f.root, '.git', 'index'))).toEqual(index)
      expect(await readFile(join(f.root, 'tracked.txt'), 'utf8')).toBe('worker delivery\n')
    } finally {
      await delivery.close()
      await projection.dispose()
    }
  })
})
