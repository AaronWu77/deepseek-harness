import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { contents, git, loaderHarness, repository, testAgent } from './harness.ts'

let ctx: Context | undefined
let root: string | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('non-entering worktrees through real Loader composition', () => {
  it('keeps dirty parent HEAD, index bytes, files, and cwd while provisioning a clean task branch', async () => {
    root = await repository()
    ctx = await loaderHarness(root)
    const agent = testAgent(ctx, root)
    await writeFile(join(root, 'tracked.txt'), 'staged\n')
    await git(root, 'add', 'tracked.txt')
    await writeFile(join(root, 'tracked.txt'), 'unstaged\n')
    await writeFile(join(root, 'untracked.txt'), 'local\n')
    const head = await git(root, 'rev-parse', 'HEAD')
    const status = await git(root, 'status', '--porcelain')
    const index = await readFile(join(root, '.git/index'))
    const ensure = vi.spyOn(ctx.workingDirectory, 'ensure')
    const set = vi.spyOn(ctx.workingDirectory, 'set')
    const phases: string[] = []

    const created = await ctx.worktrees.provision(agent, { name: 'task', detached: false }, undefined, (phase) => {
      phases.push(phase)
      expect(ctx!.workingDirectory.get(agent.session)).toBe(root)
    })

    expect(created).toEqual({ path: join(root, '.agents/worktrees/task'), branch: 'task', baseCommit: head, repositoryRoot: root })
    expect(phases).toEqual(['prepare', 'checkout'])
    expect(ensure).not.toHaveBeenCalled()
    expect(set).not.toHaveBeenCalled()
    expect(ctx.workingDirectory.get(agent.session)).toBe(root)
    expect(await readFile(join(root, '.git/index'))).toEqual(index)
    expect(await git(root, 'rev-parse', 'HEAD')).toBe(head)
    expect(await git(root, 'branch', '--show-current')).toBe('main')
    expect(await contents(join(root, 'tracked.txt'))).toBe('unstaged\n')
    expect(await contents(join(root, 'untracked.txt'))).toBe('local\n')
    expect(await git(root, 'status', '--porcelain')).toBe(status)
    expect(await contents(join(created.path, 'tracked.txt'))).toBe('initial\n')
    await expect(access(join(created.path, 'untracked.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await git(created.path, 'branch', '--show-current')).toBe('task')
    expect(await git(created.path, 'status', '--porcelain')).toBe('')
  })

  it('checks out an exact older local revision detached without creating or reusing its namesake branch', async () => {
    root = await repository()
    const baseCommit = await git(root, 'rev-parse', 'HEAD')
    await writeFile(join(root, 'tracked.txt'), 'advanced\n')
    await git(root, 'commit', '-am', 'advance')
    await git(root, 'branch', 'review')
    const refs = await git(root, 'show-ref')
    ctx = await loaderHarness(root)
    const agent = testAgent(ctx, root)

    const created = await ctx.worktrees.provision(agent, { name: 'review', from: baseCommit, detached: true })

    expect(created).toEqual({ path: join(root, '.agents/worktrees/review'), branch: null, baseCommit, repositoryRoot: root })
    expect(await git(created.path, 'rev-parse', 'HEAD')).toBe(baseCommit)
    expect(await git(created.path, 'branch', '--show-current')).toBe('')
    expect(await contents(join(created.path, 'tracked.txt'))).toBe('initial\n')
    expect(await git(root, 'show-ref')).toBe(refs)
    expect(ctx.workingDirectory.get(agent.session)).toBe(root)
  })

  it('defaults to an exclusive generated branch at HEAD and refuses duplicate names and invalid revisions', async () => {
    root = await repository()
    ctx = await loaderHarness(root)
    const agent = testAgent(ctx, root)
    const created = await ctx.worktrees.provision(agent)
    expect(created.branch).toMatch(/^dsh-/)
    expect(created.baseCommit).toBe(await git(root, 'rev-parse', 'HEAD'))
    await expect(ctx.worktrees.provision(agent, { name: created.branch! })).rejects.toThrow('branch already exists')
    await expect(ctx.worktrees.provision(agent, { name: created.branch!, detached: true })).rejects.toThrow('path already exists')
    await expect(ctx.worktrees.provision(agent, { name: 'missing', from: 'unavailable', detached: true })).rejects.toThrow('command failed')
    expect(ctx.workingDirectory.get(agent.session)).toBe(root)
  })

  it('does not recover or temporarily change a missing parent directory', async () => {
    root = await repository()
    ctx = await loaderHarness(root)
    const agent = testAgent(ctx, root)
    const gone = join(root, 'gone')
    await mkdir(gone)
    await ctx.workingDirectory.set(agent, gone)
    await rm(gone, { recursive: true })
    const ensure = vi.spyOn(ctx.workingDirectory, 'ensure')
    const set = vi.spyOn(ctx.workingDirectory, 'set')
    await expect(ctx.worktrees.provision(agent, { name: 'no-recovery' })).rejects.toThrow()
    expect(ensure).not.toHaveBeenCalled()
    expect(set).not.toHaveBeenCalled()
    expect(ctx.workingDirectory.get(agent.session)).toBe(gone)
    expect(await git(root, 'branch', '--list', 'no-recovery')).toBe('')
  })

  it.each([false, true])('retains partial allocation on cancellation at checkout (detached=%s)', async (detached) => {
    root = await repository()
    ctx = await loaderHarness(root)
    const agent = testAgent(ctx, root)
    const controller = new AbortController()
    const path = join(root, '.agents/worktrees/partial')
    const reason = new Error('caller stopped checkout')

    await expect(ctx.worktrees.provision(agent, { name: 'partial', detached }, controller.signal, (phase) => {
      if (phase === 'checkout') controller.abort(reason)
    })).rejects.toThrow('Any created checkout and branch are retained. caller stopped checkout')

    expect(await readdir(path)).toEqual(['.git'])
    expect(await git(path, 'rev-parse', 'HEAD')).toBe(await git(root, 'rev-parse', 'HEAD'))
    expect(await git(path, 'branch', '--show-current')).toBe(detached ? '' : 'partial')
    expect(await git(root, 'branch', '--list', 'partial')).toBe(detached ? '' : '+ partial')
    expect(ctx.workingDirectory.get(agent.session)).toBe(root)
  })

  it.each([false, true])('does not fetch missing partial-clone objects (detached=%s)', async (detached) => {
    root = await repository()
    await git(root, 'config', 'uploadpack.allowFilter', 'true')
    const partial = join(root, 'partial')
    await git(root, 'clone', '--filter=blob:none', '--no-checkout', pathToFileURL(root).href, partial)
    const missing = await git(partial, 'rev-list', '--objects', '--missing=print', 'HEAD')
    expect(missing).toContain('?')
    ctx = await loaderHarness(partial)
    const agent = testAgent(ctx, partial)
    await expect(ctx.worktrees.provision(agent, { name: 'local-only', detached })).rejects.toThrow('command failed')
    expect(await git(partial, 'rev-list', '--objects', '--missing=print', 'HEAD')).toBe(missing)
    expect(await contents(join(partial, '.agents/worktrees/local-only/.git'))).toContain('gitdir:')
    expect(ctx.workingDirectory.get(agent.session)).toBe(partial)
  })

  it('preserves a standing permission refusal without spawning or changing cwd', async () => {
    root = await repository()
    ctx = await loaderHarness(root, 'read-only')
    const agent = testAgent(ctx, root)
    const denial = new Error('permission denied by fixture provider')
    const confine = vi.spyOn(ctx.sandbox, 'confine').mockRejectedValueOnce(denial)
    const spawn = vi.spyOn(ctx.subprocess, 'spawn')
    await expect(ctx.worktrees.provision(agent, { name: 'denied', detached: true })).rejects.toBe(denial)
    expect(confine).toHaveBeenCalledOnce()
    expect(confine.mock.calls[0]?.[1]).toMatchObject({ mode: 'read-only', workspaceRoot: root })
    expect(spawn).not.toHaveBeenCalled()
    expect(await git(root, 'branch', '--list', 'denied')).toBe('')
    await expect(access(join(root, '.agents/worktrees'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(ctx.workingDirectory.get(agent.session)).toBe(root)
  })

  it('drains pending provisioning on service disposal and rejects later requests', async () => {
    root = await repository()
    ctx = await loaderHarness(root)
    const agent = testAgent(ctx, root)
    const service = ctx.worktrees
    const entry = [...ctx.loader.entries()].find(candidate => candidate.options.name === 'cordis:worktree')!
    const entered = Promise.withResolvers<AbortSignal>()
    const aborted = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const lookup = ctx.subprocess.resolveExecutable.bind(ctx.subprocess)
    const probe = vi.spyOn(ctx.subprocess, 'resolveExecutable').mockImplementationOnce(async (command, env, signal) => {
      if (signal === undefined) throw new Error('operation signal required')
      signal.addEventListener('abort', () => { aborted.resolve(undefined) }, { once: true })
      entered.resolve(signal)
      await release.promise
      signal.throwIfAborted()
      return lookup(command, env, signal)
    })
    const operation = service.provision(agent, { name: 'disposing', detached: true })
    const rejected = expect(operation).rejects.toThrow('worktree service disposed')
    let disposal: Promise<void> | undefined
    try {
      const signal = await entered.promise
      let disposed = false
      disposal = entry.fiber!.dispose().then(() => { disposed = true })
      expect(await Promise.race([aborted.promise.then(() => 'aborted'), disposal.then(() => 'disposed')])).toBe('aborted')
      expect(signal.aborted).toBe(true)
      expect(disposed).toBe(false)
      release.resolve(undefined)
      await rejected
      await disposal
      expect(disposed).toBe(true)
      expect(ctx.get('worktrees')).toBeUndefined()
      await expect(service.provision(agent)).rejects.toThrow('worktree service disposed')
      expect(ctx.workingDirectory.get(agent.session)).toBe(root)
      expect(await git(root, 'branch', '--list', 'disposing')).toBe('')
    } finally {
      release.resolve(undefined)
      await Promise.allSettled([operation, rejected, disposal])
      probe.mockRestore()
    }
  })
})
