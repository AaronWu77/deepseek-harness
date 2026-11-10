/** JSON data shared by RG settings, Session projections, and client views. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { RgGitState } from './git-types.ts'
export type { RgGitState, RgGitCandidate, RgCandidateId } from './git-types.ts'

/** Bounded model-visible claim details; rawPayloadTruncated always records omitted raw fields. */
export interface RgClaimReport {
  readonly claimStatus: 'saving' | 'unknown' | null
  readonly sessionId: string
  readonly sessionIdTruncated: boolean
  readonly rawPayloadTruncated: true
  readonly hint: string
  readonly claim: {
    readonly intentSeq: SessionSeq
    readonly target: 'next-turn' | 'next-step'
    readonly turn: number
    readonly step: number
    readonly phase: 'unsettled' | 'entered' | 'rejected' | 'empty'
    readonly inputCount: number
    readonly otherContent: boolean
    readonly textPreview: string
  } | null
}

/** Complete ordered RG view for one authorized Session. */
export interface RgView {
  readonly status: 'ready' | 'saving' | 'unknown'
  readonly state: RgSessionState | null
  readonly git: RgGitState | null
  /** Bounded text preview; complete raw inputs remain in the Session log. */
  readonly claim: { readonly phase: 'unsettled' | 'entered' | 'rejected' | 'empty'; readonly text: string; readonly truncated: boolean; readonly otherContent: boolean } | null
}

/** Identifies one human-owned RG task. */
export type RgTaskId = Branded<'RgTaskId'>
/** Identifies one budgeted role attempt. */
export type RgRunId = Branded<'RgRunId'>
/** Stable reasons that a human or coordinator can act on. */
export type RgErrorCode = 'RG_NOT_READY' | 'RG_LEGACY_SESSION' | 'RG_TASK_REQUIRED' | 'RG_BUSY' | 'RG_BUDGET_EXHAUSTED' | 'RG_MODEL_NOT_ALLOWED' | 'RG_INVALID_REPORT' | 'RG_UNAUTHORIZED_START' | 'RG_SCOPE_UNVERIFIED' | 'RG_GIT_AUTH_REQUIRED' | 'RG_GIT_UNAVAILABLE' | 'RG_GIT_CHANGED' | 'RG_GIT_UNKNOWN'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** An RG policy refusal; callers localize the category and offer the appropriate recovery. */
    'review-gated/refused': { readonly reason: RgErrorCode }
  }
}

/** Roles with independent model selection and request history. */
export type RgRole = 'main' | 'worker' | 'reviewer'
/** An exact model route and its configured reasoning choice. */
export interface RgModel {
  /** Registered LLM provider id. */
  readonly provider: string
  /** Provider-owned model id. */
  readonly model: string
  /** Omission uses the adapter default, never a parent role's effort. */
  readonly reasoningEffort?: string
}
/** Authorized choices and a default naming one of their routes. */
export interface RgModelPool {
  /** Exact permitted routes and reasoning choices; may be empty before configuration. */
  readonly candidates: readonly RgModel[]
  /** Initial route naming one candidate, or null while unconfigured. */
  readonly default: {
    /** Provider of the default candidate. */
    readonly provider: string
    /** Model of the default candidate. */
    readonly model: string
  } | null
}
/** Editable reviewer choice; inheritance is resolved once per new Session. */
export type RgReviewerSettings =
  | {
    /** Copy the main pool, default and reasoning into the new Session's frozen reviewer policy. */
    readonly mode: 'inherit-main'
  }
  | {
    /** Use an independent reviewer pool instead of inheriting the main configuration. */
    readonly mode: 'custom'
    /** Reviewer candidates and default captured for newly initialized RG Sessions. */
    readonly pool: RgModelPool
  }
/** One atomically saved RG configuration document. */
export interface RgSettings {
  /** Whether this document authorizes model pools for newly initialized RG Sessions. */
  readonly configured: boolean
  /** Main role candidates and default captured when an RG Session is initialized. */
  readonly main: RgModelPool
  /** Worker pool frozen with the parent RG Session, not read again for each child. */
  readonly worker: RgModelPool
  /** Reviewer inheritance mode or custom pool, resolved once when an RG Session is initialized. */
  readonly reviewer: RgReviewerSettings
  /** Accepted worker and repair attempts per human task; failures and cancellations are not refunded. */
  readonly maxWorkerAttempts: number
  /** Accepted reviewer attempts per human task; failures, cancellations and inconclusive results consume attempts. */
  readonly maxReviewAttempts: number
  /** Maximum characters in a task objective or complete serialized role handoff. */
  readonly maxHandoffChars: number
  /** Maximum characters in a complete serialized parent result notice, including its wrapper and bounded diagnostics. */
  readonly maxReportChars: number
  /** Maximum filesystem entries per review-scope capture; exceeding it leaves the scope unverified. */
  readonly maxScopeFiles: number
  /** Maximum hashed file-content bytes per review-scope capture; exceeding it leaves the scope unverified. */
  readonly maxScopeBytes: number
}
/** Immutable authorization and budget captured for a new RG Session. */
export interface RgPolicy {
  readonly version: 1
  readonly configurationHash: string
  readonly main: RgModelPool
  readonly worker: RgModelPool
  readonly reviewer: RgModelPool
  readonly reviewerInherited: boolean
  readonly maxWorkerAttempts: number
  readonly maxReviewAttempts: number
  readonly maxHandoffChars: number
  readonly maxReportChars: number
  readonly maxScopeFiles: number
  readonly maxScopeBytes: number
}
/** Complete requirements delivered to a fresh role. */
export interface RgHandoff {
  readonly objective: string
  readonly acceptance: readonly string[]
  readonly scope: readonly string[]
  readonly constraints: readonly string[]
  readonly facts: readonly string[]
  readonly validation: readonly string[]
}
/** Worker-authored report; validation entries remain claims with tool evidence. */
export interface RgWorkerReport {
  readonly kind: 'worker'
  readonly outcome: 'completed' | 'partial' | 'blocked'
  readonly summary: string
  readonly changes: readonly string[]
  readonly validation: readonly string[]
  readonly unverified: readonly string[]
}
/** One evidence-based reviewer finding. */
export interface RgFinding {
  readonly location: string
  readonly impact: string
  readonly evidence: string
}
/** Reviewer-authored verdict, not a proof of program correctness. */
export interface RgReviewReport {
  readonly kind: 'reviewer'
  readonly verdict: 'pass' | 'changes-requested' | 'inconclusive'
  readonly summary: string
  readonly inspectedScope: readonly string[]
  readonly findings: readonly RgFinding[]
  readonly validation: readonly string[]
  readonly unverified: readonly string[]
}
/** Role-specific structured result. */
export type RgReport = RgWorkerReport | RgReviewReport
/** Content identity of the explicitly inspected file scope. */
export interface RgScopeSnapshot {
  readonly root: string
  readonly paths: readonly string[]
  readonly fingerprint: string | null
  readonly diagnostic: string | null
  readonly capturedAt: number
}
/** Persisted admission and terminal facts for one role attempt. */
export interface RgRun {
  readonly id: RgRunId
  readonly childId: SessionId
  readonly role: 'worker' | 'reviewer'
  readonly workRevision: number
  readonly selection: RgModel
  readonly status: 'reserved' | 'running' | 'saving' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
  readonly report: RgReport | null
  readonly diagnostic: string | null
  readonly scope: RgScopeSnapshot | null
}
/** Current task only; historical attempts remain in the Session log. */
export interface RgTask {
  readonly id: RgTaskId
  readonly originMessageId: MessageId
  readonly objective: string
  readonly workRevision: number
  readonly workerAttempts: number
  readonly reviewAttempts: number
  readonly active: RgRun | null
  readonly lastWorker: RgRun | null
  readonly lastReview: RgRun | null
  readonly reviewStatus: 'not-reviewed' | 'reviewing' | 'reported-pass' | 'changes-requested' | 'inconclusive' | 'stale'
}
/** Frozen role ownership of a Session; no live resource is persisted. */
export interface RgSessionState {
  /** Blank-preset rollback restores the selection that preceded RG binding. */
  readonly priorModel?: RgModel | null
  readonly policy: RgPolicy | null
  readonly role: RgRole
  readonly parentSessionId: SessionId | null
  readonly taskId: RgTaskId | null
  readonly runId: RgRunId | null
  readonly task: RgTask | null
  readonly diagnostic: string | null
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    reviewGated: RgSessionState | null
  }
}
