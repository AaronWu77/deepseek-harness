/** Remaining attempts and review disposition shared by Host status and client presentation. */
import type { RgPolicy, RgReviewWorkflow, RgTask } from './types.ts'

/**
 * Derive remaining attempts and whether further automatic work needs a human decision.
 * @param task - Current committed task; a running attempt has already consumed its reservation.
 * @param policy - Frozen per-task attempt limits.
 * @returns Advice only; a completed or stale review is never promoted to a pass.
 */
export function reviewWorkflow(task: RgTask, policy: RgPolicy): RgReviewWorkflow {
  const remaining = Math.max(0, policy.maxReviewAttempts - task.reviewAttempts)
  const report = task.lastReview?.report
  return { workerAttemptsRemaining: Math.max(0, policy.maxWorkerAttempts - task.workerAttempts),
    reviewAttemptsRemaining: remaining, nextReviewIsLast: remaining === 1,
    needsHumanDecision: remaining === 0 && task.active === null && task.reviewStatus !== 'reported-pass',
    evidenceIncomplete: task.reviewStatus === 'inconclusive' && report?.kind === 'reviewer'
      && report.verdict === 'inconclusive' && report.findings.length === 0 && report.unverified.length > 0 }
}
