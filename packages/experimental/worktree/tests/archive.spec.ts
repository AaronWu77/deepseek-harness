import { access, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox, unsupportedModel } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SessionStore, { appendPluginRecord, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type { MaintenanceEpoch } from '@deepseek-ai/dsh-session-persistence'
import * as SessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionProjectionCache from '@deepseek-ai/dsh-session-projection-cache'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import type { SessionEventSearchPage, SessionSearchHit, SessionSearchPage } from '@deepseek-ai/dsh-session-query'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import WorkingDirectoryService from '@deepseek-ai/dsh-working-directory'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import type {} from '../src/archive.ts'
import WorktreeService, { CREATED_RECORD, worktreeProjection } from '../src/index.ts'
import type { WorktreeCleanup } from '../src/index.ts'
import * as removal from '../src/removal.ts'
import { ReferenceProducerGate } from '../src/reference-quiescence.ts'
import { git, repository, UnusedSandbox } from './harness.ts'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'

/** Archive tests only use the query service's listing and observation APIs. */
class ArchiveQueries extends SessionQueryEngine {
  searchSessions(): Promise<SessionSearchPage<SessionSearchHit>> { throw new Error('search is not used') }
  searchEvents(): Promise<SessionEventSearchPage> { throw new Error('search is not used') }
}

vi.mock('../src/removal.ts', async (importActual) => {
  const actual = await importActual<typeof import('../src/removal.ts')>()
  return { ...actual, removeCheckout: vi.fn(actual.removeCheckout) }
})

const removeCheckout = vi.mocked(removal.removeCheckout)
/** The unmocked removal step, for interceptors that delay or observe it. */
const actualRemoveCheckout = (await vi.importActual<typeof import('../src/removal.ts')>('../src/removal.ts')).removeCheckout

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  removeCheckout.mockReset()
  removeCheckout.mockImplementation(actualRemoveCheckout)
  vi.restoreAllMocks()
})

function agentFor(ctx: Context, session: Session): Agent {
  const scope = ctx.plugin(() => {})
  const agent: Agent = {
    id: session.id, session, options: {}, status: 'idle', ctx: scope.ctx, model: unsupportedModel(),
    inbox: unsupportedInbox(),
    send() {}, followup() {}, steer() {}, inject() {}, cancel() {},
    whenIdle: async () => {}, runMaintenance: task => task(new AbortController().signal),
  }
  return agent
}

async function fixture(options: { cache?: boolean; retainOnArchive?: boolean; maxOutputBytes?: number; maintenance?: boolean; referenceQuiescence?: boolean } = {}) {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'dsh-worktree-archive-')))
  cleanups.push(() => rm(temporary, { recursive: true, force: true }))
  const root = await repository(temporary)
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(LocalFileSystem, { cwd: root })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(UnusedSandbox)
  await ctx.plugin(SandboxPolicyService, { mode: 'danger-full-access', workspaceRoot: root })
  await ctx.plugin(WorkingDirectoryService)
  await ctx.plugin(SessionPersistence, { root: join(temporary, 'sessions'), compression: 'none', maintenance: { enabled: options.maintenance === true } })
  await ctx.plugin(ArchiveQueries)
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
  const domain = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', domain)
  ctx.provide('storageDomain', domain)
  if (options.cache === true) await ctx.plugin(SessionProjectionCache, { writeEveryEvents: 1_000, writeIntervalMs: 60_000 })
  await ctx.plugin(WorkspaceRegistry)
  const { cache: _cache, maintenance: _maintenance, ...config } = options
  const worktrees = ctx.plugin(WorktreeService, config)
  await worktrees
  const session = ctx.sessions.create(SessionId('archive-owner'), { meta: { cwd: root } })
  const agent = agentFor(ctx, session)
  await ctx.agents.register(agent)
  const worktree = await ctx.worktrees.create(agent, { name: 'archive-me' })
  return { ctx, root, session, agent, worktree, temporary, worktrees }
}

type Fixture = Awaited<ReturnType<typeof fixture>>

/** The settled attempt of `session`, or null when the service registered none. */
async function settled(f: Fixture, session: Session = f.session): Promise<WorktreeCleanup | null> {
  const scheduled = await f.ctx.worktrees.cleanupOf(session, null)
  return scheduled === null ? null : await f.ctx.worktrees.cleanupOf(session, scheduled.revision)
}

async function persisted(f: Fixture, session: Session): Promise<void> {
  await using writer = await f.ctx.sessionPersistence.create(session.header, { inheritedEventCount: session.inheritedEventCount })
  await writer.append(session.snapshotEvents())
  await writer.flush()
  await writer.close()
}

/** A live Session whose store entry the test detaches itself, leaving only its persisted log. */
function detachable(f: Fixture, id: string, meta: { cwd?: string }): { session: Session; detach: () => void } {
  const session = f.ctx.sessions.prepare(SessionId(id), { meta })
  const detach = f.ctx.sessions.enter(session)
  f.ctx.sessions.announce(session)
  return { session, detach }
}

describe('Worktree checkout evidence', () => {
  it('finds a cold creation, inherited creation and a cwd-only borrower without opening Sessions', async () => {
    const f = await fixture({ maintenance: true })
    const owner = detachable(f, 'evidence-owner', { cwd: f.root })
    const agent = agentFor(f.ctx, owner.session)
    const registration = f.ctx.agents.register(agent)
    await registration
    const checkout = await f.ctx.worktrees.create(agent, { name: 'evidence-checkout' })
    const seed = owner.session.snapshotEvents()
    const fork = f.ctx.sessions.create(SessionId('evidence-fork'), {
      seed, inheritedEventCount: SessionLogOffset(seed.length), meta: { isSeeded: true, cwd: f.root, parentSession: owner.session.id },
    })
    const borrower = detachable(f, 'evidence-borrower', { cwd: checkout.path })
    for (const session of [owner.session, fork, borrower.session]) await persisted(f, session)
    await registration()
    owner.detach()
    borrower.detach()
    const open = vi.spyOn(f.ctx.sessionQuery, 'inspectSession')
    const ids = [owner.session.id, fork.id, borrower.session.id]
    const epoch = await f.ctx.sessionPersistence.withExclusiveMaintenance('worktree fixture', async epoch => {
      expect(await f.ctx.worktrees.inspectSessionCheckout(epoch, ids)).toEqual({ state: 'complete', epoch, items: [
        { kind: 'owned', sessionId: owner.session.id, path: checkout.path },
        { kind: 'cwd', sessionId: owner.session.id, path: checkout.path },
        { kind: 'inherited', sessionId: fork.id, path: checkout.path },
        { kind: 'cwd', sessionId: fork.id, path: checkout.path },
        { kind: 'cwd', sessionId: borrower.session.id, path: checkout.path },
      ] })
      return epoch
    })
    expect(open).not.toHaveBeenCalled()
    expect(f.ctx.sessions.get(owner.session.id)).toBeUndefined()
    expect(await f.ctx.worktrees.inspectSessionCheckout(epoch, ids)).toEqual({ state: 'unknown', reason: { code: 'stale-epoch' } })
    await access(checkout.path)
  })

  it('reports unknown when the recorded checkout cannot be located in Git', async () => {
    const f = await fixture({ maintenance: true })
    const cold = detachable(f, 'unregistered-checkout', { cwd: f.root })
    appendPluginRecord(cold.session, CREATED_RECORD, { ...f.worktree, path: f.worktree.path + '-not-registered' })
    await persisted(f, cold.session)
    cold.detach()
    await f.ctx.sessionPersistence.withExclusiveMaintenance('worktree fixture', async epoch => {
      expect(await f.ctx.worktrees.inspectSessionCheckout(epoch, [cold.session.id]))
        .toMatchObject({ state: 'unknown', reason: { code: 'unstable' } })
    })
  })

  it('does not spawn Git if the Host sandbox policy would require confinement', async () => {
    const f = await fixture({ maintenance: true })
    vi.spyOn(f.ctx.sandboxPolicy, 'resolve').mockReturnValue({ mode: 'read-only', workspaceRoot: f.root })
    const spawn = vi.spyOn(f.ctx.subprocess, 'spawn')
    await f.ctx.sessionPersistence.withExclusiveMaintenance('worktree fixture', async epoch => {
      expect(await f.ctx.worktrees.inspectSessionCheckout(epoch, [f.session.id]))
        .toMatchObject({ state: 'unknown', reason: { code: 'io', detail: 'Worktree Git inspection requires a non-writing Host runner' } })
    })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('reports unknown without waiting on an archive cleanup that has not settled', async () => {
    const f = await fixture({ maintenance: true })
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    removeCheckout.mockImplementationOnce(async () => { started.resolve(); await release.promise; return false })
    try {
      await f.ctx.workspaceRegistry.archiveSession(f.session.id)
      await started.promise
      await f.ctx.sessionPersistence.withExclusiveMaintenance('worktree fixture', async (epoch: MaintenanceEpoch) => {
        expect(await f.ctx.worktrees.inspectSessionCheckout(epoch, [f.session.id]))
          .toMatchObject({ state: 'unknown', reason: { code: 'busy' } })
      })
    } finally {
      release.resolve()
      await settled(f)
    }
  })
})

describe('Worktree reference producer quiescence', () => {
  const busy = { code: 'REFERENCE_PRODUCER_BUSY', reason: 'busy', phase: 'held' }

  it('does not allocate or admit operations with the default configuration', async () => {
    const admit = vi.spyOn(ReferenceProducerGate.prototype, 'admit')
    const f = await fixture()
    const service = f.ctx.worktrees
    const fn = vi.fn(async () => {})
    expect(service.referenceQuiescenceEnabled()).toBe(false)
    expect(Reflect.get(service, 'referenceGate')).toBeUndefined()
    await expect(service.withReferenceQuiescence('disabled', fn))
      .rejects.toMatchObject({ code: 'REFERENCE_QUIESCENCE_DISABLED', reason: 'disabled' })
    expect(fn).not.toHaveBeenCalled()
    removeCheckout.mockResolvedValueOnce(false)
    await f.ctx.workspaceRegistry.archiveSession(f.session.id)
    expect(await settled(f)).toMatchObject({ status: 'retained' })
    expect(removeCheckout).toHaveBeenCalledOnce()
    expect(admit).not.toHaveBeenCalled()
  })

  it('drains earlier cleanup, refuses new create and restore, and releases on callback failure', async () => {
    const f = await fixture({ referenceQuiescence: true })
    const service = f.ctx.worktrees
    const admit = vi.spyOn(ReferenceProducerGate.prototype, 'admit')
    expect(service.referenceQuiescenceEnabled()).toBe(true)
    expect(admit).not.toHaveBeenCalled()
    const preAborted = AbortSignal.abort(new Error('cancelled before admission'))
    const enter = vi.fn(async ({ holder }: Readonly<{ holder: string }>) => {
      expect(holder).toBe('drain')
      expect(await settled(f)).toMatchObject({ status: 'retained' })
      await expect(service.create(f.agent, { name: 'blocked' })).rejects.toMatchObject(busy)
      await expect(service.restore(f.agent, f.worktree)).rejects.toMatchObject(busy)
      throw new Error('callback failed')
    })
    await expect(service.withReferenceQuiescence('pre-aborted', enter, { signal: preAborted })).rejects.toBe(preAborted.reason)
    expect(enter).not.toHaveBeenCalled()
    const started = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<void>()
    removeCheckout.mockImplementationOnce(async () => { started.resolve(); await finish.promise; return false })
    try {
      await f.ctx.workspaceRegistry.archiveSession(f.session.id)
      await started.promise
      await expect(service.withReferenceQuiescence('timeout', enter, { drainTimeoutMs: 0 }))
        .rejects.toMatchObject({ ...busy, phase: 'drain-timeout' })
      const maintenance = service.withReferenceQuiescence('drain', enter)
      const rejection = expect(maintenance).rejects.toThrow('callback failed')
      try {
        await expect(service.withReferenceQuiescence('competing', async () => {})).rejects.toMatchObject(busy)
        await expect(service.create(f.agent, { name: 'blocked-while-draining' })).rejects.toMatchObject(busy)
        expect(enter).not.toHaveBeenCalled()
      } finally {
        finish.resolve()
        await rejection
      }
      expect(enter).toHaveBeenCalledOnce()
      await expect(service.create(f.agent, { name: 'allowed-after-release' })).resolves.toMatchObject({ branch: 'allowed-after-release' })
    } finally {
      finish.resolve()
      await settled(f)
    }
  })

  it('replays valid archive intentions in order and cancels the superseded one without waiting', async () => {
    const f = await fixture({ referenceQuiescence: true })
    const { ctx } = f
    const service = ctx.worktrees
    const other = ctx.sessions.create(SessionId('other-owner'), { meta: { cwd: f.root } })
    const agent = agentFor(ctx, other)
    await ctx.agents.register(agent)
    await service.create(agent, { name: 'other-checkout' })
    const completed = Promise.withResolvers<void>()
    const order: SessionId[] = []
    removeCheckout.mockResolvedValue(false)
    ctx.on('worktree/cleanup', ({ sessionId, cleanup }) => {
      if (cleanup.status === 'retained') {
        order.push(sessionId)
        if (order.length === 2) completed.resolve()
      }
    })
    await service.withReferenceQuiescence('collect archive intents', async () => {
      await ctx.workspaceRegistry.archiveSession(f.session.id)
      await ctx.workspaceRegistry.unarchiveSession(f.session.id)
      await ctx.workspaceRegistry.archiveSession(other.id)
      await ctx.workspaceRegistry.archiveSession(f.session.id)
      expect(await service.cleanupOf(f.session, null)).toBeNull()
      expect(await service.cleanupOf(other, null)).toBeNull()
      expect(removeCheckout).not.toHaveBeenCalled()
    })
    await completed.promise
    expect(await settled(f)).toMatchObject({ status: 'retained' })
    expect(order).toEqual([other.id, f.session.id])
    expect(removeCheckout).toHaveBeenCalledTimes(2)
    await access(f.worktree.path)
  })
})

describe('archive-triggered worktree cleanup', () => {
  it('removes the clean checkout the archived Session created and keeps its branch and commits', async () => {
    const f = await fixture()
    await writeFile(join(f.worktree.path, 'local.txt'), 'not pushed\n')
    await git(f.worktree.path, 'add', 'local.txt')
    await git(f.worktree.path, 'commit', '-m', 'local commit')
    const head = await git(f.worktree.path, 'rev-parse', 'HEAD')
    const statuses: WorktreeCleanup['status'][] = []
    f.ctx.on('worktree/cleanup', ({ cleanup }) => { statuses.push(cleanup.status) })
    await f.ctx.workspaceRegistry.archiveSession(f.session.id)
    expect(await f.ctx.worktrees.cleanupOf(f.session, null)).toMatchObject({ status: 'scheduled' })
    expect(await settled(f)).toMatchObject({ status: 'removed' })
    expect(statuses).toEqual(['scheduled', 'removed'])
    await expect(access(f.worktree.path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await git(f.root, 'rev-parse', f.worktree.branch)).toBe(head)
    expect(f.ctx.workspaceRegistry.archivedSessionIds).toContain(f.session.id)
  })

  it('removes a clean checkout whose file listing exceeds maxOutputBytes', async () => {
    const f = await fixture({ maxOutputBytes: 1_024 })
    for (let index = 0; index < 64; index++) {
      await writeFile(join(f.worktree.path, `file-${String(index).padStart(3, '0')}-${'x'.repeat(24)}.txt`), `${index}\n`)
    }
    await git(f.worktree.path, 'add', '.')
    await git(f.worktree.path, 'commit', '-m', 'many files')
    expect((await git(f.worktree.path, 'ls-files', '-z')).length).toBeGreaterThan(1_024)
    await f.ctx.workspaceRegistry.archiveSession(f.session.id)
    expect(await settled(f)).toMatchObject({ status: 'removed' })
    await expect(access(f.worktree.path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('retains a checkout whose status output exceeds maxOutputBytes instead of failing', async () => {
    const f = await fixture({ maxOutputBytes: 1_024 })
    for (let index = 0; index < 64; index++) {
      await writeFile(join(f.worktree.path, `untracked-${String(index).padStart(3, '0')}-${'x'.repeat(24)}.txt`), `${index}\n`)
    }
    expect((await git(f.worktree.path, 'status', '--porcelain', '-z', '--untracked-files=all')).length).toBeGreaterThan(1_024)
    await f.ctx.workspaceRegistry.archiveSession(f.session.id)
    expect(await settled(f)).toMatchObject({ status: 'retained' })
    await access(join(f.worktree.path, 'untracked-000-xxxxxxxxxxxxxxxxxxxxxxxx.txt'))
  })

  it('removes a clean checkout when the worktree listing exceeds maxOutputBytes', async () => {
    const f = await fixture({ maxOutputBytes: 1_024 })
    for (let index = 0; index < 8; index++) await git(f.root, 'worktree', 'add', '--detach', join(f.temporary, `extra-${index}`))
    expect((await git(f.root, 'worktree', 'list', '--porcelain', '-z')).length).toBeGreaterThan(1_024)
    await f.ctx.workspaceRegistry.archiveSession(f.session.id)
    expect(await settled(f)).toMatchObject({ status: 'removed' })
    await expect(access(f.worktree.path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('returns from admission before the inspection runs', async () => {
    const f = await fixture()
    const release = Promise.withResolvers<undefined>()
    const list = f.ctx.sessionQuery.listSessions.bind(f.ctx.sessionQuery)
    vi.spyOn(f.ctx.sessionQuery, 'listSessions').mockImplementation(async (...args) => {
      await release.promise
      return await list(...args)
    })
    cleanups.push(async () => { release.resolve(undefined) })
    await f.ctx.workspaceRegistry.archiveSession(f.session.id)
    expect(await f.ctx.worktrees.cleanupOf(f.session, null)).toMatchObject({ status: 'scheduled' })
    release.resolve(undefined)
    expect(await settled(f)).toMatchObject({ status: 'removed' })
  })

  it('removes the checkout after the Session moved elsewhere, and the ordinary ensure contract holds afterwards', async () => {
    const f = await fixture()
    await f.ctx.workingDirectory.set(f.agent, f.root)
    await f.ctx.workspaceRegistry.archiveSession(f.session.id)
    expect(await settled(f)).toMatchObject({ status: 'removed' })
    await f.ctx.workspaceRegistry.unarchiveSession(f.session.id)
    await f.ctx.worktrees.restore(f.agent, f.worktree)
    await f.ctx.workingDirectory.set(f.agent, f.worktree.path)
    await f.ctx.workspaceRegistry.archiveSession(f.session.id)
    expect(await settled(f)).toMatchObject({ status: 'removed' })
    await f.ctx.workspaceRegistry.unarchiveSession(f.session.id)
    // The directory is gone: ensure recovers the original project as it documents, with no cleanup-specific failure.
    expect(await f.ctx.workingDirectory.ensure(f.agent)).toBe(f.root)
  })

  it('retains an untracked file but not ignored files', async () => {
    const f = await fixture()
    await writeFile(join(f.worktree.path, 'keep.txt'), 'keep')
    await f.ctx.workspaceRegistry.archiveSession(f.session.id)
    expect(await settled(f)).toMatchObject({ status: 'retained' })
    await access(f.worktree.path)
    await f.ctx.workspaceRegistry.unarchiveSession(f.session.id)
    await rm(join(f.worktree.path, 'keep.txt'))
    await git(f.worktree.path, 'config', 'core.excludesFile', join(f.root, 'exclude'))
    await writeFile(join(f.root, 'exclude'), '.env\n')
    await writeFile(join(f.worktree.path, '.env'), 'private fixture')
    await f.ctx.workspaceRegistry.archiveSession(f.session.id)
    expect(await settled(f)).toMatchObject({ status: 'removed' })
  })

  it('registers nothing for a Session that created no checkout or only inherited one', async () => {
    const f = await fixture()
    const other = f.ctx.sessions.create(SessionId('no-checkout'), { meta: { cwd: f.root } })
    await f.ctx.workspaceRegistry.archiveSession(other.id)
    expect(await f.ctx.worktrees.cleanupOf(other, null)).toBeNull()
    const seed = f.session.snapshotEvents()
    const fork = f.ctx.sessions.create(SessionId('fork'), {
      seed, inheritedEventCount: SessionLogOffset(seed.length), meta: { isSeeded: true, cwd: f.root },
    })
    await f.ctx.workspaceRegistry.archiveSession(fork.id)
    expect(await f.ctx.worktrees.cleanupOf(fork, null)).toBeNull()
    await access(f.worktree.path)
  })

  it('retains a checkout while a fork or a directory borrower is unarchived, and does not reconsider when they archive', async () => {
    const f = await fixture()
    const seed = f.session.snapshotEvents()
    const fork = f.ctx.sessions.create(SessionId('fork'), {
      seed, inheritedEventCount: SessionLogOffset(seed.length), meta: { isSeeded: true, cwd: f.root },
    })
    await f.ctx.workspaceRegistry.archiveSession(f.session.id)
    expect(await settled(f)).toMatchObject({ status: 'retained' })
    await access(f.worktree.path)
    await f.ctx.workspaceRegistry.archiveSession(fork.id)
    expect(await f.ctx.worktrees.cleanupOf(fork, null)).toBeNull()
    await access(f.worktree.path)
    await f.ctx.workspaceRegistry.unarchiveSession(f.session.id)
    const borrower = f.ctx.sessions.create(SessionId('borrower'), { meta: { cwd: f.worktree.path } })
    await f.ctx.workspaceRegistry.archiveSession(f.session.id)
    expect(await settled(f)).toMatchObject({ status: 'retained' })
    await f.ctx.workspaceRegistry.archiveSession(borrower.id)
    await access(f.worktree.path)
  })

  it('treats a subagent child beneath the archived Session as archived', async () => {
    const f = await fixture()
    const child = f.ctx.sessions.create(SessionId('child'), {
      meta: { cwd: f.worktree.path, origin: 'subagent', parentSession: f.session.id },
    })
    const grandchild = f.ctx.sessions.create(SessionId('grandchild'), {
      meta: { cwd: f.worktree.path, origin: 'subagent', parentSession: child.id },
    })
    expect(f.ctx.workspaceRegistry.archivedSessionIds).not.toContain(child.id)
    await f.ctx.workspaceRegistry.archiveSession(f.session.id)
    expect(await settled(f)).toMatchObject({ status: 'removed' })
    expect(f.ctx.workspaceRegistry.archivedSessionIds).not.toContain(grandchild.id)
  })

  it('retains a checkout for an unrelated subagent child that works inside it', async () => {
    const f = await fixture()
    const other = f.ctx.sessions.create(SessionId('other-parent'), { meta: { cwd: f.root } })
    f.ctx.sessions.create(SessionId('other-child'), { meta: { cwd: f.worktree.path, origin: 'subagent', parentSession: other.id } })
    await f.ctx.workspaceRegistry.archiveSession(f.session.id)
    expect(await settled(f)).toMatchObject({ status: 'retained' })
  })

  it('removes a persisted checkout without loading its Agent, reading cold Sessions from the projection cache when present', async () => {
    const f = await fixture({ cache: true })
    const owner = detachable(f, 'cold-owner', { cwd: f.root })
    const agent = agentFor(f.ctx, owner.session)
    const registration = f.ctx.agents.register(agent)
    await registration
    const worktree = await f.ctx.worktrees.create(agent, { name: 'cold-ui' })
    const bystander = detachable(f, 'cold-bystander', { cwd: f.root })
    await f.ctx.sessionProjectionCache.write(owner.session)
    await f.ctx.sessionProjectionCache.write(bystander.session)
    await persisted(f, owner.session)
    await persisted(f, bystander.session)
    await registration()
    owner.detach()
    bystander.detach()
    expect(f.ctx.sessions.get(owner.session.id)).toBeUndefined()
    const inspect = vi.spyOn(f.ctx.sessionQuery, 'inspectSession')
    await f.ctx.workspaceRegistry.archiveSession(owner.session.id)
    expect(await settled(f, owner.session)).toMatchObject({ status: 'removed' })
    // The creator is prepared once for its own creations and policy; the cached bystander never is.
    expect(inspect.mock.calls.map(call => call[0])).toEqual([owner.session.id, owner.session.id])
    expect(f.ctx.sessions.get(owner.session.id)).toBeUndefined()
    expect(f.ctx.agents.list().some(agent => agent.session.id === owner.session.id)).toBe(false)
    await expect(access(worktree.path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('retains a checkout while a live fork that moved elsewhere still carries its creation', async () => {
    const f = await fixture()
    const seed = f.session.snapshotEvents()
    const fork = f.ctx.sessions.create(SessionId('fork-elsewhere'), {
      seed, inheritedEventCount: SessionLogOffset(seed.length), meta: { isSeeded: true, cwd: f.root },
    })
    const agent = agentFor(f.ctx, fork)
    await f.ctx.agents.register(agent)
    await f.ctx.workingDirectory.set(agent, f.root)
    expect(f.ctx.workingDirectory.get(fork)).toBe(f.root)
    await f.ctx.workspaceRegistry.archiveSession(f.session.id)
    expect(await settled(f)).toMatchObject({ status: 'retained' })
    expect(removeCheckout).not.toHaveBeenCalled()
  })

  it('treats a cached cold Session that recorded no directory as working nowhere', async () => {
    const f = await fixture({ cache: true })
    const nowhere = detachable(f, 'cold-nowhere', {})
    await f.ctx.sessionProjectionCache.write(nowhere.session)
    await persisted(f, nowhere.session)
    nowhere.detach()
    await f.ctx.workspaceRegistry.archiveSession(f.session.id)
    expect(await settled(f)).toMatchObject({ status: 'removed' })
  })

  it('reads a cold Session from its log without the cache', async () => {
    const f = await fixture()
    const borrower = detachable(f, 'cold-borrower', { cwd: f.worktree.path })
    await persisted(f, borrower.session)
    borrower.detach()
    expect(f.ctx.sessions.get(borrower.session.id)).toBeUndefined()
    await f.ctx.workspaceRegistry.archiveSession(f.session.id)
    expect(await settled(f)).toMatchObject({ status: 'retained' })
  })

  it('does not wait for the archived Session\'s own stopping work', async () => {
    const f = await fixture()
    f.ctx.on('workspace/session-activity', async (_request, next) => [{ kind: 'turn' }, ...await next()])
    await f.ctx.workspaceRegistry.archiveSession(f.session.id, { stopActivity: true })
    expect(await settled(f)).toMatchObject({ status: 'removed' })
  })

  it('retains a checkout under its creator\'s read-only policy', async () => {
    const f = await fixture()
    f.session.append('sandbox/mode', { mode: 'read-only' })
    await f.ctx.workspaceRegistry.archiveSession(f.session.id)
    expect(await settled(f)).toMatchObject({ status: 'retained' })
    await access(f.worktree.path)
  })

  it('keeps the archive and reports a failed removal', async () => {
    const f = await fixture()
    const warning = vi.spyOn(f.ctx.logger, 'warn').mockImplementation(() => {})
    removeCheckout.mockRejectedValue(new Error('checkout removal denied'))
    await f.ctx.workspaceRegistry.archiveSession(f.session.id)
    expect(await settled(f)).toMatchObject({ status: 'failed' })
    expect(f.ctx.workspaceRegistry.archivedSessionIds).toContain(f.session.id)
    expect(warning).toHaveBeenCalledOnce()
    await access(f.worktree.path)
  })

  it('cancels an unadmitted removal on unarchive and waits for an admitted one', async () => {
    const f = await fixture()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    removeCheckout.mockImplementation(async (...args) => {
      entered.resolve(undefined)
      await release.promise
      return await actualRemoveCheckout(...args)
    })
    cleanups.push(async () => { release.resolve(undefined) })
    await f.ctx.workspaceRegistry.archiveSession(f.session.id)
    await entered.promise
    const unarchive = f.ctx.workspaceRegistry.unarchiveSession(f.session.id)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(f.ctx.workspaceRegistry.archivedSessionIds).toContain(f.session.id)
    release.resolve(undefined)
    await unarchive
    expect(f.ctx.workspaceRegistry.archivedSessionIds).not.toContain(f.session.id)
    expect(await f.ctx.worktrees.cleanupOf(f.session, null)).toBeNull()
    await access(f.worktree.path)
    expect(await f.ctx.workingDirectory.ensure(f.agent)).toBe(f.worktree.path)
  })

  it('holds directory entry into a checkout being removed and leaves other paths alone', async () => {
    const f = await fixture()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    removeCheckout.mockImplementation(async (...args) => {
      entered.resolve(undefined)
      await release.promise
      return await actualRemoveCheckout(...args)
    })
    cleanups.push(async () => { release.resolve(undefined) })
    await f.ctx.workingDirectory.set(f.agent, f.root)
    await f.ctx.workspaceRegistry.archiveSession(f.session.id)
    await entered.promise
    const other = f.ctx.sessions.create(SessionId('elsewhere'), { meta: { cwd: f.root } })
    const otherAgent = agentFor(f.ctx, other)
    await f.ctx.agents.register(otherAgent)
    expect(await f.ctx.workingDirectory.ensure(otherAgent)).toBe(f.root)
    let settledEntry = false
    const entering = f.ctx.workingDirectory.set(otherAgent, f.worktree.path)
      .then(() => { settledEntry = true }, () => { settledEntry = true })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(settledEntry).toBe(false)
    release.resolve(undefined)
    await entering
    expect(await settled(f)).toMatchObject({ status: 'removed' })
    // Entry ran after removal, against a directory that no longer exists.
    expect(f.ctx.workingDirectory.get(other)).toBe(f.root)
  })

  it('registers nothing for a cold Session without creations and ignores an unarchive without an attempt', async () => {
    const f = await fixture()
    const cold = detachable(f, 'cold-empty', { cwd: f.root })
    await persisted(f, cold.session)
    cold.detach()
    await f.ctx.workspaceRegistry.archiveSession(cold.session.id)
    // A cold Session's creations are only known once its log or cache was read, so the placeholder settles to nothing.
    expect(await settled(f, cold.session)).toBeNull()
    expect(await f.ctx.worktrees.cleanupOf(cold.session, null)).toBeNull()
    await f.ctx.workspaceRegistry.unarchiveSession(cold.session.id)
    expect(f.ctx.workspaceRegistry.archivedSessionIds).not.toContain(cold.session.id)
  })

  it('retains a checkout for a borrower that appeared between the eligible inspection and the locked recheck', async () => {
    const f = await fixture()
    const list = f.ctx.sessionQuery.listSessions.bind(f.ctx.sessionQuery)
    vi.spyOn(f.ctx.sessionQuery, 'listSessions').mockImplementationOnce(async (...args) => {
      const records = await list(...args)
      f.ctx.sessions.create(SessionId('late-borrower'), { meta: { cwd: f.worktree.path } })
      return records
    })
    await f.ctx.workspaceRegistry.archiveSession(f.session.id)
    expect(await settled(f)).toMatchObject({ status: 'retained' })
    expect(removeCheckout).not.toHaveBeenCalled()
    await access(f.worktree.path)
  })

  it('treats a subagent child whose parent is unknown to the corpus as unarchived', async () => {
    const f = await fixture()
    f.ctx.sessions.create(SessionId('orphan-child'), {
      meta: { cwd: f.worktree.path, origin: 'subagent', parentSession: SessionId('never-existed') },
    })
    await f.ctx.workspaceRegistry.archiveSession(f.session.id)
    expect(await settled(f)).toMatchObject({ status: 'retained' })
  })

  it('skips a creation record whose payload fails validation', async () => {
    const f = await fixture()
    const handle = await f.ctx.sessionProjections.register(worktreeProjection)
    const before = handle.stateOf(f.session).created
    appendPluginRecord(f.session, CREATED_RECORD, { path: '', branch: 'x', baseCommit: 'y', repositoryRoot: 'z' })
    expect(handle.stateOf(f.session).created).toEqual(before)
  })

  it('registers no attempt while retainOnArchive is set, and resumes once it is cleared', async () => {
    const f = await fixture({ retainOnArchive: true })
    await f.ctx.workspaceRegistry.archiveSession(f.session.id)
    expect(await f.ctx.worktrees.cleanupOf(f.session, null)).toBeNull()
    await access(f.worktree.path)
    await f.ctx.workspaceRegistry.unarchiveSession(f.session.id)
    await f.worktrees.update({ retainOnArchive: false })
    await f.ctx.workspaceRegistry.archiveSession(f.session.id)
    expect(await settled(f)).toMatchObject({ status: 'removed' })
  })

  it('withdraws listeners before draining, so disposal neither fails unrelated access nor serves a stale result', async () => {
    const f = await fixture()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    removeCheckout.mockImplementation(async () => {
      entered.resolve(undefined)
      await release.promise
      return false
    })
    cleanups.push(async () => { release.resolve(undefined) })
    await f.ctx.workspaceRegistry.archiveSession(f.session.id)
    await entered.promise
    const scheduled = await f.ctx.worktrees.cleanupOf(f.session, null)
    const result = f.ctx.worktrees.cleanupOf(f.session, scheduled!.revision)
    const disposing = f.ctx.fiber.dispose()
    release.resolve(undefined)
    await disposing
    expect(await result).toBeNull()
    await access(f.worktree.path)
  })
})
