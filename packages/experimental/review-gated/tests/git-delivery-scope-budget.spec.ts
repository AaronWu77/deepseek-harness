import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'
import { git, gitRuntimeFixture, gitSettings } from './fixtures/git-runtime.ts'

const signal = () => new AbortController().signal

describe('local Git scope size accounting', { timeout: 120_000 }, () => {
  it('rejects a huge raw path before serializing it or starting Git', async () => {
    const f = await gitRuntimeFixture()
    const { agent } = await f.task()
    const head = await git(f.root, 'rev-parse', 'HEAD')
    const index = await readFile(join(f.root, '.git', 'index'))
    const huge = 'x'.repeat(2_000_000)
    const scope = [huge]
    const spawn = vi.spyOn(f.ctx.subprocess, 'spawn')
    const stringify = vi.spyOn(JSON, 'stringify')
    let serialized = false
    try {
      await expect(f.runtime.authorizeLocalGit(agent, scope, signal())).rejects.toMatchObject({
        code: 'review-gated/refused', details: { reason: 'RG_GIT_AUTH_REQUIRED' },
      })
      serialized = stringify.mock.calls.some(([value]) => value === scope || value === huge)
    } finally { stringify.mockRestore() }
    expect(serialized).toBe(false)
    expect(spawn).not.toHaveBeenCalled()
    expect(f.runtime.readGit(agent.session)).toBeNull()
    expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(head)
    expect(await readFile(join(f.root, '.git', 'index'))).toEqual(index)
    expect(await git(f.root, 'status', '--porcelain')).toBe('')
  })

  it.each([
    { scope: ['a'.repeat(40) + '"'], tooLarge: ['a'.repeat(40) + '""'] },
    { scope: ['b'.repeat(40) + '😀中'], tooLarge: ['b'.repeat(40) + '😀中x'] },
    { scope: ['dir/' + 'c'.repeat(35), 'q"r', '💡'], tooLarge: ['dir/' + 'c'.repeat(35), 'q"r', '💡', 'x'] },
    { scope: ['d'.repeat(40) + '\ud800'], tooLarge: ['d'.repeat(40) + '\ud800x'] },
  ])('accepts exact JSON length and refuses larger escaped or Unicode scope %#', async ({ scope, tooLarge }) => {
    const limit = JSON.stringify(scope).length
    expect(JSON.stringify(tooLarge).length).toBeGreaterThan(limit)
    const f = await gitRuntimeFixture({ settings: { ...gitSettings(), maxHandoffChars: limit } })
    const { agent } = await f.task()
    const index = await readFile(join(f.root, '.git', 'index'))
    const spawn = vi.spyOn(f.ctx.subprocess, 'spawn')
    await expect(f.runtime.authorizeLocalGit(agent, tooLarge, signal())).rejects.toMatchObject({
      code: 'review-gated/refused', details: { reason: 'RG_GIT_AUTH_REQUIRED' },
    })
    expect(spawn).not.toHaveBeenCalled()
    expect(f.runtime.readGit(agent.session)).toBeNull()
    const grant = await f.runtime.authorizeLocalGit(agent, scope, signal())
    expect(grant.scope).toEqual([...scope].sort())
    expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(grant.source.headOid)
    expect(await readFile(join(f.root, '.git', 'index'))).toEqual(index)
    expect(await git(f.root, 'status', '--porcelain')).toBe('')
  })

  it('refuses when even the JSON array wrapper cannot fit the configured limit', async () => {
    const f = await gitRuntimeFixture({ settings: { ...gitSettings(), maxHandoffChars: 1 } })
    const { agent } = await f.create()
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'x' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const spawn = vi.spyOn(f.ctx.subprocess, 'spawn')
    await expect(f.runtime.authorizeLocalGit(agent, ['.'], signal())).rejects.toMatchObject({
      code: 'review-gated/refused', details: { reason: 'RG_GIT_AUTH_REQUIRED' },
    })
    expect(spawn).not.toHaveBeenCalled()
    expect(f.runtime.readGit(agent.session)).toBeNull()
    expect(await git(f.root, 'status', '--porcelain')).toBe('')
  })
})
