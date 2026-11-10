/** Pure local-Git replay over real Session, projection registry, and durable JSON parsing. */
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import SessionStore, { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import { scanLog, toHeaderLine } from '@deepseek-ai/dsh-session-persistence-jsonl/src/format'
import { describe, expect, it, onTestFinished } from 'vitest'
import { foldGitState, gitProjectionDefinition, gitStateSchema, type RgGitProjectionState } from '../src/git-projection.ts'
import type { RgCandidateId, RgGitState } from '../src/git-types.ts'
import type { RgRunId, RgTaskId } from '../src/types.ts'

const head = 'a'.repeat(40)
const next = 'b'.repeat(40)
const tree = 'c'.repeat(40)
const source = { root: '/workspace/repo', gitDir: '/workspace/repo/.git', commonDir: '/workspace/repo/.git',
  headOid: head, treeOid: tree, branch: 'refs/heads/main', linkedWorktree: false }
const workspace = { ...source, root: '/workspace/repo/.agents/worktrees/task', gitDir: '/workspace/repo/.git/worktrees/task',
  branch: 'refs/heads/task', linkedWorktree: true }
const empty = (): RgGitProjectionState => ({ value: null, failure: null })
const grant = (): RgGitState => ({ taskId: brandString<RgTaskId>('human-task'), configurationHash: 'frozen-model-policy',
  status: 'authorized', source, scope: ['src'], worktreeName: 'rg-task', workspace: null, candidate: null, binding: null, diagnostic: null })
const completed = (): RgGitState => ({ ...grant(), status: 'candidate', workspace: { ...workspace, headOid: next },
  candidate: { id: brandString<RgCandidateId>('candidate-1'), workerRunId: brandString<RgRunId>('worker-1'),
    inspection: { ...workspace, headOid: next }, baseOid: head, headOid: next, treeOid: tree, scope: ['src'],
    scopeIdentity: 'scope-content-identity', validation: ['Worker-reported fixture validation'] } })

/** Use the real opaque-plugin durable ingress instead of asserting malformed JSON is a typed event. */
function durable(rows: readonly object[]) {
  const session = Session.create(SessionId('rg-git-jsonl'), [])
  return scanLog(Buffer.from([JSON.stringify(toHeaderLine(session.header)), ...rows.map(row => JSON.stringify(row)), ''].join('\n'))).events
}

async function registry() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjections)
  const handle = await ctx.sessionProjections.register(gitProjectionDefinition)
  return { ctx, handle }
}

describe('local Git projection', () => {
  it('starts legacy v1 RG Sessions without an implicit Git grant or execution services', async () => {
    const f = await registry()
    const session = f.ctx.sessions.create(SessionId('legacy-rg'))
    session.append('request/header', { header: { config: { provider: 'fixture', model: 'main' } }, reason: 'initial' })
    expect(f.handle.stateOf(session)).toEqual(empty())
    expect(f.ctx.sessionProjections.snapshot(session).values.reviewGatedGit).toBeNull()
    expect(f.ctx.get('fs')).toBeUndefined()
    expect(f.ctx.get('subprocess')).toBeUndefined()
    expect(f.ctx.get('worktrees')).toBeUndefined()
  })

  it('replays grants and candidates and matches checkpoint-plus-suffix restoration without I/O', async () => {
    const f = await registry()
    const session = f.ctx.sessions.create(SessionId('rg-git-replay'))
    session.append('review-gated/git-state', { version: 1, state: grant() })
    session.append('review-gated/git-state', { version: 1, state: { ...grant(), status: 'preparing', workspace } })
    const checkpoint = f.ctx.sessionProjections.checkpoint(session)
    const cut = SessionLogOffset(session.snapshotEvents().length)
    const before = gitProjectionDefinition.stateSchema.parse(f.handle.stateOf(session))
    session.append('review-gated/git-state', { version: 1, state: completed() })
    const unrelated = session.append('request/header', { header: { config: { provider: 'fixture', model: 'main' } }, reason: 'resume' })
    const current = f.handle.stateOf(session)
    expect(foldGitState(current, unrelated)).toBe(current)
    const events = session.snapshotEvents()
    expect(events.slice(cut).reduce(foldGitState, before)).toEqual(events.reduce(foldGitState, empty()))
    const restored = f.ctx.sessionProjections.restore(checkpoint, events.slice(cut), cut, session.header, SessionLogOffset(0))
    expect(restored.snapshot.values.reviewGatedGit).toEqual(completed())
    expect(f.ctx.sessionProjections.restore({}, events, SessionLogOffset(0), session.header, SessionLogOffset(0)).snapshot)
      .toEqual(restored.snapshot)
    const reloaded = Session.create(SessionId('rg-git-restored'), events)
    expect(f.handle.stateOf(reloaded)).toEqual(current)
    expect(gitProjectionDefinition.wire.view(current)).toBe(current.value)
    expect(f.ctx.get('subprocess')).toBeUndefined()
    expect(f.ctx.get('worktrees')).toBeUndefined()
    session.append('review-gated/git-state', { version: 1, state: null })
    expect(f.handle.stateOf(session)).toEqual(empty())
  })

  it('preserves exact reviewer bindings, interrupted outcomes, and null candidate fields through schema parsing', () => {
    const candidate = completed()
    const reviewing: RgGitState = { ...candidate, status: 'reviewing',
      binding: { runId: brandString<RgRunId>('review-1'), role: 'reviewer', candidateId: brandString<RgCandidateId>('candidate-1'),
        checkoutName: 'rg-review-1', checkout: { ...workspace, headOid: next, branch: null,
          root: '/workspace/repo/.agents/worktrees/review-1', gitDir: '/workspace/repo/.git/worktrees/review-1' } } }
    expect(gitStateSchema.parse(reviewing)).toEqual(reviewing)
    for (const status of ['working', 'finalizing', 'interrupted', 'unknown', 'failed'] as const) {
      expect(gitStateSchema.parse({ ...grant(), status, diagnostic: 'Retain the partial worktree for inspection.' }).status).toBe(status)
    }
    expect(gitStateSchema.safeParse({ ...grant(), undocumented: true }).success).toBe(false)
    expect(gitStateSchema.safeParse({ ...candidate, candidate: { ...candidate.candidate, content: 'must not be persisted' } }).success).toBe(false)
  })

  it('keeps malformed durable version and payload records poisoned across later valid grants or clears', () => {
    for (const data of [{ version: 2, state: null }, { version: 1, state: { ...grant(), source: { ...source, headOid: 'short' } } },
      { version: 1, state: grant(), unexpected: true }]) {
      const events = durable([
        { type: 'review-gated/git-state', seq: 0, time: 1, ignorable: true, data },
        { type: 'review-gated/git-state', seq: 1, time: 2, ignorable: true, data: { version: 1, state: grant() } },
        { type: 'review-gated/git-state', seq: 2, time: 3, ignorable: true, data: { version: 1, state: null } },
      ])
      const first = events[0]
      const second = events[1]
      if (first === undefined || second === undefined) throw new Error('The durable scanner must preserve opaque plugin records.')
      const poisoned = foldGitState(empty(), first)
      expect(poisoned.failure).toContain('RG_GIT_STATE_INVALID: event 0')
      expect(foldGitState(poisoned, second)).toBe(poisoned)
      expect(events.reduce(foldGitState, empty())).toEqual(poisoned)
    }
  })
})


it('poisons malformed cross-references and refuses a semantically invalid checkpoint without I/O', async () => {
  const f = await registry()
  const state = completed()
  const candidate = state.candidate
  if (candidate === null) throw new Error('The completed durable fixture must contain its candidate.')
  const review = { runId: brandString<RgRunId>('review-1'), role: 'reviewer' as const,
    candidateId: candidate.id, checkoutName: 'review-1', checkout: { ...candidate.inspection, branch: null,
      root: '/workspace/repo/.agents/worktrees/review-1', gitDir: '/workspace/repo/.git/worktrees/review-1' } }
  const invalid: unknown[] = [
    { ...state, candidate: { ...candidate, baseOid: next } },
    { ...state, candidate: { ...candidate, headOid: head } },
    { ...state, candidate: { ...candidate, treeOid: head } },
    { ...state, candidate: { ...candidate, scope: ['outside'] } },
    { ...state, candidate: { ...candidate, inspection: { ...candidate.inspection, commonDir: '/outside/.git' } } },
    { ...state, workspace: { ...workspace, root: '/outside/checkout' } },
    { ...state, binding: { ...review, candidateId: brandString<RgCandidateId>('different-candidate') } },
    { ...state, binding: { ...review, checkout: { ...review.checkout, branch: 'refs/heads/not-detached' } } },
    { ...state, binding: { ...review, checkout: { ...review.checkout, root: workspace.root } } },
    { ...state, binding: { ...review, checkout: { ...review.checkout, headOid: head } } },
    { ...state, binding: { ...review, checkout: { ...review.checkout, treeOid: head } } },
    { ...state, binding: { ...review, checkout: { ...review.checkout, commonDir: '/outside/.git' } } },
    { ...state, binding: { ...review, role: 'worker', checkout: candidate.inspection } },
  ]
  const session = f.ctx.sessions.create(SessionId('git-crossref-checkpoint'))
  session.append('review-gated/git-state', { version: 1, state })
  const checkpoint = f.ctx.sessionProjections.checkpoint(session)
  const row = checkpoint.reviewGatedGit
  if (row === undefined) throw new Error('A registered projection must publish its checkpoint row.')
  for (const value of invalid) {
    expect(gitStateSchema.safeParse(value).success).toBe(false)
    const events = durable([{ type: 'review-gated/git-state', seq: 0, time: 1, ignorable: true, data: { version: 1, state: value } }])
    expect(events.reduce(foldGitState, empty()).failure).toContain('RG_GIT_STATE_INVALID')
    expect(() => f.ctx.sessionProjections.restore({ ...checkpoint, reviewGatedGit: { ...row, val: { value, failure: null } } },
      session.snapshotEvents(), SessionLogOffset(0), session.header, SessionLogOffset(0))).toThrow()
  }
  expect(f.ctx.get('fs')).toBeUndefined()
  expect(f.ctx.get('subprocess')).toBeUndefined()
})


it('accepts pending and exact worker bindings and rejects each persisted worker checkout mismatch', () => {
  const binding = { runId: brandString<RgRunId>('pending-worker'), role: 'worker' as const,
    candidateId: null, checkoutName: 'task', checkout: workspace }
  expect(gitStateSchema.parse({ ...grant(), status: 'preparing', binding: { ...binding, checkout: null } }).binding?.checkout).toBeNull()
  expect(gitStateSchema.parse({ ...grant(), status: 'working', workspace, binding }).binding?.checkout).toEqual(workspace)
  for (const value of [
    { ...grant(), binding },
    { ...grant(), workspace, binding: { ...binding, checkout: { ...workspace, root: '/different/root' } } },
    { ...grant(), workspace, binding: { ...binding, checkout: { ...workspace, gitDir: '/different/gitdir' } } },
    { ...grant(), workspace, binding: { ...binding, checkout: { ...workspace, commonDir: '/different/common' } } },
  ]) expect(gitStateSchema.safeParse(value).success).toBe(false)
})
