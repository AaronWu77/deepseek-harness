import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { git, gitRuntimeFixture } from './fixtures/git-runtime.ts'

describe('local Git durable grant validation', { timeout: 120_000 }, () => {
  it('refuses a corrupted saved grant instead of using its empty scope', async () => {
    const f = await gitRuntimeFixture()
    const { agent } = await f.task()
    const grant = await f.runtime.authorizeLocalGit(agent, ['tracked.txt'], new AbortController().signal)
    const index = await readFile(join(f.root, '.git', 'index'))
    agent.session.append('review-gated/git-state', { version: 1, state: { ...grant, scope: [] } })
    expect(() => f.runtime.readGit(agent.session)).toThrow('RG_GIT_STATE_INVALID')
    expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(grant.source.headOid)
    expect(await readFile(join(f.root, '.git', 'index'))).toEqual(index)
    expect(await git(f.root, 'status', '--porcelain')).toBe('')
  })
})
