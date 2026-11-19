import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { referenceDescendants, SessionMaintenanceDisabledError, type MaintenanceEpoch, type ReferenceArtifactRef, type SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import * as jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { appendFile, lstat, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'

type Compression = 'none' | 'zstd'
const contexts: Context[] = []
let home: string
let root: string

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-root-gate-')))
  root = join(home, 'sessions')
})

afterEach(async () => {
  try {
    for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

async function backend(enabled = true, compression: Compression = 'none') {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(jsonl, { root, compression, maintenance: { enabled } })
  return ctx.sessionPersistence
}

function header(id: string, parent?: string): SessionHeader {
  return { version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: 1, isSeeded: false,
    ...(parent === undefined ? {} : { parentSession: SessionId(parent) }) }
}

async function stored(host: SessionPersistence, id: string, parent?: string, events: readonly SessionEvent[] = []) {
  const writer = await host.create(header(id, parent))
  try {
    await writer.flush()
    for (const event of events) {
      await writer.append([event])
      await writer.flush()
    }
  } finally {
    await writer.close()
  }
  const path = (await host.stat(SessionId(id)))?.location?.path
  if (path === undefined) throw new Error('missing fixture log')
  return path
}

it('keeps root admission shared until close and refuses exclusive acquisitions immediately', async () => {
  const one = await backend()
  const two = await backend()
  expect(await two.maintenanceGate()).toMatchObject({ active: false })
  expect(await readdir(home)).toEqual([])
  const first = await one.create(header('first'))
  try {
    const second = await two.create(header('second'))
    try {
      expect(await two.maintenanceGate()).toMatchObject({ active: false })
      await expect(two.withExclusiveMaintenance('operator', async () => {})).rejects.toMatchObject({ reason: 'maintenance-gate' })
      await expect(lstat(root)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await second.close()
    }
  } finally {
    await first.close()
  }
  await expect(two.withExclusiveMaintenance('operator', async () => 'settled')).resolves.toBe('settled')
  await expect(lstat(root)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('denies every new handle and unrelated B2a mutation before per-session locks or directories', async () => {
  const owner = await backend()
  const peer = await backend()
  const disabled = await backend(false)
  const id = SessionId('existing')
  const path = await stored(owner, id)
  const lockRoot = (await owner.maintenanceCapability()).lockRoot!
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const exclusive = owner.withExclusiveMaintenance('operator', async (epoch) => {
    expect(await owner.maintenanceGate()).toMatchObject({ active: true, holder: 'operator', since: expect.any(String) })
    expect(await owner.inspectMaintenance(id)).toMatchObject({ state: 'available', gate: { active: true } })
    expect(await owner.inspectReferenceCorpus()).toMatchObject({ state: 'complete', epoch })
    entered.resolve()
    await release.promise
  })
  try {
    await Promise.race([entered.promise, exclusive.then(() => { throw new Error('exclusive callback left before release') })])
    const files = await readdir(lockRoot)
    expect(files).toContain('root.lock')
    expect(await peer.maintenanceGate()).toMatchObject({ active: true })
    expect(await peer.inspectMaintenance(id)).toMatchObject({ state: 'maintenance-gate', gate: { active: true } })
    expect(await peer.inspectReferenceCorpus()).toMatchObject({ state: 'unknown', reason: { code: 'maintenance-gate', gate: { active: true } } })
    await expect(peer.recoverMaintenance()).resolves.toMatchObject({ status: 'refused', reason: 'maintenance-gate' })
    for (const operation of [() => peer.create(header('blocked')), () => peer.open(id, 'read'), () => peer.open(id, 'write')]) {
      await expect(operation()).rejects.toMatchObject({ reason: 'maintenance-gate', code: 'SESSION_MAINTENANCE_GATE' })
    }
    expect(await readdir(lockRoot)).toEqual(files)
    expect(await readdir(dirname(dirname(path)))).toEqual([id])
    const legacy = await disabled.open(id, 'read')
    await legacy.close()
    const pending = await disabled.create(header('legacy'))
    await pending.close()
    await expect(disabled.maintenanceGate()).rejects.toBeInstanceOf(SessionMaintenanceDisabledError)
    await expect(disabled.inspectReferenceCorpus()).rejects.toBeInstanceOf(SessionMaintenanceDisabledError)
    await expect(disabled.withExclusiveMaintenance('disabled', async () => {})).rejects.toBeInstanceOf(SessionMaintenanceDisabledError)
    expect(await readdir(lockRoot)).toEqual(files)
  } finally {
    release.resolve()
    await exclusive
  }
  expect(await peer.maintenanceGate()).toMatchObject({ active: false })
  expect(await peer.inspectReferenceCorpus()).toEqual({ state: 'unknown', reason: { code: 'gate-required' } })
})

it('releases on cancellation and callback error and never reuses an epoch', async () => {
  const host = await backend()
  const called = () => { throw new Error('aborted callback ran') }
  const signal = AbortSignal.abort(new Error('cancelled'))
  await expect(host.withExclusiveMaintenance('operator', async () => called(), { signal })).rejects.toThrow('cancelled')
  expect(await readdir(home)).toEqual([])
  const first = await host.withExclusiveMaintenance('operator', async epoch => epoch)
  await expect(host.withExclusiveMaintenance('operator', async () => { throw new Error('test rejection') })).rejects.toThrow('test rejection')
  const second = await host.withExclusiveMaintenance('operator', async epoch => epoch)
  expect(second).not.toBe(first)
})

it('validates only the initiating async scope and rejects stale explicit census epochs', async () => {
  const host = await backend()
  const entered = Promise.withResolvers<MaintenanceEpoch>()
  const hold = Promise.withResolvers<void>()
  const detached = Promise.withResolvers<void>()
  const detachedResult = Promise.withResolvers<boolean>()
  const first = host.withExclusiveMaintenance('first', async (epoch) => {
    expect(host.isMaintenanceEpochActive(epoch)).toBe(true)
    entered.resolve(epoch)
    void detached.promise.then(() => detachedResult.resolve(host.isMaintenanceEpochActive(epoch)))
    await hold.promise
    expect(host.isMaintenanceEpochActive(epoch)).toBe(true)
    return epoch
  })
  const epoch = await Promise.race([entered.promise, first.then(() => { throw new Error('first scope settled too early') })])
  try {
    expect(host.isMaintenanceEpochActive(epoch)).toBe(false)
    await expect(host.withExclusiveMaintenance('contender', async () => {})).rejects.toMatchObject({ reason: 'maintenance-gate' })
    expect(await host.inspectReferenceCorpus({ epoch })).toMatchObject({ state: 'unknown', reason: { code: 'stale-epoch' } })
  } finally {
    hold.resolve()
    await first
  }
  expect(host.isMaintenanceEpochActive(epoch)).toBe(false)
  expect(await host.inspectReferenceCorpus({ epoch })).toMatchObject({ state: 'unknown', reason: { code: 'stale-epoch' } })
  await host.withExclusiveMaintenance('second', async (next) => {
    expect(host.isMaintenanceEpochActive(epoch)).toBe(false)
    expect(host.isMaintenanceEpochActive(next)).toBe(true)
    expect(await host.inspectReferenceCorpus({ epoch })).toMatchObject({ state: 'unknown', reason: { code: 'stale-epoch' } })
    expect(await host.inspectReferenceCorpus({ epoch: next })).toEqual({ state: 'complete', epoch: next, items: [] })
    detached.resolve()
    expect(await detachedResult.promise).toBe(false)
  })
})

it.each(['none', 'zstd'] as const)('includes current active and restorable trash lineage (%s)', async (compression) => {
  const host = await backend(true, compression)
  await stored(host, 'parent')
  await stored(host, 'child', 'parent')
  await stored(host, 'grandchild', 'child', [
    { type: 'feedback/record', seq: SessionSeq(0), time: 2, data: { text: 'one' } },
    { type: 'feedback/record', seq: SessionSeq(1), time: 3, data: { text: 'two' } },
  ])
  const id = SessionId('grandchild')
  await host.withExclusiveMaintenance('temporary corpus fixture', async (epoch) => {
    const preview = await host.inspectMaintenance(id)
    if (preview.state !== 'available') throw new Error(JSON.stringify(preview))
    const moved = await host.withMaintenance(id, 'delete', async () => ({ status: 'admitted', evidence: {
      source: 'temporary corpus fixture', version: 1, archived: true, live: false, references: { descendants: 0, teamTasks: 0 },
    } } as const), { caller: 'test', expectedIdentity: preview.identity, expectedRevision: preview.revision })
    expect(moved).toMatchObject({ status: 'moved' })
    const corpus = await host.inspectReferenceCorpus()
    expect(corpus).toMatchObject({ state: 'complete', epoch, items: [
      { id: 'child', parentSession: 'parent', location: { kind: 'active' }, layout: 'current' },
      { id: 'parent', location: { kind: 'active' } },
      { id: 'grandchild', parentSession: 'child', location: { kind: 'trash' }, revision: preview.revision, identity: preview.identity },
    ] })
    if (corpus.state !== 'complete') throw new Error(JSON.stringify(corpus))
    const trash = corpus.items.find(item => item.id === id)!
    const entries = await readdir(home, { recursive: true })
    const visited: string[] = []
    expect(await host.inspectReferenceLog(epoch, trash, (event) => { visited.push(event.type) })).toEqual({
      state: 'complete', epoch, items: [{ events: 2, inheritedEventCount: 0 }],
    })
    expect(visited).toEqual(['feedback/record', 'feedback/record'])
    expect(await readdir(home, { recursive: true })).toEqual(entries)
    expect(referenceDescendants(corpus, SessionId('parent'))).toMatchObject({ state: 'complete', epoch, items: [
      { depth: 1, artifact: { id: 'child' } }, { depth: 2, artifact: { id: 'grandchild', location: { kind: 'trash' } } },
    ] })
    expect(await host.inspectReferenceCorpus({ includeTrash: false })).toMatchObject({ state: 'complete', epoch, items: [
      { id: 'child' }, { id: 'parent' },
    ] })
  })
})

async function raw(id: string, version: number, parent?: string, cwd?: string, project = '_no-cwd') {
  const dir = join(root, project, id)
  await mkdir(dir, { recursive: true })
  const log = join(dir, 'session.v' + version + '.jsonl')
  await writeFile(log, JSON.stringify({ ...header(id, parent), type: 'session', version, delegationDepth: 0, cwd }) + '\n')
  return log
}

it('accepts a v3 head without migrating it; reports missing parents and cycles separately', async () => {
  const host = await backend()
  await raw('historical', 3, 'missing')
  await host.withExclusiveMaintenance('operator', async (epoch) => {
    const corpus = await host.inspectReferenceCorpus()
    expect(corpus).toMatchObject({ state: 'complete', epoch, items: [{ id: 'historical', layout: 'migration-required', generations: [{ version: 3 }] }] })
    expect(referenceDescendants(corpus, SessionId('missing'))).toMatchObject({ state: 'unknown', reason: { code: 'lineage', detail: 'missing parent: missing' } })
  })
  expect(await readdir(join(root, '_no-cwd', 'historical'))).toEqual(['session.v3.jsonl'])
  await raw('missing', 4, 'historical')
  await host.withExclusiveMaintenance('operator', async () => {
    const corpus = await host.inspectReferenceCorpus()
    expect(referenceDescendants(corpus, SessionId('missing'))).toMatchObject({ state: 'unknown', reason: { code: 'lineage', detail: expect.stringContaining('cycle') } })
  })
})

it.each(['bad-header', 'unsupported-generation', 'layout', 'migration-pending', 'trash-unresolved'] as const)
('returns unknown %s rather than an incomplete collection', async (code) => {
  const host = await backend()
  const path = await raw('session', 4)
  if (code === 'bad-header') await writeFile(path, '{}\n')
  if (code === 'unsupported-generation') await raw('session', 5)
  if (code === 'layout') await writeFile(join(root, '_no-cwd', 'flat.jsonl'), '')
  if (code === 'migration-pending') await writeFile(join(dirname(path), 'session.migration.pending.tmp'), '')
  if (code === 'trash-unresolved') await mkdir(join(home, 'trash', 'sessions', 'unexpected'), { recursive: true })
  await host.withExclusiveMaintenance('operator', async () => {
    expect(await host.inspectReferenceCorpus()).toMatchObject({ state: 'unknown', reason: { code } })
  })
})

it('refuses a malformed predecessor even when the current generation is readable', async () => {
  const host = await backend()
  await raw('session', 4)
  await writeFile(await raw('session', 3), '{bad historical header\n')
  await host.withExclusiveMaintenance('operator', async () => {
    expect(await host.inspectReferenceCorpus()).toMatchObject({ state: 'unknown', reason: { code: 'bad-header' } })
  })
})

it('refuses duplicate ids across valid project directories', async () => {
  const host = await backend()
  await raw('duplicate', 4)
  const cwd = join(home, 'private')
  const { projectKey } = await import('../src/format.ts')
  await raw('duplicate', 4, undefined, cwd, projectKey(cwd))
  await host.withExclusiveMaintenance('operator', async () => {
    expect(await host.inspectReferenceCorpus()).toMatchObject({ state: 'unknown', reason: { code: 'duplicate-id' } })
  })
})

it('streams active v3 source events, reports the exact inherited cut, and refuses stale or cloned refs', async () => {
  const host = await backend()
  const path = await raw('fork', 3, 'parent')
  const rows = [
    { type: 'session', version: 3, id: 'fork', createdAt: 1, isSeeded: true, delegationDepth: 0, parentSession: 'parent' },
    { type: 'feedback/record', seq: 0, time: 2, data: { text: 'inherited' } },
    { type: 'session/end-seed', seq: 1, time: 3, data: { inherited: true } },
    { type: 'feedback/record', seq: 2, time: 4, data: { text: 'own' } },
  ]
  await writeFile(path, rows.map(row => JSON.stringify(row) + '\n').join(''))
  const { epoch, artifact } = await host.withExclusiveMaintenance('reader', async (epoch) => {
    const artifact = await retained(host, epoch)
    const before = await readdir(home, { recursive: true })
    const seen: number[] = []
    expect(await host.inspectReferenceLog(epoch, artifact, (event) => { seen.push(event.seq) })).toEqual({
      state: 'complete', epoch, items: [{ events: 3, inheritedEventCount: 1 }],
    })
    expect(seen).toEqual([0, 1, 2])
    expect(await host.inspectReferenceLog(epoch, { ...artifact }, () => {})).toMatchObject({ state: 'unknown', reason: { code: 'artifact-ref' } })
    expect(await readdir(home, { recursive: true })).toEqual(before)
    return { epoch, artifact }
  })
  expect(await host.inspectReferenceLog(epoch, artifact, () => {})).toMatchObject({ state: 'unknown', reason: { code: 'stale-epoch' } })
  await host.withExclusiveMaintenance('next', async (next) => {
    expect(await host.inspectReferenceLog(next, artifact, () => {})).toMatchObject({ state: 'unknown', reason: { code: 'artifact-ref' } })
  })
})

async function retained(host: SessionPersistence, epoch: MaintenanceEpoch): Promise<ReferenceArtifactRef> {
  const corpus = await host.inspectReferenceCorpus({ epoch })
  const first = corpus.state === 'complete' ? corpus.items[0] : undefined
  if (first === undefined) throw new Error(JSON.stringify(corpus))
  return first
}

it.each([
  ['bad-event', 'not-json\n'],
  ['bad-event', '{"type":"feedback/record","seq":2,"time":2,"data":{}}\n'],
  ['truncated', '{"type":'],
] as const)('does not return complete body evidence on %s', async (code, body) => {
  const host = await backend()
  await appendFile(await raw('artifact', 4), body)
  await host.withExclusiveMaintenance('reader', async (epoch) => {
    expect(await host.inspectReferenceLog(epoch, await retained(host, epoch), () => {}))
      .toMatchObject({ state: 'unknown', reason: { code } })
  })
})

it('bounds a multi-chunk body and detects file changes made while visiting', async () => {
  const host = await backend()
  const path = await raw('large', 4)
  const rows = Array.from({ length: 10_000 }, (_, seq) => JSON.stringify({ type: 'feedback/record', seq, time: seq + 1, data: { text: 'row' } }) + '\n').join('')
  await appendFile(path, rows)
  await host.withExclusiveMaintenance('reader', async (epoch) => {
    const artifact = await retained(host, epoch)
    let seen = 0
    const visit = () => { seen++ }
    expect(await host.inspectReferenceLog(epoch, artifact, visit, { maxEvents: 10 })).toMatchObject({ state: 'unknown', reason: { code: 'event-limit' } })
    expect(seen).toBe(10)
    seen = 0
    expect(await host.inspectReferenceLog(epoch, artifact, visit, { maxEvents: 10_000 })).toMatchObject({ state: 'complete', items: [{ events: 10_000 }] })
    expect(seen).toBe(10_000)
    expect(await host.inspectReferenceLog(epoch, artifact, visit, { signal: AbortSignal.abort() })).toMatchObject({ state: 'unknown', reason: { code: 'aborted' } })
    const { appendFileSync } = await import('node:fs')
    let changed = false
    const result = await host.inspectReferenceLog(epoch, artifact, () => {
      if (!changed) {
        changed = true
        appendFileSync(path, JSON.stringify({ type: 'feedback/record', seq: 10_000, time: 1, data: { text: 'concurrent' } }) + '\n')
      }
    })
    expect(result).toMatchObject({ state: 'unknown', reason: { code: 'unstable' } })
  })
})

it('stops a detached body visitor when the exclusive callback settles', async () => {
  const host = await backend()
  const path = await raw('large', 4)
  await appendFile(path, Array.from({ length: 10_000 }, (_, seq) => JSON.stringify({
    type: 'feedback/record', seq, time: 1, data: { text: 'chunk' },
  }) + '\n').join(''))
  const observed = Promise.withResolvers<void>()
  let seen = 0
  const { reading } = await host.withExclusiveMaintenance('reader', async (epoch) => {
    const artifact = await retained(host, epoch)
    const reading = host.inspectReferenceLog(epoch, artifact, () => { if (++seen === 1) observed.resolve() })
    await Promise.race([observed.promise, reading.then(() => { throw new Error('body returned before visiting') })])
    return { reading }
  })
  expect(await reading).toMatchObject({ state: 'unknown', reason: { code: 'stale-epoch' } })
  expect(seen).toBeGreaterThan(0)
  expect(seen).toBeLessThan(10_000)
  expect(await host.maintenanceGate()).toMatchObject({ active: false })
})

it('rejects a linked artifact directory instead of visiting another root', async () => {
  const host = await backend()
  await raw('kept', 4)
  const outside = join(home, 'outside-sessions')
  await mkdir(outside)
  await symlink(outside, join(root, '_no-cwd', 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  await host.withExclusiveMaintenance('reader', async (epoch) => {
    expect(await host.inspectReferenceCorpus({ epoch })).toMatchObject({ state: 'unknown', reason: { code: 'layout' } })
  })
})
