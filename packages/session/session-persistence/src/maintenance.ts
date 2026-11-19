/** Host-side reversible maintenance. These records are not Session log records. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionHeader, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionPersistenceSnapshot } from './index.ts'
import type { SessionPersistenceRevision } from './revision.ts'

/** Identifies a backend-owned maintenance batch. */
export type SessionMaintenanceBatchId = Branded<'SessionMaintenanceBatchId'>
/** Identifies a single direction of movement within a batch. */
export type SessionMaintenanceOperationId = Branded<'SessionMaintenanceOperationId'>
/** Both operations move one entire Session directory, without removing its contents. */
export type SessionMaintenanceOperation = 'delete' | 'restore'

/** Facts about filesystem identity, not deployment or Session activity. */
export interface SessionMaintenanceIdentity {
  readonly device: string
  readonly inode: string
  readonly entriesHash: string
  readonly bytes: number
  readonly generations: readonly {
    readonly name: string
    readonly version: number
    readonly bytes: number
    readonly digest: string
    readonly modifiedNs: string
    readonly fileId: string
  }[]
}

/** Read-only root-lock observation. Holder details are optional and are not ownership tokens. */
export interface SessionMaintenanceGate {
  readonly active: boolean
  readonly holder?: string
  readonly since?: string
  readonly rootKey: string
}

/** Identifies one acquisition of exclusive maintenance on this backend. */
export type MaintenanceEpoch = Branded<'MaintenanceEpoch'>

/** Cancellation before invoking the exclusive callback; an entered callback must settle before release. */
export interface SessionMaintenanceGateOptions {
  readonly signal?: AbortSignal
}

/** Include restorable trash by default. Active-only evidence does not cover deletion admission. */
export interface ReferenceCorpusScope {
  readonly includeTrash?: boolean
  /** Require this exact active epoch; omitting it still requires a currently active exclusive callback. */
  readonly epoch?: MaintenanceEpoch
}

/** Why a strict reference query could not establish complete coverage. */
export interface ReferenceFailure {
  readonly code: 'gate-required' | 'maintenance-gate' | 'stale-epoch' | 'busy' | 'bad-header' | 'unsupported-generation'
    | 'duplicate-id' | 'layout' | 'migration-pending' | 'unstable' | 'trash-unresolved' | 'io' | 'lineage'
    | 'artifact-ref' | 'bad-event' | 'truncated' | 'event-limit' | 'aborted' | 'visitor'
  readonly gate?: SessionMaintenanceGate
  readonly detail?: string
}

/**
 * Evidence for a declared source and scope. Only complete evidence, consumed in the same
 * still-active exclusive epoch, can establish that the query found no references when items is empty.
 * Unknown results never establish absence.
 */
export type Evidence<T> =
  | { readonly state: 'complete'; readonly epoch: MaintenanceEpoch; readonly items: readonly T[] }
  | { readonly state: 'unknown'; readonly reason: ReferenceFailure }

/** Validated header of one retained artifact, without decoding its event body. */
export interface ArtifactHeader {
  readonly id: SessionId
  readonly parentSession?: SessionId
  readonly origin?: SessionHeader['origin']
  readonly isSeeded: boolean
  readonly delegationDepth: number
  readonly location: { readonly kind: 'active' } | { readonly kind: 'trash'; readonly batchId: SessionMaintenanceBatchId }
  readonly revision: SessionPersistenceRevision
  readonly identity: SessionMaintenanceIdentity
  readonly generations: SessionMaintenanceIdentity['generations']
  readonly layout: 'current' | 'migration-required'
}

/**
 * Only an unchanged item returned by inspectReferenceCorpus is a usable reference. Do not construct,
 * clone, or serialize a locator; the backend resolves the path privately inside the originating epoch.
 */
export type ReferenceArtifactRef = ArtifactHeader

/** One strictly decoded source-generation event. Extension payload fields belong to their owning provider. */
export interface SessionEventLike {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: unknown
  readonly ignorable?: true
  readonly [key: string]: unknown
}

/** Bounds for read-only reference body inspection. */
export interface ReferenceLogOptions {
  readonly signal?: AbortSignal
  /** Maximum expanded events delivered; a larger log yields unknown, not partial evidence. */
  readonly maxEvents?: number
}

/** Summary of a complete body read in source-generation coordinates. */
export interface ReferenceLogSummary {
  readonly events: number
  readonly inheritedEventCount: SessionLogOffset
}

/** One direct or transitive descendant; the queried parent itself is not returned. */
export interface ReferenceDescendant {
  readonly artifact: ArtifactHeader
  readonly depth: number
}

/** A strict read-only preview. Commit must validate the returned expectations again under ownership. */
export type SessionMaintenanceInspection = { readonly gate?: SessionMaintenanceGate } & (
  | { readonly state: 'available'; readonly id: SessionId; readonly revision: SessionPersistenceRevision
    readonly identity: SessionMaintenanceIdentity; readonly sameVolume: boolean; readonly migrationPending: false }
  | { readonly state: 'not-found' | 'inspecting-busy' | 'migration-pending' | 'corrupt' | 'unsupported' | 'maintenance-gate'; readonly id: SessionId
    readonly sameVolume: boolean | 'unknown'; readonly migrationPending: boolean; readonly detail?: string | undefined
    readonly trashEntry?: SessionMaintenanceManifest | undefined })

/** Assertions from the policy caller, never observations made by persistence. */
export interface SessionMaintenanceClaims {
  readonly source: string
  readonly version: 1
  readonly archived: boolean
  readonly live: false
  readonly references: { readonly descendants: 0; readonly teamTasks: 0 }
  readonly workspace?: { readonly id: string; readonly position: number }
}

/** The supplied callback either vouches for admission or refuses without admitting any write. */
export type SessionMaintenanceAdmission =
  | { readonly status: 'admitted'; readonly evidence: SessionMaintenanceClaims }
  | { readonly status: 'refused'; readonly reason: string }

/** Backend observations at the time a durable intent was allowed. Paths are relative to their respective roots. */
export interface SessionMaintenanceHostChecks {
  readonly rootKey: string
  readonly tombstoneRelative: string
  readonly sourceRelative: string
  readonly targetRelative: string
  readonly expectedIdentity: SessionMaintenanceIdentity
  readonly observedIdentity: SessionMaintenanceIdentity
  readonly preRevision: SessionPersistenceRevision
  readonly postRevision: SessionPersistenceRevision
  readonly writerIdle: true
  readonly leaseIdle: true
  readonly sameVolume: true
}

/** Locked observations supplied to the policy callback; the host rechecks them after it returns. */
export interface SessionMaintenanceContext {
  readonly id: SessionId
  readonly operation: SessionMaintenanceOperation
  readonly batchId: SessionMaintenanceBatchId
  readonly snapshot?: SessionPersistenceSnapshot | undefined
  readonly deletion?: SessionMaintenanceManifest | undefined
  readonly hostChecks: SessionMaintenanceHostChecks
}

/** A caller and the immutable preview identity authorizing its requested operation. */
export interface SessionMaintenanceOptions {
  readonly caller: string
  readonly expectedRevision?: SessionPersistenceRevision
  readonly expectedIdentity?: SessionMaintenanceIdentity
  readonly batchId?: SessionMaintenanceBatchId
  readonly expectedOperationId?: SessionMaintenanceOperationId
  readonly signal?: AbortSignal
}

/** Versioned intent and receipt for one move. A receipt can be reconstructed after a crash. */
export interface SessionMaintenanceManifest {
  readonly schemaVersion: 1
  readonly batchId: SessionMaintenanceBatchId
  readonly operationId: SessionMaintenanceOperationId
  readonly operation: SessionMaintenanceOperation
  readonly id: SessionId
  readonly startedAt: string
  readonly updatedAt: string
  readonly state: 'intent' | 'reserved' | 'moved' | 'not-moved' | 'quarantined'
  readonly hostChecks: SessionMaintenanceHostChecks
  readonly claims: SessionMaintenanceClaims & { readonly caller: string }
  readonly reservation?: { readonly device: string; readonly inode: string } | undefined
  readonly reason?: string | undefined
}

/** A refusal never reports a completed move. An unknown outcome requires recovery before more writes. */
export type SessionMaintenanceRefusal = {
  readonly status: 'refused'
  readonly reason: 'writer' | 'lease' | 'batch-busy' | 'not-found' | 'corrupt' | 'hash-mismatch'
    | 'revision-changed' | 'identity-changed' | 'migration-pending'
    | 'conflict' | 'cross-volume' | 'admission' | 'invalid-request' | 'recovery-required' | 'io' | 'maintenance-gate'
  readonly detail?: string | undefined
  readonly batchId?: SessionMaintenanceBatchId
  readonly outcome?: 'not-moved' | 'moved-unrecorded' | 'unknown'
}

/** Receipt or typed refusal from an attempted move. */
export type SessionMaintenanceResult =
  | { readonly status: 'moved'; readonly entry: SessionMaintenanceManifest }
  | SessionMaintenanceRefusal

/** One batch's observed or recovered state. Unrecognized state is never permission to write. */
export interface SessionMaintenanceBatch {
  readonly batch: string
  readonly status: 'intent' | 'not-moved' | 'moved' | 'restored' | 'reserved-empty' | 'quarantined'
  readonly deletion?: SessionMaintenanceManifest | undefined
  readonly restore?: SessionMaintenanceManifest | undefined
  readonly detail?: string | undefined
}

/** Results of listing or recovering maintenance batches. */
export type SessionMaintenanceBatches =
  | { readonly status: 'ok'; readonly batches: readonly SessionMaintenanceBatch[] }
  | SessionMaintenanceRefusal

/** Deploy-time information, not proof that external participants respect the protocol. */
export interface SessionMaintenanceCapability {
  readonly enabled: boolean
  readonly allowHistoricalCorpus?: boolean
  readonly coordination: 'unsupported' | 'cooperative-kernel-locks'
  readonly isolation: 'not-verified'
  readonly sessionsRoot?: string
  readonly trashRoot?: string
  readonly lockRoot?: string
  readonly sameVolume: boolean | 'unknown'
  readonly batchBusy: boolean | 'unknown'
  readonly boundaries: readonly string[]
}

/** A backend has not enabled maintenance writes. */
export class SessionMaintenanceDisabledError extends Error {
  constructor() {
    super('Session maintenance writes are not enabled by this persistence backend')
    this.name = 'SessionMaintenanceDisabledError'
  }
}
