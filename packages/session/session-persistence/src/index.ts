/**
 * Durable session-persistence Service Definition (`ctx.sessionPersistence`). Backends store
 * {@link SessionEvent}s as the event-sourced log and carry non-replayable
 * {@link SessionHeader} metadata separately; callers address one stored
 * session through a {@link SessionHandle} obtained from `create`/`open`.
 * @module @deepseek-ai/dsh-session-persistence
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { SessionEvent, SessionHeader, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionHandle, SessionAccess } from './handle.ts'
import type { SessionLocation } from './errors.ts'
import type { SessionPersistenceRevision } from './revision.ts'

import {
  SessionMaintenanceDisabledError,
  type SessionMaintenanceAdmission, type SessionMaintenanceBatches, type SessionMaintenanceContext,
  type SessionMaintenanceCapability, type SessionMaintenanceInspection, type SessionMaintenanceOperation, type SessionMaintenanceOptions,
  type SessionMaintenanceBatchId, type SessionMaintenanceOperationId, type SessionMaintenanceRefusal,
  type SessionMaintenanceResult, type ArtifactHeader, type Evidence, type MaintenanceEpoch, type ReferenceCorpusScope,
  type SessionMaintenanceGate, type SessionMaintenanceGateOptions,
  type ReferenceArtifactRef, type ReferenceLogOptions, type ReferenceLogSummary, type SessionEventLike,
} from './maintenance.ts'

export * from './maintenance.ts'
export { referenceDescendants } from './reference-lineage.ts'

// Re-export the metadata vocabulary so Consumers import it from the Service Definition.
export type { SessionHeader } from '@deepseek-ai/dsh-session'
export { SessionPersistenceRevision } from './revision.ts'
export type {
  SessionAccess,
  SessionHandle,
  SessionHandleAppendOptions,
  SessionHandleFlushOptions,
  SessionHandleReadOptions,
  SessionHandleReadResult,
} from './handle.ts'
export {
  SessionAlreadyExistsError,
  SessionAlreadyOwnedError,
  SessionFormatUnsupportedError,
  SessionHandleClosedError,
  SessionOwnershipLostError,
  SessionPersistenceCorruptionError,
  SessionPersistenceNotFoundError,
  SessionReadOnlyError,
  sessionFormatVersionRefusal,
} from './errors.ts'
export type { SessionLocation } from './errors.ts'
export {
  assertContiguous,
  assertStoredId,
  assertVersion,
  materializeAppendBatch,
  materializeCreateHeader,
  validateStoredEvents,
} from './storage-contract.ts'

/**
 * Lightweight stored-session observation returned by {@link SessionPersistence.stat}
 * and {@link SessionPersistence.list} without reading the full event log.
 */
export interface SessionPersistenceSnapshot {
  /** Detached metadata for one stored session. */
  readonly header: SessionHeader
  /** Header-only format classification; absent without versioned artifact metadata. */
  readonly formatStatus?: 'current' | 'migration-required'
  /** Opaque change token; see {@link SessionPersistence.stat}. */
  readonly revision: SessionPersistenceRevision
  /** Logical event count, when the backend can provide it cheaply from metadata; otherwise absent. */
  readonly eventCount?: number
  /** Physical artifact byte size, when the backend can provide it cheaply (JSONL); otherwise absent. */
  readonly sizeBytes?: number
  /**
   * Backend-resolved location of the selected materialized per-Session
   * artifact, for diagnostics and export. Absent when the backend has no
   * materialized per-Session file, including an unmaterialized pending Session.
   */
  readonly location?: SessionLocation
}

/** Options for {@link SessionPersistence.create}. */
export interface SessionPersistenceCreateOptions {
  /** Optional cancellation observed before backend work starts. */
  readonly signal?: AbortSignal
  /**
   * Exact fork-inherited prefix length. Required when `header.isSeeded` is
   * true and must be omitted (or `0`) otherwise; the backend refuses a
   * mismatch at create.
   */
  readonly inheritedEventCount?: SessionLogOffset
}

/**
 * Logical Session header paired with its exact inherited cut for body-bearing
 * storage operations. `isSeeded` marks fork lineage on the header; the
 * numeric cut travels beside it, never inside the replayable event log.
 */
export interface SessionStorageMetadata {
  /** Validated immutable Session header. */
  readonly meta: SessionHeader
  /** Number of leading events inherited from the Session's fork parent. */
  readonly inheritedEventCount: SessionLogOffset
}

/** Immutable logical session read: storage metadata plus the complete validated event log. */
export interface SessionInspection extends SessionStorageMetadata {
  /** Contiguous validated events from seq 0. */
  readonly events: readonly SessionEvent[]
}

/** Options for {@link SessionPersistence.open}. */
export interface SessionPersistenceOpenOptions {
  /** Optional cancellation observed before backend work starts. */
  readonly signal?: AbortSignal
}

/** Options for {@link SessionPersistence.stat}. */
export interface SessionPersistenceStatOptions {
  /** Optional cancellation for backend metadata reads. */
  readonly signal?: AbortSignal
}

/** Options for {@link SessionPersistence.list}. */
export interface SessionPersistenceListOptions {
  /** Optional cancellation for backend listing work. */
  readonly signal?: AbortSignal
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionPersistence: SessionPersistence
  }
}

/**
 * Durable append-only session storage addressed through per-session handles.
 *
 * Storage semantics shared by every backend: events are contiguous from seq 0
 * and never rewritten; a torn physical tail is never returned to a reader and
 * is truncated by the write path before its first append; reads validate
 * current-format records only and refuse unknown vocabulary fail-closed.
 * `append` persists best-effort; `flush` — per handle or service-wide — is
 * the durability barrier.
 *
 * Visibility: a created session is observable through `stat`/`list`/`open`
 * in this process from the moment `create` resolves, even while a backend
 * defers physical materialization (a pure optimization); other processes see
 * the session only once it materializes, and a session that never
 * materialized before a crash never existed. `SessionHandle.flush` forces
 * materialization.
 *
 * Freshness: once an `append` or `flush` resolves, reads started afterwards
 * on this backend instance observe at least that prefix.
 */
export abstract class SessionPersistence extends Service {
  /** Process-local instance identity, stable through Context proxies and distinct after service replacement. */
  readonly identity: symbol = Symbol('sessionPersistence')

  constructor(ctx: Context) {
    super(ctx, 'sessionPersistence')
  }

  /**
   * Create a new stored session and take its write ownership.
   * @param header - the immutable header (id, version, cwd, lineage) to store.
   * @param options - optional cancellation.
   * @returns a `write` handle owned by the caller; close it to release ownership.
   * @throws {SessionAlreadyExistsError} when the id already exists.
   */
  abstract create(header: SessionHeader, options?: SessionPersistenceCreateOptions): Promise<SessionHandle>

  /**
   * Open an existing stored session.
   *
   * `read` never takes ownership and works while another handle (or process)
   * holds write ownership. `write` atomically claims single-writer ownership;
   * an existing active owner rejects.
   * @param id - the stored session to open.
   * @param access - `read` or `write`.
   * @param options - optional cancellation.
   * @returns the open handle.
   * @throws {SessionPersistenceNotFoundError} when the session does not exist.
   * @throws {SessionAlreadyOwnedError} for `write` when ownership is taken.
   */
  abstract open(id: SessionId, access: SessionAccess, options?: SessionPersistenceOpenOptions): Promise<SessionHandle>

  /**
   * Flush every active write handle owned by this service instance in one
   * durability barrier: each handle's routed live events drain durably and
   * its session materializes, exactly as that handle's own
   * `SessionHandle.flush` would. Read handles buffer nothing and are
   * untouched. A handle closed concurrently counts as flushed — close itself
   * drains durably.
   * @returns resolution once every write handle active at the call has flushed.
   * @throws {AggregateError} naming each session whose flush failed; the
   *   remaining handles still flush.
   */
  abstract flush(): Promise<void>

  /**
   * Observe one stored session without reading its event log or taking
   * ownership.
   *
   * The snapshot's `revision` is an opaque change token comparable only
   * against revisions from the same service instance and session id: equal
   * revisions may be treated as an unchanged log; unequal revisions promise
   * nothing. Write-ownership churn does not change a revision. It exists for
   * derived read-model caches keyed off `stat`/`list`; it plays no part in
   * open, read, or resume.
   * @param id - the stored session to observe.
   * @param options - optional cancellation.
   * @returns the snapshot, or `undefined` when the session does not exist.
   */
  abstract stat(id: SessionId, options?: SessionPersistenceStatOptions): Promise<SessionPersistenceSnapshot | undefined>

  /**
   * List every stored session visible to this process, in no promised order.
   * @param options - optional cancellation.
   * @returns one snapshot per stored session.
   */
  abstract list(options?: SessionPersistenceListOptions): Promise<readonly SessionPersistenceSnapshot[]>

  /** @returns read-only root-lock status, never ownership. @throws {SessionMaintenanceDisabledError} when disabled. */
  async maintenanceGate(): Promise<SessionMaintenanceGate> {
    throw new SessionMaintenanceDisabledError()
  }

  /**
   * Try root exclusion without waiting for existing handles to close. The callback must await all work it starts.
   * Cooperating storage handles cannot open while the callback runs. This does not establish deployment isolation.
   * @param holder - diagnostic name of the caller.
   * @param fn - exclusive work, with the epoch for comparing evidence from cooperating providers.
   * @param options - optional cancellation before entering the callback.
   * @returns the callback result, after root ownership has been released.
   * @throws {SessionMaintenanceDisabledError} when disabled; rejects with reason 'maintenance-gate' on contention.
   */
  async withExclusiveMaintenance<T>(
    _holder: string, _fn: (epoch: MaintenanceEpoch) => Promise<T>, _options?: SessionMaintenanceGateOptions,
  ): Promise<T> {
    throw new SessionMaintenanceDisabledError()
  }

  /**
   * Check whether the caller is inside this instance's exclusive callback for the given epoch.
   * Providers must not return complete evidence when this check fails.
   * @param epoch - epoch supplied to the callback by this service.
   * @returns whether the epoch may currently authorize evidence from this caller's scope.
   */
  isMaintenanceEpochActive(_epoch: MaintenanceEpoch): boolean {
    return false
  }

  /**
   * Read the retained header corpus. Complete results require this backend's active exclusive callback.
   * Do not call from a move admission callback; collect evidence before taking the target locks.
   * @param scope - corpus coverage; defaults to active and restorable trash.
   * @returns complete header evidence or a typed reason why the result cannot be used.
   */
  async inspectReferenceCorpus(_scope?: ReferenceCorpusScope): Promise<Evidence<ArtifactHeader>> {
    throw new SessionMaintenanceDisabledError()
  }

  /**
   * Visit decoded events from an unchanged active or trash corpus item under its originating exclusive epoch.
   * This read does not acquire locks, create files, or decode migrations. Visitor results remain provisional
   * until the read returns complete. The visitor must be synchronous, must not mutate storage, and may see
   * inherited events; use the returned cut to distinguish them from own events.
   * @param epoch - active exclusive epoch that produced the item.
   * @param artifact - the unchanged corpus item (not a clone or a path).
   * @param visit - callback for each validated source-generation event, in sequence order.
   * @param options - cancellation or a maximum event count.
   * @returns a one-item summary only after clean EOF and identity checks; otherwise unknown.
   */
  async inspectReferenceLog(
    _epoch: MaintenanceEpoch, _artifact: ReferenceArtifactRef, _visit: (event: SessionEventLike) => void, _options?: ReferenceLogOptions,
  ): Promise<Evidence<ReferenceLogSummary>> {
    return { state: 'unknown', reason: { code: 'stale-epoch' } }
  }

  /** @returns backend capabilities and known limits, without acquiring ownership. */
  async maintenanceCapability(): Promise<SessionMaintenanceCapability> {
    return { enabled: false, coordination: 'unsupported', isolation: 'not-verified', sameVolume: 'unknown', batchBusy: 'unknown', boundaries: [] }
  }

  /**
   * Read complete backend artifact identity without writing or admitting a move.
   * @param id - the requested session.
   * @returns preview observations, never ownership or authorization.
   */
  async inspectMaintenance(id: SessionId): Promise<SessionMaintenanceInspection> {
    return { id, state: 'unsupported', sameVolume: 'unknown', migrationPending: false }
  }

  /**
   * Run a policy check and, if admitted and still valid, move the entire session directory.
   * The callback must not re-enter maintenance or mutate the artifact. Its evidence
   * is persisted separately from backend checks. The caller owns isolation, lifecycle
   * admission and derived registry/cache updates; a receipt certifies only the move.
   * @param id - stored session id.
   * @param operation - move to trash or restore to the recorded original location.
   * @param admit - policy callback, called while storage exclusion is held.
   * @param options - caller, plus preview revision and artifact identity for delete, or the confirmed batch and operation ids for restore.
   * @returns a move receipt or a refusal; unknown outcomes require recovery before retrying.
   * @throws {SessionMaintenanceDisabledError} from an unsupported or disabled backend.
   */
  async withMaintenance<T extends SessionMaintenanceAdmission>(
    _id: SessionId, _operation: SessionMaintenanceOperation,
    _admit: (ctx: SessionMaintenanceContext) => Promise<T>, _options?: SessionMaintenanceOptions,
  ): Promise<SessionMaintenanceResult> {
    throw new SessionMaintenanceDisabledError()
  }

  /** @returns known journal records and isolation findings, without changing them. */
  async listMaintenanceBatches(): Promise<SessionMaintenanceBatches> {
    return { status: 'ok', batches: [] }
  }

  /** @returns observed/recorded recovery results. Recovery never moves artifact directories. */
  async recoverMaintenance(): Promise<SessionMaintenanceBatches> {
    throw new SessionMaintenanceDisabledError()
  }

  /**
   * Explicitly release an empty POSIX reservation matching a persisted identity.
   * @param batchId - batch whose pending operation reserved the target.
   * @param operationId - expected reservation owner.
   * @returns the updated report or a refusal; never removes artifact directories.
   */
  async releaseMaintenanceReservation(
    _batchId: SessionMaintenanceBatchId, _operationId: SessionMaintenanceOperationId,
  ): Promise<SessionMaintenanceBatches | SessionMaintenanceRefusal> {
    throw new SessionMaintenanceDisabledError()
  }
}

export default SessionPersistence
