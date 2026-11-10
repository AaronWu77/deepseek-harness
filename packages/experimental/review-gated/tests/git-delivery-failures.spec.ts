import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { git, gitHandoff, gitRuntimeFixture } from './fixtures/git-runtime.ts'

const signal = () => new AbortController().signal

describe('local Git delivery recovery failures', { timeout: 120_000 }, () => {
  it('keeps the verified commit and reports an unknown outcome if review verification cannot be saved', async () => {
    const f = await gitRuntimeFixture()
    const { agent } = await f.task()
    const grant = await f.runtime.authorizeLocalGit(agent, ['tracked.txt'], signal())
    const index = await readFile(join(f.root, '.git', 'index'))
    await f.role(agent, 'worker')
    const candidate = f.runtime.readGit(agent.session)?.candidate
    if (candidate == null) throw new Error('The worker must have committed a candidate.')
    let failed = false
    f.ctx.on('session/flush', (session) => {
      const state = f.runtime.readGit(session)
      if (session === agent.session && !failed && state?.status === 'candidate' && state.binding?.role === 'reviewer') {
        failed = true
        throw new Error('review verification acknowledgement failed')
      }
    })
    await f.role(agent, 'reviewer')
    expect(failed).toBe(true)
    const delivery = f.runtime.readGit(agent.session)
    expect(delivery).toMatchObject({ status: 'unknown', candidate: { id: candidate.id } })
    expect(delivery?.diagnostic).toContain('save outcome is unknown')
    expect(f.runtime.read(agent.session)?.task).toMatchObject({ reviewStatus: 'inconclusive',
      lastReview: { status: 'failed', report: null } })
    expect(f.runtime.read(agent.session)?.task?.lastReview?.diagnostic).toContain('save outcome is unknown')
    expect(await git(candidate.inspection.root, 'rev-parse', 'HEAD')).toBe(candidate.headOid)
    expect(await git(candidate.inspection.root, 'show', 'HEAD:tracked.txt')).toBe('worker delivery')
    expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(grant.source.headOid)
    expect(await readFile(join(f.root, '.git', 'index'))).toEqual(index)
    expect(await git(f.root, 'status', '--porcelain')).toBe('')
  })

  it('marks an altered candidate unknown when publication loses its owned state after commit', async () => {
    const f = await gitRuntimeFixture()
    const { agent } = await f.task()
    const grant = await f.runtime.authorizeLocalGit(agent, ['tracked.txt'], signal())
    const index = await readFile(join(f.root, '.git', 'index'))
    let changed = false
    f.ctx.on('session/flush', (session) => {
      if (session !== agent.session || changed) return
      const state = f.runtime.readGit(session)
      if (state?.status === 'candidate' && state.candidate !== null && state.binding === null) {
        changed = true
        session.append('review-gated/git-state', { version: 1, state: { ...state, diagnostic: 'Concurrent owner update' } })
      }
    })
    await f.role(agent, 'worker')
    const state = f.runtime.readGit(agent.session)
    const candidate = state?.candidate
    if (candidate == null) throw new Error('The committed candidate must remain available for inspection.')
    expect(changed).toBe(true)
    expect(state).toMatchObject({ status: 'unknown', binding: null })
    expect(state?.diagnostic).toContain('no rollback was performed')
    expect(f.runtime.read(agent.session)?.task?.lastWorker).toMatchObject({ status: 'failed', report: null })
    expect(await git(candidate.inspection.root, 'rev-parse', 'HEAD')).toBe(candidate.headOid)
    expect(await git(candidate.inspection.root, 'show', 'HEAD:tracked.txt')).toBe('worker delivery')
    expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(grant.source.headOid)
    expect(await readFile(join(f.root, '.git', 'index'))).toEqual(index)
    expect(await git(f.root, 'status', '--porcelain')).toBe('')
  })

  it('marks allocation uncertainty visibly when the backend rejects without an Error', async () => {
    const f = await gitRuntimeFixture()
    const { agent } = await f.task()
    const grant = await f.runtime.authorizeLocalGit(agent, ['tracked.txt'], signal())
    const index = await readFile(join(f.root, '.git', 'index'))
    vi.spyOn(f.ctx.worktrees, 'provision').mockRejectedValueOnce('backend rejected without details')
    await expect(f.runtime.startRole(agent, 'worker', gitHandoff, undefined, signal())).rejects.toBe('backend rejected without details')
    expect(f.runtime.readGit(agent.session)).toMatchObject({ status: 'unknown', binding: null, candidate: null,
      diagnostic: 'Local Git delivery failed; inspect its retained resources.' })
    expect(f.runtime.read(agent.session)?.task).toMatchObject({ workerAttempts: 1, active: null })
    expect(f.adapter.calls.some(call => call.model === 'worker')).toBe(false)
    await expect(f.runtime.newTask(agent, 'Do not abandon an uncertain allocation')).rejects.toMatchObject({
      code: 'review-gated/refused', details: { reason: 'RG_GIT_UNKNOWN' },
    })
    expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(grant.source.headOid)
    expect(await readFile(join(f.root, '.git', 'index'))).toEqual(index)
    expect(await git(f.root, 'status', '--porcelain')).toBe('')
  })
})
