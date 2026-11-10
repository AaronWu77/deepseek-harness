/** Local-only Git delivery through real AgentLoop, Loader presets, JSONL, and managed subprocesses. */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { PeerId, RemoteInvocation } from '@deepseek-ai/dsh-typert-protocol'
import { describe, expect, it, vi } from 'vitest'
import { gitRuntimeFixture, git, gitHandoff, gitSettings, workerReport, reviewReport } from './fixtures/git-runtime.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    /** Non-owner principal for the real Remote method authority checks. */
    'git-test-guest': { readonly kind: 'git-test-guest'; readonly guest: string }
  }
}
const signal = () => new AbortController().signal
const refused = (reason: string) => ({ code: 'review-gated/refused', details: { reason } })

// A local delivery and independent review each own dozens of real managed Git processes.
describe('local Git RG runtime', { timeout: 120_000 }, () => {
  it('refuses an unacknowledged Git grant without making it usable', async () => {
    const f = await gitRuntimeFixture()
    const { agent } = await f.task()
    const flush = vi.spyOn(f.ctx.sessions, 'flush').mockResolvedValueOnce(false)
    try {
      await expect(f.runtime.authorizeLocalGit(agent, ['tracked.txt'], signal())).rejects.toMatchObject(refused('RG_GIT_UNKNOWN'))
      expect(f.runtime.readGit(agent.session)).toMatchObject({ status: 'unknown', workspace: null, candidate: null })
      await expect(f.runtime.startRole(agent, 'worker', gitHandoff, undefined, signal())).rejects.toThrow()
      expect(f.adapter.calls.filter(call => call.model === 'worker')).toHaveLength(0)
      expect((await git(f.root, 'worktree', 'list', '--porcelain')).split('\n').filter(line => line.startsWith('worktree '))).toHaveLength(1)
    } finally { flush.mockRestore() }
  })

  it('blocks workspace work when leaving Git has an unacknowledged save', async () => {
    const f = await gitRuntimeFixture()
    const { agent } = await f.task()
    await f.runtime.authorizeLocalGit(agent, ['tracked.txt'], signal())
    const flush = vi.spyOn(f.ctx.sessions, 'flush').mockResolvedValueOnce(false)
    try {
      await expect(f.runtime.leaveLocalGit(agent)).rejects.toMatchObject(refused('RG_NOT_READY'))
      expect(f.runtime.read(agent.session)?.diagnostic).toMatch(/may not be saved/i)
      await expect(f.runtime.startRole(agent, 'worker', gitHandoff, undefined, signal())).rejects.toMatchObject({ code: 'RG_NOT_READY' })
      expect(f.adapter.calls.filter(call => call.model === 'worker')).toHaveLength(0)
    } finally { flush.mockRestore() }
  })

  it('does not allocate Git work or invoke a worker after an unacknowledged reservation', async () => {
    const f = await gitRuntimeFixture()
    const { agent } = await f.task()
    await f.runtime.authorizeLocalGit(agent, ['tracked.txt'], signal())
    const flush = vi.spyOn(f.ctx.sessions, 'flush').mockResolvedValueOnce(false)
    try {
      await expect(f.runtime.startRole(agent, 'worker', gitHandoff, undefined, signal())).rejects.toThrow()
      expect(f.adapter.calls.filter(call => call.model === 'worker')).toHaveLength(0)
      expect(f.runtime.readGit(agent.session)).toMatchObject({ status: 'authorized', workspace: null })
      expect(f.runtime.read(agent.session)?.diagnostic).toContain('RG_RESULT_SAVE_FAILED')
      expect((await git(f.root, 'worktree', 'list', '--porcelain')).split('\n').filter(line => line.startsWith('worktree '))).toHaveLength(1)
    } finally { flush.mockRestore() }
  })

  it('preserves the source HEAD, index, dirty and untracked contents through a committed candidate and independent review', async () => {
    const f = await gitRuntimeFixture()
    const { agent } = await f.task()
    const sourceHead = await git(f.root, 'rev-parse', 'HEAD')
    await writeFile(join(f.root, 'tracked.txt'), 'source staged\n')
    await git(f.root, 'add', 'tracked.txt')
    await writeFile(join(f.root, 'tracked.txt'), 'source unstaged\n')
    await writeFile(join(f.root, 'untracked.txt'), 'source untracked\n')
    const sourceStatus = await git(f.root, 'status', '--porcelain')
    const sourceIndex = await readFile(join(f.root, '.git/index'))
    const grant = await f.runtime.authorizeLocalGit(agent, ['tracked.txt'], signal())
    expect(grant).toMatchObject({ status: 'authorized', source: { root: f.root, headOid: sourceHead }, candidate: null, workspace: null })
    expect(f.ctx.workingDirectory.get(agent.session)).toBe(f.root)
    let workerCwd = ''
    f.adapter.worker = async (worker, request) => {
      workerCwd = f.ctx.workingDirectory.get(worker.session)
      expect(workerCwd).not.toBe(f.root)
      expect(await f.ctx.fs.readText(await f.ctx.fs.resolve('tracked.txt', { cwd: workerCwd }))).toBe('initial\n')
      await f.write(worker, 'tracked.txt', 'scoped candidate\n', request.signal)
      return workerReport
    }
    const worker = await f.role(agent, 'worker')
    const candidate = f.runtime.readGit(agent.session)?.candidate
    if (candidate === null || candidate === undefined) throw new Error('A successful worker must produce a Host-verified candidate.')
    expect(candidate.workerRunId).toBe(worker.runId)
    expect(candidate.headOid).not.toBe(sourceHead)
    expect(candidate.inspection.root).toBe(workerCwd)
    expect(await git(workerCwd, 'show', 'HEAD:tracked.txt')).toBe('scoped candidate')
    expect(f.runtime.read(agent.session)?.task).toMatchObject({ workerAttempts: 1, reviewAttempts: 0, lastWorker: { status: 'completed' } })
    let reviewCwd = ''
    f.adapter.reviewer = async (reviewer) => {
      reviewCwd = f.ctx.workingDirectory.get(reviewer.session)
      expect(reviewCwd).not.toBe(workerCwd)
      expect(await git(reviewCwd, 'rev-parse', 'HEAD')).toBe(candidate.headOid)
      expect(await git(reviewCwd, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD')
      expect(await f.ctx.fs.readText(await f.ctx.fs.resolve('tracked.txt', { cwd: reviewCwd }))).toBe('scoped candidate\n')
      return reviewReport
    }
    await f.role(agent, 'reviewer')
    expect(f.runtime.read(agent.session)?.task).toMatchObject({ workerAttempts: 1, reviewAttempts: 1, reviewStatus: 'reported-pass' })
    expect(f.runtime.readGit(agent.session)).toMatchObject({ status: 'candidate', binding: { role: 'reviewer', checkout: { root: reviewCwd } } })
    expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(sourceHead)
    expect(await git(f.root, 'status', '--porcelain')).toBe(sourceStatus)
    expect(await readFile(join(f.root, '.git/index'))).toEqual(sourceIndex)
    expect(await readFile(join(f.root, 'tracked.txt'), 'utf8')).toBe('source unstaged\n')
    expect(await readFile(join(f.root, 'untracked.txt'), 'utf8')).toBe('source untracked\n')
    expect(f.ctx.workingDirectory.get(agent.session)).toBe(f.root)
    await writeFile(join(grant.source.commonDir, 'info/exclude'), 'review-hidden.txt\n')
    await writeFile(join(reviewCwd, 'review-hidden.txt'), 'ignored input created after review\n')
    expect(await git(reviewCwd, 'status', '--porcelain')).toBe('')
    expect((await f.runtime.recheck(agent, signal()))?.task?.reviewStatus).toBe('stale')
  })

  it('continues a second worker in the retained candidate descendant while charging the same task budget', async () => {
    const f = await gitRuntimeFixture()
    const { agent } = await f.task()
    await f.runtime.authorizeLocalGit(agent, ['tracked.txt'], signal())
    await f.role(agent, 'worker')
    const first = f.runtime.readGit(agent.session)?.candidate
    if (first === null || first === undefined) throw new Error('The first worker must produce a candidate.')
    const taskId = f.runtime.read(agent.session)?.task?.id
    f.adapter.worker = async (worker, request) => {
      const cwd = f.ctx.workingDirectory.get(worker.session)
      expect(cwd).toBe(first.inspection.root)
      expect(await git(cwd, 'rev-parse', 'HEAD')).toBe(first.headOid)
      await f.write(worker, 'tracked.txt', 'second candidate\n', request.signal)
      return workerReport
    }
    const worker = await f.role(agent, 'worker')
    const current = f.runtime.readGit(agent.session)?.candidate
    expect(current).toMatchObject({ baseOid: first.baseOid, workerRunId: worker.runId })
    expect(current?.headOid).not.toBe(first.headOid)
    expect(f.runtime.read(agent.session)?.task).toMatchObject({ id: taskId, workerAttempts: 2 })
    await expect(f.runtime.startRole(agent, 'worker', gitHandoff, undefined, signal())).rejects.toMatchObject({ code: 'RG_BUDGET_EXHAUSTED' })
  })

  it('keeps default workspace mode usable without optional Git services and refuses local authorization visibly', async () => {
    const f = await gitRuntimeFixture({ backend: false })
    const { agent } = await f.task()
    expect(f.runtime.readGit(agent.session)).toBeNull()
    await expect(f.runtime.authorizeLocalGit(agent, ['tracked.txt'], signal())).rejects.toMatchObject(refused('RG_GIT_UNAVAILABLE'))
    expect(f.runtime.read(agent.session)?.task?.workerAttempts).toBe(0)
    await f.role(agent, 'worker')
    expect(f.runtime.read(agent.session)?.task?.lastWorker?.status).toBe('completed')
    expect(f.runtime.readGit(agent.session)).toBeNull()
  })

  it('requires the owner and an idle unused task, and rejects a second grant or an excessive literal scope', async () => {
    const f = await gitRuntimeFixture()
    const empty = await f.create()
    await expect(f.runtime.authorizeLocalGit(empty.agent, ['tracked.txt'], signal())).rejects.toMatchObject(refused('RG_BUSY'))
    const { agent } = await f.task()
    const invocation: RemoteInvocation = { request: { namespace: 'reviewGated', method: 'authorizeLocalGit', args: {} }, service: 'reviewGated',
      peer: { id: brandString<PeerId>('git-guest'), ctx: f.ctx, principal: { kind: 'git-test-guest', guest: 'not-owner' },
        signal: signal(), interactions: 'none', dispose: async () => {} }, signal: signal(),
      uplink: <In>(): AsyncIterable<In> => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }) }) }
    const guest = f.ctx.extend({ invocation }).reviewGated
    await expect(guest.authorizeLocalGit(agent, ['tracked.txt'], signal())).rejects.toMatchObject(refused('RG_GIT_AUTH_REQUIRED'))
    await expect(guest.leaveLocalGit(agent)).rejects.toMatchObject(refused('RG_GIT_AUTH_REQUIRED'))
    for (const scope of [[], ['../escape'], ['.git/config'], [':(glob)**']]) {
      await expect(f.runtime.authorizeLocalGit(agent, scope, signal())).rejects.toMatchObject(refused('RG_GIT_AUTH_REQUIRED'))
    }
    await expect(f.runtime.authorizeLocalGit(agent, ['x'.repeat(gitSettings().maxHandoffChars + 1)], signal()))
      .rejects.toMatchObject(refused('RG_GIT_AUTH_REQUIRED'))
    await expect(f.runtime.authorizeLocalGit(agent, Array.from({ length: gitSettings().maxScopeFiles + 1 }, () => 'tracked.txt'), signal()))
      .rejects.toMatchObject(refused('RG_GIT_AUTH_REQUIRED'))
    await f.runtime.authorizeLocalGit(agent, ['tracked.txt/', ' tracked.txt '], signal())
    expect(f.runtime.readGit(agent.session)?.scope).toEqual(['tracked.txt'])
    await expect(f.runtime.authorizeLocalGit(agent, ['tracked.txt'], signal())).rejects.toMatchObject(refused('RG_GIT_AUTH_REQUIRED'))
    await f.runtime.leaveLocalGit(agent)
    expect(f.runtime.readGit(agent.session)).toBeNull()
    expect(f.runtime.read(agent.session)?.task?.workerAttempts).toBe(0)
  })

  it('refuses out-of-scope handoffs and a substituted cwd through the public subagent start guard', async () => {
    const f = await gitRuntimeFixture()
    const { agent } = await f.task()
    await f.runtime.authorizeLocalGit(agent, ['tracked.txt'], signal())
    await expect(f.runtime.startRole(agent, 'worker', { ...gitHandoff, scope: ['outside.txt'] }, undefined, signal()))
      .rejects.toMatchObject({ code: 'RG_GIT_AUTH_REQUIRED' })
    expect(f.runtime.read(agent.session)?.task).toMatchObject({ workerAttempts: 0, active: null, lastWorker: null })
    const start = f.ctx.subagents.startActivation.bind(f.ctx.subagents)
    vi.spyOn(f.ctx.subagents, 'startActivation').mockImplementation(spec => start({ ...spec, request: { ...spec.request, cwd: f.root } }))
    await expect(f.runtime.startRole(agent, 'worker', gitHandoff, undefined, signal())).rejects.toMatchObject({ code: 'RG_UNAUTHORIZED_START' })
    expect(f.adapter.calls.some(call => call.model === 'worker')).toBe(false)
    expect(f.runtime.read(agent.session)?.task?.workerAttempts).toBe(1)
    expect(f.runtime.readGit(agent.session)?.status).toBe('interrupted')
  })

  it('marks a failed worktree allocation as unknown and does not start a role', async () => {
    const f = await gitRuntimeFixture()
    const { agent } = await f.task()
    await f.runtime.authorizeLocalGit(agent, ['tracked.txt'], signal())
    vi.spyOn(f.ctx.worktrees, 'provision').mockRejectedValueOnce(new Error('allocation outcome cannot be established'))
    await expect(f.runtime.startRole(agent, 'worker', gitHandoff, undefined, signal()))
      .rejects.toThrow('allocation outcome cannot be established')
    expect(f.runtime.readGit(agent.session)).toMatchObject({ status: 'unknown', candidate: null })
    expect(f.adapter.calls.some(call => call.model === 'worker')).toBe(false)
    await expect(f.runtime.startRole(agent, 'worker', gitHandoff, undefined, signal())).rejects.toMatchObject({ code: 'RG_GIT_UNKNOWN' })
    await f.runtime.leaveLocalGit(agent)
    expect(f.runtime.readGit(agent.session)).toBeNull()
  })

  it('requires the role scope to equal the complete human grant rather than reviewing only a subset', async () => {
    const f = await gitRuntimeFixture()
    const { agent } = await f.task()
    await f.runtime.authorizeLocalGit(agent, ['tracked.txt', 'new.txt'], signal())
    await expect(f.runtime.startRole(agent, 'worker', gitHandoff, undefined, signal())).rejects.toMatchObject({ code: 'RG_GIT_AUTH_REQUIRED' })
    expect(f.runtime.read(agent.session)?.task?.workerAttempts).toBe(0)
    expect(f.runtime.readGit(agent.session)?.workspace).toBeNull()
  })

  it('retains the committed checkout when candidate flush returns false', async () => {
    const f = await gitRuntimeFixture()
    const { agent } = await f.task()
    const grant = await f.runtime.authorizeLocalGit(agent, ['tracked.txt'], signal())
    const flush = f.ctx.sessions.flush.bind(f.ctx.sessions)
    let refused = false
    const spy = vi.spyOn(f.ctx.sessions, 'flush').mockImplementation(async (session) => {
      if (session === agent.session && f.runtime.readGit(session)?.status === 'candidate' && !refused) {
        refused = true
        return false
      }
      return flush(session)
    })
    try {
      await f.role(agent, 'worker')
      const state = f.runtime.readGit(agent.session)
      expect(refused).toBe(true)
      expect(state?.status).toBe('unknown')
      const cwd = state?.workspace?.root
      if (cwd === undefined) throw new Error('The committed checkout must remain available.')
      expect(await git(cwd, 'rev-parse', 'HEAD')).not.toBe(grant.source.headOid)
      expect(await git(cwd, 'show', 'HEAD:tracked.txt')).toBe('worker delivery')
      await expect(f.runtime.startRole(agent, 'worker', gitHandoff, undefined, signal())).rejects.toMatchObject({ code: 'RG_GIT_UNKNOWN' })
    } finally { spy.mockRestore() }
  })

  it('retains a real commit as unknown after candidate publication flush fails, and leaving never refunds the task', async () => {
    const f = await gitRuntimeFixture()
    const { agent } = await f.task()
    const grant = await f.runtime.authorizeLocalGit(agent, ['tracked.txt'], signal())
    let failed = false
    f.ctx.on('session/flush', (session) => {
      if (session === agent.session && f.runtime.readGit(session)?.status === 'candidate' && !failed) {
        failed = true
        throw new Error('candidate publication acknowledgement failed')
      }
    })
    await f.role(agent, 'worker')
    const partial = f.runtime.readGit(agent.session)
    expect(partial?.status).toBe('unknown')
    const cwd = partial?.workspace?.root
    if (cwd === undefined) throw new Error('Unknown delivery must retain the allocated task workspace.')
    expect(await git(cwd, 'rev-parse', 'HEAD')).not.toBe(grant.source.headOid)
    expect(f.runtime.read(agent.session)?.task).toMatchObject({ workerAttempts: 1, lastWorker: { status: 'failed' } })
    await expect(f.runtime.startRole(agent, 'worker', gitHandoff, undefined, signal())).rejects.toMatchObject({ code: 'RG_GIT_UNKNOWN' })
    await expect(f.runtime.newTask(agent, 'Do not silently reset this budget')).rejects.toMatchObject(refused('RG_GIT_UNKNOWN'))
    await f.runtime.leaveLocalGit(agent)
    expect(f.runtime.readGit(agent.session)).toBeNull()
    expect(f.runtime.read(agent.session)?.task?.workerAttempts).toBe(1)
    expect(await git(cwd, 'show', 'HEAD:tracked.txt')).toBe('worker delivery')
  })
})


describe('local Git admission and lifetime races', { timeout: 120_000 }, () => {
  it('refuses authorization if the task changes while Git inspection is pending', async () => {
    const f = await gitRuntimeFixture()
    const { agent } = await f.task()
    const replacement = await f.task()
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
    agent.session.append('review-gated/state', { version: 1, state: f.runtime.read(replacement.agent.session) })
    release.resolve(undefined)
    await expect(authorization).rejects.toMatchObject(refused('RG_BUSY'))
    expect(f.runtime.readGit(agent.session)).toBeNull()
    expect(f.runtime.read(agent.session)?.task?.workerAttempts).toBe(0)
    await agent.whenIdle()
  })

  it.each(['parent', 'disable'] as const)('joins final Git verification and terminal flush before %s disposal releases the writer', async (mode) => {
    const f = await gitRuntimeFixture()
    const handle = await f.task()
    const parent = handle.agent
    const runtime = f.runtime
    await runtime.authorizeLocalGit(parent, ['tracked.txt'], signal())
    await f.role(parent, 'worker')
    const workspace = runtime.readGit(parent.session)?.workspace?.root
    if (workspace === undefined) throw new Error('The completed worker must retain its checkout.')
    const entered = f.gate()
    const release = f.gate()
    const flushEntered = f.gate()
    const flushRelease = f.gate()
    const disposalBegan = f.gate()
    let reportReturned = false
    let intercepted = false
    let flushing = false
    f.adapter.reviewer = async () => { reportReturned = true; return reviewReport }
    const spawn = f.ctx.subprocess.spawn.bind(f.ctx.subprocess)
    vi.spyOn(f.ctx.subprocess, 'spawn').mockImplementation((spec) => {
      const child = spawn(spec)
      if (reportReturned && !intercepted && spec.argv.includes('--is-inside-work-tree')) {
        intercepted = true
        return { ...child, done: child.done.then(async (outcome) => {
          entered.resolve(undefined); await release.promise; return outcome
        }), terminate: () => { child.terminate() }, waitForExit: () => child.waitForExit() }
      }
      return child
    })
    f.ctx.on('session/flush', (session) => {
      if (session === parent.session && runtime.read(session)?.task?.active?.status === 'saving' && !flushing) {
        flushing = true; flushEntered.resolve(undefined); return flushRelease.promise
      }
    })
    const reviewer = await runtime.startRole(parent, 'reviewer', gitHandoff, undefined, signal())
    await entered.promise
    const checkout = runtime.readGit(parent.session)?.binding?.checkout?.root
    if (checkout === undefined) throw new Error('The admitted review must retain its independent checkout.')
    expect((await runtime.recheck(parent, signal()))?.task?.reviewStatus).not.toBe('reported-pass')
    const observer = mode === 'parent' ? parent.ctx : f.entry.fiber?.ctx
    if (observer === undefined) throw new Error('Disposal observation requires the public owner Context.')
    observer.effect(() => () => { disposalBegan.resolve(undefined) })
    let closed = false
    const closing = f.track((mode === 'parent' ? handle.dispose() : f.enabled(false)).then(() => { closed = true }))
    await disposalBegan.promise
    expect(closed).toBe(false)
    expect(f.ctx.agents.get(parent.id)).toBe(parent)
    release.resolve(undefined)
    await flushEntered.promise
    expect(closed).toBe(false)
    await expect(f.ctx.sessionPersistence.open(parent.id, 'write'))
      .rejects.toMatchObject({ name: 'SessionAlreadyOwnedError' })
    expect((await f.ctx.fs.stat(await f.ctx.fs.resolve(workspace)))?.type).toBe('directory')
    expect((await f.ctx.fs.stat(await f.ctx.fs.resolve(checkout)))?.type).toBe('directory')
    flushRelease.resolve(undefined)
    await closing
    expect(closed).toBe(true)
    expect(runtime.read(parent.session)?.task?.reviewStatus).not.toBe('reported-pass')
    expect(f.ctx.agents.get(reviewer.subagentId)).toBeUndefined()
    expect((await f.ctx.fs.stat(await f.ctx.fs.resolve(workspace)))?.type).toBe('directory')
    expect((await f.ctx.fs.stat(await f.ctx.fs.resolve(checkout)))?.type).toBe('directory')
  })

  it('retains a completed review across restore, rejects crash-prefix passes, and refuses concurrent rechecks', async () => {
    const f = await gitRuntimeFixture()
    const { agent } = await f.task()
    await f.runtime.authorizeLocalGit(agent, ['tracked.txt'], signal())
    await f.role(agent, 'worker')
    await f.role(agent, 'reviewer')
    const events = agent.session.snapshotEvents()
    const restored = await f.create(events)
    expect(f.runtime.readGit(restored.agent.session)?.status).toBe('candidate')
    expect((await f.runtime.recheck(restored.agent, signal()))?.task?.reviewStatus).toBe('reported-pass')
    const workerCut = events.findIndex(event => event.type === 'review-gated/git-state' && event.data.state?.status === 'candidate'
      && event.data.state.candidate !== null && event.data.state.binding === null)
    const reviewCut = events.findIndex(event => event.type === 'review-gated/git-state' && event.data.state?.status === 'candidate'
      && event.data.state.binding?.role === 'reviewer')
    expect(workerCut).toBeGreaterThan(0)
    expect(reviewCut).toBeGreaterThan(workerCut)
    for (const cut of [workerCut, reviewCut]) {
      const crashed = await f.create(events.slice(0, cut + 1))
      expect(f.runtime.readGit(crashed.agent.session)?.status).toBe('interrupted')
      expect(f.runtime.read(crashed.agent.session)?.task?.reviewStatus).not.toBe('reported-pass')
      expect(f.runtime.read(crashed.agent.session)?.task?.workerAttempts).toBe(1)
    }
    const entered = f.gate()
    const release = f.gate()
    const spawn = f.ctx.subprocess.spawn.bind(f.ctx.subprocess)
    let intercepted = false
    const spying = vi.spyOn(f.ctx.subprocess, 'spawn').mockImplementation((spec) => {
      const child = spawn(spec)
      if (!intercepted && spec.argv.includes('--is-inside-work-tree')) {
        intercepted = true
        return { ...child, done: child.done.then(async (outcome) => {
          entered.resolve(undefined); await release.promise; return outcome
        }), terminate: () => { child.terminate() }, waitForExit: () => child.waitForExit() }
      }
      return child
    })
    const checking = f.track(f.runtime.recheck(restored.agent, signal()))
    await entered.promise
    await expect(f.runtime.recheck(restored.agent, signal())).rejects.toMatchObject(refused('RG_BUSY'))
    release.resolve(undefined)
    expect((await checking)?.task?.reviewStatus).toBe('reported-pass')
    spying.mockRestore()
    const workspace = f.runtime.readGit(restored.agent.session)?.workspace?.root
    if (workspace === undefined) throw new Error('A restored candidate must retain its actual worker checkout.')
    await writeFile(join(workspace, 'tracked.txt'), 'changed after restore\n')
    expect((await f.runtime.recheck(restored.agent, signal()))?.task?.reviewStatus).toBe('stale')
  })

  it('does not leave a live reservation after prepare and every cleanup flush fail, and exposes the recovery diagnostic', async () => {
    const f = await gitRuntimeFixture()
    const handle = await f.task()
    const parent = handle.agent
    await f.runtime.authorizeLocalGit(parent, ['tracked.txt'], signal())
    let failed = false
    f.ctx.on('session/flush', (session) => {
      if (session === parent.session && (failed || f.runtime.readGit(session)?.status === 'preparing')) {
        failed = true
        throw new Error('prepare and cleanup flush acknowledgement failed')
      }
    })
    await expect(f.runtime.startRole(parent, 'worker', gitHandoff, undefined, signal())).rejects.toBeInstanceOf(AggregateError)
    expect(f.runtime.read(parent.session)?.diagnostic).toContain('RG_RESULT_SAVE_FAILED')
    expect(f.runtime.read(parent.session)?.task).toMatchObject({ active: null, workerAttempts: 1, reviewStatus: 'inconclusive' })
    expect(f.adapter.calls.some(call => call.model === 'worker')).toBe(false)
    expect(f.runtime.readGit(parent.session)?.status).toBe('unknown')
    await handle.dispose()
    expect(f.ctx.agents.get(parent.id)).toBeUndefined()
  })
})


it('never publishes a candidate when the worker creates ignored source through its own ignore rules', { timeout: 120_000 }, async () => {
  const f = await gitRuntimeFixture()
  const { agent } = await f.task()
  const grant = await f.runtime.authorizeLocalGit(agent, ['.'], signal())
  f.adapter.worker = async (worker, options) => {
    await f.write(worker, '.gitignore', 'hidden.txt\n', options.signal)
    await f.write(worker, 'hidden.txt', 'must not be omitted from verification\n', options.signal)
    await f.write(worker, 'tracked.txt', 'visible worker change\n', options.signal)
    return workerReport
  }
  await f.role(agent, 'worker', { ...gitHandoff, scope: ['.'] })
  const state = f.runtime.readGit(agent.session)
  expect(state?.status).toBe('failed')
  expect(state?.diagnostic).toContain('Ignored untracked')
  expect(state?.candidate).toBeNull()
  const cwd = state?.workspace?.root
  if (cwd === undefined) throw new Error('Rejected ignored source must remain in the allocated checkout.')
  expect(await git(cwd, 'rev-parse', 'HEAD')).toBe(grant.source.headOid)
  expect(await git(cwd, 'diff', '--cached', '--name-only')).toBe('')
  expect(await readFile(join(cwd, 'hidden.txt'), 'utf8')).toBe('must not be omitted from verification\n')
  expect(f.runtime.read(agent.session)?.task).toMatchObject({ workerAttempts: 1, lastWorker: { status: 'failed' } })
})


it('does not commit a blocked formal worker report and does not spend review budget before a candidate exists', { timeout: 120_000 }, async () => {
  const f = await gitRuntimeFixture()
  const { agent } = await f.task()
  const grant = await f.runtime.authorizeLocalGit(agent, ['tracked.txt'], signal())
  await expect(f.runtime.startRole(agent, 'reviewer', gitHandoff, undefined, signal())).rejects.toMatchObject({ code: 'RG_GIT_CHANGED' })
  expect(f.runtime.read(agent.session)?.task?.reviewAttempts).toBe(0)
  f.adapter.worker = async (worker, options) => {
    await f.write(worker, 'tracked.txt', 'unfinished implementation\n', options.signal)
    return { ...workerReport, outcome: 'blocked', summary: 'A human decision is needed', validation: [], unverified: ['Acceptance remains unresolved'] }
  }
  await f.role(agent, 'worker')
  expect(f.runtime.read(agent.session)?.task).toMatchObject({ workerAttempts: 1, lastWorker: { status: 'completed', report: { outcome: 'blocked' } } })
  const state = f.runtime.readGit(agent.session)
  expect(state).toMatchObject({ status: 'interrupted', candidate: null })
  const cwd = state?.workspace?.root
  if (cwd === undefined) throw new Error('Blocked work must retain its actual modified checkout.')
  expect(await git(cwd, 'rev-parse', 'HEAD')).toBe(grant.source.headOid)
  expect(await readFile(join(cwd, 'tracked.txt'), 'utf8')).toBe('unfinished implementation\n')
})


it('logs a role-disposal failure after optional-provider withdrawal joins both role and Git teardown', { timeout: 120_000 }, async () => {
  const f = await gitRuntimeFixture()
  const own = await f.task()
  const other = await f.task()
  await f.runtime.authorizeLocalGit(own.agent, ['tracked.txt'], signal())
  const workerEntered = f.gate()
  f.adapter.worker = async (_worker, request) => {
    const cancellation = request.signal
    if (cancellation === undefined) throw new Error('A real role request must carry cancellation.')
    const stopped = f.gate()
    const abort = () => { stopped.resolve(undefined) }
    cancellation.addEventListener('abort', abort, { once: true })
    workerEntered.resolve(undefined)
    try { if (cancellation.aborted) abort(); await stopped.promise; return workerReport }
    finally { cancellation.removeEventListener('abort', abort) }
  }
  const childDisposeEntered = f.gate()
  const childDisposeRelease = f.gate()
  const failure = new Error('child disposal acknowledgement was lost after the real child stopped')
  let failedDisposal = false
  const start = f.ctx.subagents.startActivation.bind(f.ctx.subagents)
  vi.spyOn(f.ctx.subagents, 'startActivation').mockImplementation(async (spec) => {
    const activation = await start(spec)
    let closing: Promise<void> | undefined
    return { ...activation, dispose() {
      closing ??= (async () => {
        childDisposeEntered.resolve(undefined)
        await childDisposeRelease.promise
        await activation.dispose()
        failedDisposal = true
        throw failure
      })()
      return closing
    } }
  })
  const worker = await f.runtime.startRole(own.agent, 'worker', gitHandoff, undefined, signal())
  await workerEntered.promise
  const gitEntered = f.gate()
  const gitRelease = f.gate()
  const spawn = f.ctx.subprocess.spawn.bind(f.ctx.subprocess)
  let intercepted = false
  vi.spyOn(f.ctx.subprocess, 'spawn').mockImplementation((spec) => {
    const child = spawn(spec)
    if (!intercepted && spec.argv.includes('symbolic-ref')) {
      intercepted = true
      return { ...child, done: child.done.then(async (outcome) => {
        gitEntered.resolve(undefined); await gitRelease.promise; return outcome
      }), terminate: () => { child.terminate() }, waitForExit: () => child.waitForExit() }
    }
    return child
  })
  const authorization = f.track(f.runtime.authorizeLocalGit(other.agent, ['tracked.txt'], signal()))
  const authorizationResult = authorization.then(() => true, () => false)
  await gitEntered.promise
  const provider = f.worktreeFiber
  if (provider === undefined) throw new Error('This composed fixture must own the optional worktree provider.')
  const logs = vi.spyOn(f.ctx.logger, 'error')
  const containsFailure = (value: unknown): boolean => value === failure
    || value instanceof AggregateError && value.errors.some((nested: unknown) => containsFailure(nested))
  const cleanupLogs = () => logs.mock.calls.flatMap(args => args.filter((arg): arg is AggregateError =>
    arg instanceof AggregateError && arg.message === 'Local Git backend cleanup failed'))
  let withdrawn = false
  const withdrawal = f.track(provider.dispose().then(() => { withdrawn = true }))
  const withdrawalResult = withdrawal.then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error }))
  await childDisposeEntered.promise
  expect(withdrawn).toBe(false)
  expect(cleanupLogs()).toEqual([])
  gitRelease.resolve(undefined)
  expect(await authorizationResult).toBe(false)
  expect(withdrawn).toBe(false)
  expect(cleanupLogs()).toEqual([])
  childDisposeRelease.resolve(undefined)
  const outcome = await withdrawalResult
  expect(failedDisposal).toBe(true)
  expect(f.ctx.agents.get(worker.subagentId)).toBeUndefined()
  expect(f.runtime.read(own.agent.session)?.task?.lastWorker?.status).toBe('cancelled')
  expect(f.runtime.readGit(own.agent.session)?.status).toBe('interrupted')
  expect(outcome).toEqual({ ok: true })
  expect(cleanupLogs().some(error => containsFailure(error))).toBe(true)
})


describe('Git finalization reservation ownership', { timeout: 120_000 }, () => {
  it.each([
    { phase: 'worker', replacement: 'task' }, { phase: 'worker', replacement: 'null' },
    { phase: 'write-tree', replacement: 'task' }, { phase: 'write-tree', replacement: 'null' },
    { phase: 'write-tree', replacement: 'terminal' },
  ] as const)('does not commit when $replacement replaces the main reservation during $phase', async ({ phase, replacement }) => {
    const f = await gitRuntimeFixture()
    const own = await f.task()
    const other = await f.task()
    const runtime = f.runtime
    const grant = await runtime.authorizeLocalGit(own.agent, ['tracked.txt'], signal())
    const workerEntered = f.gate()
    const workerRelease = f.gate()
    const gitEntered = f.gate()
    const gitRelease = f.gate()
    const settled = f.gate()
    let cwd = ''
    f.adapter.worker = async (worker, request) => {
      cwd = f.ctx.workingDirectory.get(worker.session)
      await f.write(worker, 'tracked.txt', 'must not be committed after reservation revocation\n', request.signal)
      workerEntered.resolve(undefined)
      if (phase === 'worker') await workerRelease.promise
      return workerReport
    }
    f.ctx.logger.exporter({ export: (message) => {
      if (message.args[0] === 'RG role result could not be durably settled: %s') settled.resolve(undefined)
    } })
    const commitReservations: { taskId: string | null; runId: string | null }[] = []
    const spawn = f.ctx.subprocess.spawn.bind(f.ctx.subprocess)
    let intercepted = false
    vi.spyOn(f.ctx.subprocess, 'spawn').mockImplementation((spec) => {
      if (spec.argv.includes('commit')) {
        const state = runtime.read(own.agent.session)
        commitReservations.push({ taskId: state?.task?.id ?? null, runId: state?.task?.active?.id ?? null })
      }
      const child = spawn(spec)
      if (phase === 'write-tree' && !intercepted && spec.argv.includes('write-tree')) {
        intercepted = true
        return { ...child, done: child.done.then(async (outcome) => {
          gitEntered.resolve(undefined); await gitRelease.promise; return outcome
        }), terminate: () => { child.terminate() }, waitForExit: () => child.waitForExit() }
      }
      return child
    })
    const run = await runtime.startRole(own.agent, 'worker', gitHandoff, undefined, signal())
    await workerEntered.promise
    if (phase === 'write-tree') await gitEntered.promise
    expect(await git(cwd, 'rev-parse', 'HEAD')).toBe(grant.source.headOid)
    const current = runtime.read(own.agent.session)
    if (current?.task?.active === null || current?.task?.active === undefined) throw new Error('The original reservation must still be active.')
    const state = replacement === 'null' ? null : replacement === 'task' ? runtime.read(other.agent.session)
      : { ...current, task: { ...current.task, active: null, lastWorker: { ...current.task.active, status: 'completed' as const, report: workerReport } } }
    own.agent.session.append('review-gated/state', { version: 1, state })
    workerRelease.resolve(undefined)
    gitRelease.resolve(undefined)
    await settled.promise
    expect(f.ctx.agents.get(run.subagentId)).toBeUndefined()
    const head = await git(cwd, 'rev-parse', 'HEAD')
    expect({ head, commitReservations }).toEqual({ head: grant.source.headOid, commitReservations: [] })
  })
})


it('marks a review stale when the worker checkout changes while the independent reviewer checkout is being verified', { timeout: 120_000 }, async () => {
  const f = await gitRuntimeFixture()
  const { agent } = await f.task()
  await f.runtime.authorizeLocalGit(agent, ['tracked.txt'], signal())
  await f.role(agent, 'worker')
  await f.role(agent, 'reviewer')
  expect(f.runtime.read(agent.session)?.task?.reviewStatus).toBe('reported-pass')
  const state = f.runtime.readGit(agent.session)
  const worker = state?.candidate?.inspection.root
  const reviewer = state?.binding?.checkout?.root
  if (worker === undefined || reviewer === undefined) throw new Error('A completed local review must retain both actual checkouts.')
  expect(worker).not.toBe(reviewer)
  const entered = f.gate()
  const release = f.gate()
  const inspectedRoots: string[] = []
  const spawn = f.ctx.subprocess.spawn.bind(f.ctx.subprocess)
  let intercepted = false
  vi.spyOn(f.ctx.subprocess, 'spawn').mockImplementation((spec) => {
    if (spec.argv.includes('--is-inside-work-tree')) inspectedRoots.push(spec.cwd)
    const child = spawn(spec)
    if (!intercepted && spec.cwd === reviewer && spec.argv.includes('--is-inside-work-tree')) {
      intercepted = true
      return { ...child, done: child.done.then(async (outcome) => {
        entered.resolve(undefined); await release.promise; return outcome
      }), terminate: () => { child.terminate() }, waitForExit: () => child.waitForExit() }
    }
    return child
  })
  const checking = f.track(f.runtime.recheck(agent, signal()))
  await entered.promise
  expect(inspectedRoots.length).toBeGreaterThan(1)
  expect(inspectedRoots.slice(0, -1).every(root => root === worker)).toBe(true)
  expect(inspectedRoots.at(-1)).toBe(reviewer)
  await writeFile(join(worker, 'tracked.txt'), 'worker changed after its first verification\n')
  release.resolve(undefined)
  expect((await checking)?.task?.reviewStatus).toBe('stale')
  expect(f.runtime.readGit(agent.session)?.diagnostic).not.toBeNull()
  expect(inspectedRoots.at(-1)).toBe(worker)
  expect(await readFile(join(worker, 'tracked.txt'), 'utf8')).toBe('worker changed after its first verification\n')
})
