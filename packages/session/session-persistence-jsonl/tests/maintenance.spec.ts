import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionMaintenanceDisabledError, type SessionMaintenanceAdmission, type SessionMaintenanceContext } from '@deepseek-ai/dsh-session-persistence'
import * as jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { appendFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { SessionWriteLease } from '../src/lease.ts'

const id = SessionId('maintenance-fixture')
const meta: SessionHeader = { version: SESSION_FORMAT_VERSION, id, createdAt: 123, isSeeded: false }
const policy = async (): Promise<SessionMaintenanceAdmission> => ({
  status: 'admitted', evidence: {
    source: 'fixture', version: 1, archived: true, live: false,
    references: { descendants: 0, teamTasks: 0 }, workspace: { id: 'workspace-fixture', position: 2 },
  },
})

let home: string
let root: string
let trashRoot: string
const contexts: Context[] = []

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-session-maintenance-')))
  root = join(home, 'sessions')
  trashRoot = join(home, 'trash', 'sessions')
})

afterEach(async () => {
  try {
    for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

async function backend(enabled = true) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(jsonl, { root, compression: 'none', maintenance: { enabled } })
  return ctx.sessionPersistence
}

async function fixture() {
  const persistence = await backend()
  const writer = await persistence.create(meta)
  await writer.flush()
  await writer.close()
  const snapshot = (await persistence.stat(id))!
  const log = snapshot.location!.path
  const inspection = await persistence.inspectMaintenance(id)
  if (inspection.state !== 'available') throw new Error(JSON.stringify(inspection))
  const options = { caller: 'fixture-owner', expectedRevision: inspection.revision, expectedIdentity: inspection.identity }
  return { persistence, snapshot, log, source: dirname(log), options }
}

it('fails with the typed disabled error in both directions and leaves no lock or trash footprint', async () => {
  const persistence = await backend(false)
  const capability = await persistence.maintenanceCapability()
  expect(capability).toMatchObject({ enabled: false, isolation: 'not-verified', batchBusy: false, trashRoot })
  for (const operation of ['delete', 'restore'] as const) {
    await expect(persistence.withMaintenance(id, operation, policy)).rejects.toBeInstanceOf(SessionMaintenanceDisabledError)
  }
  expect(await readdir(home)).toEqual([])
})

it('refuses an in-process writer, a shared-root backend writer, a reader, and a legacy kernel lease', async () => {
  const { persistence, source, options } = await fixture()
  const other = await backend()
  const writer = await persistence.open(id, 'write')
  expect(await persistence.withMaintenance(id, 'delete', policy, options)).toMatchObject({ status: 'refused', reason: 'writer' })
  expect(await other.withMaintenance(id, 'delete', policy, options)).toMatchObject({ status: 'refused', reason: 'lease' })
  await writer.close()
  const reader = await other.open(id, 'read')
  expect(await persistence.withMaintenance(id, 'delete', policy, options)).toMatchObject({ status: 'refused', reason: 'lease' })
  await reader.close()
  const legacy = await SessionWriteLease.acquire(source, id)
  try {
    expect(await persistence.withMaintenance(id, 'delete', policy, options)).toMatchObject({ status: 'refused', reason: 'lease' })
  } finally {
    await legacy.release()
  }
  await expect(lstat(trashRoot)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('keeps batch and writer ownership across an asynchronous policy callback', async () => {
  const { persistence, options } = await fixture()
  const other = await backend()
  const entered = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  const pending = persistence.withMaintenance(id, 'delete', async () => {
    entered.resolve()
    await resume.promise
    return { status: 'refused', reason: 'retain' }
  }, options)
  await Promise.race([entered.promise, pending.then(() => { throw new Error('admission did not run') })])
  try {
    expect((await other.maintenanceCapability()).batchBusy).toBe(true)
    expect(await other.withMaintenance(id, 'delete', policy, options)).toMatchObject({ status: 'refused', reason: 'batch-busy' })
    await expect(other.open(id, 'write')).rejects.toMatchObject({ name: 'SessionAlreadyOwnedError' })
  } finally {
    resume.resolve()
    expect(await pending).toMatchObject({ status: 'refused', reason: 'admission' })
  }
  await expect(lstat(trashRoot)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('rechecks filesystem identity after admission and leaves no intent on refusal or policy error', async () => {
  const { persistence, options, log, source } = await fixture()
  expect(await persistence.withMaintenance(id, 'delete', async () => ({ status: 'refused', reason: 'running' }), options))
    .toMatchObject({ status: 'refused', reason: 'admission', detail: 'running' })
  expect(await persistence.withMaintenance(id, 'delete', async () => { throw new Error('provider disconnected') }, options))
    .toMatchObject({ status: 'refused', reason: 'admission', detail: 'provider disconnected' })
  expect(await persistence.withMaintenance(id, 'delete', async () => {
    await appendFile(log, '\n')
    return policy()
  }, options)).toMatchObject({ status: 'refused', reason: 'revision-changed' })
  expect(await persistence.withMaintenance(id, 'delete', policy, options)).toMatchObject({ status: 'refused', reason: 'revision-changed' })
  expect((await lstat(source)).isDirectory()).toBe(true)
  await expect(lstat(trashRoot)).rejects.toMatchObject({ code: 'ENOENT' })
})

async function moved() {
  const f = await fixture()
  const result = await f.persistence.withMaintenance(id, 'delete', async (ctx: SessionMaintenanceContext) => {
    expect(ctx.hostChecks).toMatchObject({ preRevision: f.options.expectedRevision, sameVolume: true, writerIdle: true, leaseIdle: true })
    return policy()
  }, f.options)
  expect(result.status, JSON.stringify(result)).toBe('moved')
  if (result.status !== 'moved') throw new Error(JSON.stringify(result))
  const entry = result.entry
  return {
    ...f, entry, target: join(trashRoot, entry.hostChecks.targetRelative), manifest: join(trashRoot, entry.batchId, 'manifest.json'),
    restore: { caller: 'fixture-owner', batchId: entry.batchId, expectedOperationId: entry.operationId },
  }
}

it('persists a segregated audit, moves and restores without replacing an occupied target', async () => {
  const f = await moved()
  const bytes = await readFile(join(f.target, f.log.split(/[\\/]/u).at(-1)!))
  await expect(lstat(f.source)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(JSON.parse(await readFile(f.manifest, 'utf8'))).toMatchObject({
    schemaVersion: 1, operation: 'delete', state: 'moved',
    claims: { caller: 'fixture-owner', source: 'fixture', live: false, archived: true, workspace: { position: 2 } },
    hostChecks: { observedIdentity: { entriesHash: expect.any(String) }, expectedIdentity: f.options.expectedIdentity, sameVolume: true, preRevision: f.snapshot.revision },
  })
  expect(await f.persistence.stat(id)).toBeUndefined()
  await expect(f.persistence.create(meta)).rejects.toMatchObject({ name: 'SessionAlreadyExistsError' })
  await expect(f.persistence.open(id, 'write')).rejects.toMatchObject({ name: 'SessionAlreadyOwnedError' })
  await mkdir(f.source)
  await writeFile(join(f.source, 'keep'), 'untouched')
  expect(await f.persistence.withMaintenance(id, 'restore', policy, f.restore)).toMatchObject({ status: 'refused', reason: 'conflict' })
  expect(await readFile(join(f.source, 'keep'), 'utf8')).toBe('untouched')
  await rm(f.source, { recursive: true })
  const restored = await f.persistence.withMaintenance(id, 'restore', policy, f.restore)
  expect(restored, JSON.stringify(restored)).toMatchObject({ status: 'moved', entry: { operation: 'restore' } })
  expect(await readFile(f.log)).toEqual(bytes)
  const writer = await f.persistence.open(id, 'write')
  await writer.close()
  await expect(lstat(f.target)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await f.persistence.listMaintenanceBatches()).toMatchObject({ status: 'ok', batches: [{ status: 'restored' }] })
})

it.each([
  ['source-only', 'not-moved'], ['target-only', 'moved'], ['both', 'quarantined'], ['neither', 'quarantined'], ['wrong-identity', 'quarantined'],
] as const)('reconciles an interrupted intent: %s → %s', async (quadrant, expected) => {
  const f = await moved()
  const { reservation: _old, ...intent } = f.entry
  await writeFile(f.manifest, JSON.stringify({ ...intent, state: 'intent' }))
  if (quadrant === 'source-only') await rename(f.target, f.source)
  if (quadrant === 'both') await mkdir(f.source)
  if (quadrant === 'neither') await rm(f.target, { recursive: true })
  if (quadrant === 'wrong-identity') await appendFile(join(f.target, f.log.split(/[\\/]/u).at(-1)!), '\n')
  const reopened = await backend()
  expect(await reopened.recoverMaintenance()).toMatchObject({ status: 'ok', batches: [{ status: expected, deletion: { state: expected } }] })
  const saved = await readFile(f.manifest, 'utf8')
  expect(await reopened.recoverMaintenance()).toMatchObject({ status: 'ok', batches: [{ status: expected }] })
  expect(await readFile(f.manifest, 'utf8')).toBe(saved)
})

it('reports a recorded empty reservation and releases only that verified empty directory on explicit request', async () => {
  const f = await moved()
  await rename(f.target, f.source)
  await mkdir(f.target)
  const s = await lstat(f.target, { bigint: true })
  await writeFile(f.manifest, JSON.stringify({ ...f.entry, state: 'reserved', reservation: { device: String(s.dev), inode: String(s.ino) } }))
  expect(await f.persistence.recoverMaintenance()).toMatchObject({ status: 'ok', batches: [{ status: 'reserved-empty' }] })
  expect((await lstat(f.target)).isDirectory()).toBe(true)
  await writeFile(join(f.target, 'keep'), 'other occupant')
  expect(await f.persistence.releaseMaintenanceReservation(f.entry.batchId, f.entry.operationId)).toMatchObject({ status: 'refused', reason: 'conflict' })
  expect(await readFile(join(f.target, 'keep'), 'utf8')).toBe('other occupant')
  await rm(join(f.target, 'keep'))
  expect(await f.persistence.releaseMaintenanceReservation(f.entry.batchId, f.entry.operationId)).toMatchObject({ status: 'ok', batches: [{ status: 'not-moved' }] })
  await expect(lstat(f.target)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await f.persistence.stat(id)).toBeDefined()
})

it('isolates damaged journals without overwriting or moving either side', async () => {
  const f = await moved()
  await writeFile(f.manifest, '{truncated')
  expect(await f.persistence.recoverMaintenance()).toMatchObject({ status: 'ok', batches: [{ status: 'quarantined' }] })
  expect(await f.persistence.withMaintenance(id, 'restore', policy, f.restore)).toMatchObject({ status: 'refused', reason: 'recovery-required' })
  expect(await readFile(f.manifest, 'utf8')).toBe('{truncated')
  expect((await lstat(f.target)).isDirectory()).toBe(true)
})

it('previews without creating a lock, batch or other file, including when maintenance is disabled', async () => {
  const persistence = await backend(false)
  const writer = await persistence.create(meta)
  await writer.flush()
  await writer.close()
  const before = (await readdir(home, { recursive: true })).sort()
  expect(await persistence.inspectMaintenance(id)).toMatchObject({
    state: 'available', id, sameVolume: true, migrationPending: false,
    identity: { generations: [{ version: SESSION_FORMAT_VERSION, digest: expect.any(String) }] },
  })
  expect((await readdir(home, { recursive: true })).sort()).toEqual(before)
})

it('binds retained generation bytes to the preview before and after admission', async () => {
  const f = await fixture()
  const history = join(f.source, 'session.v' + (SESSION_FORMAT_VERSION - 1) + '.jsonl')
  await writeFile(history, 'retained immutable generation fixture')
  const first = await f.persistence.inspectMaintenance(id)
  if (first.state !== 'available') throw new Error(JSON.stringify(first))
  const options = { ...f.options, expectedIdentity: first.identity }
  expect(first.identity.generations).toHaveLength(2)
  expect(await f.persistence.withMaintenance(id, 'delete', async () => {
    await appendFile(history, '!')
    return policy()
  }, options)).toMatchObject({ status: 'refused', reason: 'identity-changed' })
  expect(await f.persistence.withMaintenance(id, 'delete', policy, options))
    .toMatchObject({ status: 'refused', reason: 'identity-changed' })
  expect(await f.persistence.stat(id)).toMatchObject({ revision: first.revision })
  expect(await f.persistence.listMaintenanceBatches()).toEqual({ status: 'ok', batches: [] })
})

it('refuses both a migration staging file and a different historical-only session under the same root', async () => {
  const f = await fixture()
  const stage = join(f.source, 'session.migration.fake.jsonl.tmp')
  await writeFile(stage, 'staging')
  expect(await f.persistence.inspectMaintenance(id)).toMatchObject({ state: 'migration-pending', migrationPending: true })
  expect(await f.persistence.withMaintenance(id, 'delete', policy, f.options))
    .toMatchObject({ status: 'refused', reason: 'migration-pending' })
  await rm(stage)
  const sibling = join(dirname(f.source), 'other-pending')
  await mkdir(sibling)
  await writeFile(join(sibling, 'session.v' + (SESSION_FORMAT_VERSION - 1) + '.jsonl'), 'older generation fixture')
  expect(await f.persistence.withMaintenance(id, 'delete', policy, f.options))
    .toMatchObject({ status: 'refused', reason: 'migration-pending' })
  expect(await f.persistence.listMaintenanceBatches()).toEqual({ status: 'ok', batches: [] })
})

it('rejects linked project directories instead of following their targets', async () => {
  const f = await fixture()
  await symlink(dirname(f.source), join(root, 'linked-project'), process.platform === 'win32' ? 'junction' : 'dir')
  expect(await f.persistence.withMaintenance(id, 'delete', policy, f.options)).toMatchObject({ status: 'refused', reason: 'corrupt' })
  expect((await lstat(f.source)).isDirectory()).toBe(true)
})
