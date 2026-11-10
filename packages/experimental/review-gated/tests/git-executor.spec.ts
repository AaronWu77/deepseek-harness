/** Actual public filesystem/subprocess services over private scratch repositories. */
import { chmod, mkdir, readFile, symlink, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { FsError } from '@deepseek-ai/dsh-fs'
import { GitExecutor, GitExecutorError, type GitExecutorConfig } from '../src/git-executor.ts'
import { git, harness, repository, testAgent } from '../../worktree/tests/harness.ts'

const config: GitExecutorConfig = { gitCommand: 'git', timeoutMs: 30_000, graceMs: 1_000, maxOutputBytes: 1_000_000 }
const limits = { maxScopeFiles: 100, maxScopeBytes: 100_000 }
const signal = () => new AbortController().signal

async function setup(linked = true, detached = false) {
  const root = await repository()
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const ctx = await harness(root)
  onTestFinished(() => ctx.fiber.dispose())
  const agent = testAgent(ctx, root)
  const executor = new GitExecutor(ctx, config)
  const source = await executor.inspect(agent, root, signal())
  let cwd = root
  if (linked) {
    const result = await ctx.worktrees.provision(agent, { name: 'candidate', detached })
    cwd = result.path
  }
  const worktree = await executor.inspect(agent, cwd, signal())
  const finalize = (scope: readonly string[] = ['.'], message = 'Deliver scoped change', expected = worktree.headOid) =>
    executor.finalize(agent, worktree, source.headOid, expected, scope, message, limits, signal())
  return { root, ctx, agent, executor, source, worktree, cwd, finalize }
}

async function rejection(work: Promise<unknown>, code: string, effect = 'none') {
  await expect(work).rejects.toBeInstanceOf(GitExecutorError)
  await expect(work).rejects.toMatchObject({ code, effect })
}

// Each case pays for dozens of real managed Git processes and their Windows range inspection.
describe('local Git executor', { timeout: 120_000 }, () => {
  it('captures a clean source and reports typed no-changes without a commit', async () => {
    const f = await setup()
    expect(await f.executor.capture(f.agent, f.cwd, f.source.headOid, f.source.headOid, ['.'], limits, signal()))
      .toMatchObject({ manifest: [], headOid: f.source.headOid })
    await rejection(f.finalize(), 'RG_GIT_NO_CHANGES')
    expect(await git(f.cwd, 'rev-parse', 'HEAD')).toBe(f.source.headOid)
    await rejection(f.executor.finalize(f.agent, f.source, f.source.headOid, f.source.headOid, ['.'], 'no', limits, signal()), 'RG_GIT_UNSUPPORTED')
  })

  it('commits actual scoped tracked and untracked paths while preserving the dirty source and its index', async () => {
    const f = await setup()
    await writeFile(join(f.root, 'tracked.txt'), 'staged source\n')
    await git(f.root, 'add', 'tracked.txt')
    await writeFile(join(f.root, 'tracked.txt'), 'unstaged source\n')
    await writeFile(join(f.root, 'source-only.txt'), 'source-only\n')
    const sourceStatus = await git(f.root, 'status', '--porcelain')
    await rejection(f.executor.capture(f.agent, f.root, f.source.headOid, undefined, ['.'], limits, signal()), 'RG_GIT_SCOPE')
    await writeFile(join(f.cwd, 'tracked.txt'), 'delivered\n')
    await writeFile(join(f.cwd, 'literal[1].txt'), 'new\n')
    const candidate = await f.finalize(['tracked.txt', 'literal[1].txt'], 'message with --no-verify and $(not a shell)')
    expect(candidate.headOid).not.toBe(f.source.headOid)
    expect(candidate.treeOid).toBe(await git(f.cwd, 'rev-parse', 'HEAD^{tree}'))
    expect(candidate.manifest.map(entry => entry.path)).toEqual(['literal[1].txt', 'tracked.txt'])
    expect(await f.executor.verifyCandidate(f.agent, candidate, limits, signal())).toEqual(candidate)
    expect(await git(f.root, 'status', '--porcelain')).toBe(sourceStatus)
    expect(await git(f.root, 'show', ':tracked.txt')).toBe('staged source')
    expect(await readFile(join(f.root, 'tracked.txt'), 'utf8')).toBe('unstaged source\n')
    await writeFile(join(f.cwd, 'tracked.txt'), 'after review\n')
    await rejection(f.executor.verifyCandidate(f.agent, candidate, limits, signal()), 'RG_GIT_CHANGED')
  })

  it('supports detached task worktrees and deletion manifests', async () => {
    const f = await setup(true, true)
    await rm(join(f.cwd, 'tracked.txt'))
    const candidate = await f.finalize(['tracked.txt'])
    expect(candidate.inspection.branch).toBeNull()
    expect(candidate.manifest).toEqual([{ path: 'tracked.txt', kind: 'delete', content: null, bytes: 0, mode: '000000' }])
  })

  it('accepts an already committed descendant without an empty follow-up commit', async () => {
    const f = await setup()
    await writeFile(join(f.cwd, 'tracked.txt'), 'committed by worker\n')
    await git(f.cwd, 'commit', '-am', 'worker commit')
    const expected = await git(f.cwd, 'rev-parse', 'HEAD')
    const result = await f.finalize(['tracked.txt'], 'no empty follow-up', expected)
    expect(result.headOid).toBe(expected)
  })

  it('refuses scope escapes, pathspec magic, prefix siblings, metadata, empty scope, and preexisting staged changes', async () => {
    const f = await setup()
    await writeFile(join(f.cwd, 'outside.txt'), 'outside\n')
    await rejection(f.finalize(['tracked.txt']), 'RG_GIT_SCOPE')
    for (const scope of [[':(glob)**'], ['../tracked.txt'], ['.git/HEAD'], [''], []]) {
      await rejection(f.executor.capture(f.agent, f.cwd, f.source.headOid, undefined, scope, limits, signal()), 'RG_GIT_SCOPE')
    }
    await mkdir(join(f.cwd, 'prefix-sibling'))
    await writeFile(join(f.cwd, 'prefix-sibling/file.txt'), 'outside\n')
    await rejection(f.finalize(['prefix', 'outside.txt']), 'RG_GIT_SCOPE')
    await git(f.cwd, 'add', 'outside.txt')
    await rejection(f.finalize(), 'RG_GIT_STAGED')
    expect(await git(f.cwd, 'show', ':outside.txt')).toBe('outside')
  })

  it('rejects mismatched canonical metadata, expected HEAD, and branch movement', async () => {
    const f = await setup()
    await writeFile(join(f.cwd, 'tracked.txt'), 'work\n')
    await rejection(f.executor.finalize(f.agent, { ...f.worktree, commonDir: f.root }, f.source.headOid, f.source.headOid, ['.'], 'no', limits, signal()), 'RG_GIT_CHANGED')
    await rejection(f.finalize(['.'], 'no', '0'.repeat(40)), 'RG_GIT_CHANGED')
    await git(f.cwd, 'checkout', '-b', 'external-branch')
    await rejection(f.finalize(), 'RG_GIT_CHANGED')
  })

  it('rejects non-descendant HEAD and unsupported index flags', async () => {
    const f = await setup()
    await git(f.cwd, 'checkout', '--orphan', 'unrelated')
    await git(f.cwd, 'commit', '-am', 'unrelated root')
    const next = await f.executor.inspect(f.agent, f.cwd, signal())
    await rejection(f.executor.capture(f.agent, f.cwd, f.source.headOid, next.headOid, ['.'], limits, signal()), 'RG_GIT_CHANGED')
    await git(f.cwd, 'update-index', '--assume-unchanged', 'tracked.txt')
    await rejection(f.executor.capture(f.agent, f.cwd, next.headOid, next.headOid, ['.'], limits, signal()), 'RG_GIT_UNSUPPORTED')
  })

  it('enforces exact complete file and byte limits and rejects binary data', async () => {
    const f = await setup()
    await writeFile(join(f.cwd, 'tracked.txt'), '界')
    const capture = () => f.executor.capture(f.agent, f.cwd, f.source.headOid, undefined, ['.'], { maxScopeFiles: 1, maxScopeBytes: 3 }, signal())
    expect((await capture()).manifest[0]?.bytes).toBe(3)
    await rejection(f.executor.capture(f.agent, f.cwd, f.source.headOid, undefined, ['.'], { maxScopeFiles: 0, maxScopeBytes: 3 }, signal()), 'RG_GIT_LIMIT')
    await rejection(f.executor.capture(f.agent, f.cwd, f.source.headOid, undefined, ['.'], { maxScopeFiles: 1, maxScopeBytes: 2 }, signal()), 'RG_GIT_LIMIT')
    await writeFile(join(f.cwd, 'tracked.txt'), Buffer.from([1, 0, 2]))
    await rejection(capture(), 'RG_GIT_UNSUPPORTED')
    await writeFile(join(f.cwd, 'tracked.txt'), Buffer.from([0xff]))
    await rejection(capture(), 'RG_GIT_UNSUPPORTED')
    const bounded = new GitExecutor(f.ctx, { ...config, maxOutputBytes: 1 })
    await rejection(bounded.inspect(f.agent, f.cwd, signal()), 'RG_GIT_LIMIT')
  })

  it('preserves normal hook refusal and detects hooks replacing staged contents after a real commit', async () => {
    const f = await setup()
    const hooks = join(f.source.commonDir, 'hooks')
    await writeFile(join(f.cwd, 'tracked.txt'), 'delivery\n')
    await writeFile(join(hooks, 'pre-commit'), '#!/bin/sh\nexit 1\n')
    await chmod(join(hooks, 'pre-commit'), 0o755)
    await rejection(f.finalize(), 'RG_GIT_UNKNOWN', 'unknown')
    expect(await git(f.cwd, 'rev-parse', 'HEAD')).toBe(f.source.headOid)
    expect(await git(f.cwd, 'diff', '--cached', '--name-only')).toBe('tracked.txt')
    // The fixture, not the executor, explicitly clears the retained staged change.
    await git(f.cwd, 'reset', 'HEAD', '--', 'tracked.txt')
    await writeFile(join(hooks, 'pre-commit'), '#!/bin/sh\nprintf "hook changed\\n" > tracked.txt\ngit add -- tracked.txt\n')
    await rejection(f.finalize(), 'RG_GIT_UNKNOWN', 'unknown')
    expect(await git(f.cwd, 'rev-parse', 'HEAD')).not.toBe(f.source.headOid)
    expect(await git(f.cwd, 'show', 'HEAD:tracked.txt')).toBe('hook changed')
  })

  it('detects external refs changing after staging without resetting partial changes', async () => {
    const f = await setup()
    await writeFile(join(f.cwd, 'tracked.txt'), 'delivery\n')
    const original = f.ctx.subprocess.spawn.bind(f.ctx.subprocess)
    let moved = false
    vi.spyOn(f.ctx.subprocess, 'spawn').mockImplementation((spec) => {
      const child = original(spec)
      if (spec.argv.includes('add') && !moved) {
        moved = true
        const done = child.done.then(async (outcome) => {
          await git(f.root, 'branch', 'external-ref')
          return outcome
        })
        return { ...child, done, terminate: () => { child.terminate() }, waitForExit: () => child.waitForExit() }
      }
      return child
    })
    await rejection(f.finalize(), 'RG_GIT_CHANGED', 'partial')
    expect(await git(f.cwd, 'diff', '--cached', '--name-only')).toBe('tracked.txt')
    expect(await git(f.cwd, 'rev-parse', 'HEAD')).toBe(f.source.headOid)
  })

  it('disables clean filters, external diff, textconv, and fsmonitor without suppressing commit hooks', async () => {
    const f = await setup()
    await git(f.root, 'config', 'filter.probe.clean', 'exit 91')
    await git(f.root, 'config', 'filter.probe.process', 'exit 92')
    await git(f.root, 'config', 'filter.probe.required', 'true')
    await git(f.root, 'config', 'filter.probe.note', 'ordinary non-command config')
    await git(f.root, 'config', 'diff.probe.command', 'exit 93')
    await git(f.root, 'config', 'diff.probe.textconv', 'exit 94')
    await git(f.root, 'config', 'core.fsmonitor', 'exit 95')
    await writeFile(join(f.cwd, '.gitattributes'), 'tracked.txt filter=probe diff=probe\n')
    await writeFile(join(f.cwd, 'tracked.txt'), 'unaltered\n')
    const result = await f.finalize()
    expect(result.manifest.find(entry => entry.path === 'tracked.txt')?.content).toBe('unaltered\n')
    expect((await f.executor.verifyCandidate(f.agent, result, limits, signal())).headOid).toBe(result.headOid)
  })

  it('awaits managed quiescence on cancellation and never widens current policy', async () => {
    const f = await setup()
    const stop = new AbortController()
    const original = f.ctx.subprocess.spawn.bind(f.ctx.subprocess)
    let terminated = false
    let quiescent = false
    const spawn = vi.spyOn(f.ctx.subprocess, 'spawn').mockImplementation((spec): SubprocessHandle => {
      const child = original(spec)
      return { ...child, done: child.done.then((outcome) => { stop.abort(); return outcome }),
        terminate() { terminated = true; child.terminate() },
        async waitForExit() { const result = await child.waitForExit(); quiescent = true; return result } }
    })
    const policy = vi.spyOn(f.ctx.sandboxPolicy, 'resolve')
    await rejection(f.executor.inspect(f.agent, f.cwd, stop.signal), 'RG_GIT_CANCELLED')
    expect(terminated && quiescent).toBe(true)
    expect(spawn.mock.calls[0]?.[0].env).toMatchObject({ GIT_DIR: undefined, GIT_NO_LAZY_FETCH: '1', GIT_LITERAL_PATHSPECS: '1' })
    expect(policy).toHaveBeenCalledWith({ session: f.agent.session })
  })
})


/** Inject complete process-wire records while retaining the real filesystem and current policy service. */
function transport(f: Awaited<ReturnType<typeof setup>>) {
  type Reply = { stdout: string; stderr: string; exitCode: number | null; signal: NodeJS.Signals | null; lossy: boolean }
  const ordinary = (spec: SubprocessSpawnSpec): Reply => {
    const checkout = f.worktree
    let stdout = ''
    if (spec.argv.includes('--is-inside-work-tree')) stdout = 'true\n'
    else if (spec.argv.includes('--show-toplevel')) {
      stdout = [checkout.root, checkout.gitDir, checkout.commonDir, checkout.headOid, checkout.treeOid].join('\n') + '\n'
    } else if (spec.argv.includes('symbolic-ref')) stdout = String(checkout.branch) + '\n'
    else if (spec.argv.includes('-v')) stdout = 'H tracked.txt\0'
    return { stdout, stderr: '', exitCode: 0, signal: null, lossy: false }
  }
  let transform: (spec: SubprocessSpawnSpec, reply: Reply) => Reply = (_spec, reply) => reply
  let exited = true
  const spy = vi.spyOn(f.ctx.subprocess, 'spawn').mockImplementation((spec): SubprocessHandle => {
    const reply = transform(spec, ordinary(spec))
    return {
      stdin: undefined, stdout: undefined, stderr: undefined, control: undefined,
      collected: {
        stdout: { readFrom: () => ({ text: reply.stdout, nextOffset: Buffer.byteLength(reply.stdout), lossy: reply.lossy }) },
        stderr: { readFrom: () => ({ text: reply.stderr, nextOffset: Buffer.byteLength(reply.stderr), lossy: false }) },
      },
      done: Promise.resolve({ exitCode: reply.exitCode, signal: reply.signal }),
      terminate() {}, async waitForExit() { return exited },
    }
  })
  return {
    spy,
    set(value: typeof transform) { transform = value },
    quiescence(value: boolean) { exited = value },
  }
}

describe('Git process-wire refusal', { timeout: 120_000 }, () => {
  it('rejects malformed checkout facts, paths, object ids, branches, process signals, and incomplete output', async () => {
    const f = await setup(false)
    const wire = transport(f)
    const inspect = () => f.executor.inspect(f.agent, f.root, signal())
    expect(await inspect()).toEqual(f.source)
    for (const value of ['false\n', '', 'true\nextra\n']) {
      wire.set((spec, reply) => spec.argv.includes('--is-inside-work-tree') ? { ...reply, stdout: value } : reply)
      await rejection(inspect(), 'RG_GIT_UNSUPPORTED')
    }
    for (const facts of [[], [f.root, f.source.gitDir, f.source.commonDir, 'bad oid', f.source.treeOid],
      [f.root, f.source.gitDir, f.source.commonDir, f.source.headOid, 'bad tree']]) {
      wire.set((spec, reply) => spec.argv.includes('--show-toplevel') ? { ...reply, stdout: facts.join('\n') + '\n' } : reply)
      await rejection(inspect(), 'RG_GIT_UNSUPPORTED')
    }
    wire.set((spec, reply) => spec.argv.includes('symbolic-ref') ? { ...reply, stdout: 'refs/tags/not-branch\n' } : reply)
    await rejection(inspect(), 'RG_GIT_UNSUPPORTED')
    wire.set((_spec, reply) => ({ ...reply, lossy: true }))
    await rejection(inspect(), 'RG_GIT_LIMIT')
    wire.set((_spec, reply) => ({ ...reply, signal: 'SIGTERM', exitCode: null }))
    await rejection(inspect(), 'RG_GIT_FAILED')
    wire.set((_spec, reply) => ({ ...reply, signal: null, exitCode: null }))
    await rejection(inspect(), 'RG_GIT_FAILED')
    wire.set((_spec, reply) => ({ ...reply, exitCode: 2, stderr: 'wire failure' }))
    await rejection(inspect(), 'RG_GIT_FAILED')
    wire.set((_spec, reply) => reply)
    wire.quiescence(false)
    await rejection(inspect(), 'RG_GIT_UNKNOWN', 'unknown')
  })

  it('rejects malformed NUL records, conflict states, and unsupported tree modes through capture', async () => {
    const f = await setup(false)
    const wire = transport(f)
    const capture = () => f.executor.capture(f.agent, f.root, f.source.headOid, undefined, ['.'], limits, signal())
    const cases: [string, string, string][] = [
      ['status', 'broken', 'RG_GIT_UNSUPPORTED'],
      ['status', 'XX tracked.txt\0', 'RG_GIT_UNSUPPORTED'],
      ['status', 'UU tracked.txt\0', 'RG_GIT_CONFLICT'],
      ['status', 'AA tracked.txt\0', 'RG_GIT_CONFLICT'],
      ['status', 'DD tracked.txt\0', 'RG_GIT_CONFLICT'],
      ['status', 'R  tracked.txt\0', 'RG_GIT_UNSUPPORTED'],
      ['status', '?? ../escape\0', 'RG_GIT_SCOPE'],
      ['status', '?? replacement-\ufffd.txt\0', 'RG_GIT_UNSUPPORTED'],
      ['--raw', 'invalid\0tracked.txt\0', 'RG_GIT_UNSUPPORTED'],
      ['--raw', ':100644 100644 a b M\0', 'RG_GIT_UNSUPPORTED'],
      ['--raw', ':100644 100644 a b U\0tracked.txt\0', 'RG_GIT_CONFLICT'],
      ['--raw', ':120000 100644 a b M\0tracked.txt\0', 'RG_GIT_UNSUPPORTED'],
      ['--raw', ':100644 160000 a b M\0tracked.txt\0', 'RG_GIT_UNSUPPORTED'],
      ['--others', '../escape\0', 'RG_GIT_SCOPE'],
      ['--others', 'dir\\escape\0', 'RG_GIT_SCOPE'],
      ['--numstat', '-\t-\ttracked.txt\0', 'RG_GIT_UNSUPPORTED'],
      ['-v', 's tracked.txt\0', 'RG_GIT_UNSUPPORTED'],
    ]
    for (const [argument, stdout, code] of cases) {
      wire.set((spec, reply) => spec.argv.includes(argument) ? { ...reply, stdout } : reply)
      await rejection(capture(), code)
    }
    wire.set((spec, reply) => (spec.argv.includes('--others') && !spec.argv.includes('--ignored')) ? { ...reply, stdout: 'tracked.txt\0' } : reply)
    const result = await capture()
    expect(result.manifest[0]?.content).toBe('initial\n')
  })

  it('does not spawn after current-policy confinement refuses the operation', async () => {
    const f = await setup(false)
    const wire = transport(f)
    const policy = f.ctx.sandboxPolicy.resolve({ session: f.agent.session })
    vi.spyOn(f.ctx.sandboxPolicy, 'resolve').mockReturnValue({ ...policy, mode: 'read-only' })
    const confine = vi.spyOn(f.ctx.sandbox, 'confine').mockRejectedValue(new Error('policy denied'))
    await rejection(f.executor.inspect(f.agent, f.root, signal()), 'RG_GIT_FAILED')
    expect(wire.spy).not.toHaveBeenCalled()
    expect(confine).toHaveBeenCalledWith(expect.any(Array), { ...policy, mode: 'read-only' }, expect.any(AbortSignal))
  })

  it('awaits quiescence after a real deadline while preserving typed timeout and non-error transport failures', async () => {
    const f = await setup(false)
    const wire = transport(f)
    const timed = new GitExecutor(f.ctx, { ...config, timeoutMs: 1 })
    vi.spyOn(f.ctx.subprocess, 'resolveExecutable').mockResolvedValue('git')
    let quiescent = false
    wire.spy.mockImplementation((spec): SubprocessHandle => ({
      stdin: undefined, stdout: undefined, stderr: undefined, control: undefined, collected: {},
      done: new Promise((_resolve, reject) => spec.signal?.addEventListener('abort', () => { reject(new Error('stopped')) }, { once: true })),
      terminate() {}, async waitForExit() { quiescent = true; return true },
    }))
    await rejection(timed.inspect(f.agent, f.root, signal()), 'RG_GIT_TIMEOUT')
    expect(quiescent).toBe(true)
    wire.spy.mockImplementation(() => { throw new Error('provider unavailable') })
    await rejection(f.executor.inspect(f.agent, f.root, signal()), 'RG_GIT_FAILED')
    vi.spyOn(f.ctx.subprocess, 'resolveExecutable').mockRejectedValue('transport failure')
    await rejection(f.executor.inspect(f.agent, f.root, signal()), 'RG_GIT_FAILED')
  })

  it('fails invalid executable and budgets at construction rather than at the first Git mutation', async () => {
    const f = await setup(false)
    for (const value of [0, -1, NaN, 2_147_483_648]) expect(() => new GitExecutor(f.ctx, { ...config, timeoutMs: value })).toThrow()
    for (const value of ['', 'git\0extra']) expect(() => new GitExecutor(f.ctx, { ...config, gitCommand: value })).toThrow()
  })
})


describe('Git filesystem and publication races', { timeout: 120_000 }, () => {
  it('rejects complete-result overflow, nonregular files, read failures, and canonical escapes', async () => {
    const f = await setup(false)
    const wire = transport(f)
    const capture = (executor = f.executor) => executor.capture(f.agent, f.root, f.source.headOid, undefined, ['.'], limits, signal())
    const bounded = new GitExecutor(f.ctx, { ...config, maxOutputBytes: Buffer.byteLength(JSON.stringify(f.source)) })
    await rejection(capture(bounded), 'RG_GIT_LIMIT')
    await mkdir(join(f.root, 'directory'))
    wire.set((spec, reply) => (spec.argv.includes('--others') && !spec.argv.includes('--ignored')) ? { ...reply, stdout: 'directory\0' } : reply)
    await rejection(capture(), 'RG_GIT_UNSUPPORTED')
    wire.set((spec, reply) => (spec.argv.includes('--others') && !spec.argv.includes('--ignored')) ? { ...reply, stdout: 'tracked.txt\0' } : reply)
    const parent = await f.ctx.fs.resolve(join(f.root, '..'))
    const resolve = f.ctx.fs.resolve.bind(f.ctx.fs)
    const resolving = vi.spyOn(f.ctx.fs, 'resolve').mockImplementation((path, options) => path === 'tracked.txt'
      ? Promise.resolve(parent) : resolve(path, options))
    await rejection(capture(), 'RG_GIT_SCOPE')
    resolving.mockRestore()
    const reading = vi.spyOn(f.ctx.fs, 'readBytes').mockRejectedValue(new FsError('Filesystem transport failed', 'FS_IO_ERROR'))
    await rejection(capture(), 'RG_GIT_UNSUPPORTED')
    reading.mockRestore()
    const readBytes = f.ctx.fs.readBytes.bind(f.ctx.fs)
    const raced = vi.spyOn(f.ctx.fs, 'readBytes').mockImplementation(async (target, cancel, max) => {
      const bytes = await readBytes(target, cancel, max)
      await writeFile(join(f.root, 'tracked.txt'), 'changed during read\n')
      return bytes
    })
    await rejection(capture(), 'RG_GIT_CHANGED')
    raced.mockRestore()
  })

  it('rejects status and raw-diff changes between the first and last capture', async () => {
    const f = await setup(false)
    const wire = transport(f)
    for (const argument of ['status', '--raw']) {
      let reads = 0
      wire.set((spec, reply) => {
        if (!spec.argv.includes(argument) || ++reads === 1) return reply
        return { ...reply, stdout: argument === 'status' ? '?? tracked.txt\0' : ':100644 100644 a b M\0tracked.txt\0' }
      })
      await rejection(f.executor.capture(f.agent, f.root, f.source.headOid, undefined, ['.'], limits, signal()), 'RG_GIT_CHANGED')
    }
    wire.set((_spec, reply) => reply)
    await rejection(f.executor.capture(f.agent, f.root, f.source.headOid, '0'.repeat(40), ['.'], limits, signal()), 'RG_GIT_CHANGED')
  })

  it('rejects stale linked-worktree backlinks and external source metadata', async () => {
    const f = await setup()
    await writeFile(join(f.worktree.gitDir, 'gitdir'), join(f.root, '.git') + '\n')
    await rejection(f.executor.inspect(f.agent, f.cwd, signal()), 'RG_GIT_CHANGED')
    const wire = transport(f)
    wire.set((spec, reply) => spec.argv.includes('--show-toplevel') ? { ...reply,
      stdout: [f.cwd, f.worktree.gitDir, f.root, f.worktree.headOid, f.worktree.treeOid].join('\n') + '\n' } : reply)
    await rejection(f.executor.inspect(f.agent, f.cwd, signal()), 'RG_GIT_UNSUPPORTED')
    wire.spy.mockRestore()
    await git(f.root, 'init', '--separate-git-dir', join(f.root, 'external-metadata'))
    await rejection(f.executor.inspect(f.agent, f.root, signal()), 'RG_GIT_UNSUPPORTED')
  })

  it('rejects a real directory junction or symlink before reading outside files', async () => {
    const f = await setup(false)
    await symlink(f.root, join(f.root, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    const wire = transport(f)
    wire.set((spec, reply) => (spec.argv.includes('--others') && !spec.argv.includes('--ignored')) ? { ...reply, stdout: 'link/tracked.txt\0' } : reply)
    await rejection(f.executor.capture(f.agent, f.root, f.source.headOid, undefined, ['.'], limits, signal()), 'RG_GIT_UNSUPPORTED')
  })

  it('refuses content conversion instead of committing a different blob', async () => {
    const f = await setup()
    await writeFile(join(f.cwd, '.gitattributes'), 'tracked.txt text eol=lf\n')
    await writeFile(join(f.cwd, 'tracked.txt'), 'line\r\n')
    await rejection(f.finalize(), 'RG_GIT_UNSUPPORTED', 'partial')
    expect(await git(f.cwd, 'rev-parse', 'HEAD')).toBe(f.source.headOid)
  })

  it('retains unrelated staged paths introduced after manifest verification', async () => {
    const f = await setup()
    await writeFile(join(f.cwd, 'tracked.txt'), 'delivery\n')
    const spawn = f.ctx.subprocess.spawn.bind(f.ctx.subprocess)
    vi.spyOn(f.ctx.subprocess, 'spawn').mockImplementation((spec) => {
      const child = spawn(spec)
      const done = spec.argv.includes('add') ? child.done.then(async (result) => {
        await writeFile(join(f.cwd, 'foreign.txt'), 'foreign staged\n')
        await git(f.cwd, 'add', 'foreign.txt')
        return result
      }) : child.done
      return { ...child, done, terminate: () => { child.terminate() }, waitForExit: () => child.waitForExit() }
    })
    await rejection(f.finalize(), 'RG_GIT_CHANGED', 'partial')
    expect(await git(f.cwd, 'show', ':foreign.txt')).toBe('foreign staged')
  })

  it('reports unknown when post-commit hooks move unrelated refs or dirty committed files', async () => {
    const f = await setup()
    const hook = join(f.source.commonDir, 'hooks/post-commit')
    await writeFile(join(hook), '#!/bin/sh\ngit branch hook-ref\n')
    await chmod(hook, 0o755)
    await writeFile(join(f.cwd, 'tracked.txt'), 'delivery\n')
    await rejection(f.finalize(), 'RG_GIT_UNKNOWN', 'unknown')
    const head = await git(f.cwd, 'rev-parse', 'HEAD')
    expect(head).not.toBe(f.source.headOid)
    await writeFile(hook, '#!/bin/sh\nprintf "after commit\\n" > tracked.txt\n')
    await writeFile(join(f.cwd, 'tracked.txt'), 'second delivery\n')
    await rejection(f.finalize(['.'], 'second', head), 'RG_GIT_UNKNOWN', 'unknown')
    expect(await readFile(join(f.cwd, 'tracked.txt'), 'utf8')).toBe('after commit\n')
  })
})


describe('Git capture end-state checks', { timeout: 120_000 }, () => {
  it('rejects disappearing untracked files, decoded binary data, and changes after the content read', async () => {
    const f = await setup(false)
    const wire = transport(f)
    const capture = () => f.executor.capture(f.agent, f.root, f.source.headOid, undefined, ['.'], limits, signal())
    wire.set((spec, reply) => (spec.argv.includes('--others') && !spec.argv.includes('--ignored')) ? { ...reply, stdout: 'missing.txt\0' } : reply)
    await rejection(capture(), 'RG_GIT_CHANGED')
    await writeFile(join(f.root, 'tracked.txt'), Buffer.from([1, 0, 2]))
    wire.set((spec, reply) => (spec.argv.includes('--others') && !spec.argv.includes('--ignored')) ? { ...reply, stdout: 'tracked.txt\0' } : reply)
    await rejection(capture(), 'RG_GIT_UNSUPPORTED')
    await writeFile(join(f.root, 'tracked.txt'), 'first content\n')
    let rawReads = 0
    const spawning = wire.spy.getMockImplementation()
    if (spawning === undefined) throw new Error('Transport fixture must be installed.')
    wire.spy.mockImplementation((spec) => {
      const child = spawning(spec)
      if (spec.argv.includes('--raw') && ++rawReads === 2) {
        return { ...child, done: child.done.then(async (result) => {
          await writeFile(join(f.root, 'tracked.txt'), 'changed after content read\n')
          return result
        }) }
      }
      return child
    })
    await rejection(capture(), 'RG_GIT_CHANGED')
  })

  it('awaits range observation even when termination throws and reports lost observation as unknown', async () => {
    const f = await setup(false)
    const wire = transport(f)
    const spawn = wire.spy.getMockImplementation()
    if (spawn === undefined) throw new Error('Transport fixture must be installed.')
    let observed = false
    wire.spy.mockImplementation(spec => ({ ...spawn(spec),
      terminate() { throw new Error('termination transport failed') },
      async waitForExit() { observed = true; return true },
    }))
    await rejection(f.executor.inspect(f.agent, f.root, signal()), 'RG_GIT_FAILED')
    expect(observed).toBe(true)
    wire.spy.mockImplementation(spec => ({ ...spawn(spec), async waitForExit() { throw new Error('observation transport failed') } }))
    await rejection(f.executor.inspect(f.agent, f.root, signal()), 'RG_GIT_UNKNOWN', 'unknown')
  })
})


it('refuses late ref movement while finalizing an existing descendant', { timeout: 120_000 }, async () => {
  const f = await setup()
  await writeFile(join(f.cwd, 'tracked.txt'), 'worker committed\n')
  await git(f.cwd, 'commit', '-am', 'worker commit')
  const head = await git(f.cwd, 'rev-parse', 'HEAD')
  const spawn = f.ctx.subprocess.spawn.bind(f.ctx.subprocess)
  vi.spyOn(f.ctx.subprocess, 'spawn').mockImplementation((spec) => {
    const child = spawn(spec)
    if (spec.argv.includes('status') && !spec.argv.includes('--no-renames')) {
      return { ...child, done: child.done.then(async (outcome) => {
        await git(f.root, 'branch', 'late-external-ref')
        return outcome
      }), terminate: () => { child.terminate() }, waitForExit: () => child.waitForExit() }
    }
    return child
  })
  await rejection(f.finalize(['.'], 'no empty commit', head), 'RG_GIT_CHANGED')
  expect(await git(f.cwd, 'rev-parse', 'HEAD')).toBe(head)
})


it('verifies a persisted identity in a separately provisioned detached reviewer checkout', { timeout: 120_000 }, async () => {
  const f = await setup()
  await writeFile(join(f.cwd, 'tracked.txt'), 'candidate\n')
  const candidate = await f.finalize(['tracked.txt'])
  const review = await f.ctx.worktrees.provision(f.agent, { name: 'review', from: candidate.headOid, detached: true })
  const inspection = await f.executor.inspect(f.agent, review.path, signal())
  const persisted = { inspection, baseOid: candidate.baseOid, headOid: candidate.headOid, treeOid: candidate.treeOid,
    scope: candidate.scope, scopeIdentity: candidate.scopeIdentity }
  const verified = await f.executor.verifyCandidate(f.agent, persisted, limits, signal())
  expect(verified.headOid).toBe(candidate.headOid)
  expect(verified.inspection.branch).toBeNull()
  expect(verified.inspection.root).toBe(review.path)
})

it('refuses a diff whose committed base contains undecodable bytes', { timeout: 120_000 }, async () => {
  const f = await setup(false)
  await writeFile(join(f.root, 'tracked.txt'), Buffer.from([0xff]))
  await git(f.root, 'commit', '-am', 'non-text base')
  const base = await f.executor.inspect(f.agent, f.root, signal())
  await writeFile(join(f.root, 'tracked.txt'), 'regular text\n')
  await rejection(f.executor.capture(f.agent, f.root, base.headOid, base.headOid, ['tracked.txt'], limits, signal()), 'RG_GIT_UNSUPPORTED')
})


it('reports cancellation after commit as unknown and retains the actual commit', { timeout: 120_000 }, async () => {
  const f = await setup()
  await writeFile(join(f.cwd, 'tracked.txt'), 'committed before cancellation\n')
  const stop = new AbortController()
  const spawn = f.ctx.subprocess.spawn.bind(f.ctx.subprocess)
  let observedCommitExit = false
  vi.spyOn(f.ctx.subprocess, 'spawn').mockImplementation((spec) => {
    const child = spawn(spec)
    if (spec.argv.includes('commit')) {
      return { ...child, done: child.done.then((outcome) => { stop.abort(); return outcome }),
        terminate: () => { child.terminate() }, async waitForExit() {
          const result = await child.waitForExit()
          observedCommitExit = true
          return result
        } }
    }
    return child
  })
  await rejection(f.executor.finalize(f.agent, f.worktree, f.source.headOid, f.source.headOid,
    ['tracked.txt'], 'commit before cancellation', limits, stop.signal), 'RG_GIT_UNKNOWN', 'unknown')
  expect(observedCommitExit).toBe(true)
  expect(await git(f.cwd, 'rev-parse', 'HEAD')).not.toBe(f.source.headOid)
  expect(await git(f.cwd, 'show', 'HEAD:tracked.txt')).toBe('committed before cancellation')
})


describe('ignored-file candidate refusal', { timeout: 120_000 }, () => {
  it('captures tracked, staged, unstaged, and untracked source contents before a worktree pool exists', async () => {
    const f = await setup(false)
    await writeFile(join(f.root, 'tracked.txt'), 'source staged\n')
    await git(f.root, 'add', 'tracked.txt')
    await writeFile(join(f.root, 'tracked.txt'), 'source unstaged\n')
    await writeFile(join(f.root, 'source-only.txt'), 'source-only\n')
    const before = await readFile(join(f.root, '.git/index'))
    const captured = await f.executor.capture(f.agent, f.root, f.source.headOid, undefined, ['.'], limits, signal())
    expect(captured.manifest.map(entry => [entry.path, entry.content])).toEqual([
      ['source-only.txt', 'source-only\n'], ['tracked.txt', 'source unstaged\n'],
    ])
    expect(await readFile(join(f.root, '.git/index'))).toEqual(before)
  })

  it('refuses worker-hidden files, nested ignored directories, and out-of-scope ignored dependencies for every scope', async () => {
    const f = await setup()
    await writeFile(join(f.source.commonDir, 'info/exclude'), 'hidden.txt\nignored/\n')
    await writeFile(join(f.cwd, 'tracked.txt'), 'candidate\n')
    await writeFile(join(f.cwd, 'hidden.txt'), 'omitted source\n')
    for (const scope of [['tracked.txt'], ['.']]) {
      await rejection(f.finalize(scope), 'RG_GIT_SCOPE')
    }
    await rm(join(f.cwd, 'hidden.txt'))
    await mkdir(join(f.cwd, 'ignored/deep'), { recursive: true })
    await writeFile(join(f.cwd, 'ignored/deep/dependency.txt'), 'hidden dependency\n')
    await rejection(f.finalize(['tracked.txt']), 'RG_GIT_SCOPE')
    expect(await git(f.cwd, 'diff', '--cached', '--name-only')).toBe('')
    expect(await git(f.cwd, 'rev-parse', 'HEAD')).toBe(f.source.headOid)
    await rm(join(f.cwd, 'ignored'), { recursive: true })
    await writeFile(join(f.cwd, '.gitignore'), 'hidden.txt\n')
    await writeFile(join(f.cwd, 'hidden.txt'), 'worker-created omission\n')
    await rejection(f.finalize(['.']), 'RG_GIT_SCOPE')
  })

  it('refuses ignored data created after the first capture scan rather than trusting unchanged status', async () => {
    const f = await setup()
    await writeFile(join(f.source.commonDir, 'info/exclude'), 'hidden.txt\n')
    await writeFile(join(f.cwd, 'tracked.txt'), 'candidate\n')
    const spawn = f.ctx.subprocess.spawn.bind(f.ctx.subprocess)
    let scans = 0
    vi.spyOn(f.ctx.subprocess, 'spawn').mockImplementation((spec) => {
      const child = spawn(spec)
      const done = spec.argv.includes('--ignored') && ++scans === 1 ? child.done.then(async (outcome) => {
        await writeFile(join(f.cwd, 'hidden.txt'), 'appeared after ignored scan\n')
        return outcome
      }) : child.done
      return { ...child, done, terminate: () => { child.terminate() }, waitForExit: () => child.waitForExit() }
    })
    await rejection(f.executor.capture(f.agent, f.cwd, f.source.headOid, f.source.headOid, ['tracked.txt'], limits, signal()), 'RG_GIT_SCOPE')
    expect(scans).toBe(2)
  })

  it('refuses ignored files in an independent detached review checkout, including a closing-status race', async () => {
    const f = await setup()
    await writeFile(join(f.source.commonDir, 'info/exclude'), 'hidden.txt\n')
    await writeFile(join(f.cwd, 'tracked.txt'), 'candidate\n')
    const candidate = await f.finalize(['tracked.txt'])
    const review = await f.ctx.worktrees.provision(f.agent, { name: 'ignored-review', from: candidate.headOid, detached: true })
    const inspection = await f.executor.inspect(f.agent, review.path, signal())
    const identity = { ...candidate, inspection }
    await writeFile(join(review.path, 'hidden.txt'), 'hidden reviewer input\n')
    await rejection(f.executor.verifyCandidate(f.agent, identity, limits, signal()), 'RG_GIT_SCOPE')
    await rm(join(review.path, 'hidden.txt'))
    const spawn = f.ctx.subprocess.spawn.bind(f.ctx.subprocess)
    vi.spyOn(f.ctx.subprocess, 'spawn').mockImplementation((spec) => {
      const child = spawn(spec)
      const done = spec.argv.includes('status') && !spec.argv.includes('--no-renames') ? child.done.then(async (outcome) => {
        await writeFile(join(review.path, 'hidden.txt'), 'appeared during closing status\n')
        return outcome
      }) : child.done
      return { ...child, done, terminate: () => { child.terminate() }, waitForExit: () => child.waitForExit() }
    })
    await rejection(f.executor.verifyCandidate(f.agent, identity, limits, signal()), 'RG_GIT_SCOPE')
  })

  it('rejects incomplete and over-limit ignored-file NUL output without treating it as an empty checkout', async () => {
    const f = await setup(false)
    const wire = transport(f)
    const capture = () => f.executor.capture(f.agent, f.root, f.source.headOid, f.source.headOid, ['.'], limits, signal())
    wire.set((spec, reply) => spec.argv.includes('--ignored') ? { ...reply, stdout: 'hidden-without-NUL' } : reply)
    await rejection(capture(), 'RG_GIT_UNSUPPORTED')
    wire.set((spec, reply) => spec.argv.includes('--ignored') ? { ...reply, stdout: 'retained-tail\0', lossy: true } : reply)
    await rejection(capture(), 'RG_GIT_LIMIT')
  })
})
