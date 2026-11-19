/**
 * Real two-process lock contention over one shared root: a child Node
 * process (running the built package under plain Node) creates a session and
 * holds its kernel write lock; this process is excluded while the child
 * lives, and acquires immediately after a SIGKILL — the kernel releases the
 * lock with the dead process's descriptors, no waiting period. Keyless.
 */

import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { lstat, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { SessionAlreadyOwnedError } from '@deepseek-ai/dsh-session-persistence'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'

const SESSION = 'two-process-lease'

const dirs: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

const HOLDER = fileURLToPath(new URL('./fixtures/lease-holder.mjs', import.meta.url))

describe('two-process write lock (built lib)', () => {
  it('excludes a live holder process and takes over immediately after its crash', { timeout: 30_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lease-2proc-'))
    dirs.push(root)

    const holder = spawn(process.execPath, [HOLDER, root, SESSION], {
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    const exited = new Promise<void>((resolve) => { holder.once('exit', () => { resolve() }) })
    try {
      await once(holder.stdout, 'data') // 'holding'

      const ctx = new Context()
      contexts.push(ctx)
      await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
      const mine = ctx.sessionPersistence

      // Excluded while the other process's descriptor holds the kernel lock.
      await expect(mine.open(SessionId(SESSION), 'write')).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
      // Reads are unaffected across processes.
      const reader = await mine.open(SessionId(SESSION), 'read')
      expect((await reader.read()).events.map(event => event.seq)).toEqual([0, 1])
      await reader.close()

      // Crash the holder: no release runs, but the kernel drops the lock with
      // the process, so takeover succeeds without any waiting period.
      holder.kill('SIGKILL')
      await exited
      const taken = await mine.open(SessionId(SESSION), 'write')
      await taken.append([{ type: 'turn/start', seq: SessionSeq(2), time: 3, data: { turn: 2 } }])
      expect((await taken.read()).events.map(event => event.seq)).toEqual([0, 1, 2])
      await taken.close()
    } finally {
      if (holder.exitCode === null) holder.kill('SIGKILL')
    }
  })

  it.each(['legacy', 'maintenance'] as const)('refuses delete while an independent %s writer holds the lease', { timeout: 30_000 }, async (protocol) => {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-maintenance-2proc-')))
    dirs.push(home)
    const root = join(home, 'sessions')
    const id = SessionId(SESSION)
    const holder = spawn(process.execPath, [HOLDER, root, id, protocol], { stdio: ['ignore', 'pipe', 'inherit'] })
    const exited = once(holder, 'exit')
    try {
      await Promise.race([
        once(holder.stdout, 'data'),
        exited.then(([code]) => { throw new Error('lease holder exited before reporting readiness: ' + String(code)) }),
      ])
      const ctx = new Context()
      contexts.push(ctx)
      await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none', maintenance: { enabled: true } })
      const host = ctx.sessionPersistence
      const preview = await host.inspectMaintenance(id)
      if (preview.state !== 'available') throw new Error(JSON.stringify(preview))
      const options = { caller: 'cross-process-fixture', expectedRevision: preview.revision, expectedIdentity: preview.identity }
      const admit = async () => ({ status: 'admitted', evidence: {
        source: 'isolated-fixture', version: 1, archived: true, live: false, references: { descendants: 0, teamTasks: 0 },
      } } as const)
      expect(await host.withMaintenance(id, 'delete', admit, options)).toMatchObject({ status: 'refused', reason: 'lease' })
      holder.kill('SIGKILL')
      await exited
      expect(await host.withMaintenance(id, 'delete', admit, options)).toMatchObject({ status: 'moved' })
    } finally {
      if (holder.exitCode === null && holder.signalCode === null) holder.kill('SIGKILL')
      await exited
    }
  })
})

const ROOT_HOLDER = fileURLToPath(new URL('./fixtures/root-gate-child.mjs', import.meta.url))

function rootChild(root: string, mode: 'shared' | 'exclusive' | 'contend') {
  const child = spawn(process.execPath, [ROOT_HOLDER, root, mode], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
  const closed = once(child, 'close')
  const message = Promise.race([
    once(child, 'message').then(([value]): unknown => value),
    closed.then(([code, signal]) => { throw new Error('root gate child exited before reporting: ' + String(code ?? signal)) }),
  ])
  return {
    message,
    closed,
    async kill() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await closed
    },
  }
}

it.each(['shared', 'exclusive'] as const)('uses a real root file across independent child processes (%s holder)', { timeout: 30_000 }, async (mode) => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-gate-2proc-')))
  dirs.push(home)
  const root = join(home, 'sessions')
  const holder = rootChild(root, mode)
  try {
    expect(await holder.message).toBe('holding-' + mode)
    const contender = rootChild(root, 'contend')
    try {
      expect(await contender.message).toMatchObject({
        status: { active: mode === 'exclusive' },
        create: mode === 'exclusive' ? 'maintenance-gate' : 'acquired',
        open: mode === 'exclusive' ? 'maintenance-gate' : 'SessionPersistenceNotFoundError',
        exclusive: 'maintenance-gate',
      })
      expect(await contender.closed).toEqual([0, null])
      await expect(lstat(root)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await contender.kill()
    }
    await holder.kill()
    const successor = rootChild(root, 'contend')
    try {
      expect(await successor.message).toMatchObject({ status: { active: false }, exclusive: 'acquired' })
      expect(await successor.closed).toEqual([0, null])
    } finally {
      await successor.kill()
    }
  } finally {
    await holder.kill()
  }
})
