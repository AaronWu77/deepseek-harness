/** Frozen RG task facts used by rendered task and registration tests. */
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RgCandidateId, RgGitState } from '../src/git-types.ts'
import type { RgRun, RgRunId, RgSessionState, RgTaskId } from '../src/types.ts'
import { main, settings } from './fixture.client.ts'

export function reviewRun(): RgRun {
  return { id: 'review-1' as RgRunId, childId: 'child-1' as SessionId, role: 'reviewer', workRevision: 3,
    selection: { ...main, reasoningEffort: 'high' }, status: 'completed', diagnostic: null,
    scope: { root: '/work', paths: ['src/first.ts'], fingerprint: 'fingerprint', diagnostic: null, capturedAt: 1 },
    report: { kind: 'reviewer', verdict: 'pass', summary: 'Inspected the requested change', inspectedScope: ['src/first.ts'],
      findings: [{ location: 'src/first.ts:4', impact: 'Incorrect output', evidence: 'A negative input returns zero' }],
      validation: ['unit suite passed'], unverified: ['cross-platform behavior'] } }
}

/** An unused task eligible for explicit local Git authorization. */
export function freshRgState(): RgSessionState {
  const state = rgState()
  return { ...state, task: { ...state.task!, workRevision: 0, workerAttempts: 0, reviewAttempts: 0, lastReview: null, reviewStatus: 'not-reviewed' } }
}

/** Host-recorded authorization facts without an allocated checkout. */
export function gitState(): RgGitState {
  return { taskId: 'task-1' as RgTaskId, configurationHash: 'frozen-policy', status: 'authorized', scope: ['src'], worktreeName: 'task',
    source: { root: '/work', gitDir: '/work/.git', commonDir: '/work/.git', headOid: 'a'.repeat(40), treeOid: 'b'.repeat(40), branch: 'main', linkedWorktree: false },
    workspace: null, candidate: null, binding: null, diagnostic: null }
}

/** A verified candidate and its retained task checkout, independent of review status. */
export function candidateGitState(): RgGitState {
  const state = gitState()
  const workspace = { ...state.source, root: '/work/.agents/worktrees/task', gitDir: '/work/.git/worktrees/task',
    headOid: 'c'.repeat(40), treeOid: 'd'.repeat(40), branch: 'task', linkedWorktree: true }
  return { ...state, status: 'candidate', workspace, candidate: { id: 'candidate-1' as RgCandidateId, workerRunId: 'worker-1' as RgRunId,
    inspection: workspace, baseOid: state.source.headOid, headOid: workspace.headOid, treeOid: workspace.treeOid,
    scope: ['src/first.ts'], scopeIdentity: 'verified-scope', validation: ['Worker reports focused tests passed'] } }
}

export function rgState(): RgSessionState {
  const saved = settings()
  return { role: 'main', parentSessionId: null, taskId: null, runId: null, diagnostic: null,
    policy: { ...saved, version: 1, configurationHash: 'frozen-policy', reviewer: saved.main, reviewerInherited: true },
    task: { id: 'task-1' as RgTaskId, originMessageId: 'message-1' as MessageId, objective: 'Repair the requested output',
      workRevision: 3, workerAttempts: 1, reviewAttempts: 2, active: null, lastWorker: null,
      lastReview: reviewRun(), reviewStatus: 'reported-pass' } }
}
