/** Review budget advice never upgrades an uncertain verdict. */
import { describe, expect, it } from 'vitest'
import { reviewWorkflow } from '../src/review-workflow.ts'
import { capturePolicy, defaultSettings } from '../src/config.ts'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RgRun, RgRunId, RgTask, RgTaskId } from '../src/types.ts'

function fixture() {
  const route = { provider: 'fixture', model: 'reviewer' }
  const pool = { candidates: [route], default: route }
  const policy = capturePolicy({ ...defaultSettings(), configured: true, main: pool, worker: pool })
  const task: RgTask = { id: 'task' as RgTaskId, originMessageId: 'input' as MessageId, objective: 'Complete deliverable',
    workRevision: 0, workerAttempts: 0, reviewAttempts: 0, active: null, lastWorker: null, lastReview: null, reviewStatus: 'not-reviewed' }
  return { task, policy }
}
function reviewRun(): RgRun {
  return { id: 'review' as RgRunId, childId: 'child' as SessionId, role: 'reviewer', workRevision: 0,
    selection: { provider: 'fixture', model: 'reviewer' }, status: 'completed', report: null, diagnostic: null, scope: null }
}

describe('review budget workflow', () => {
  it('derives separate worker and reviewer budgets', () => {
    const { task, policy } = fixture()
    expect(reviewWorkflow({ ...task, workerAttempts: policy.maxWorkerAttempts }, policy)).toMatchObject({
      workerAttemptsRemaining: 0, reviewAttemptsRemaining: policy.maxReviewAttempts, needsHumanDecision: false, evidenceIncomplete: false,
    })
  })
  it.each(['not-reviewed', 'reviewing', 'changes-requested', 'inconclusive', 'stale'] as const)('needs a human decision for an exhausted %s result', (reviewStatus) => {
    const { task, policy } = fixture()
    expect(reviewWorkflow({ ...task, reviewAttempts: policy.maxReviewAttempts, reviewStatus }, policy).needsHumanDecision).toBe(true)
  })
  it('waits for the active attempt to settle and preserves a reported pass', () => {
    const { task, policy } = fixture()
    const exhausted = { ...task, reviewAttempts: policy.maxReviewAttempts }
    expect(reviewWorkflow({ ...exhausted, active: reviewRun() }, policy).needsHumanDecision).toBe(false)
    expect(reviewWorkflow({ ...exhausted, reviewStatus: 'reported-pass' }, policy).needsHumanDecision).toBe(false)
  })
  it('distinguishes missing evidence from reported concrete defects without calling either a pass', () => {
    const { task, policy } = fixture()
    const run = reviewRun()
    const report = { kind: 'reviewer' as const, verdict: 'inconclusive' as const, summary: 'Page could not be inspected', inspectedScope: ['src'],
      findings: [], validation: ['Static checks passed'], unverified: ['Authenticated browser acceptance'] }
    const pending = { ...task, reviewStatus: 'inconclusive' as const, lastReview: { ...run, report } }
    expect(reviewWorkflow(pending, policy).evidenceIncomplete).toBe(true)
    expect(reviewWorkflow({ ...pending, lastReview: { ...run, report: { ...report, findings: [{ location: 'src:1', impact: 'Wrong output', evidence: 'Observed mismatch' }] } } }, policy).evidenceIncomplete).toBe(false)
    const verified = { ...pending, lastReview: { ...run, report: { ...report, unverified: [] } } }
    expect(reviewWorkflow(verified, policy).evidenceIncomplete).toBe(false)
  })
})
