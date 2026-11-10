/** Durable local Git delivery facts; reports and role budgets remain owned by the RG task. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { RgRunId, RgTaskId } from './types.ts'
/** Canonical process paths and a pinned, non-unborn checkout. */
export interface GitInspection {
  readonly root: string
  readonly gitDir: string
  readonly commonDir: string
  readonly headOid: string
  readonly treeOid: string
  readonly branch: string | null
  readonly linkedWorktree: boolean
}
/** Persisted identity only; content and diff text are read through the Git executor. */
export interface GitCandidateIdentity {
  readonly inspection: GitInspection
  readonly baseOid: string
  readonly headOid: string
  readonly treeOid: string
  readonly scope: readonly string[]
  readonly scopeIdentity: string
}

/** Identifies one Host-verified immutable delivery candidate. */
export type RgCandidateId = Branded<'RgCandidateId'>
/** A verified commit and the worker whose complete report preceded its creation. */
export interface RgGitCandidate extends GitCandidateIdentity {
  readonly id: RgCandidateId
  readonly workerRunId: RgRunId
  /** Worker claims, retained as evidence rather than independently verified test outcomes. */
  readonly validation: readonly string[]
}
/** Current local delivery only; historical candidates and operations stay in the Session log. */
export interface RgGitState {
  readonly taskId: RgTaskId
  readonly configurationHash: string
  readonly status: 'authorized' | 'preparing' | 'working' | 'finalizing' | 'candidate' | 'reviewing' | 'interrupted' | 'unknown' | 'failed'
  readonly source: GitInspection
  readonly scope: readonly string[]
  /** Reserved before allocation; retained after failure so partial resources can be located. */
  readonly worktreeName: string
  readonly workspace: GitInspection | null
  readonly candidate: RgGitCandidate | null
  readonly binding: {
    readonly runId: RgRunId
    readonly role: 'worker' | 'reviewer'
    readonly candidateId: RgCandidateId | null
    readonly checkoutName: string
    readonly checkout: GitInspection | null
  } | null
  readonly diagnostic: string | null
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    reviewGatedGit: RgGitState | null
  }
}
