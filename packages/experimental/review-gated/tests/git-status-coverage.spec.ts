/** Local Git status and backend availability through the real public runtime and tool registry. */
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { git, gitHandoff, gitRuntimeFixture, gitSettings, reviewReport, workerReport } from './fixtures/git-runtime.ts'

const signal = () => new AbortController().signal

describe('local Git status', { timeout: 120_000 }, () => {
  it('returns the verified delivery from rg_status and marks the review stale when the owner leaves', async () => {
    const f = await gitRuntimeFixture()
    const { agent } = await f.task()
    const sourceHead = await git(f.root, 'rev-parse', 'HEAD')
    await f.runtime.authorizeLocalGit(agent, ['tracked.txt'], signal())
    await f.role(agent, 'worker')
    await f.role(agent, 'reviewer')

    const results = await f.ctx.tools.execute({ agent, signal: signal(), calls: [
      { type: 'tool-call', id: ToolCallId('status'), name: 'rg_status', arguments: '{}' },
    ] })
    const result = results.results[0]!.result
    expect(result).toMatchObject({ isError: false, value: {
      state: { task: { reviewStatus: 'reported-pass', workerAttempts: 1, reviewAttempts: 1 } },
      localGitDelivery: { status: 'candidate', scope: ['tracked.txt'], binding: { role: 'reviewer' } },
    } })
    if (!result.isError) expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(result.value) }])
    const candidate = f.runtime.readGit(agent.session)?.candidate
    if (candidate === null || candidate === undefined) throw new Error('A verified worker candidate must exist.')

    await f.runtime.leaveLocalGit(agent)
    expect(f.runtime.readGit(agent.session)).toBeNull()
    expect(f.runtime.read(agent.session)?.task).toMatchObject({ reviewStatus: 'stale', workerAttempts: 1, reviewAttempts: 1 })
    expect(await git(candidate.inspection.root, 'rev-parse', 'HEAD')).toBe(candidate.headOid)
    expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(sourceHead)
  })

  it('retains changes without committing when the full worker notice exceeds its limit', async () => {
    const maxReportChars = JSON.stringify(workerReport).length
    const f = await gitRuntimeFixture({ settings: { ...gitSettings(), maxReportChars } })
    const { agent } = await f.task()
    const grant = await f.runtime.authorizeLocalGit(agent, ['tracked.txt'], signal())
    await f.role(agent, 'worker')
    const task = f.runtime.read(agent.session)?.task
    const delivery = f.runtime.readGit(agent.session)
    expect(task).toMatchObject({ workerAttempts: 1, lastWorker: { status: 'failed', report: null } })
    expect(delivery).toMatchObject({ status: 'interrupted', candidate: null })
    const cwd = delivery?.workspace?.root
    if (cwd === undefined) throw new Error('The worker checkout must be retained for inspection.')
    expect(await git(cwd, 'rev-parse', 'HEAD')).toBe(grant.source.headOid)
    expect(await git(cwd, 'status', '--porcelain')).toContain('tracked.txt')
    expect(await git(f.root, 'status', '--porcelain')).toBe('')
  })

  it('does not accept a pass when the review checkout changes during the review', async () => {
    const f = await gitRuntimeFixture()
    const { agent } = await f.task()
    await f.runtime.authorizeLocalGit(agent, ['tracked.txt'], signal())
    await f.role(agent, 'worker')
    const candidate = f.runtime.readGit(agent.session)?.candidate
    if (candidate === null || candidate === undefined) throw new Error('A worker candidate must exist.')
    let reviewerCwd = ''
    f.adapter.reviewer = async (reviewer, request) => {
      reviewerCwd = f.ctx.workingDirectory.get(reviewer.session)
      await f.write(reviewer, 'tracked.txt', 'modified during review\n', request.signal)
      return reviewReport
    }
    await f.role(agent, 'reviewer')
    expect(f.runtime.read(agent.session)?.task).toMatchObject({ reviewStatus: 'stale',
      lastReview: { status: 'completed', report: { verdict: 'pass' },
        diagnostic: 'The Git candidate or independent review checkout is no longer the exact verified version.' } })
    expect(f.runtime.readGit(agent.session)?.status).toBe('candidate')
    expect(typeof f.runtime.readGit(agent.session)?.diagnostic).toBe('string')
    expect(await git(reviewerCwd, 'status', '--porcelain')).toContain('tracked.txt')
    expect(await git(candidate.inspection.root, 'status', '--porcelain')).toBe('')
    expect(await git(candidate.inspection.root, 'rev-parse', 'HEAD')).toBe(candidate.headOid)
  })

  it('refuses role admission after the optional worktree service is withdrawn without spending budget', async () => {
    const f = await gitRuntimeFixture()
    const { agent } = await f.task()
    const grant = await f.runtime.authorizeLocalGit(agent, ['tracked.txt'], signal())
    if (f.worktreeFiber === undefined) throw new Error('The fixture must mount the worktree service.')
    await f.worktreeFiber.dispose()

    await expect(f.runtime.startRole(agent, 'worker', gitHandoff, undefined, signal()))
      .rejects.toMatchObject({ code: 'RG_GIT_UNAVAILABLE' })
    expect(f.runtime.read(agent.session)?.task).toMatchObject({ active: null, workerAttempts: 0 })
    expect(f.runtime.readGit(agent.session)).toEqual(grant)
    expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(grant.source.headOid)
  })
})
