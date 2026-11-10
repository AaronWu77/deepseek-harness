/** Pure admission and settlement of one bounded RG role cycle. */
import { RgError } from './errors.ts'
import type { RgPolicy, RgReport, RgRun, RgRunId, RgTask } from './types.ts'

/** Reserve the next attempt without an asynchronous gap between checking and consuming capacity.
 * @param task - current human-owned task.
 * @param policy - immutable Session budgets.
 * @param run - new role attempt with its reserved child identity.
 * @returns the complete post-admission task state.
 */
export function reserveRun(task: RgTask, policy: RgPolicy, run: RgRun): RgTask {
  if (task.active !== null) throw new RgError('RG_BUSY', 'Wait for the active RG role to finish or stop it before starting another.')
  const used = run.role === 'worker' ? task.workerAttempts : task.reviewAttempts
  const limit = run.role === 'worker' ? policy.maxWorkerAttempts : policy.maxReviewAttempts
  if (used >= limit) throw new RgError('RG_BUDGET_EXHAUSTED', 'The RG role-attempt budget is exhausted. Report unresolved work; a human must explicitly start a new task.')
  return { ...task, active: run,
    workRevision: run.role === 'worker' ? task.workRevision + 1 : task.workRevision,
    workerAttempts: task.workerAttempts + (run.role === 'worker' ? 1 : 0),
    reviewAttempts: task.reviewAttempts + (run.role === 'reviewer' ? 1 : 0),
    reviewStatus: run.role === 'reviewer' ? 'reviewing' : task.lastReview === null ? 'not-reviewed' : 'stale' }
}

/** Accept a terminal role result only for the exact outstanding reservation.
 * @param task - current task state.
 * @param runId - the settled activation's RG identity.
 * @param outcome - terminal status, validated report, and scope evidence.
 * @param scopeMatches - whether a reviewer inspected the same content at completion.
 * @returns complete terminal task state; an unrelated late result is refused.
 */
export function settleRun(task: RgTask, runId: RgRunId, outcome: Pick<RgRun, 'status' | 'report' | 'diagnostic' | 'scope'>, scopeMatches: boolean): RgTask {
  const active = task.active
  if (active === null || active.id !== runId) throw new RgError('RG_UNAUTHORIZED_START', 'A late RG result does not belong to the active task reservation.')
  const settled = { ...active, ...outcome }
  let reviewStatus = task.reviewStatus
  if (active.role === 'reviewer') {
    const report: RgReport | null = outcome.report
    reviewStatus = outcome.status !== 'completed' || report?.kind !== 'reviewer' ? 'inconclusive'
      : !scopeMatches || active.workRevision !== task.workRevision ? 'stale'
        : report.verdict === 'pass' ? 'reported-pass' : report.verdict === 'changes-requested' ? 'changes-requested' : 'inconclusive'
  }
  return { ...task, active: null, reviewStatus,
    ...active.role === 'worker' ? { lastWorker: settled } : { lastReview: settled } }
}
