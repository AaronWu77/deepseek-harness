/** Stable ownership, journal admission, and recovery for reversible JSONL maintenance. */
import { createHash, randomUUID } from 'node:crypto'
import { readFile, readdir, mkdir, mkdtemp, rename } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep, isAbsolute } from 'node:path'
import { SessionId, SESSION_FORMAT_VERSION, type SessionHeader } from '@deepseek-ai/dsh-session'
import {
  SessionAlreadyOwnedError, SessionMaintenanceDisabledError, SessionPersistenceCorruptionError,
  SessionPersistenceRevision, type SessionMaintenanceAdmission, type SessionMaintenanceBatch,
  type SessionMaintenanceBatchId, type SessionMaintenanceBatches, type SessionMaintenanceCapability,
  type SessionMaintenanceClaims, type SessionMaintenanceContext, type SessionMaintenanceHostChecks,
  type SessionMaintenanceIdentity, type SessionMaintenanceInspection,
  type SessionMaintenanceManifest, type SessionMaintenanceOperation, type SessionMaintenanceOperationId,
  type SessionMaintenanceOptions, type SessionMaintenanceRefusal, type SessionMaintenanceResult,
  type SessionPersistenceSnapshot, type MaintenanceEpoch, type SessionMaintenanceGateOptions,
  type ArtifactHeader, type Evidence, type ReferenceCorpusScope, type ReferenceFailure,
  type ReferenceArtifactRef, type ReferenceLogOptions, type ReferenceLogSummary, type SessionEventLike,
} from '@deepseek-ai/dsh-session-persistence'
import { encodeSegment, generationLogFilename, parseGenerationLogFilename, projectDir, type JsonlCompression } from './format.ts'
import { LEASE_FILENAME, SessionWriteLease } from './lease.ts'
import { publishNewFileWin32 } from './win32.ts'
import { JsonlRootGate, SessionMaintenanceGateError } from './root-gate.ts'
import { readReferenceLog } from './reference-log.ts'
import {
  CorpusIncomplete, createDirectories, directoryChain, errno, identifyArtifact, MaintenanceRefused,
  readIdentity, sameArtifact, syncDirectory, writeJournal,
} from './maintenance-fs.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
const DIGEST = /^[0-9a-f]{64}$/u
const INTEGER = /^\d+$/u
const BATCH_LOCK_ID = SessionId('maintenance-batch')
const JOURNAL_LIMIT = 64 * 1024
/** Oldest generation the corpus reader admits; historical Sessions below it cannot be moved beside. */
const MINIMUM_CORPUS_VERSION = 3

// The browser VFS does not offer Node's nonrecursive directory removal or
// cross-process kernel locks. Do not statically import a missing VFS export.
function hostRmdir(): typeof import('node:fs/promises').rmdir | undefined {
  const fs = process.getBuiltinModule?.('node:fs/promises') as Partial<Pick<typeof import('node:fs/promises'), 'rmdir'>> | undefined
  return fs?.rmdir
}

interface Hooks {
  readonly hasWriter: (id: SessionId) => boolean
  readonly inspect: (id: SessionId, expected: SessionMaintenanceOptions['expectedRevision'], signal?: AbortSignal) => Promise<SessionPersistenceSnapshot | undefined>
  readonly readCorpusHeader: (path: string, version: number) => Promise<{ header: SessionHeader; revision: SessionPersistenceRevision }>
  readonly invalidate: (id: SessionId) => void
  readonly warn: (message: string) => void
}

type RecordValue = Record<string, unknown>
const record = (value: unknown): value is RecordValue => typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 4096
const isoDate = (value: unknown): value is string => text(value) && Number.isFinite(Date.parse(value))
const amount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const uint = (value: unknown): value is string => typeof value === 'string' && INTEGER.test(value)

function validClaims(value: unknown): value is SessionMaintenanceClaims {
  if (!record(value) || !text(value.source) || value.version !== 1 || typeof value.archived !== 'boolean' || value.live !== false
    || !record(value.references) || value.references.descendants !== 0 || value.references.teamTasks !== 0) return false
  const workspace = value.workspace
  return workspace === undefined || (record(workspace) && text(workspace.id) && amount(workspace.position))
}

function validIdentity(value: unknown): value is SessionMaintenanceIdentity {
  return record(value) && uint(value.device) && uint(value.inode) && amount(value.bytes)
    && text(value.entriesHash) && DIGEST.test(value.entriesHash) && Array.isArray(value.generations)
    && value.generations.length > 0 && value.generations.every((entry: unknown) => record(entry)
      && text(entry.name) && amount(entry.version) && amount(entry.bytes)
      && text(entry.digest) && DIGEST.test(entry.digest) && uint(entry.modifiedNs) && uint(entry.fileId))
}

function refusal(reason: SessionMaintenanceRefusal['reason'], detail?: string): SessionMaintenanceRefusal {
  return { status: 'refused', reason, detail }
}

function explain(error: unknown): SessionMaintenanceRefusal {
  if (error instanceof MaintenanceRefused || error instanceof SessionMaintenanceGateError) return refusal(error.reason, error.message)
  if (error instanceof SessionAlreadyOwnedError) return refusal('lease')
  if (error instanceof SessionPersistenceCorruptionError) return refusal('corrupt', error.message)
  if (errno(error) === 'EXDEV') return refusal('cross-volume')
  if (errno(error) === 'EEXIST' || errno(error) === 'ENOTEMPTY') return refusal('conflict')
  return refusal('io', error instanceof Error ? error.message : String(error))
}

function within(parent: string, path: string): boolean {
  const rest = relative(parent, path)
  return rest === '' || (!isAbsolute(rest) && rest !== '..' && !rest.startsWith('..' + sep))
}

function unknownCorpus(code: ReferenceFailure['code'], detail?: string): Evidence<never> {
  return { state: 'unknown', reason: { code, ...(detail === undefined ? {} : { detail }) } }
}

interface BatchRecords {
  readonly deletion: SessionMaintenanceManifest
  readonly restores: readonly SessionMaintenanceManifest[]
}

/** Coordinates every maintenance action under both the batch lock and its Session's stable locks. */
export class JsonlMaintenance {
  readonly trashRoot: string
  readonly lockRoot: string
  private readonly rootKey: string
  private readonly rootGate: JsonlRootGate
  private readonly corpusFiles = new WeakMap<ReferenceArtifactRef, { epoch: MaintenanceEpoch; path: string }>()
  private readonly rmdir = hostRmdir()
  private closing = false
  private readonly operations = new Set<Promise<unknown>>()
  private readonly localReaders = new Map<SessionId, { count: number; lease: Promise<SessionWriteLease> }>()

  /**
   * @param sessionsRoot - resolved artifact root.
   * @param trashRoot - optional sibling root; must not overlap storage or locks.
   * @param enabled - explicit deployment opt-in; not an isolation check.
   * @param allowHistoricalCorpus - opt-in to move a current Session beside historical generations.
   * @param compression - physical generation encoding.
   * @param hooks - JSONL observations and invalidation owned by the backend instance.
   */
  constructor(
    readonly sessionsRoot: string, trashRoot: string | undefined, readonly enabled: boolean,
    readonly allowHistoricalCorpus: boolean,
    private readonly compression: JsonlCompression, private readonly hooks: Hooks,
  ) {
    if (enabled && this.rmdir === undefined) throw new TypeError('JSONL maintenance is supported only on the Node host')
    const home = dirname(sessionsRoot)
    this.trashRoot = resolve(trashRoot ?? join(home, 'trash', 'sessions'))
    const key = createHash('sha256').update(process.platform === 'win32' ? sessionsRoot.toLowerCase() : sessionsRoot).digest('hex')
    this.lockRoot = join(home, 'locks', 'session-maintenance', key)
    this.rootKey = createHash('sha256').update(JSON.stringify([key, process.platform === 'win32' ? this.trashRoot.toLowerCase() : this.trashRoot, compression])).digest('hex')
    if (within(sessionsRoot, this.trashRoot) || within(this.trashRoot, sessionsRoot)
      || within(this.lockRoot, this.trashRoot) || within(this.trashRoot, this.lockRoot)
      || (enabled && (within(sessionsRoot, this.lockRoot) || within(this.lockRoot, sessionsRoot)))) {
      throw new TypeError('JSONL maintenance roots must be disjoint')
    }
    this.rootGate = new JsonlRootGate(enabled, sessionsRoot, this.lockRoot, key)
  }

  private lockPath(id: SessionId, access: 'read' | 'write'): string {
    const key = createHash('sha256').update(process.platform === 'win32' ? id.toLowerCase() : id).digest('hex')
    return join(this.lockRoot, access + '-' + key + '.lock')
  }

  private async acquire(path: string, id: SessionId): Promise<SessionWriteLease> {
    await createDirectories(this.lockRoot)
    const existing = await readIdentity(path)
    if (existing !== undefined && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1n)) {
      throw new MaintenanceRefused('corrupt', 'unsafe stable lock path')
    }
    const lease = await SessionWriteLease.acquirePath(path, id, true)
    if (lease === undefined) throw new MaintenanceRefused('io', 'stable lock was not created')
    return lease
  }

  /** @param id - requested session. @param access - handle access. @returns handle-owned release when enabled. */
  async enterHandle(id: SessionId, access: 'read' | 'write'): Promise<(() => Promise<void>) | undefined> {
    if (!this.enabled) return undefined
    const leaveRoot = await this.rootGate.enter()
    try {
      const leaveSession = await this.enterSessionHandle(id, access)
      return async () => {
        try {
          await leaveSession()
        } finally {
          await leaveRoot()
        }
      }
    } catch (error) {
      await leaveRoot()
      throw error
    }
  }

  private async enterSessionHandle(id: SessionId, access: 'read' | 'write'): Promise<() => Promise<void>> {
    const path = this.lockPath(id, access)
    if (access === 'write') {
      const lock = await this.acquire(path, id)
      try {
        await this.assertHandleAllowed(id)
        return () => lock.release()
      } catch (error) {
        await lock.release()
        throw error
      }
    }
    let readers = this.localReaders.get(id)
    if (readers === undefined) {
      readers = { count: 0, lease: this.acquire(path, id).then(async (lock) => {
        try {
          await this.assertHandleAllowed(id)
          return lock
        } catch (error) {
          await lock.release()
          throw error
        }
      }) }
      this.localReaders.set(id, readers)
    }
    const group = readers
    group.count++
    try {
      const lease = await group.lease
      return async () => {
        if (--group.count !== 0) return
        if (this.localReaders.get(id) === group) this.localReaders.delete(id)
        await lease.release()
      }
    } catch (error) {
      if (this.localReaders.get(id) === group) this.localReaders.delete(id)
      throw error
    }
  }

  private tombstonePath(id: SessionId): string {
    return this.lockPath(id, 'write') + '.json'
  }

  private async readTombstone(id: SessionId): Promise<{ schemaVersion: 1; batchId: string; blocked: boolean } | undefined> {
    const path = this.tombstonePath(id)
    const file = await readIdentity(path)
    if (file === undefined) return undefined
    if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1n || file.size > 1024n) {
      throw new MaintenanceRefused('corrupt', 'invalid maintenance tombstone file')
    }
    const value: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (!record(value) || value.schemaVersion !== 1 || !text(value.batchId) || !UUID.test(value.batchId) || typeof value.blocked !== 'boolean') {
      throw new MaintenanceRefused('corrupt', 'invalid maintenance tombstone record')
    }
    return { schemaVersion: 1, batchId: value.batchId, blocked: value.blocked }
  }

  private async assertHandleAllowed(id: SessionId): Promise<void> {
    if ((await this.readTombstone(id))?.blocked === true) throw new SessionAlreadyOwnedError(id)
  }

  private async tombstone(entry: SessionMaintenanceManifest, blocked: boolean): Promise<void> {
    const current = await this.readTombstone(entry.id)
    if (!blocked && (current?.batchId !== entry.batchId || !current.blocked)) return
    if (blocked && current?.blocked === true) {
      if (current.batchId !== entry.batchId) throw new MaintenanceRefused('conflict', 'another batch owns the session tombstone')
      return
    }
    await writeJournal(this.tombstonePath(entry.id), { schemaVersion: 1, batchId: entry.batchId, blocked }, current !== undefined)
  }

  /** @returns deployment information; does not create any directories or lock files. */
  async capability(): Promise<SessionMaintenanceCapability> {
    let sameVolume: boolean | 'unknown' = 'unknown'
    let batchBusy: boolean | 'unknown' = 'unknown'
    if (this.rmdir === undefined) {
      return { enabled: false, coordination: 'unsupported', isolation: 'not-verified', sameVolume, batchBusy, boundaries: ['Maintenance is only available on the Node host.'] }
    }
    try {
      sameVolume = await this.sameVolume(this.sessionsRoot, this.trashRoot)
      await directoryChain(this.lockRoot)
      const path = join(this.lockRoot, 'batch.lock')
      const existing = await readIdentity(path)
      if (existing?.isSymbolicLink()) throw new MaintenanceRefused('corrupt', 'linked batch lock')
      const lock = await SessionWriteLease.acquirePath(path, BATCH_LOCK_ID, false)
      await lock?.release()
      batchBusy = false
    } catch (error) {
      if (error instanceof SessionAlreadyOwnedError) batchBusy = true
    }
    return {
      enabled: this.enabled, allowHistoricalCorpus: this.allowHistoricalCorpus, sessionsRoot: this.sessionsRoot, trashRoot: this.trashRoot,
      lockRoot: this.lockRoot, sameVolume, batchBusy, coordination: 'cooperative-kernel-locks', isolation: 'not-verified',
      boundaries: [
        'When enabled, writers hold a stable lock from create/open to close, including materialization and migration.',
        'Does not protect old processes or processes not configured for this protocol.',
        'Does not protect cold selection in other browsers.',
        'Does not verify Team references without a cooperating provider.',
        'On Windows, named locks are scoped to the same logon session.',
      ],
    }
  }

  /** @returns the observed root lock state. */
  gate() {
    return this.rootGate.status()
  }

  /** @param epoch - callback token. @returns whether it is active in the calling scope. */
  epochActive(epoch: MaintenanceEpoch): boolean {
    return this.rootGate.epoch === epoch
  }

  /** @param holder - display label. @param fn - exclusive callback. @param options - cancellation before entry. @returns the callback result. */
  async exclusive<T>(holder: string, fn: (epoch: MaintenanceEpoch) => Promise<T>, options?: SessionMaintenanceGateOptions): Promise<T> {
    if (this.closing) throw new SessionMaintenanceGateError('io')
    const work = this.rootGate.exclusive(holder, fn, options)
    this.operations.add(work)
    try {
      return await work
    } finally {
      this.operations.delete(work)
    }
  }

  /** @param id - requested session. @returns an unlocked preview, or a preview within the caller's exclusive scope. */
  async inspect(id: SessionId): Promise<SessionMaintenanceInspection> {
    if (!this.enabled) return this.inspectArtifact(id)
    try {
      const blocked = async (): Promise<SessionMaintenanceInspection> => ({
        id, state: 'maintenance-gate', gate: await this.rootGate.status(), sameVolume: 'unknown', migrationPending: false,
      })
      if (this.rootGate.epoch !== undefined) {
        return await this.rootGate.scoped<SessionMaintenanceInspection>(async () => ({
          ...await this.inspectArtifact(id), gate: await this.rootGate.status(),
        }), blocked)
      }
      if ((await this.rootGate.status()).active) return blocked()
      const preview = await this.inspectArtifact(id)
      const gate = await this.rootGate.status()
      if (gate.active) return { id, state: 'maintenance-gate', gate, sameVolume: 'unknown', migrationPending: false }
      return { ...preview, gate }
    } catch (error) {
      return { id, state: 'corrupt', sameVolume: 'unknown', migrationPending: false, detail: explain(error).detail }
    }
  }

  /** @param scope - include restorable trash unless explicitly excluded. @returns strict evidence under the current exclusive callback. */
  async inspectCorpus(scope?: ReferenceCorpusScope): Promise<Evidence<ArtifactHeader>> {
    if (!this.enabled) throw new SessionMaintenanceDisabledError()
    if (scope?.epoch !== undefined && !this.epochActive(scope.epoch)) return unknownCorpus('stale-epoch')
    try {
      return await this.rootGate.scoped<Evidence<ArtifactHeader>>(async (epoch) => {
        const items = await this.collectCorpus(epoch, scope?.includeTrash !== false)
        return this.epochActive(epoch) ? { state: 'complete', epoch, items } : unknownCorpus('stale-epoch')
      }, async () => {
        const gate = await this.rootGate.status()
        if (this.rootGate.epoch !== undefined) return unknownCorpus('busy')
        if (gate.active) return { state: 'unknown', reason: { code: 'maintenance-gate', gate } }
        return unknownCorpus('gate-required')
      })
    } catch (error) {
      if (error instanceof CorpusIncomplete) return unknownCorpus(error.code, error.message)
      if (error instanceof MaintenanceRefused) {
        const code = error.reason === 'migration-pending' ? 'migration-pending'
          : error.reason === 'identity-changed' ? 'unstable' : 'layout'
        return unknownCorpus(code, error.message)
      }
      return unknownCorpus('io', explain(error).detail)
    }
  }

  /**
   * @param epoch - originating active maintenance epoch.
   * @param artifact - exact corpus item.
   * @param visit - synchronous observer of each source-generation event.
   * @param options - cancellation and event limit.
   * @returns a complete read summary, or a typed reason to discard the visitor's partial findings.
   */
  async inspectReferenceLog(
    epoch: MaintenanceEpoch, artifact: ReferenceArtifactRef, visit: (event: SessionEventLike) => void, options?: ReferenceLogOptions,
  ): Promise<Evidence<ReferenceLogSummary>> {
    if (!this.epochActive(epoch)) return unknownCorpus('stale-epoch')
    const file = this.corpusFiles.get(artifact)
    if (file?.epoch !== epoch) return unknownCorpus('artifact-ref', 'expected a corpus item from this epoch')
    try {
      return await this.rootGate.scoped<Evidence<ReferenceLogSummary>>(async () => {
        const signal = options?.signal
        const requireActive = () => {
          if (!this.epochActive(epoch)) throw new CorpusIncomplete('stale-epoch', 'exclusive callback has already settled')
        }
        signal?.throwIfAborted()
        const identify = () => identifyArtifact(file.path, this.compression, SESSION_FORMAT_VERSION, MINIMUM_CORPUS_VERSION, signal)
        const before = await identify()
        if (before === undefined || !sameArtifact(before, artifact.identity)) return unknownCorpus('unstable', 'artifact differs from the corpus item')
        const generation = before.generations.reduce((selected, value) => value.version > selected.version ? value : selected)
        const path = join(file.path, generation.name)
        const revision = async () => (await this.hooks.readCorpusHeader(path, generation.version)).revision
        if (await revision() !== artifact.revision) return unknownCorpus('unstable', 'generation revision differs from the corpus item')
        const summary = await readReferenceLog(path, generation.version, this.compression, visit, requireActive, options)
        requireActive()
        if (!sameArtifact(await identify(), before) || await revision() !== artifact.revision) {
          return unknownCorpus('unstable', 'artifact changed while reading its events')
        }
        signal?.throwIfAborted()
        if (!this.epochActive(epoch)) return unknownCorpus('stale-epoch')
        return { state: 'complete', epoch, items: [summary] }
      }, () => unknownCorpus('busy'))
    } catch (error) {
      if (options?.signal?.aborted) return unknownCorpus('aborted')
      if (error instanceof CorpusIncomplete) return unknownCorpus(error.code, error.message)
      if (error instanceof MaintenanceRefused) {
        return unknownCorpus(error.reason === 'migration-pending' ? 'migration-pending' : 'unstable', error.message)
      }
      return unknownCorpus('io', explain(error).detail)
    }
  }

  private async collectCorpus(epoch: MaintenanceEpoch, includeTrash: boolean): Promise<ArtifactHeader[]> {
    const items = new Map<string, ArtifactHeader>()
    const normalize = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value
    const add = (artifact: ArtifactHeader) => {
      const key = normalize(artifact.id)
      if (items.has(key)) throw new CorpusIncomplete('duplicate-id', 'multiple retained directories for Session ' + artifact.id)
      items.set(key, artifact)
    }
    const active = await directoryChain(this.sessionsRoot)
    if (active.exists) {
      for (const project of (await readdir(this.sessionsRoot)).sort()) {
        const dir = join(this.sessionsRoot, project)
        if (!this.projectName(project) || (await readIdentity(dir))?.isDirectory() !== true) {
          throw new CorpusIncomplete('layout', 'invalid project directory: ' + dir)
        }
        for (const name of (await readdir(dir)).sort()) {
          add(await this.corpusArtifact(epoch, join(dir, name), project, { kind: 'active' }))
        }
      }
    }
    if (includeTrash) {
      for (const batch of await this.batchNames()) {
        const artifact = await this.corpusTrashArtifact(epoch, batch)
        if (artifact !== undefined) add(artifact)
      }
    }
    return [...items.values()]
  }

  private async corpusTrashArtifact(epoch: MaintenanceEpoch, batch: string): Promise<ArtifactHeader | undefined> {
    let saved: BatchRecords
    try {
      saved = await this.records(batch)
    } catch (error) {
      if (errno(error) !== undefined && errno(error) !== 'ENOENT') throw error
      throw new CorpusIncomplete('trash-unresolved', explain(error).detail ?? 'invalid batch: ' + batch)
    }
    const { deletion } = saved
    const restore = saved.restores.find(entry => entry.state !== 'not-moved')
    const { target } = this.paths(deletion)
    if (deletion.state === 'not-moved' || restore?.state === 'moved') {
      if (await readIdentity(target) !== undefined) throw new CorpusIncomplete('trash-unresolved', 'unexpected artifact in closed batch: ' + batch)
      return undefined
    }
    if (deletion.state !== 'moved' || restore !== undefined) {
      throw new CorpusIncomplete('trash-unresolved', 'batch requires recovery: ' + batch)
    }
    const project = dirname(deletion.hostChecks.sourceRelative).split(sep).join('/')
    const artifact = await this.corpusArtifact(epoch, target, project, { kind: 'trash', batchId: deletion.batchId })
    if (artifact.id !== deletion.id || !sameArtifact(artifact.identity, deletion.hostChecks.observedIdentity)) {
      throw new CorpusIncomplete('trash-unresolved', 'trash artifact does not match its receipt: ' + batch)
    }
    return artifact
  }

  private async corpusArtifact(epoch: MaintenanceEpoch, path: string, project: string, location: ArtifactHeader['location']): Promise<ArtifactHeader> {
    const identify = () => identifyArtifact(path, this.compression, SESSION_FORMAT_VERSION, MINIMUM_CORPUS_VERSION)
    const identity = await identify()
    if (identity === undefined) throw new CorpusIncomplete('unstable', 'artifact disappeared: ' + path)
    let selected: { version: number; header: SessionHeader; revision: SessionPersistenceRevision } | undefined
    for (const generation of identity.generations) {
      const metadata = await this.hooks.readCorpusHeader(join(path, generation.name), generation.version)
      const { header } = metadata
      if (encodeSegment(header.id) !== basename(path) || basename(projectDir(this.sessionsRoot, header.cwd)) !== project) {
        throw new CorpusIncomplete('layout', 'header does not identify its directory: ' + path)
      }
      if (selected !== undefined && (header.id !== selected.header.id || header.parentSession !== selected.header.parentSession
        || header.origin !== selected.header.origin || header.isSeeded !== selected.header.isSeeded
        || header.delegationDepth !== selected.header.delegationDepth || header.cwd !== selected.header.cwd)) {
        throw new CorpusIncomplete('bad-header', 'committed generations disagree about lineage: ' + path)
      }
      if (selected === undefined || selected.version < generation.version) selected = { ...metadata, version: generation.version }
    }
    if (selected === undefined || !sameArtifact(await identify(), identity)) {
      throw new CorpusIncomplete('unstable', 'artifact changed during inspection: ' + path)
    }
    const { header, revision, version } = selected
    const artifact: ArtifactHeader = {
      id: header.id, location, revision, identity, generations: identity.generations,
      layout: version === SESSION_FORMAT_VERSION ? 'current' : 'migration-required',
      isSeeded: header.isSeeded, delegationDepth: header.delegationDepth ?? 0,
      ...(header.parentSession === undefined ? {} : { parentSession: header.parentSession }),
      ...(header.origin === undefined ? {} : { origin: header.origin }),
    }
    this.corpusFiles.set(artifact, { epoch, path })
    return artifact
  }

  private async inspectArtifact(id: SessionId): Promise<SessionMaintenanceInspection> {
    if (this.rmdir === undefined) return { id, state: 'unsupported', sameVolume: 'unknown', migrationPending: false }
    let sameVolume: boolean | 'unknown' = 'unknown'
    try {
      sameVolume = await this.sameVolume(this.sessionsRoot, this.trashRoot)
      if (this.hooks.hasWriter(id)) return { id, state: 'inspecting-busy', sameVolume, migrationPending: false }
      const path = await this.findActiveDirectory(id)
      if (path === undefined) {
        const trashEntry = (await this.scan(false)).find(batch => batch.status === 'moved' && batch.deletion?.id === id)?.deletion
        return { id, state: 'not-found', sameVolume, migrationPending: false, trashEntry }
      }
      await this.assertCorpusIndependent()
      const identity = await this.identify(path)
      const snapshot = await this.hooks.inspect(id, undefined)
      if (identity === undefined || snapshot?.location === undefined || snapshot.formatStatus !== 'current'
        || dirname(snapshot.location.path) !== path || !sameArtifact(await this.identify(path), identity)
        || (await this.hooks.inspect(id, undefined))?.revision !== snapshot.revision) {
        return { id, state: 'inspecting-busy', sameVolume, migrationPending: false }
      }
      return { id, state: 'available', sameVolume, migrationPending: false, revision: snapshot.revision, identity }
    } catch (error) {
      const refused = explain(error)
      const migrationPending = refused.reason === 'migration-pending'
      const state = migrationPending ? 'migration-pending' : refused.reason === 'identity-changed' ? 'inspecting-busy' : 'corrupt'
      return { id, state, sameVolume, migrationPending, detail: refused.detail }
    }
  }

  /**
   * @param id - target session. @param operation - move direction.
   * @param admit - caller policy under the locks. @param options - identity from the confirmed preview.
   * @returns a receipt or refusal, not an accounting result.
   */
  async run<T extends SessionMaintenanceAdmission>(
    id: SessionId, operation: SessionMaintenanceOperation, admit: (ctx: SessionMaintenanceContext) => Promise<T>,
    options?: SessionMaintenanceOptions,
  ): Promise<SessionMaintenanceResult> {
    if (!this.enabled) throw new SessionMaintenanceDisabledError()
    if (!text(options?.caller) || (operation === 'delete' && (!text(options.expectedRevision) || !validIdentity(options.expectedIdentity)))
      || (operation === 'restore' && (!UUID.test(options.batchId ?? '') || !UUID.test(options.expectedOperationId ?? '')))) {
      return refusal('invalid-request', 'missing caller or expected operation identity')
    }
    if (this.hooks.hasWriter(id)) return refusal('writer')
    return this.withBatchLock(() => this.withSessionLocks(id, async () => {
      options.signal?.throwIfAborted()
      if (!await this.sameVolume(this.sessionsRoot, this.trashRoot)) return refusal('cross-volume')
      const batches = await this.scan(false)
      if (batches.some(batch => batch.status === 'intent' || batch.status === 'reserved-empty' || batch.status === 'quarantined')) {
        return refusal('recovery-required', 'resolve pending or quarantined maintenance batches before moving another session')
      }
      const batchId = operation === 'delete' ? randomUUID() as SessionMaintenanceBatchId : options.batchId!
      const operationId = randomUUID() as SessionMaintenanceOperationId
      const targetName = this.trashRelative(batchId, id)
      const saved = operation === 'restore' ? await this.records(batchId) : undefined
      const deletion = saved?.deletion
      if (deletion !== undefined && (deletion.id !== id || deletion.operationId !== options.expectedOperationId
        || deletion.state !== 'moved' || saved?.restores.some(entry => entry.state !== 'not-moved'))) {
        return refusal('conflict', 'batch does not identify a restorable entry')
      }
      // Before the legacy lease lookup, the locator must not follow an untrusted
      // project or Session link. It does not mkdir or touch a generation.
      const activePath = await this.findActiveDirectory(id)
      if (operation === 'delete' && activePath === undefined) return refusal('not-found')
      if (operation === 'restore' && activePath !== undefined) return refusal('conflict', 'a Session directory already exists for this id')
      const activeRelative = deletion?.hostChecks.sourceRelative ?? this.activeRelative(activePath!, id)
      const sourceRelative = operation === 'delete' ? activeRelative : targetName
      const targetRelative = operation === 'delete' ? targetName : activeRelative
      const source = join(operation === 'delete' ? this.sessionsRoot : this.trashRoot, sourceRelative)
      const target = join(operation === 'delete' ? this.trashRoot : this.sessionsRoot, targetRelative)
      await this.assertVacant(source, target)
      await this.assertCorpusIndependent()
      if (this.hooks.hasWriter(id)) return refusal('writer')
      const legacyPath = join(source, LEASE_FILENAME)
      const lockInfo = await readIdentity(legacyPath)
      if (lockInfo !== undefined && (!lockInfo.isFile() || lockInfo.isSymbolicLink() || lockInfo.nlink !== 1n)) {
        return refusal('corrupt', 'legacy artifact lock has an unsafe identity')
      }
      const legacy = await SessionWriteLease.acquirePath(legacyPath, id, false)
      // A legacy Windows writer may still hold the original path's semaphore.
      let original: SessionWriteLease | undefined
      try {
        if (operation === 'restore' && process.platform === 'win32') {
          original = await SessionWriteLease.acquirePath(join(target, LEASE_FILENAME), id, false)
        }
        const identity = await this.identify(source)
        if (identity === undefined) return refusal('not-found')
        const snapshot = operation === 'delete' ? await this.hooks.inspect(id, options.expectedRevision, options.signal) : undefined
        const revision = snapshot?.revision ?? deletion?.hostChecks.postRevision
        if (revision === undefined || (operation === 'delete' && snapshot?.location === undefined)) return refusal('corrupt')
        if (operation === 'delete' && revision !== options.expectedRevision) return refusal('revision-changed')
        const expectedIdentity = deletion?.hostChecks.observedIdentity ?? options.expectedIdentity
        if (expectedIdentity === undefined || !sameArtifact(identity, expectedIdentity)
          || (snapshot?.location !== undefined && dirname(snapshot.location.path) !== source)) {
          return refusal('identity-changed', 'artifact differs from the confirmed preview or deletion receipt')
        }
        const checks: SessionMaintenanceHostChecks = {
          rootKey: this.rootKey, tombstoneRelative: relative(this.lockRoot, this.tombstonePath(id)),
          sourceRelative, targetRelative, expectedIdentity: identity, observedIdentity: identity, preRevision: revision, postRevision: revision,
          writerIdle: true, leaseIdle: true, sameVolume: true,
        }
        let admission: T
        try {
          // Never hand mutable aliases of the checks or decoded manifest back to policy.
          admission = await admit(structuredClone({ id, operation, batchId, snapshot, deletion, hostChecks: checks }))
        } catch (error) {
          return refusal('admission', error instanceof Error ? error.message : 'policy callback failed')
        }
        if (admission.status === 'refused') return refusal('admission', admission.reason)
        if (!validClaims(admission.evidence) || (operation === 'delete' && admission.evidence.archived !== true)) {
          return refusal('admission', 'policy did not supply complete admission evidence')
        }
        const evidence = admission.evidence
        const claims: SessionMaintenanceManifest['claims'] = {
          caller: options.caller, source: evidence.source, version: evidence.version,
          archived: evidence.archived, live: evidence.live,
          references: { descendants: evidence.references.descendants, teamTasks: evidence.references.teamTasks },
          ...(evidence.workspace === undefined ? {} : { workspace: { ...evidence.workspace } }),
        }
        options.signal?.throwIfAborted()
        if (this.hooks.hasWriter(id)) return refusal('writer')
        const afterPath = await this.findActiveDirectory(id)
        if (afterPath !== activePath) return refusal('identity-changed', 'session directory changed during policy admission')
        const selected = await readIdentity(join(source, generationLogFilename(SESSION_FORMAT_VERSION, this.compression)))
        if (!selected?.isFile() || selected.isSymbolicLink()) return refusal('identity-changed', 'current generation changed during policy admission')
        const post = operation === 'delete' ? (await this.hooks.inspect(id, undefined, options.signal))?.revision : revision
        if (post !== revision) return refusal('revision-changed', 'revision changed during policy admission')
        if (!sameArtifact(await this.identify(source), identity)) return refusal('identity-changed')
        await this.assertCorpusIndependent()
        await this.assertVacant(source, target)
        options.signal?.throwIfAborted()
        const startedAt = new Date().toISOString()
        const entry: SessionMaintenanceManifest = {
          schemaVersion: 1, batchId, operationId, operation, id, startedAt, updatedAt: startedAt,
          state: 'intent', hostChecks: { ...checks, postRevision: post }, claims,
        }
        return await this.commit(entry, source, target)
      } finally {
        try {
          await original?.release()
        } finally {
          await legacy?.release()
        }
      }
    }))
  }

  /** @returns journal state without writing or taking a filesystem lock. */
  async list(): Promise<SessionMaintenanceBatches> {
    try {
      return { status: 'ok', batches: await this.scan(false) }
    } catch (error) {
      return explain(error)
    }
  }

  /** @returns mechanically reconciled records; never moves or removes any directory. */
  async recover(): Promise<SessionMaintenanceBatches> {
    if (!this.enabled) throw new SessionMaintenanceDisabledError()
    return this.withBatchLock(async () => ({ status: 'ok', batches: await this.scan(true) }))
  }

  /** @param batchId - journal batch. @param operationId - exact pending operation. @returns the updated record or refusal. */
  async releaseReservation(batchId: SessionMaintenanceBatchId, operationId: SessionMaintenanceOperationId): Promise<SessionMaintenanceBatches> {
    if (!this.enabled) throw new SessionMaintenanceDisabledError()
    return this.withBatchLock(async () => {
      const records = await this.records(batchId)
      const entry = [records.deletion, ...records.restores].find(value => value.operationId === operationId)
      if (entry?.state !== 'reserved') return refusal('conflict', 'there is no recorded reservation to release')
      return this.withSessionLocks(entry.id, async () => {
        const observation = await this.reconcile(entry, false)
        if (observation !== 'reserved-empty') return refusal('conflict', 'reservation is no longer known and empty')
        const { target } = this.paths(entry)
        await this.removeReservationDirectory(target)
        await syncDirectory(dirname(target))
        await this.update(entry, 'not-moved', 'empty reservation released by caller')
        if (entry.operation === 'delete') await this.tombstone(entry, false)
        return { status: 'ok', batches: [await this.batchReport(await this.records(batchId), false)] }
      })
    })
  }

  /** Stop accepting work; wait until each accepted operation has reached a recoverable state. */
  async stop(): Promise<void> {
    this.closing = true
    await Promise.allSettled(this.operations)
  }

  private async withBatchLock<T>(fn: () => Promise<T>): Promise<T | SessionMaintenanceRefusal> {
    if (this.closing) return refusal('io', 'maintenance service is stopping')
    const work = this.rootGate.epoch === undefined
      ? this.withSharedRoot(() => this.runWithBatchLock(fn))
      : this.rootGate.scoped<T | SessionMaintenanceRefusal>(() => this.runWithBatchLock(fn), () => refusal('maintenance-gate'))
    this.operations.add(work)
    try {
      return await work
    } finally {
      this.operations.delete(work)
    }
  }

  private async withSharedRoot<T>(fn: () => Promise<T>): Promise<T | SessionMaintenanceRefusal> {
    let release: () => Promise<void>
    try {
      release = await this.rootGate.enter()
    } catch (error) {
      return explain(error)
    }
    try {
      return await fn()
    } finally {
      await release()
    }
  }

  private async runWithBatchLock<T>(fn: () => Promise<T>): Promise<T | SessionMaintenanceRefusal> {
    let lease: SessionWriteLease
    try {
      lease = await this.acquire(join(this.lockRoot, 'batch.lock'), BATCH_LOCK_ID)
    } catch (error) {
      if (error instanceof SessionAlreadyOwnedError) return refusal('batch-busy')
      return explain(error)
    }
    try {
      return await fn()
    } catch (error) {
      return explain(error)
    } finally {
      await this.releaseLock(lease)
    }
  }

  private async releaseLock(lease: SessionWriteLease): Promise<void> {
    try {
      await lease.release()
    } catch (error) {
      this.hooks.warn('maintenance kernel-lock release failed: ' + String(error))
    }
  }

  private async withSessionLocks<T>(id: SessionId, fn: () => Promise<T>): Promise<T | SessionMaintenanceRefusal> {
    if (this.hooks.hasWriter(id)) return refusal('writer')
    const writer = await this.acquire(this.lockPath(id, 'write'), id)
    try {
      const reader = await this.acquire(this.lockPath(id, 'read'), id)
      try {
        if (this.hooks.hasWriter(id)) return refusal('writer')
        return await fn()
      } finally {
        await this.releaseLock(reader)
      }
    } finally {
      await this.releaseLock(writer)
    }
  }

  private async sameVolume(left: string, right: string): Promise<boolean> {
    const a = await directoryChain(left)
    const b = await directoryChain(right)
    return a.identity.dev === b.identity.dev
      && (process.platform !== 'win32' || resolve(a.path).toLowerCase().split(sep)[0] === resolve(b.path).toLowerCase().split(sep)[0])
  }

  private async findActiveDirectory(id: SessionId): Promise<string | undefined> {
    if (!(await directoryChain(this.sessionsRoot)).exists) return undefined
    const encoded = encodeSegment(id)
    let found: string | undefined
    for (const project of await readdir(this.sessionsRoot, { withFileTypes: true })) {
      const root = join(this.sessionsRoot, project.name)
      if (project.isSymbolicLink()) throw new MaintenanceRefused('corrupt', 'linked project in the Session root')
      if (!project.isDirectory()) {
        if (project.name.endsWith('.jsonl') || project.name.endsWith('.zstd')) {
          throw new MaintenanceRefused('corrupt', 'legacy flat artifact in the Session root')
        }
        continue
      }
      if (await readIdentity(join(root, encoded + '.jsonl')) !== undefined
        || await readIdentity(join(root, encoded + '.jsonl.zstd')) !== undefined) {
        throw new MaintenanceRefused('corrupt', 'legacy flat artifact for the requested Session')
      }
      const candidate = join(root, encoded)
      if ((await directoryChain(candidate)).exists) {
        if (found !== undefined) throw new MaintenanceRefused('corrupt', 'duplicate session directories')
        found = candidate
      }
    }
    return found
  }

  // A historical authoritative generation can consult other Sessions while
  // preparing a successor. Removing or restoring any directory would change its inputs.
  private async assertCorpusIndependent(): Promise<void> {
    if (!(await directoryChain(this.sessionsRoot)).exists) return
    for (const project of await readdir(this.sessionsRoot, { withFileTypes: true })) {
      if (project.isSymbolicLink()) throw new MaintenanceRefused('corrupt', 'linked project in the Session root')
      if (!project.isDirectory()) continue
      const dir = join(this.sessionsRoot, project.name)
      for (const session of await readdir(dir, { withFileTypes: true })) {
        if (session.isSymbolicLink() || (!session.isDirectory() && /\.jsonl(?:\.zstd)?$/u.test(session.name))) {
          throw new MaintenanceRefused('corrupt', 'linked or flat entry in the Session corpus')
        }
        if (!session.isDirectory()) continue
        let highest = -1
        for (const artifact of await readdir(join(dir, session.name), { withFileTypes: true })) {
          if (/^session\.migration\..+\.tmp$/u.test(artifact.name)) {
            throw new MaintenanceRefused('migration-pending', 'a migration staging file exists in the Session corpus')
          }
          if (artifact.name === LEASE_FILENAME && artifact.isFile()) continue
          const generation = parseGenerationLogFilename(artifact.name, this.compression)
          if (generation === undefined || generation > SESSION_FORMAT_VERSION || !artifact.isFile()) {
            throw new MaintenanceRefused('corrupt', 'unrecognized layout or generation in the Session corpus')
          }
          highest = Math.max(highest, generation)
        }
        if (highest < SESSION_FORMAT_VERSION) {
          if (!this.allowHistoricalCorpus) throw new MaintenanceRefused('migration-pending', 'the Session corpus has a historical or unmaterialized generation')
          if (highest < MINIMUM_CORPUS_VERSION) throw new MaintenanceRefused('corrupt', 'historical generation is below the minimum readable version')
        }
      }
    }
  }

  private activeRelative(path: string, id: SessionId): string {
    const parts = relative(this.sessionsRoot, path).split(sep)
    if (parts.length !== 2 || !this.projectName(parts[0]) || parts[1] !== encodeSegment(id)) {
      throw new MaintenanceRefused('corrupt', 'invalid Session directory layout')
    }
    return parts.join('/')
  }

  private projectName(value: string | undefined): boolean {
    return value === '_no-cwd' || (value !== undefined && /^--[^/\\:\x00]+--$/u.test(value))
  }

  private trashRelative(batchId: string, id: SessionId): string {
    if (!UUID.test(batchId)) throw new MaintenanceRefused('invalid-request', 'invalid batch id')
    const component = encodeSegment(id)
    if (/^(?:manifest\.json|restore-[0-9a-f-]+\.json|\.journal-[0-9a-f-]+\.tmp)$/iu.test(component)) {
      throw new MaintenanceRefused('conflict', 'session id collides with the maintenance journal namespace')
    }
    return batchId + '/' + component
  }

  private paths(entry: SessionMaintenanceManifest) {
    const incoming = entry.operation === 'restore'
    return {
      source: join(incoming ? this.trashRoot : this.sessionsRoot, entry.hostChecks.sourceRelative),
      target: join(incoming ? this.sessionsRoot : this.trashRoot, entry.hostChecks.targetRelative),
    }
  }

  private async assertVacant(source: string, target: string): Promise<void> {
    if (!(await directoryChain(source)).exists) throw new MaintenanceRefused('not-found', 'source directory is absent')
    const dir = await directoryChain(dirname(target))
    if (dir.exists && await readIdentity(target) !== undefined) throw new MaintenanceRefused('conflict', 'target already exists')
    if (!await this.sameVolume(source, dirname(target))) throw new MaintenanceRefused('cross-volume', 'source and target are not on one volume')
  }

  private identify(path: string) {
    return identifyArtifact(path, this.compression, SESSION_FORMAT_VERSION)
  }

  private journalPath(entry: SessionMaintenanceManifest): string {
    const name = entry.operation === 'delete' ? 'manifest.json' : 'restore-' + entry.operationId + '.json'
    return join(this.trashRoot, entry.batchId, name)
  }

  private async update(entry: SessionMaintenanceManifest, state: SessionMaintenanceManifest['state'], reason?: string, reservation = entry.reservation) {
    const next = { ...entry, updatedAt: new Date().toISOString(), state, reason, reservation }
    await writeJournal(this.journalPath(entry), next, true)
    return next
  }

  private async commit(intent: SessionMaintenanceManifest, source: string, target: string): Promise<SessionMaintenanceResult> {
    let entry = intent
    let prepared = false
    let attempted = false
    try {
      if (entry.operation === 'delete') {
        await createDirectories(this.trashRoot)
        const path = join(this.trashRoot, entry.batchId)
        if (process.platform === 'win32') {
          const staging = await mkdtemp(join(this.trashRoot, '.batch-'))
          try {
            await publishNewFileWin32(staging, path)
          } catch (error) {
            await this.removeReservationDirectory(staging)
            throw error
          }
        } else {
          await mkdir(path, { mode: 0o700 })
          await syncDirectory(this.trashRoot)
        }
      } else if (!(await directoryChain(dirname(target))).exists) {
        return refusal('conflict', 'the original project directory no longer exists')
      }
      await writeJournal(this.journalPath(entry), entry, false)
      prepared = true
      if (entry.operation === 'delete') await this.tombstone(entry, true)
      await this.assertVacant(source, target)
      if (!sameArtifact(await this.identify(source), entry.hostChecks.observedIdentity)) {
        throw new MaintenanceRefused('hash-mismatch', 'source changed after intent publication')
      }
      if (process.platform === 'win32') {
        attempted = true
        await publishNewFileWin32(source, target)
      } else {
        // POSIX rename can replace an empty directory. Reserve exactly this slot
        // while every cooperating user of either path is excluded by kernel locks.
        await mkdir(target, { mode: 0o700 })
        const reserved = await readIdentity(target)
        if (!reserved?.isDirectory() || reserved.isSymbolicLink()) throw new MaintenanceRefused('conflict', 'reservation was replaced')
        await syncDirectory(dirname(target))
        entry = await this.update(entry, 'reserved', undefined, { device: String(reserved.dev), inode: String(reserved.ino) })
        if (!await this.emptyReservation(target, entry)) throw new MaintenanceRefused('conflict', 'reservation was not empty or changed identity')
        attempted = true
        await rename(source, target)
        await syncDirectory(dirname(source))
        await syncDirectory(dirname(target))
      }
      this.hooks.invalidate(entry.id)
      const completed = await this.update(entry, 'moved')
      if (entry.operation === 'restore') await this.tombstone(entry, false)
      return { status: 'moved', entry: completed }
    } catch (error) {
      const refused = explain(error)
      if (!prepared) {
        // A directory or intent may have appeared even if its publication failed.
        return { ...refused, batchId: entry.batchId, outcome: 'not-moved' }
      }
      try {
        const observed = await this.reconcile(entry, false)
        if (observed === 'moved') {
          this.hooks.invalidate(entry.id)
          return { ...refusal('recovery-required', 'directory moved but maintenance bookkeeping did not finish'), batchId: entry.batchId, outcome: 'moved-unrecorded' }
        }
        if (observed === 'not-moved') {
          await this.update(entry, 'not-moved', refused.reason)
          if (entry.operation === 'delete') await this.tombstone(entry, false)
          return { ...refused, batchId: entry.batchId, outcome: 'not-moved' }
        }
        if (observed === 'reserved-empty' && !attempted) {
          return { ...refused, batchId: entry.batchId, outcome: 'not-moved' }
        }
      } catch (recordError) {
        this.hooks.warn('maintenance outcome could not be recorded: ' + String(recordError))
      }
      return { ...refusal('recovery-required', refused.detail ?? refused.reason), batchId: entry.batchId, outcome: 'unknown' }
    }
  }

  private async removeReservationDirectory(path: string): Promise<void> {
    if (this.rmdir === undefined) throw new SessionMaintenanceDisabledError()
    await this.rmdir(path) // never recursive, even when the recorded occupant is ours
  }

  private async emptyReservation(path: string, entry: SessionMaintenanceManifest): Promise<boolean> {
    const s = await readIdentity(path)
    return s?.isDirectory() === true && !s.isSymbolicLink() && entry.reservation !== undefined
      && String(s.dev) === entry.reservation.device && String(s.ino) === entry.reservation.inode
      && (await readdir(path)).length === 0
  }

  private async reconcile(entry: SessionMaintenanceManifest, persist: boolean): Promise<'not-moved' | 'moved' | 'reserved-empty' | 'quarantined'> {
    const { source, target } = this.paths(entry)
    const activePath = entry.operation === 'delete' ? source : target
    let result: 'not-moved' | 'moved' | 'reserved-empty' | 'quarantined' = 'quarantined'
    let detail = 'source/target presence or artifact identity is inconsistent'
    try {
      const selectedActivePath = await this.findActiveDirectory(entry.id)
      if (selectedActivePath !== undefined && selectedActivePath !== activePath) throw new MaintenanceRefused('conflict', 'session reappeared at another path')
      const sourcePresent = (await directoryChain(source)).exists
      const targetPresent = (await directoryChain(target)).exists
      if (sourcePresent && sameArtifact(await this.identify(source), entry.hostChecks.observedIdentity)) {
        if (!targetPresent) result = 'not-moved'
        else if (await this.emptyReservation(target, entry)) result = 'reserved-empty'
      } else if (!sourcePresent && targetPresent && sameArtifact(await this.identify(target), entry.hostChecks.observedIdentity)) {
        result = 'moved'
      }
    } catch (error) {
      detail = explain(error).detail ?? explain(error).reason
    }
    if (persist && (result === 'not-moved' || result === 'moved' || result === 'quarantined')) {
      if (result === 'moved') {
        await syncDirectory(dirname(source))
        await syncDirectory(dirname(target))
        this.hooks.invalidate(entry.id)
      }
      await this.update(entry, result, result === 'quarantined' ? detail : undefined)
      if ((result === 'not-moved' && entry.operation === 'delete') || (result === 'moved' && entry.operation === 'restore')) {
        await this.tombstone(entry, false)
      }
      if (result === 'moved' && entry.operation === 'delete') await this.tombstone(entry, true)
    }
    return result
  }

  private async batchNames(): Promise<string[]> {
    if (!(await directoryChain(this.trashRoot)).exists) return []
    return (await readdir(this.trashRoot)).sort()
  }

  private async scan(recover: boolean): Promise<SessionMaintenanceBatch[]> {
    const batches: SessionMaintenanceBatch[] = []
    for (const batch of await this.batchNames()) {
      try {
        const records = await this.records(batch)
        if (!recover) batches.push(await this.batchReport(records, false))
        else {
          const state = await this.withSessionLocks(records.deletion.id, () => this.batchReport(records, true)).catch((error: unknown) => {
            if (error instanceof SessionAlreadyOwnedError) return refusal('lease')
            throw error
          })
          batches.push('reason' in state && state.status === 'refused'
            ? { batch, status: 'intent', detail: state.reason, deletion: records.deletion }
            : state)
        }
      } catch (error) {
        batches.push({ batch, status: 'quarantined', detail: explain(error).detail ?? explain(error).reason })
      }
    }
    return batches
  }

  private async batchReport(records: BatchRecords, recover: boolean): Promise<SessionMaintenanceBatch> {
    const { deletion, restores } = records
    const restore = restores.find(entry => entry.state !== 'not-moved') ?? restores[0]
    const entry = deletion.state === 'moved' && restore !== undefined ? restore : deletion
    let status: SessionMaintenanceBatch['status']
    if (entry.state === 'intent' || entry.state === 'reserved') {
      const observed = await this.reconcile(entry, recover)
      if (observed === 'reserved-empty' || observed === 'quarantined') status = observed
      else if (!recover) status = 'intent'
      else if (observed === 'moved') status = entry.operation === 'restore' ? 'restored' : 'moved'
      else status = entry.operation === 'restore' ? 'moved' : 'not-moved'
      if (recover && observed !== 'reserved-empty') return this.batchReport(await this.records(deletion.batchId), false)
    } else if (entry.state === 'moved') {
      status = entry.operation === 'restore' ? 'restored' : 'moved'
    } else if (entry.state === 'not-moved') {
      status = entry.operation === 'restore' ? 'moved' : 'not-moved'
    } else {
      status = 'quarantined'
    }
    // A crash can occur after committing the receipt but before reopening access.
    if (recover && (status === 'restored' || status === 'not-moved')) await this.tombstone(entry, false)
    return { batch: deletion.batchId, status, deletion, restore, detail: entry.reason }
  }

  private async records(batch: string): Promise<BatchRecords> {
    if (!UUID.test(batch)) throw new MaintenanceRefused('corrupt', 'unrecognized batch name')
    const dir = join(this.trashRoot, batch)
    if (!(await directoryChain(dir)).exists) throw new MaintenanceRefused('not-found', 'batch is absent')
    const deletion = await this.readJournal(join(dir, 'manifest.json'), batch, 'delete')
    const restores: SessionMaintenanceManifest[] = []
    for (const name of await readdir(dir)) {
      if (name === 'manifest.json' || name === encodeSegment(deletion.id) || /^\.journal-[0-9a-f-]+\.tmp$/u.test(name)) continue
      const match = /^restore-([0-9a-f-]+)\.json$/u.exec(name)
      if (match?.[1] === undefined) throw new MaintenanceRefused('corrupt', 'unknown batch entry')
      const entry = await this.readJournal(join(dir, name), batch, 'restore')
      if (entry.id !== deletion.id || entry.operationId !== match[1] || entry.operationId === deletion.operationId
        || entry.hostChecks.targetRelative !== deletion.hostChecks.sourceRelative
        || !sameArtifact(entry.hostChecks.observedIdentity, deletion.hostChecks.observedIdentity)
        || entry.hostChecks.preRevision !== deletion.hostChecks.postRevision || deletion.state !== 'moved') {
        throw new MaintenanceRefused('corrupt', 'restore journal does not match its deletion')
      }
      restores.push(entry)
    }
    if (restores.filter(entry => entry.state !== 'not-moved').length > 1) throw new MaintenanceRefused('corrupt', 'conflicting restore records')
    restores.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    return { deletion, restores }
  }

  private async readJournal(path: string, batch: string, operation: SessionMaintenanceOperation): Promise<SessionMaintenanceManifest> {
    const file = await readIdentity(path)
    if (!file?.isFile() || file.isSymbolicLink() || file.nlink !== 1n || file.size > BigInt(JOURNAL_LIMIT)) {
      throw new MaintenanceRefused('corrupt', 'missing or invalid maintenance journal')
    }
    const value: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (!record(value) || value.schemaVersion !== 1 || value.batchId !== batch || value.operation !== operation
      || !text(value.operationId) || !UUID.test(value.operationId) || !text(value.id)
      || !isoDate(value.startedAt) || !isoDate(value.updatedAt) || (value.reason !== undefined && !text(value.reason))
      || !record(value.claims) || !text(value.claims.caller) || !validClaims(value.claims)
      || (operation === 'delete' && value.claims.archived !== true)) {
      throw new MaintenanceRefused('corrupt', 'invalid or unknown maintenance journal version')
    }
    const state = value.state
    if (state !== 'intent' && state !== 'reserved' && state !== 'moved' && state !== 'not-moved' && state !== 'quarantined') {
      throw new MaintenanceRefused('corrupt', 'unknown maintenance journal state')
    }
    const reservation = value.reservation
    if (reservation !== undefined ? !record(reservation) || !uint(reservation.device) || !uint(reservation.inode) : state === 'reserved') {
      throw new MaintenanceRefused('corrupt', 'invalid reservation record')
    }
    const host = value.hostChecks
    if (!record(host) || host.rootKey !== this.rootKey || !text(host.tombstoneRelative) || !text(host.sourceRelative) || !text(host.targetRelative) || !text(host.preRevision)
      || host.preRevision !== host.postRevision || host.writerIdle !== true || host.leaseIdle !== true || host.sameVolume !== true
      || !validIdentity(host.expectedIdentity) || !validIdentity(host.observedIdentity)
      || !sameArtifact(host.expectedIdentity, host.observedIdentity)) {
      throw new MaintenanceRefused('corrupt', 'invalid maintenance host checks')
    }
    const id = SessionId(value.id)
    if (host.tombstoneRelative !== relative(this.lockRoot, this.tombstonePath(id))) {
      throw new MaintenanceRefused('corrupt', 'journal tombstone does not identify the Session')
    }
    const active = operation === 'delete' ? host.sourceRelative : host.targetRelative
    const trash = operation === 'delete' ? host.targetRelative : host.sourceRelative
    const parts = active.split('/')
    if (parts.length !== 2 || !this.projectName(parts[0]) || parts[1] !== encodeSegment(id) || trash !== this.trashRelative(batch, id)) {
      throw new MaintenanceRefused('corrupt', 'journal paths do not identify the expected Session and batch')
    }
    const claims = value.claims
    return {
      schemaVersion: 1, batchId: batch as SessionMaintenanceBatchId, operation, state,
      operationId: value.operationId as SessionMaintenanceOperationId, id,
      startedAt: value.startedAt, updatedAt: value.updatedAt, reason: typeof value.reason === 'string' ? value.reason : undefined,
      claims: { ...claims, caller: claims.caller as string },
      hostChecks: {
        rootKey: host.rootKey, tombstoneRelative: host.tombstoneRelative,
        sourceRelative: host.sourceRelative, targetRelative: host.targetRelative,
        preRevision: SessionPersistenceRevision(host.preRevision), postRevision: SessionPersistenceRevision(host.preRevision),
        expectedIdentity: host.expectedIdentity, observedIdentity: host.observedIdentity,
        writerIdle: true, leaseIdle: true, sameVolume: true,
      },
      reservation: record(reservation) && uint(reservation.device) && uint(reservation.inode)
        ? { device: reservation.device, inode: reservation.inode }
        : undefined,
    }
  }
}
