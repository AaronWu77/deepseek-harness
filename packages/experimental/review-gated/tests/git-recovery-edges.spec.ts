import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { git, gitHandoff, gitRuntimeFixture, reviewReport, workerReport } from './fixtures/git-runtime.ts'

const signal = () => new AbortController().signal

// Each role uses a real scratch repository and managed Git subprocesses.
describe('local Git recovery edges', { timeout: 120_000 }, () => {
  it.each(['cleared', 'replaced'] as const)('does not accept a review after Git state is %s during verification', async (change) => {
    const f = await gitRuntimeFixture()
    const { agent } = await f.task()
    const other = await f.task()
    await f.runtime.authorizeLocalGit(agent, ['tracked.txt'], signal())
    const replacement = await f.runtime.authorizeLocalGit(other.agent, ['tracked.txt'], signal())
    await f.role(agent, 'worker')
    const candidate = f.runtime.readGit(agent.session)?.candidate
    if (candidate == null) throw new Error('The worker must produce a real candidate.')
    const entered = f.gate()
    const release = f.gate()
    let returned = false
    let intercepted = false
    f.adapter.reviewer = async () => { returned = true; return reviewReport }
    const spawn = f.ctx.subprocess.spawn.bind(f.ctx.subprocess)
    vi.spyOn(f.ctx.subprocess, 'spawn').mockImplementation((spec) => {
      const child = spawn(spec)
      if (returned && !intercepted && spec.argv.includes('--is-inside-work-tree')) {
        intercepted = true
        return { ...child, done: child.done.then(async (outcome) => {
          entered.resolve(undefined); await release.promise; return outcome
        }), terminate: () => { child.terminate() }, waitForExit: () => child.waitForExit() }
      }
      return child
    })
    const checking = f.track(f.role(agent, 'reviewer'))
    await entered.promise
    const current = f.runtime.readGit(agent.session)
    expect(current?.binding?.role).toBe('reviewer')
    const next = change === 'cleared' ? null : replacement
    agent.session.append('review-gated/git-state', { version: 1, state: next })
    release.resolve(undefined)
    await checking
    expect(f.runtime.readGit(agent.session)).toEqual(next)
    expect(f.runtime.read(agent.session)?.task).toMatchObject({ reviewStatus: 'stale',
      lastReview: { status: 'completed', report: { verdict: 'pass' } } })
    expect(await git(candidate.inspection.root, 'rev-parse', 'HEAD')).toBe(candidate.headOid)
    expect(await git(candidate.inspection.root, 'status', '--porcelain')).toBe('')
    expect(f.runtime.readGit(other.agent.session)).toEqual(replacement)
  })

  it.each(['cleared', 'replaced'] as const)('does not restore an old Git grant after it is %s and verification fails', async (change) => {
    const f = await gitRuntimeFixture()
    const { agent } = await f.task()
    const other = change === 'replaced' ? await f.task() : null
    await f.runtime.authorizeLocalGit(agent, ['tracked.txt'], signal())
    const replacement = other === null ? null : await f.runtime.authorizeLocalGit(other.agent, ['tracked.txt'], signal())
    await f.role(agent, 'worker')
    const candidate = f.runtime.readGit(agent.session)?.candidate
    if (candidate == null) throw new Error('The worker must produce a candidate.')
    const entered = f.gate()
    const release = f.gate()
    let returned = false
    let intercepted = false
    f.adapter.reviewer = async () => { returned = true; return reviewReport }
    const spawn = f.ctx.subprocess.spawn.bind(f.ctx.subprocess)
    vi.spyOn(f.ctx.subprocess, 'spawn').mockImplementation((spec) => {
      const child = spawn(spec)
      if (returned && !intercepted && spec.argv.includes('--is-inside-work-tree')) {
        intercepted = true
        return { ...child, done: child.done.then(async (outcome) => {
          entered.resolve(undefined); await release.promise; return outcome
        }), terminate: () => { child.terminate() }, waitForExit: () => child.waitForExit() }
      }
      return child
    })
    const checking = f.track(f.role(agent, 'reviewer'))
    await entered.promise
    agent.session.append('review-gated/git-state', { version: 1, state: replacement })
    await writeFile(join(candidate.inspection.root, 'tracked.txt'), 'changed during verification\n')
    release.resolve(undefined)
    await checking
    expect(f.runtime.readGit(agent.session)).toEqual(replacement)
    expect(f.runtime.read(agent.session)?.task?.reviewStatus).toBe('stale')
  })

  it('does not overwrite a grant installed during authorization inspection', async () => {
    const f = await gitRuntimeFixture()
    const { agent } = await f.task()
    const other = await f.task()
    const replacement = await f.runtime.authorizeLocalGit(other.agent, ['tracked.txt'], signal())
    const entered = f.gate()
    const release = f.gate()
    const spawn = f.ctx.subprocess.spawn.bind(f.ctx.subprocess)
    let intercepted = false
    vi.spyOn(f.ctx.subprocess, 'spawn').mockImplementation((spec) => {
      const child = spawn(spec)
      if (!intercepted && spec.argv.includes('--is-inside-work-tree')) {
        intercepted = true
        return { ...child, done: child.done.then(async (outcome) => {
          entered.resolve(undefined); await release.promise; return outcome
        }), terminate: () => { child.terminate() }, waitForExit: () => child.waitForExit() }
      }
      return child
    })
    const authorization = f.track(f.runtime.authorizeLocalGit(agent, ['tracked.txt'], signal()))
    const outcome = authorization.then(() => null, (error: unknown) => error)
    await entered.promise
    // Inject a durable replacement; overlapping authorization is blocked by the public API.
    agent.session.append('review-gated/git-state', { version: 1, state: replacement })
    release.resolve(undefined)
    expect(await outcome).toMatchObject({ code: 'review-gated/refused', details: { reason: 'RG_GIT_AUTH_REQUIRED' } })
    expect(f.runtime.readGit(agent.session)).toEqual(replacement)
    expect(f.runtime.readGit(other.agent.session)).toEqual(replacement)
    expect(await git(f.root, 'status', '--porcelain')).toBe('')
  })

  it.each(['cleared', 'replaced'] as const)('does not restore a Git grant %s during source inspection', async (change) => {
    const f = await gitRuntimeFixture()
    const { agent } = await f.task()
    const other = await f.task()
    const grant = await f.runtime.authorizeLocalGit(agent, ['tracked.txt'], signal())
    const replacement = await f.runtime.authorizeLocalGit(other.agent, ['tracked.txt'], signal())
    const entered = f.gate()
    const release = f.gate()
    const spawn = f.ctx.subprocess.spawn.bind(f.ctx.subprocess)
    let intercepted = false
    vi.spyOn(f.ctx.subprocess, 'spawn').mockImplementation((spec) => {
      const child = spawn(spec)
      if (!intercepted && spec.argv.includes('--is-inside-work-tree')) {
        intercepted = true
        return { ...child, done: child.done.then(async (outcome) => {
          entered.resolve(undefined); await release.promise; return outcome
        }), terminate: () => { child.terminate() }, waitForExit: () => child.waitForExit() }
      }
      return child
    })
    const starting = f.track(f.runtime.startRole(agent, 'worker', gitHandoff, undefined, signal()))
    const outcome = starting.then(() => null, (error: unknown) => error)
    await entered.promise
    const next = change === 'cleared' ? null : replacement
    // Inject a durable state change; the public UI does not replace an active grant.
    agent.session.append('review-gated/git-state', { version: 1, state: next })
    release.resolve(undefined)
    expect(await outcome).toMatchObject({ code: 'RG_GIT_CHANGED' })
    expect(f.runtime.readGit(agent.session)).toEqual(next)
    expect(f.runtime.readGit(other.agent.session)).toEqual(replacement)
    expect(f.adapter.calls.some(call => call.model === 'worker')).toBe(false)
    expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(grant.source.headOid)
    expect(await git(f.root, 'status', '--porcelain')).toBe('')
  })

  it('does not allocate a checkout after the grant changes during preparation flush', async () => {
    const f = await gitRuntimeFixture()
    const { agent } = await f.task()
    const other = await f.task()
    const grant = await f.runtime.authorizeLocalGit(agent, ['tracked.txt'], signal())
    const replacement = await f.runtime.authorizeLocalGit(other.agent, ['tracked.txt'], signal())
    const entered = f.gate()
    const release = f.gate()
    let paused = false
    f.ctx.on('session/flush', async (session) => {
      if (session === agent.session && !paused && f.runtime.readGit(session)?.status === 'preparing') {
        paused = true
        entered.resolve(undefined)
        await release.promise
      }
    })
    const provision = vi.spyOn(f.ctx.worktrees, 'provision')
    const starting = f.track(f.runtime.startRole(agent, 'worker', gitHandoff, undefined, signal()))
    const outcome = starting.then(() => null, (error: unknown) => error)
    await entered.promise
    // Inject a durable state change; the public UI does not replace an active grant.
    agent.session.append('review-gated/git-state', { version: 1, state: replacement })
    release.resolve(undefined)
    expect(await outcome).toMatchObject({ code: 'RG_GIT_CHANGED' })
    expect(provision.mock.calls.length).toBe(0)
    expect(f.runtime.readGit(agent.session)).toEqual(replacement)
    expect(f.runtime.readGit(other.agent.session)).toEqual(replacement)
    expect(f.adapter.calls.some(call => call.model === 'worker')).toBe(false)
    expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(grant.source.headOid)
  })

  it('does not start a role after its checkout grant changes during workspace flush', async () => {
    const f = await gitRuntimeFixture()
    const { agent } = await f.task()
    const other = await f.task()
    const grant = await f.runtime.authorizeLocalGit(agent, ['tracked.txt'], signal())
    const replacement = await f.runtime.authorizeLocalGit(other.agent, ['tracked.txt'], signal())
    const entered = f.gate()
    const release = f.gate()
    let paused = false
    f.ctx.on('session/flush', async (session) => {
      if (session === agent.session && !paused && f.runtime.readGit(session)?.status === 'working') {
        paused = true
        entered.resolve(undefined)
        await release.promise
      }
    })
    const starting = f.track(f.runtime.startRole(agent, 'worker', gitHandoff, undefined, signal()))
    const outcome = starting.then(() => null, (error: unknown) => error)
    await entered.promise
    const cwd = f.runtime.readGit(agent.session)?.workspace?.root
    if (cwd === undefined) throw new Error('The worker checkout must be retained.')
    // Inject a durable state change; the public UI does not replace an active grant.
    agent.session.append('review-gated/git-state', { version: 1, state: replacement })
    release.resolve(undefined)
    expect(await outcome).toMatchObject({ code: 'RG_GIT_CHANGED' })
    expect(f.runtime.readGit(agent.session)).toEqual(replacement)
    expect(f.runtime.readGit(other.agent.session)).toEqual(replacement)
    expect(f.adapter.calls.some(call => call.model === 'worker')).toBe(false)
    expect(await git(cwd, 'rev-parse', 'HEAD')).toBe(grant.source.headOid)
    expect(await git(f.root, 'status', '--porcelain')).toBe('')
  })

  it.each(['cleared', 'replaced'] as const)('does not fail a Git grant %s during checkout allocation', async (change) => {
    const f = await gitRuntimeFixture()
    const { agent } = await f.task()
    const other = await f.task()
    const grant = await f.runtime.authorizeLocalGit(agent, ['tracked.txt'], signal())
    const replacement = await f.runtime.authorizeLocalGit(other.agent, ['tracked.txt'], signal())
    const entered = f.gate()
    const release = f.gate()
    const provision = f.ctx.worktrees.provision.bind(f.ctx.worktrees)
    let retained = ''
    vi.spyOn(f.ctx.worktrees, 'provision').mockImplementation(async (...args) => {
      const checkout = await provision(...args)
      retained = checkout.path
      entered.resolve(undefined)
      await release.promise
      return checkout
    })
    const starting = f.track(f.runtime.startRole(agent, 'worker', gitHandoff, undefined, signal()))
    const outcome = starting.then(() => null, (error: unknown) => error)
    await entered.promise
    const next = change === 'cleared' ? null : replacement
    // Inject a durable state change; the public UI does not permit replacing an active grant.
    agent.session.append('review-gated/git-state', { version: 1, state: next })
    release.resolve(undefined)
    expect(await outcome).toMatchObject({ code: 'RG_GIT_CHANGED' })
    expect(f.runtime.readGit(agent.session)).toEqual(next)
    expect(f.runtime.readGit(other.agent.session)).toEqual(replacement)
    expect(f.adapter.calls.some(call => call.model === 'worker')).toBe(false)
    expect(await git(retained, 'rev-parse', 'HEAD')).toBe(grant.source.headOid)
    expect(await git(f.root, 'status', '--porcelain')).toBe('')
  })

  it('does not commit after the grant changes during finalization flush', async () => {
    const f = await gitRuntimeFixture()
    const { agent } = await f.task()
    const other = await f.task()
    const grant = await f.runtime.authorizeLocalGit(agent, ['tracked.txt'], signal())
    const replacement = await f.runtime.authorizeLocalGit(other.agent, ['tracked.txt'], signal())
    const entered = f.gate()
    const release = f.gate()
    let paused = false
    f.ctx.on('session/flush', async (session) => {
      if (session === agent.session && !paused && f.runtime.readGit(session)?.status === 'finalizing') {
        paused = true
        entered.resolve(undefined)
        await release.promise
      }
    })
    const spawn = vi.spyOn(f.ctx.subprocess, 'spawn')
    const working = f.track(f.role(agent, 'worker'))
    await entered.promise
    const cwd = f.runtime.readGit(agent.session)?.workspace?.root
    if (cwd === undefined) throw new Error('The worker checkout must exist before finalization.')
    // Inject a durable state change; the public UI does not replace an active grant.
    agent.session.append('review-gated/git-state', { version: 1, state: replacement })
    release.resolve(undefined)
    await working
    expect(spawn.mock.calls.some(([spec]) => spec.argv.includes('commit'))).toBe(false)
    expect(f.runtime.readGit(agent.session)).toEqual(replacement)
    expect(f.runtime.readGit(other.agent.session)).toEqual(replacement)
    expect(f.runtime.read(agent.session)?.task?.lastWorker).toMatchObject({ status: 'failed',
      diagnostic: 'The local Git grant changed before finalization.' })
    expect(await git(cwd, 'rev-parse', 'HEAD')).toBe(grant.source.headOid)
    expect(await git(f.root, 'status', '--porcelain')).toBe('')
  })

  it.each(['cleared', 'replaced'] as const)('does not publish into a Git grant %s while a commit is in flight', async (change) => {
    const f = await gitRuntimeFixture()
    const { agent } = await f.task()
    const other = await f.task()
    const grant = await f.runtime.authorizeLocalGit(agent, ['tracked.txt'], signal())
    const replacement = await f.runtime.authorizeLocalGit(other.agent, ['tracked.txt'], signal())
    const entered = f.gate()
    const release = f.gate()
    const spawn = f.ctx.subprocess.spawn.bind(f.ctx.subprocess)
    let intercepted = false
    vi.spyOn(f.ctx.subprocess, 'spawn').mockImplementation((spec) => {
      const child = spawn(spec)
      if (!intercepted && spec.argv.includes('commit')) {
        intercepted = true
        return { ...child, done: child.done.then(async (outcome) => {
          entered.resolve(undefined); await release.promise; return outcome
        }), terminate: () => { child.terminate() }, waitForExit: () => child.waitForExit() }
      }
      return child
    })
    const working = f.track(f.role(agent, 'worker'))
    await entered.promise
    const current = f.runtime.readGit(agent.session)
    const cwd = current?.workspace?.root
    if (cwd === undefined) throw new Error('The committed worker checkout must be retained.')
    const committedHead = await git(cwd, 'rev-parse', 'HEAD')
    expect(committedHead).not.toBe(grant.source.headOid)
    const next = change === 'cleared' ? null : replacement
    // Inject a durable state change; the public UI does not replace an active grant.
    agent.session.append('review-gated/git-state', { version: 1, state: next })
    release.resolve(undefined)
    await working
    expect(f.runtime.readGit(agent.session)).toEqual(next)
    expect(f.runtime.readGit(other.agent.session)).toEqual(replacement)
    expect(f.runtime.read(agent.session)?.task?.lastWorker).toMatchObject({ status: 'failed',
      diagnostic: `The Git grant changed after commit ${committedHead} was verified in ${cwd}. Inspect the retained checkout; no rollback was performed.` })
    expect(await git(cwd, 'rev-parse', 'HEAD')).toBe(committedHead)
    expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(grant.source.headOid)
  })

  it.each(['cleared', 'replaced'] as const)('does not report success when the Git grant is %s during candidate flush', async (change) => {
    const f = await gitRuntimeFixture()
    const { agent } = await f.task()
    const other = await f.task()
    const grant = await f.runtime.authorizeLocalGit(agent, ['tracked.txt'], signal())
    const replacement = await f.runtime.authorizeLocalGit(other.agent, ['tracked.txt'], signal())
    const entered = f.gate()
    const release = f.gate()
    let paused = false
    f.ctx.on('session/flush', async (session) => {
      if (session === agent.session && !paused && f.runtime.readGit(session)?.status === 'candidate') {
        paused = true
        entered.resolve(undefined)
        await release.promise
      }
    })
    const working = f.track(f.role(agent, 'worker'))
    await entered.promise
    const candidate = f.runtime.readGit(agent.session)?.candidate
    if (candidate == null) throw new Error('A real candidate must have been committed before publication.')
    const next = change === 'cleared' ? null : replacement
    // Inject a durable state change; the public UI does not replace an active grant.
    agent.session.append('review-gated/git-state', { version: 1, state: next })
    release.resolve(undefined)
    await working
    expect(f.runtime.readGit(agent.session)).toEqual(next)
    expect(f.runtime.readGit(other.agent.session)).toEqual(replacement)
    expect(f.runtime.read(agent.session)?.task?.lastWorker).toMatchObject({ status: 'failed',
      diagnostic: `The Git grant changed after commit ${candidate.headOid} was verified in ${candidate.inspection.root}. Inspect the retained checkout; no rollback was performed.` })
    expect(await git(candidate.inspection.root, 'rev-parse', 'HEAD')).toBe(candidate.headOid)
    expect(candidate.headOid).not.toBe(grant.source.headOid)
    expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(grant.source.headOid)
  })

  it('does not mark a replacement grant unknown after a committed candidate fails to flush', async () => {
    const f = await gitRuntimeFixture()
    const { agent } = await f.task()
    const other = await f.task()
    const grant = await f.runtime.authorizeLocalGit(agent, ['tracked.txt'], signal())
    const replacement = await f.runtime.authorizeLocalGit(other.agent, ['tracked.txt'], signal())
    const entered = f.gate()
    const release = f.gate()
    let failing = false
    f.ctx.on('session/flush', async (session) => {
      if (session === agent.session && !failing && f.runtime.readGit(session)?.status === 'candidate') {
        failing = true
        entered.resolve(undefined)
        await release.promise
        throw new Error('candidate publication acknowledgement failed')
      }
    })
    const working = f.track(f.role(agent, 'worker'))
    await entered.promise
    const candidate = f.runtime.readGit(agent.session)?.candidate
    if (candidate == null) throw new Error('A real candidate must have been committed before publication.')
    // Simulate a durable replacement, not an ordinary UI action during an active role.
    agent.session.append('review-gated/git-state', { version: 1, state: replacement })
    release.resolve(undefined)
    await working
    expect(f.runtime.readGit(agent.session)).toEqual(replacement)
    expect(f.runtime.readGit(other.agent.session)).toEqual(replacement)
    expect(f.runtime.read(agent.session)?.task?.lastWorker?.status).toBe('failed')
    expect(await git(candidate.inspection.root, 'rev-parse', 'HEAD')).toBe(candidate.headOid)
    expect(candidate.headOid).not.toBe(grant.source.headOid)
    expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(grant.source.headOid)
  })

  it('does not treat a revoked Git worker as a workspace-mode success', async () => {
    const f = await gitRuntimeFixture()
    const { agent } = await f.task()
    const grant = await f.runtime.authorizeLocalGit(agent, ['tracked.txt'], signal())
    const entered = f.gate()
    const release = f.gate()
    let cwd = ''
    f.adapter.worker = async (worker, request) => {
      cwd = f.ctx.workingDirectory.get(worker.session)
      await f.write(worker, 'tracked.txt', 'uncommitted work after revocation\n', request.signal)
      entered.resolve(undefined)
      await release.promise
      return workerReport
    }
    const working = f.track(f.role(agent, 'worker'))
    await entered.promise
    // Inject a durable state change; the public UI does not revoke an active grant.
    agent.session.append('review-gated/git-state', { version: 1, state: null })
    release.resolve(undefined)
    await working
    expect(f.runtime.readGit(agent.session)).toBeNull()
    expect(f.runtime.read(agent.session)?.task?.lastWorker).toMatchObject({ status: 'failed', report: null })
    expect(await git(cwd, 'rev-parse', 'HEAD')).toBe(grant.source.headOid)
    expect(await git(cwd, 'status', '--porcelain')).toContain('tracked.txt')
    expect(await git(f.root, 'status', '--porcelain')).toBe('')
  })

  it('does not treat a workspace worker as a Git delivery after a grant is installed', async () => {
    const f = await gitRuntimeFixture()
    const { agent } = await f.task()
    const other = await f.task()
    const replacement = await f.runtime.authorizeLocalGit(other.agent, ['tracked.txt'], signal())
    const entered = f.gate()
    const release = f.gate()
    const sourceHead = await git(f.root, 'rev-parse', 'HEAD')
    const index = await readFile(join(f.root, '.git', 'index'))
    let cwd = ''
    f.adapter.worker = async (worker, request) => {
      cwd = f.ctx.workingDirectory.get(worker.session)
      await f.write(worker, 'tracked.txt', 'workspace work retained\n', request.signal)
      entered.resolve(undefined)
      await release.promise
      return workerReport
    }
    const spawn = vi.spyOn(f.ctx.subprocess, 'spawn')
    const working = f.track(f.role(agent, 'worker'))
    await entered.promise
    expect(cwd).toBe(f.root)
    expect(f.runtime.readGit(agent.session)).toBeNull()
    // Inject a durable state change; the public UI does not grant Git during an active role.
    agent.session.append('review-gated/git-state', { version: 1, state: replacement })
    release.resolve(undefined)
    await working
    expect(f.runtime.readGit(agent.session)).toEqual(replacement)
    expect(f.runtime.readGit(other.agent.session)).toEqual(replacement)
    expect(f.runtime.read(agent.session)?.task?.lastWorker).toMatchObject({ status: 'failed', report: null,
      diagnostic: 'The delivery mode changed while the role was running. Inspect the Session before continuing.' })
    expect(spawn.mock.calls.some(([spec]) => spec.argv.includes('commit'))).toBe(false)
    expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(sourceHead)
    expect(await readFile(join(f.root, '.git', 'index'))).toEqual(index)
    expect(await readFile(join(f.root, 'tracked.txt'), 'utf8')).toBe('workspace work retained\n')
  })

  it('does not confirm a workspace result after a Git grant is installed during preparation flush', async () => {
    const f = await gitRuntimeFixture()
    const { agent } = await f.task()
    const other = await f.task()
    const replacement = await f.runtime.authorizeLocalGit(other.agent, ['tracked.txt'], signal())
    const sourceHead = await git(f.root, 'rev-parse', 'HEAD')
    const entered = f.gate()
    const release = f.gate()
    let paused = false
    f.ctx.on('session/flush', async (session) => {
      if (session === agent.session && !paused && f.runtime.read(session)?.task?.active?.status === 'saving') {
        paused = true
        entered.resolve(undefined)
        await release.promise
      }
    })
    const failed = f.until(agent, state => state?.diagnostic?.startsWith('RG_RESULT_SAVE_FAILED') === true)
    await f.runtime.startRole(agent, 'worker', gitHandoff, undefined, signal())
    await entered.promise
    expect(agent.session.snapshotEvents().some(event => event.type === 'review-gated/result-prepared')).toBe(true)
    expect(agent.session.snapshotEvents().some(event => event.type === 'review-gated/result-confirmed')).toBe(false)
    // Inject a durable state change; the public UI does not grant Git during an active role.
    agent.session.append('review-gated/git-state', { version: 1, state: replacement })
    release.resolve(undefined)
    await failed
    expect(f.runtime.readGit(agent.session)).toEqual(replacement)
    expect(f.runtime.readGit(other.agent.session)).toEqual(replacement)
    expect(f.runtime.read(agent.session)?.diagnostic).toContain('RG_RESULT_SAVE_FAILED')
    expect(f.runtime.read(agent.session)?.task).toMatchObject({ active: null, lastWorker: null })
    expect(agent.session.snapshotEvents().some(event => event.type === 'review-gated/result-confirmed')).toBe(false)
    expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(sourceHead)
    expect(await readFile(join(f.root, 'tracked.txt'), 'utf8')).toBe('worker delivery\n')
  })

  it('does not settle an old worker into a replacement task reservation', async () => {
    const f = await gitRuntimeFixture()
    const handle = await f.task()
    const { agent } = handle
    const other = await f.task()
    await f.runtime.authorizeLocalGit(agent, ['tracked.txt'], signal())
    const firstEntered = f.gate()
    const secondEntered = f.gate()
    const firstRelease = f.gate()
    const secondRelease = f.gate()
    let calls = 0
    f.adapter.worker = async () => {
      if (++calls === 1) { firstEntered.resolve(undefined); await firstRelease.promise }
      else { secondEntered.resolve(undefined); await secondRelease.promise }
      return workerReport
    }
    await f.runtime.startRole(agent, 'worker', gitHandoff, undefined, signal())
    await firstEntered.promise
    await f.runtime.startRole(other.agent, 'worker', gitHandoff, undefined, signal())
    await secondEntered.promise
    const replacement = f.runtime.read(other.agent.session)
    if (replacement?.task?.active == null) throw new Error('The second task must hold a real active reservation.')
    const settled = f.gate()
    const cancel = vi.spyOn(agent, 'cancel')
    f.ctx.logger.exporter({ export: (message) => {
      if (message.args[0] === 'RG role result could not be durably settled: %s') settled.resolve(undefined)
    } })
    agent.session.append('review-gated/state', { version: 1, state: replacement })
    firstRelease.resolve(undefined)
    await settled.promise
    expect(cancel).not.toHaveBeenCalled()
    await handle.dispose()
    expect(f.runtime.read(agent.session)?.task).toEqual(replacement.task)
    secondRelease.resolve(undefined)
  })

  it('does not write cleanup failures into a replacement reservation during startup', async () => {
    const f = await gitRuntimeFixture()
    const { agent } = await f.task()
    const other = await f.task()
    await f.runtime.authorizeLocalGit(agent, ['tracked.txt'], signal())
    const otherEntered = f.gate()
    const otherRelease = f.gate()
    f.adapter.worker = async () => { otherEntered.resolve(undefined); await otherRelease.promise; return workerReport }
    await f.runtime.startRole(other.agent, 'worker', gitHandoff, undefined, signal())
    await otherEntered.promise
    const replacement = f.runtime.read(other.agent.session)
    if (replacement?.task?.active == null) throw new Error('The second task must hold a real active reservation.')
    const entered = f.gate()
    const release = f.gate()
    let failing = false
    f.ctx.on('session/flush', async (session) => {
      if (session !== agent.session) return
      if (!failing && f.runtime.readGit(session)?.status === 'preparing') {
        failing = true
        entered.resolve(undefined)
        await release.promise
      }
      if (failing) throw new Error('Git startup and cleanup flush failed')
    })
    const starting = f.track(f.runtime.startRole(agent, 'worker', gitHandoff, undefined, signal()))
    const outcome = starting.then(() => null, (error: unknown) => error)
    await entered.promise
    agent.session.append('review-gated/state', { version: 1, state: replacement })
    release.resolve(undefined)
    expect(await outcome).toMatchObject({ code: 'RG_GIT_UNKNOWN' })
    expect(f.runtime.read(agent.session)).toEqual(replacement)
    expect(f.runtime.read(other.agent.session)).toEqual(replacement)
    otherRelease.resolve(undefined)
  })

  it('retains an interrupted worker checkout and refuses further work until explicitly left', async () => {
    const f = await gitRuntimeFixture()
    const { agent } = await f.task()
    const grant = await f.runtime.authorizeLocalGit(agent, ['tracked.txt'], signal())
    f.adapter.worker = async (worker, request) => {
      await f.write(worker, 'tracked.txt', 'unfinished work\n', request.signal)
      return { ...workerReport, outcome: 'blocked', summary: 'Human input required', unverified: ['Acceptance'] }
    }
    await f.role(agent, 'worker')
    const interrupted = f.runtime.readGit(agent.session)
    expect(interrupted).toMatchObject({ status: 'interrupted', candidate: null, binding: null })
    const cwd = interrupted?.workspace?.root
    if (cwd === undefined) throw new Error('The partial checkout must remain available.')
    expect(await git(cwd, 'rev-parse', 'HEAD')).toBe(grant.source.headOid)
    expect(await readFile(join(cwd, 'tracked.txt'), 'utf8')).toBe('unfinished work\n')
    await expect(f.runtime.startRole(agent, 'worker', gitHandoff, undefined, signal())).rejects.toMatchObject({ code: 'RG_GIT_UNKNOWN' })
    await expect(f.runtime.newTask(agent, 'Do not abandon partial work')).rejects.toMatchObject({
      code: 'review-gated/refused', details: { reason: 'RG_GIT_UNKNOWN' },
    })
    expect(f.runtime.readGit(agent.session)).toEqual(interrupted)
    expect(f.runtime.read(agent.session)?.task).toMatchObject({ workerAttempts: 1, active: null })
    await f.runtime.leaveLocalGit(agent)
    expect(f.runtime.readGit(agent.session)).toBeNull()
    expect(await readFile(join(cwd, 'tracked.txt'), 'utf8')).toBe('unfinished work\n')
    expect(await git(f.root, 'status', '--porcelain')).toBe('')
  })
})
