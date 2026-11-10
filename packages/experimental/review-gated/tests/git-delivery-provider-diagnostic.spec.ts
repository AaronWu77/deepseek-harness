import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { git, gitRuntimeFixture } from './fixtures/git-runtime.ts'

describe('local Git review verification provider failure', { timeout: 120_000 }, () => {
  it('marks a review stale and retains the candidate when filesystem resolution rejects with a non-Error', async () => {
    const f = await gitRuntimeFixture()
    const { agent } = await f.task()
    const signal = new AbortController().signal
    const grant = await f.runtime.authorizeLocalGit(agent, ['tracked.txt'], signal)
    const index = await readFile(join(f.root, '.git', 'index'))
    await f.role(agent, 'worker')
    await f.role(agent, 'reviewer')
    const state = f.runtime.readGit(agent.session)
    const candidate = state?.candidate
    if (candidate == null || state?.binding?.checkout == null) throw new Error('The verified review must retain both checkouts.')
    expect(f.runtime.read(agent.session)?.task?.reviewStatus).toBe('reported-pass')
    const resolve = vi.spyOn(f.ctx.fs, 'resolve').mockRejectedValueOnce('filesystem provider unavailable')
    try {
      expect((await f.runtime.recheck(agent, signal))?.task?.reviewStatus).toBe('stale')
      expect(resolve).toHaveBeenCalled()
    } finally {
      resolve.mockRestore()
    }
    expect(f.runtime.readGit(agent.session)).toMatchObject({ status: 'candidate', candidate: { id: candidate.id },
      binding: { role: 'reviewer' }, diagnostic: 'filesystem provider unavailable' })
    expect(await git(candidate.inspection.root, 'rev-parse', 'HEAD')).toBe(candidate.headOid)
    expect(await git(candidate.inspection.root, 'show', 'HEAD:tracked.txt')).toBe('worker delivery')
    expect(await git(state.binding.checkout.root, 'rev-parse', 'HEAD')).toBe(candidate.headOid)
    expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(grant.source.headOid)
    expect(await readFile(join(f.root, '.git', 'index'))).toEqual(index)
    expect(await git(f.root, 'status', '--porcelain')).toBe('')
  })
})
