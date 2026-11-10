import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { contents, git, loaderHarness, repository, testAgent } from './harness.ts'

let context: Context | undefined
const roots: string[] = []

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function directoryLink(target: string, path: string): Promise<boolean> {
  try {
    await symlink(target, path, process.platform === 'win32' ? 'junction' : 'dir')
    return true
  } catch (error) {
    if (process.platform === 'win32' && error instanceof Error && 'code' in error && (error.code === 'EPERM' || error.code === 'EACCES')) return false
    throw error
  }
}

describe.each(['pool', 'destination'] as const)('canonical %s containment through real Loader composition', (link) => {
  it.for(['create', 'branch', 'detached'] as const)('rejects an external directory link before %s allocation or Git mutation', async (mode, { skip }) => {
    const root = await repository()
    roots.push(root)
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'dsh-worktree-outside-')))
    roots.push(outside)
    await writeFile(join(outside, 'sentinel'), 'retain external contents\n')
    const poolPath = join(root, '.agents/worktrees')
    if (link === 'destination') await mkdir(poolPath, { recursive: true })
    if (!await directoryLink(outside, link === 'pool' ? join(root, '.agents') : join(poolPath, 'redirect'))) {
      skip('Windows directory junction creation is unavailable for this test account')
      return
    }
    context = await loaderHarness(root)
    const ctx = context
    const agent = testAgent(ctx, root)
    expect(ctx.sandboxPolicy.resolve({ session: agent.session }).mode).toBe('danger-full-access')
    const name = link === 'pool' ? 'escape' : 'redirect/escape'
    const repositoryTarget = await ctx.fs.resolve(root)
    const pool = await ctx.fs.resolve('.agents/worktrees', { cwd: root })
    const destination = await ctx.fs.resolve(name, { cwd: ctx.fs.processPath(pool) })
    expect(ctx.fs.contains(repositoryTarget, pool)).toBe(link !== 'pool')
    expect(ctx.fs.contains(pool, destination)).toBe(link === 'pool')
    expect(ctx.fs.processPath(destination)).toBe(join(outside, link === 'pool' ? 'worktrees/escape' : 'escape'))
    const refs = await git(root, 'show-ref')
    const worktrees = await git(root, 'worktree', 'list', '--porcelain')
    const operation = mode === 'create' ? ctx.worktrees.create(agent, { name })
      : ctx.worktrees.provision(agent, { name, detached: mode === 'detached' })
    const result = await operation.then(value => ({ kind: 'created' as const, value }), (error: unknown) => ({ kind: 'rejected' as const, error }))
    expect({ outcome: result.kind, externalFiles: (await readdir(outside)).sort(), refs: await git(root, 'show-ref'),
      worktrees: await git(root, 'worktree', 'list', '--porcelain') }).toEqual({ outcome: 'rejected', externalFiles: ['sentinel'], refs, worktrees })
    if (result.kind !== 'rejected') throw new Error('an escaped checkout must be rejected')
    expect(result.error).toBeInstanceOf(Error)
    expect(await contents(join(outside, 'sentinel'))).toBe('retain external contents\n')
    expect(ctx.workingDirectory.get(agent.session)).toBe(root)
  })
})

it('accepts an existing directory link whose canonical pool stays inside the source checkout', async ({ skip }) => {
  const root = await repository()
  roots.push(root)
  const internal = join(root, 'internal')
  await mkdir(internal)
  if (!await directoryLink(internal, join(root, '.agents'))) {
    skip('Windows directory junction creation is unavailable for this test account')
    return
  }
  context = await loaderHarness(root)
  const agent = testAgent(context, root)
  const created = await context.worktrees.provision(agent, { name: 'legal' })
  expect(created.path).toBe(join(internal, 'worktrees/legal'))
  expect(await contents(join(created.path, 'tracked.txt'))).toBe('initial\n')
  expect(context.workingDirectory.get(agent.session)).toBe(root)
})
