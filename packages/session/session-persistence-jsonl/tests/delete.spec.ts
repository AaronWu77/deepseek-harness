/** Deleting a stored Session moves its directory into the trash root as one atomic rename. */

import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SessionAlreadyOwnedError } from '@deepseek-ai/dsh-session-persistence'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { meta, oneTurnLog } from '../../session-persistence/tests/contract.ts'
import { sessionDir } from '../src/format.ts'

const dirs: string[] = []
const fibers: Array<{ dispose(): Promise<void> }> = []

afterEach(async () => {
  for (const fiber of fibers.splice(0)) await fiber.dispose()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

/**
 * Mount one backend over its own root.
 * @returns the mounted context, its root and trash directories, and the fiber.
 */
async function mount(): Promise<{ ctx: Context; root: string; trash: string; fiber: { dispose(): Promise<void> } }> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-jsonl-delete-'))
  dirs.push(home)
  const root = join(home, 'sessions')
  const trash = join(home, 'trash', 'sessions')
  const ctx = new Context()
  const fiber = await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  fibers.push(fiber)
  return { ctx, root, trash, fiber }
}

describe('SessionPersistence.delete', () => {
  it('moves the session directory into the trash root and stops resolving the id', async () => {
    const { ctx, root, trash } = await mount()
    const persistence = ctx.sessionPersistence
    const session = meta('delete-me', '/work')
    const handle = await persistence.create(session)
    await handle.append(oneTurnLog())
    await handle.flush()
    await handle.close()

    const directory = sessionDir(root, session.cwd, session.id)
    expect(existsSync(directory)).toBe(true)

    await expect(persistence.delete(session.id)).resolves.toBe('deleted')
    expect(existsSync(directory)).toBe(false)
    await expect(persistence.stat(session.id)).resolves.toBeUndefined()

    const stamped = await readdir(trash)
    expect(stamped).toHaveLength(1)
    expect(await readdir(join(trash, stamped[0]!))).toEqual(['delete-me'])
  })

  it('reports absent for an id that stored nothing', async () => {
    const { ctx } = await mount()
    await expect(ctx.sessionPersistence.delete(SessionId('never-stored'))).resolves.toBe('absent')
  })

  it('refuses while a write handle still owns the session', async () => {
    const { ctx } = await mount()
    const persistence = ctx.sessionPersistence
    const handle = await persistence.create(meta('still-open', '/work'))
    await expect(persistence.delete(handle.id)).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
    await handle.close()
    await expect(persistence.delete(handle.id)).resolves.toBe('absent')
  })
})
