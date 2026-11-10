/** Local Git delivery replay is pure: it never allocates checkouts, commits, or starts roles. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { RgRunId, RgTaskId } from './types.ts'
import type { RgCandidateId, RgGitState } from './git-types.ts'

const text = z.string().min(1)
const oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
const inspection = z.object({ root: text, gitDir: text, commonDir: text, headOid: oid, treeOid: oid,
  branch: text.nullable(), linkedWorktree: z.boolean() }).strict()
const candidateId = text.transform(value => brandString<RgCandidateId>(value))
const runId = text.transform(value => brandString<RgRunId>(value))
/** Parser for the durable/wire document, not for typed same-process callers. */
export const gitStateSchema: z.ZodType<RgGitState> = z.object({
  taskId: text.transform(value => brandString<RgTaskId>(value)), configurationHash: text,
  status: z.enum(['authorized', 'preparing', 'working', 'finalizing', 'candidate', 'reviewing', 'interrupted', 'unknown', 'failed']),
  source: inspection, scope: z.array(text).min(1), worktreeName: text, workspace: inspection.nullable(),
  candidate: z.object({ id: candidateId, workerRunId: runId, inspection,
    baseOid: oid, headOid: oid, treeOid: oid, scope: z.array(text).min(1), scopeIdentity: text,
    validation: z.array(z.string()) }).strict().nullable(),
  binding: z.object({ runId, role: z.enum(['worker', 'reviewer']), candidateId: candidateId.nullable(),
    checkoutName: text, checkout: inspection.nullable() }).strict().nullable(), diagnostic: z.string().nullable(),
}).strict().superRefine((state, context) => {
  const candidate = state.candidate
  const workspace = state.workspace
  const binding = state.binding
  const mismatch = candidate !== null && (workspace === null || candidate.baseOid !== state.source.headOid
    || candidate.headOid !== candidate.inspection.headOid || candidate.treeOid !== candidate.inspection.treeOid
    || candidate.inspection.commonDir !== state.source.commonDir || !candidate.inspection.linkedWorktree
    || candidate.inspection.root !== workspace.root || candidate.inspection.gitDir !== workspace.gitDir
    || candidate.inspection.branch !== workspace.branch || candidate.inspection.headOid !== workspace.headOid
    || candidate.inspection.treeOid !== workspace.treeOid || JSON.stringify(candidate.scope) !== JSON.stringify(state.scope))
  const wrongReview = binding?.role === 'reviewer' && (candidate === null || binding.candidateId !== candidate.id
    || binding.checkout !== null && (binding.checkout.commonDir !== state.source.commonDir
      || !binding.checkout.linkedWorktree || binding.checkout.branch !== null
      || binding.checkout.root === candidate.inspection.root || binding.checkout.gitDir === candidate.inspection.gitDir
      || binding.checkout.headOid !== candidate.headOid || binding.checkout.treeOid !== candidate.treeOid))
  const wrongWorker = binding?.role === 'worker' && (binding.candidateId !== null
    || binding.checkout !== null && (workspace === null || binding.checkout.root !== workspace.root
      || binding.checkout.gitDir !== workspace.gitDir || binding.checkout.commonDir !== state.source.commonDir))
  if (mismatch || wrongReview || wrongWorker) context.addIssue({ code: 'custom', message: 'The Git candidate and role binding do not match the authorized repository and scope.' })
})

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Complete local Git authorization, current candidate, and operation facts after one committed change. */
    'review-gated/git-state': { readonly version: 1; readonly state: RgGitState | null }
  }
}
/** Fail-closed replay state; an invalid record cannot be repaired by ignoring later history. */
export interface RgGitProjectionState { readonly value: RgGitState | null; readonly failure: string | null }
/** Fold one event without external effects.
 * @param state - prior state or restored checkpoint.
 * @param event - committed Session event.
 * @returns the same reference for unrelated events.
 */
export function foldGitState(state: RgGitProjectionState, event: SessionEvent): RgGitProjectionState {
  if (event.type !== 'review-gated/git-state' || state.failure !== null) return state
  const parsed = z.object({ version: z.literal(1), state: gitStateSchema.nullable() }).strict().safeParse(event.data)
  return parsed.success ? { value: parsed.data.state, failure: null }
    : { ...state, failure: 'RG_GIT_STATE_INVALID: event ' + String(event.seq) }
}
/** Separate from the unchanged RG model-policy and report projection. */
export const gitProjectionDefinition = {
  key: 'reviewGatedGit', stateVersion: 1,
  stateSchema: z.object({ value: gitStateSchema.nullable(), failure: z.string().nullable() }).strict(),
  init: () => ({ value: null, failure: null }), apply: foldGitState,
  wire: { viewSchema: gitStateSchema.nullable(), view: (state: RgGitProjectionState) => state.value },
} satisfies ProjectionDefinition<'reviewGatedGit', RgGitProjectionState>
