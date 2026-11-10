import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'
import WorktreeService, { WorktreeProcessUnknownError } from '../src/index.ts'
import { runCommand } from '../src/process.ts'
import { contents, git, harness, loaderHarness, repository, testAgent } from './harness.ts'

let context: Context | undefined
let root: string | undefined
const config = { timeoutMs: 60_000, graceMs: 1_000, maxOutputBytes: 1_024 }

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function boot() {
  root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-worktree-process-')))
  context = await harness(root)
  return { ctx: context, root, policy: context.sandboxPolicy.resolve({ session: testAgent(context, root).session }) }
}

/** Complete public provider handle; no real process is allocated by this fixture. */
function childFixture(done: Promise<SubprocessOutcome> = Promise.resolve({ exitCode: 0, signal: null })) {
  const terminate = vi.fn<SubprocessHandle['terminate']>()
  const waitForExit = vi.fn<SubprocessHandle['waitForExit']>(async () => true)
  const child: SubprocessHandle = {
    stdin: undefined, stdout: undefined, stderr: undefined, control: undefined,
    collected: {
      stdout: { readFrom: () => ({ text: 'fixture stdout\n', nextOffset: 15, lossy: false }) },
      stderr: { readFrom: () => ({ text: 'fixture failure\n', nextOffset: 16, lossy: false }) },
    },
    done, terminate, waitForExit,
  }
  return { child, terminate, waitForExit }
}

function unconfirmedChild(child: SubprocessHandle): SubprocessHandle {
  return { stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, control: child.control, collected: child.collected,
    done: child.done, terminate: () => { child.terminate() }, waitForExit: async () => { await child.waitForExit(); return false } }
}

describe('worktree managed-range completion', () => {
  it('still waits for the managed range after termination throws and reports a structured unknown result', async () => {
    const { ctx, root, policy } = await boot()
    const fixture = childFixture()
    const terminationFailure = new Error('termination procedure failed')
    fixture.terminate.mockImplementationOnce(() => { throw terminationFailure })
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<boolean>()
    fixture.waitForExit.mockImplementationOnce(async () => { entered.resolve(undefined); return await release.promise })
    vi.spyOn(ctx.subprocess, 'spawn').mockReturnValueOnce(fixture.child)
    const operation = runCommand(ctx, config, policy, root, [process.execPath], new AbortController().signal)
    const settled = operation.then(() => 'settled', () => 'settled')
    try {
      expect(await Promise.race([entered.promise.then(() => 'waiting'), settled])).toBe('waiting')
      expect(fixture.terminate).toHaveBeenCalledOnce()
      expect(fixture.waitForExit).toHaveBeenCalledWith()
      release.resolve(true)
      await expect(operation).rejects.toMatchObject({ name: 'WorktreeProcessUnknownError', code: 'WORKTREE_PROCESS_UNKNOWN', cwd: root, cause: terminationFailure })
      await expect(operation).rejects.toBeInstanceOf(WorktreeProcessUnknownError)
    } finally {
      release.resolve(true)
      await settled
    }
  })

  it.each(['success', 'failure', 'cancel'] as const)('joins a confirmed range before preserving ordinary command %s', async (kind) => {
    const { ctx, root, policy } = await boot()
    const controller = new AbortController()
    const reason = new Error('caller cancelled')
    const fixture = childFixture(Promise.resolve({ exitCode: kind === 'failure' ? 3 : 0, signal: null }))
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<boolean>()
    fixture.waitForExit.mockImplementationOnce(async () => { entered.resolve(undefined); return await release.promise })
    vi.spyOn(ctx.subprocess, 'spawn').mockImplementationOnce(() => {
      if (kind === 'cancel') controller.abort(reason)
      return fixture.child
    })
    const operation = runCommand(ctx, config, policy, root, [process.execPath], controller.signal)
    const settled = operation.then(() => 'settled', () => 'settled')
    try {
      expect(await Promise.race([entered.promise.then(() => 'waiting'), settled])).toBe('waiting')
      expect(fixture.terminate).toHaveBeenCalledOnce()
      expect(fixture.waitForExit).toHaveBeenCalledWith()
      release.resolve(true)
      if (kind === 'success') await expect(operation).resolves.toEqual({ stdout: 'fixture stdout\n', exitCode: 0 })
      else if (kind === 'cancel') await expect(operation).rejects.toBe(reason)
      else await expect(operation).rejects.toThrow('worktree command failed (3): fixture failure')
    } finally {
      release.resolve(true)
      await settled
    }
  })

  it.each(['success', 'failure', 'cancel'] as const)('does not treat a false range observation as command %s', async (kind) => {
    const { ctx, root, policy } = await boot()
    const controller = new AbortController()
    const fixture = childFixture(Promise.resolve({ exitCode: kind === 'failure' ? 3 : 0, signal: null }))
    fixture.waitForExit.mockResolvedValueOnce(false)
    vi.spyOn(ctx.subprocess, 'spawn').mockImplementationOnce(() => {
      if (kind === 'cancel') controller.abort(new Error('caller cancelled'))
      return fixture.child
    })
    const operation = runCommand(ctx, config, policy, root, [process.execPath], controller.signal)
    await expect(operation).rejects.toBeInstanceOf(WorktreeProcessUnknownError)
    await expect(operation).rejects.toMatchObject({ code: 'WORKTREE_PROCESS_UNKNOWN', cwd: root,
      cause: { message: 'The subprocess provider did not confirm an empty managed range.' } })
    expect(fixture.terminate).toHaveBeenCalledOnce()
    expect(fixture.waitForExit).toHaveBeenCalledExactlyOnceWith()
  })

  it('reports observation failure as unknown and preserves the provider cause', async () => {
    const { ctx, root, policy } = await boot()
    const fixture = childFixture()
    const observationFailure = new Error('managed range is no longer observable')
    fixture.waitForExit.mockRejectedValueOnce(observationFailure)
    vi.spyOn(ctx.subprocess, 'spawn').mockReturnValueOnce(fixture.child)
    await expect(runCommand(ctx, config, policy, root, [process.execPath], new AbortController().signal))
      .rejects.toMatchObject({ code: 'WORKTREE_PROCESS_UNKNOWN', cause: observationFailure })
    expect(fixture.terminate).toHaveBeenCalledOnce()
    expect(fixture.waitForExit).toHaveBeenCalledExactlyOnceWith()
  })

  it('drains a rejected provider outcome before propagating its original failure', async () => {
    const { ctx, root, policy } = await boot()
    const done = Promise.withResolvers<SubprocessOutcome>()
    const fixture = childFixture(done.promise)
    const failure = new Error('provider failed after launch')
    vi.spyOn(ctx.subprocess, 'spawn').mockImplementationOnce(() => { done.reject(failure); return fixture.child })
    await expect(runCommand(ctx, config, policy, root, [process.execPath], new AbortController().signal)).rejects.toBe(failure)
    expect(fixture.terminate).toHaveBeenCalledOnce()
    expect(fixture.waitForExit).toHaveBeenCalledExactlyOnceWith()
  })
})

describe('unknown checkout outcomes through real Loader composition', () => {
  it.each(['create', 'provision', 'restore'] as const)('retains %s artifacts and the structured process cause without publishing cwd', async (operation) => {
    root = await repository()
    context = await loaderHarness(root)
    const ctx = context
    const agent = testAgent(ctx, root)
    const recorded = operation === 'restore' ? await ctx.worktrees.provision(agent, { name: 'retained' }) : null
    if (recorded !== null) await rm(recorded.path, { recursive: true, force: true })
    const spawn = ctx.subprocess.spawn.bind(ctx.subprocess)
    const probe = vi.spyOn(ctx.subprocess, 'spawn').mockImplementation((spec) => {
      const child = spawn(spec)
      return spec.argv.includes('reset') ? unconfirmedChild(child) : child
    })
    try {
      const pending = operation === 'restore'
        ? ctx.worktrees.restore(agent, { path: recorded!.path, branch: 'retained', baseCommit: recorded!.baseCommit, repositoryRoot: root })
        : ctx.worktrees[operation](agent, { name: 'retained' })
      const error = await pending.then(() => { throw new Error('an unconfirmed process must not succeed') }, (cause: unknown) => cause)
      expect(error).toBeInstanceOf(Error)
      if (!(error instanceof Error)) throw new Error('worktree failure must preserve its Error cause')
      expect(error.cause).toBeInstanceOf(WorktreeProcessUnknownError)
      if (!(error.cause instanceof WorktreeProcessUnknownError)) throw new Error('structured process cause required')
      expect(error.cause.code).toBe('WORKTREE_PROCESS_UNKNOWN')
      const path = join(root, '.agents/worktrees/retained')
      expect(error.message).toContain(path)
      expect(error.message).toContain('Any created checkout and branch are retained')
      expect(await contents(join(path, 'tracked.txt'))).toBe('initial\n')
      expect(await git(path, 'branch', '--show-current')).toBe('retained')
      expect(await git(root, 'branch', '--show-current')).toBe('main')
      expect(ctx.workingDirectory.get(agent.session)).toBe(root)
    } finally { probe.mockRestore() }
  })
})


it.each(['service', 'parent'] as const)('holds %s disposal until failing process cleanup has settled', async (owner) => {
  const { ctx, root } = await boot()
  const [fiber] = [...ctx.registry.get(WorktreeService)!.fibers]
  const fixture = childFixture()
  const failure = new Error('termination failed during service cleanup')
  fixture.terminate.mockImplementationOnce(() => { throw failure })
  const entered = Promise.withResolvers<undefined>()
  const aborted = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<boolean>()
  fixture.waitForExit.mockImplementationOnce(async () => { entered.resolve(undefined); return await release.promise })
  vi.spyOn(ctx.subprocess, 'spawn').mockImplementationOnce((spec) => {
    if (spec.signal === undefined) throw new Error('worktree spawn must carry operation cancellation')
    spec.signal.addEventListener('abort', () => { aborted.resolve(undefined) }, { once: true })
    return fixture.child
  })
  const operation = ctx.worktrees.provision(testAgent(ctx, root), { name: 'disposing' })
  const rejected = expect(operation).rejects.toMatchObject({ code: 'WORKTREE_PROCESS_UNKNOWN', cause: failure })
  let disposing: Promise<void> | undefined
  try {
    await entered.promise
    let disposed = false
    disposing = (owner === 'service' ? fiber!.dispose() : ctx.fiber.dispose()).then(() => { disposed = true })
    expect(await Promise.race([aborted.promise.then(() => 'aborted'), disposing.then(() => 'disposed')])).toBe('aborted')
    expect(disposed).toBe(false)
    expect(fixture.waitForExit).toHaveBeenCalledExactlyOnceWith()
    release.resolve(true)
    await rejected
    await disposing
    expect(disposed).toBe(true)
    expect(ctx.get('worktrees')).toBeUndefined()
  } finally {
    release.resolve(true)
    await Promise.allSettled([operation, rejected, disposing])
  }
})
