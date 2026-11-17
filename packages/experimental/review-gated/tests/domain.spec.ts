/** RG configuration parsing, attempt transitions, and deterministic projection recovery. */
import { appendRecord, durableEvents, recordOf } from './records.ts'
import { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import { MessageId, type UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import { describe, expect, it, onTestFinished } from 'vitest'
import { capturePolicy, Config, defaultSettings, parseSettings, resolveModel } from '../src/config.ts'
import { foldRgState, rgProjectionDefinition, TASK_SAVE_UNCERTAIN, type RgProjectionState } from '../src/projection.ts'
import { handoffSchema, policySchema, poolSchema, reviewReportSchema, settingsSchema, workerReportSchema } from '../src/schemas.ts'
import { reserveRun, settleRun } from '../src/task.ts'
import type { RgModel, RgModelPool, RgPolicy, RgReviewReport, RgRun, RgRunId, RgSessionState, RgSettings, RgTask, RgTaskId } from '../src/types.ts'

const main: RgModel = { provider: 'strong-provider', model: 'strong-model', reasoningEffort: 'high' }
const worker: RgModel = { provider: 'fast-provider', model: 'fast-model' }
const pool = (route: RgModel): RgModelPool => ({ candidates: [{ ...route }], default: { provider: route.provider, model: route.model } })
const settings = (): RgSettings => ({ ...defaultSettings(), configured: true, main: pool(main), worker: pool(worker) })
const policy = (): RgPolicy => capturePolicy(settings())
const task = (): RgTask => ({
  id: brandString<RgTaskId>('human-task'), originMessageId: MessageId('human-input'), objective: 'Implement the requested behavior',
  workRevision: 0, workerAttempts: 0, reviewAttempts: 0, active: null, lastWorker: null, lastReview: null, reviewStatus: 'not-reviewed',
})
const run = (role: RgRun['role'], overrides: Partial<RgRun> = {}): RgRun => ({
  id: brandString<RgRunId>(`${role}-attempt`), childId: SessionId(`${role}-child`), role,
  workRevision: role === 'worker' ? 1 : 0, selection: role === 'worker' ? worker : main, status: 'reserved',
  report: null, diagnostic: null, scope: null, ...overrides,
})
const pass = (): RgReviewReport => ({
  kind: 'reviewer', verdict: 'pass', summary: 'The inspected scope meets the stated requirements.',
  inspectedScope: ['src/example.ts'], findings: [], validation: ['Inspected the reproduction and test output.'], unverified: [],
})
const sessionState = (current: RgTask | null = null): RgSessionState => ({
  policy: policy(), role: 'main', parentSessionId: null, taskId: null, runId: null, task: current, diagnostic: null,
})
const emptyProjection = (): RgProjectionState => rgProjectionDefinition.init()

function activeId(value: RgTask): RgRunId {
  if (value.active === null) throw new Error('Expected a reserved RG run')
  return value.active.id
}

describe('RG settings and frozen model choices', () => {
  it('decodes its serialized settings section without a Host-only decoder', () => {
    // The settings page validates every section against this serialized schema,
    // so the loader must not carry a transform whose callback cannot survive it.
    const schema = new Schema(JSON.parse(JSON.stringify(Config.toJSON())) as Schema)
    const [resolved] = Schema.resolve({ settings: settings() }, schema, {})
    const bound = (resolved as { settings: RgSettings | { get(): RgSettings } }).settings
    const section = 'get' in bound && typeof bound.get === 'function' ? bound.get() : bound
    expect(section).toEqual(settings())
  })

  it('starts unconfigured with no model authorization and rejects capturing that state', () => {
    const initial = defaultSettings()
    expect(settingsSchema.parse(initial)).toEqual(initial)
    expect(initial.main).toEqual({ candidates: [], default: null })
    expect(initial.worker).toEqual({ candidates: [], default: null })
    expect(() => capturePolicy(initial)).toThrow('RG_NOT_CONFIGURED')
    const independent = defaultSettings()
    expect(initial.main).not.toBe(independent.main)
    expect(() => Schema.resolve({}, Config, {})).not.toThrow()
  })

  it('resolves reviewer inheritance once and detaches all pools from later settings edits', () => {
    const input = settings()
    const captured = capturePolicy(input)
    expect(captured.reviewerInherited).toBe(true)
    expect(captured.reviewer).toEqual(captured.main)
    expect(captured.reviewer).not.toBe(captured.main)
    const changed = { ...input, main: pool({ ...main, model: 'new-model' }), maxWorkerAttempts: 5 }
    expect(capturePolicy(changed).configurationHash).not.toBe(captured.configurationHash)
    expect(captured.main).toEqual(pool(main))
    expect(captured.maxWorkerAttempts).toBe(2)
    expect(capturePolicy(settings())).toEqual(captured)
    expect(policySchema.parse(captured)).toEqual(captured)
  })

  it('uses an independent review pool and preserves configured or omitted effort per route', () => {
    const input: RgSettings = { ...settings(), reviewer: { mode: 'custom', pool: pool(worker) } }
    const captured = capturePolicy(input)
    expect(captured.reviewerInherited).toBe(false)
    expect(captured.reviewer).toEqual(pool(worker))
    expect(resolveModel(captured.worker)).toEqual(worker)
    expect(resolveModel(captured.main)).toEqual(main)
    expect(resolveModel(captured.main)).not.toBe(captured.main.candidates[0])
    expect(() => resolveModel(captured.worker, main)).toThrow('RG_MODEL_NOT_ALLOWED')
    expect(() => resolveModel({ candidates: [], default: null })).toThrow('RG_MODEL_NOT_ALLOWED')
  })

  it.each([
    { ...settings(), main: { candidates: [], default: null } },
    { ...settings(), worker: { candidates: [], default: null } },
    { ...settings(), reviewer: { mode: 'custom', pool: { candidates: [], default: null } } },
    { ...settings(), main: { candidates: [main, { ...main, reasoningEffort: 'max' }], default: pool(main).default } },
    { ...settings(), worker: { candidates: [worker], default: pool(main).default } },
    { ...settings(), main: { candidates: [main], default: null } },
    { ...settings(), maxWorkerAttempts: 0 },
    { ...settings(), maxReviewAttempts: 1.5 },
    { ...settings(), maxScopeFiles: Number.MAX_SAFE_INTEGER + 1 },
    { ...settings(), maxReportChars: -1 },
  ])('rejects an invalid complete settings document at the consumption boundary', (input) => {
    expect(settingsSchema.safeParse(input).success).toBe(false)
    expect(() => parseSettings(input)).toThrow('RG settings are invalid')
  })

  it('keeps cross-field invariants out of the serialized loader schema', () => {
    // Field bounds stay in the loader schema; membership rules that the settings
    // page must still display remain at the consumption boundary.
    const crossField = { ...settings(), main: { candidates: [], default: null } }
    expect(() => parseSettings(crossField)).toThrow('RG settings are invalid')
    expect(Schema.resolve({ settings: crossField }, Config, {})).toBeDefined()
  })

  it('rejects duplicate routes and defaults that are not members even in an unconfigured pool', () => {
    expect(poolSchema.safeParse({ candidates: [main, { ...main, reasoningEffort: 'other' }], default: pool(main).default }).success).toBe(false)
    expect(poolSchema.safeParse({ candidates: [main], default: worker }).success).toBe(false)
  })

  it.each(['main', 'worker', 'reviewer'] as const)('rejects an empty or defaultless frozen %s pool', (role) => {
    expect(policySchema.safeParse({ ...policy(), [role]: { candidates: [], default: null } }).success).toBe(false)
    expect(policySchema.safeParse({ ...policy(), [role]: { candidates: [main], default: null } }).success).toBe(false)
  })

  it('rejects unknown JSON fields and incomplete or contradictory role reports', () => {
    expect(settingsSchema.safeParse({ ...settings(), silentlyUpgrade: true }).success).toBe(false)
    expect(handoffSchema.safeParse({ objective: 'Implement', acceptance: [], scope: ['src'], constraints: [], facts: [], validation: [] }).success).toBe(false)
    expect(workerReportSchema.safeParse({ kind: 'worker', outcome: 'completed', summary: 'Done' }).success).toBe(false)
    expect(reviewReportSchema.safeParse({ ...pass(), findings: [{ location: 'file:1', impact: 'Breaks output', evidence: 'Observed reproduction' }] }).success).toBe(false)
    expect(reviewReportSchema.safeParse({ ...pass(), verdict: 'changes-requested' }).success).toBe(false)
    expect(reviewReportSchema.safeParse({ ...pass(), inspectedScope: [] }).success).toBe(false)
    expect(reviewReportSchema.safeParse(pass()).success).toBe(true)
  })
})

describe('RG attempt admission and settlement', () => {
  it('consumes an attempt on reservation, rejects overlap and never mutates the prior task', () => {
    const initial = task()
    const admitted = reserveRun(initial, policy(), run('worker'))
    expect(admitted).toMatchObject({ workerAttempts: 1, reviewAttempts: 0, workRevision: 1, reviewStatus: 'not-reviewed' })
    expect(initial).toEqual(task())
    expect(() => reserveRun(admitted, policy(), run('reviewer'))).toThrow(expect.objectContaining({ code: 'RG_BUSY' }))
  })

  it.each(['failed', 'cancelled', 'interrupted'] as const)('retains the attempt after a %s run', (status) => {
    const reserved = reserveRun(task(), policy(), run('worker'))
    const ended = settleRun(reserved, activeId(reserved), { status, report: null, diagnostic: 'Inspect partial changes.', scope: null }, false)
    expect(ended).toMatchObject({ workerAttempts: 1, active: null, lastWorker: { status } })
    const second = reserveRun(ended, policy(), run('worker', { workRevision: 2 }))
    const finished = settleRun(second, activeId(second), { status, report: null, diagnostic: null, scope: null }, false)
    expect(() => reserveRun(finished, policy(), run('worker'))).toThrow(expect.objectContaining({ code: 'RG_BUDGET_EXHAUSTED' }))
  })

  it('does not turn missing, mismatched, cancelled or failed review results into passes', () => {
    for (const [status, report] of [
      ['completed', null], ['failed', pass()], ['cancelled', pass()],
      ['completed', { kind: 'worker', outcome: 'completed', summary: 'Done', changes: [], validation: [], unverified: [] }],
    ] as const) {
      const reserved = reserveRun(task(), policy(), run('reviewer'))
      const ended = settleRun(reserved, activeId(reserved), { status, report, diagnostic: null, scope: null }, true)
      expect(ended).toMatchObject({ reviewAttempts: 1, reviewStatus: 'inconclusive', active: null })
    }
  })

  it.each(['pass', 'changes-requested', 'inconclusive'] as const)('records reviewer verdict %s for the exact inspected revision', (verdict) => {
    const reserved = reserveRun(task(), policy(), run('reviewer'))
    const report = { ...pass(), verdict }
    const ended = settleRun(reserved, activeId(reserved), { status: 'completed', report, diagnostic: null, scope: null }, true)
    expect(ended.reviewStatus).toBe(verdict === 'pass' ? 'reported-pass' : verdict)
    expect(ended.lastReview?.report).toEqual(report)
    const reopened = reserveRun(ended, policy(), run('worker'))
    expect(reopened).toMatchObject({ workRevision: 1, reviewStatus: 'stale', reviewAttempts: 1, workerAttempts: 1 })
  })

  it('rejects late results and marks changed scope or work revision as stale', () => {
    const reserved = reserveRun(task(), policy(), run('reviewer'))
    const outcome = { status: 'completed' as const, report: pass(), diagnostic: null, scope: null }
    expect(() => settleRun(reserved, brandString<RgRunId>('old-run'), outcome, true)).toThrow(expect.objectContaining({ code: 'RG_UNAUTHORIZED_START' }))
    expect(settleRun(reserved, activeId(reserved), outcome, false).reviewStatus).toBe('stale')
    expect(settleRun({ ...reserved, workRevision: 1 }, activeId(reserved), outcome, true).reviewStatus).toBe('stale')
    const ended = settleRun(reserved, activeId(reserved), outcome, true)
    expect(() => settleRun(ended, activeId(reserved), outcome, true)).toThrow(expect.objectContaining({ code: 'RG_UNAUTHORIZED_START' }))
  })

  it('retains failed review attempts and never clears the budget by advancing work revision', () => {
    let current = task()
    for (let attempt = 0; attempt < policy().maxReviewAttempts; attempt++) {
      current = reserveRun(current, policy(), run('reviewer'))
      current = settleRun(current, activeId(current), { status: 'failed', report: null, diagnostic: 'Unavailable', scope: null }, false)
    }
    current = { ...current, workRevision: 100 }
    expect(() => reserveRun(current, policy(), run('reviewer'))).toThrow(expect.objectContaining({ code: 'RG_BUDGET_EXHAUSTED' }))
  })
})

describe('RG projection recovery', () => {
  it('requires the matching entered settlement across every prepared task prefix', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjections)
    await ctx.sessionProjections.register<'reviewGated', RgProjectionState>(rgProjectionDefinition)
    const session = ctx.sessions.create(SessionId('rg-admission-prefixes'))
    appendRecord(session, 'plugin:review-gated/state', { version: 1, state: sessionState() })
    session.append('turn/start', { turn: 1 })
    const human: UserMessage = { id: MessageId('human-input'), role: 'user', content: [{ type: 'text', text: task().objective }], source: { kind: 'user' } }
    const intent = appendRecord(session, 'plugin:review-gated/claim', { version: 1, phase: 'intent', turn: 1, step: 1, inputs: [{ message: human }] })
    const opened = session.snapshotEvents().length
    const prepared = appendRecord(session, 'plugin:review-gated/task-prepared', { version: 1, intentSeq: intent.seq, messageId: human.id, input: task().objective,
      state: { ...sessionState(task()), diagnostic: TASK_SAVE_UNCERTAIN } })
    expect(prepared.ignorable).toBe(true)
    session.append('step/start', { turn: 1, step: 1 })
    session.append('user/message', human, { surfaceOp: 'append' })
    const confirmedAt = session.snapshotEvents().length
    appendRecord(session, 'plugin:review-gated/claim-settled', { version: 1, phase: 'settled', intentSeq: intent.seq, outcome: 'entered', messages: [human] })
    const events = session.snapshotEvents()
    const full = ctx.sessionProjections.restore({}, events, SessionLogOffset(0), session.header, session.inheritedEventCount)
    expect(full.snapshot.values.reviewGated?.state).toMatchObject({ task: { id: task().id }, diagnostic: null })
    expect(full.snapshot.values.reviewGated).toMatchObject({ failed: false, ready: false, taskReceipt: 'proven' })
    for (let cut = opened; cut <= confirmedAt; cut++) {
      const prefix = ctx.sessionProjections.restore(
        {}, events.slice(0, cut), SessionLogOffset(0), session.header, session.inheritedEventCount)
      if (cut === opened) {
        expect(prefix.checkpoint.reviewGated?.val).toMatchObject({ taskAdmission: { intentSeq: intent.seq, taskId: null } })
        expect(prefix.snapshot.values.reviewGated).toMatchObject({ taskReceipt: 'none', ready: false })
      } else {
        expect(prefix.snapshot.values.reviewGated?.state?.diagnostic).toContain('RG_TASK_SAVE_UNCERTAIN')
        expect(prefix.snapshot.values.reviewGated).toMatchObject({ taskReceipt: 'unproven', ready: false })
      }
      const suffix = ctx.sessionProjections.restore(
        prefix.checkpoint, events.slice(cut), SessionLogOffset(cut), session.header, session.inheritedEventCount)
      expect(suffix.snapshot.values.reviewGated).toEqual(full.snapshot.values.reviewGated)
      const forkId = SessionId(`rg-admission-fork-${cut}`)
      const fork = Session.create(forkId, events.slice(0, cut), { ...session.header, id: forkId, isSeeded: true }, SessionLogOffset(cut))
      const inherited = fork.snapshotEvents().reduce(foldRgState, emptyProjection())
      if (cut === opened) expect(inherited).toMatchObject({ failure: null, taskAdmission: { taskId: null } })
      else expect(inherited.failure).toContain('RG_STATE_INVALID')
    }
  })

  it('rejects preparation without its intent and settlement without exact model-entry evidence', () => {
    const session = Session.create(SessionId('rg-admission-validation'), [])
    const seeded = foldRgState(emptyProjection(), appendRecord(session, 'plugin:review-gated/state', { version: 1, state: sessionState() }))
    const initial = foldRgState(seeded, session.append('turn/start', { turn: 1 }))
    const human: UserMessage = { id: MessageId('human-input'), role: 'user', content: [{ type: 'text', text: task().objective }], source: { kind: 'user' } }
    const opened = appendRecord(session, 'plugin:review-gated/claim', { version: 1, phase: 'intent', turn: 1, step: 1, inputs: [{ message: human }] })
    const prepared = appendRecord(session, 'plugin:review-gated/task-prepared', { version: 1, intentSeq: opened.seq, messageId: human.id, input: task().objective,
      state: { ...sessionState(task()), diagnostic: TASK_SAVE_UNCERTAIN } })
    const start = session.append('step/start', { turn: 1, step: 1 })
    const receipt = session.append('user/message', human, { surfaceOp: 'append' })
    const confirmed = appendRecord(session, 'plugin:review-gated/claim-settled', { version: 1, phase: 'settled', intentSeq: opened.seq, outcome: 'entered', messages: [human] })
    const change = (event: typeof prepared, data: unknown) => durableEvents([{ ...event, data }])[0]!
    expect(foldRgState(initial, prepared).failure).toContain('RG_STATE_INVALID')
    const afterOpen = foldRgState(initial, opened)
    expect(foldRgState(afterOpen, change(prepared, { ...recordOf(prepared)?.data, messageId: MessageId('wrong') })).failure).toContain('RG_STATE_INVALID')
    expect(foldRgState(afterOpen, change(prepared, { ...recordOf(prepared)?.data, intentSeq: opened.seq + 1 })).failure).toContain('RG_STATE_INVALID')
    const afterPrepare = foldRgState(afterOpen, prepared)
    expect(afterPrepare.taskReceipt).toBe('unproven')
    expect(rgProjectionDefinition.stateSchema.safeParse({ ...afterPrepare, taskReceipt: 'proven' }).success).toBe(false)
    expect(foldRgState(afterPrepare, receipt).value?.diagnostic).toBe(TASK_SAVE_UNCERTAIN)
    expect(foldRgState(afterPrepare, confirmed).failure).toContain('RG_STATE_INVALID')
    const started = foldRgState(afterPrepare, start)
    const wrong = foldRgState(started, { ...receipt, data: { ...receipt.data, content: [{ type: 'text', text: 'wrong' }] } })
    expect(foldRgState(wrong, confirmed).failure).toContain('RG_STATE_INVALID')
    const received = foldRgState(started, receipt)
    expect(foldRgState(received, change(confirmed, { ...recordOf(confirmed)?.data, intentSeq: opened.seq + 1 })).failure).toContain('RG_STATE_INVALID')
    const requeued = session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [human] })
    expect(foldRgState(received, requeued).failure).toContain('RG_STATE_INVALID')
    expect(foldRgState(received, confirmed).value?.diagnostic).toBeNull()
    expect(foldRgState(initial, confirmed).failure).toContain('RG_STATE_INVALID')
    expect(foldRgState(afterOpen, change(confirmed, { ...recordOf(confirmed)?.data, intentSeq: opened.seq + 1 }))).toBe(afterOpen)
    for (const phase of ['opened', 'confirmed', 'uncertain']) {
      expect(foldRgState(initial, change(opened, { version: 1, phase, messageId: human.id })).failure).toContain('RG_STATE_INVALID')
    }
  })

  it.each([TASK_SAVE_UNCERTAIN, 'RG_TASK_SAVE_UNCERTAIN: the task or its message may not be saved reliably. Inspect the Session before continuing.'])
  ('does not trust receipt or version-four checkpoint for diagnostic %s', async (diagnostic) => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjections)
    await ctx.sessionProjections.register<'reviewGated', RgProjectionState>(rgProjectionDefinition)
    const session = ctx.sessions.create(SessionId('rg-legacy-receipt-checkpoint'))
    const human: UserMessage = { id: MessageId('human-input'), role: 'user', content: [{ type: 'text', text: 'Implement the requested behavior' }], source: { kind: 'user' } }
    appendRecord(session, 'plugin:review-gated/state', { version: 1, state: { ...sessionState(task()), diagnostic } })
    const receipt = session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [human] })
    const prefix = session.snapshotEvents()
    const old = { reviewGated: { ver: 4, seq: receipt.seq,
      val: { value: sessionState(task()), hasRequested: false, failure: null, pending: null } } }
    expect(ctx.sessionProjections.restoreFloor(old)).toBe(0)
    const restored = ctx.sessionProjections.restore(old, prefix, SessionLogOffset(0), session.header, session.inheritedEventCount)
    expect(restored.snapshot.values.reviewGated?.state?.diagnostic).toBe(TASK_SAVE_UNCERTAIN)
    session.append('user/message', { ...human, id: MessageId('other') }, { surfaceOp: 'append' })
    const wrong = ctx.sessionProjections.restore(restored.checkpoint, session.snapshotEvents().slice(prefix.length),
      SessionLogOffset(prefix.length), session.header, session.inheritedEventCount)
    expect(wrong.snapshot.values.reviewGated?.state?.diagnostic).toBe(TASK_SAVE_UNCERTAIN)
    session.append('user/message', human, { surfaceOp: 'append' })
    const full = ctx.sessionProjections.restore(
      {}, session.snapshotEvents(), SessionLogOffset(0), session.header, session.inheritedEventCount)
    const suffix = ctx.sessionProjections.restore(restored.checkpoint, session.snapshotEvents().slice(prefix.length),
      SessionLogOffset(prefix.length), session.header, session.inheritedEventCount)
    expect(full.snapshot.values.reviewGated?.state?.diagnostic).toBeNull()
    expect(suffix.snapshot.values.reviewGated).toEqual(full.snapshot.values.reviewGated)
  })

  it('retains uncertain task input across receipts and clears it only for the matching historical user message', () => {
    const session = Session.create(SessionId('rg-task-receipt'), [])
    const human: UserMessage = { id: MessageId('human-input'), role: 'user', content: [{ type: 'text', text: 'Implement the requested behavior' }], source: { kind: 'user' } }
    const saved = appendRecord(session, 'plugin:review-gated/state', { version: 1, state: { ...sessionState(task()), diagnostic: TASK_SAVE_UNCERTAIN } })
    const before = foldRgState(emptyProjection(), saved)
    const legacyClear = appendRecord(session, 'plugin:review-gated/state', { version: 1, state: sessionState(task()) })
    const cleared = foldRgState(before, legacyClear)
    expect(cleared.value?.diagnostic).toBe(TASK_SAVE_UNCERTAIN)
    const changedTask = durableEvents([{ ...legacyClear, data: { ...recordOf(legacyClear)?.data, state: sessionState({ ...task(), originMessageId: MessageId('different') }) } }])[0]!
    expect(foldRgState(before, changedTask).failure).toContain('RG_STATE_INVALID')
    const clearedTask = durableEvents([{ ...legacyClear, data: { ...recordOf(legacyClear)?.data, state: null } }])[0]!
    expect(foldRgState(before, clearedTask).failure).toContain('RG_STATE_INVALID')
    const wrong = session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [{ ...human, id: MessageId('other') }] })
    expect(foldRgState(cleared, wrong)).toBe(cleared)
    expect(foldRgState(cleared, { ...wrong, data: { ...wrong.data, target: 'next-step' } })).toBe(cleared)
    expect(foldRgState(cleared, { ...wrong, data: { ...wrong.data, inserted: [{ ...human, source: { kind: 'system-prompt' } }] } })).toBe(cleared)
    expect(foldRgState(cleared, { ...wrong, data: { ...wrong.data, inserted: [human, { ...human, id: MessageId('other') }] } })).toBe(cleared)
    expect(foldRgState(cleared, { ...wrong, data: { ...wrong.data, inserted: [{ ...human, content: [{ type: 'text', text: 'Other task' }] }] } } )).toBe(cleared)
    const receipt = { ...wrong, data: { ...wrong.data, inserted: [human] } }
    const received = foldRgState(cleared, receipt)
    expect(received).toBe(cleared)
    const wrongHistory = session.append('user/message', { ...human, id: MessageId('other') }, { surfaceOp: 'append' })
    expect(foldRgState(received, wrongHistory)).toBe(received)
    const history = session.append('user/message', human, { surfaceOp: 'append' })
    expect(foldRgState(received, { ...history, data: { ...human, source: { kind: 'system-prompt' } } })).toBe(received)
    expect(foldRgState(received, { ...history, data: { ...human, content: [{ type: 'text', text: 'Different task' }] } })).toBe(received)
    const delivered = foldRgState(received, history)
    expect(delivered.value?.diagnostic).toBeNull()
    expect(foldRgState(delivered, receipt)).toBe(delivered)
    const failed = { ...cleared, value: { ...cleared.value!, diagnostic: TASK_SAVE_UNCERTAIN + ' Message delivery failed.' } }
    expect(foldRgState(failed, receipt)).toBe(failed)
    const retryMarker = foldRgState(failed, saved)
    expect(retryMarker.value?.diagnostic).toBe(failed.value.diagnostic)
    expect(foldRgState(retryMarker, receipt)).toBe(retryMarker)
    const marker = session.append('session/end-seed', { inherited: true })
    expect(foldRgState(cleared, marker).failure).toContain('RG_STATE_INVALID')
    expect(foldRgState(delivered, marker)).toBe(delivered)
    const resume = session.append('session/end-seed', {})
    expect(foldRgState(cleared, resume)).toBe(cleared)
  })

  it('replays old checkpoints and fails closed on an inherited incomplete task', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjections)
    await ctx.sessionProjections.register<'reviewGated', RgProjectionState>(rgProjectionDefinition)
    const session = ctx.sessions.create(SessionId('rg-old-task-checkpoint'))
    appendRecord(session, 'plugin:review-gated/state', { version: 1, state: { ...sessionState(task()), diagnostic: TASK_SAVE_UNCERTAIN } })
    const legacyClear = appendRecord(session, 'plugin:review-gated/state', { version: 1, state: sessionState(task()) })
    const prefix = session.snapshotEvents()
    for (const version of [1, 2, 3, 4]) {
      const old = { reviewGated: { ver: version, seq: legacyClear.seq,
        val: { value: sessionState(task()), hasRequested: false, failure: null, pending: null } } }
      expect(ctx.sessionProjections.restoreFloor(old)).toBe(0)
      const replay = ctx.sessionProjections.restore(old, prefix, SessionLogOffset(0), session.header, session.inheritedEventCount)
      expect(replay.snapshot.values.reviewGated?.state?.diagnostic).toBe(TASK_SAVE_UNCERTAIN)
      expect(replay.checkpoint.reviewGated?.ver).toBe(rgProjectionDefinition.stateVersion)
    }
    const childId = SessionId('rg-seeded-incomplete-task')
    const child = Session.create(childId, prefix, { ...session.header, id: childId, isSeeded: true }, SessionLogOffset(prefix.length))
    const forked = child.snapshotEvents().reduce(foldRgState, emptyProjection())
    expect(forked.failure).toContain('RG_STATE_INVALID')
    expect(forked.value?.diagnostic).toBe(TASK_SAVE_UNCERTAIN)
    const receipt = session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [
      { id: MessageId('human-input'), role: 'user', content: [{ type: 'text', text: 'Implement the requested behavior' }], source: { kind: 'user' } },
    ] })
    expect(foldRgState(forked, receipt)).toBe(forked)
    const completeId = SessionId('rg-seeded-complete-task')
    const incomplete = Session.create(completeId, session.snapshotEvents(),
      { ...session.header, id: completeId, isSeeded: true }, session.seq)
    expect(incomplete.snapshotEvents().reduce(foldRgState, emptyProjection()).failure).toContain('RG_STATE_INVALID')
    session.append('user/message', receipt.data.inserted[0]!, { surfaceOp: 'append' })
    const proven = Session.create(SessionId('rg-seeded-proven-task'), session.snapshotEvents(), { ...session.header, id: SessionId('rg-seeded-proven-task'), isSeeded: true }, session.seq)
    expect(proven.snapshotEvents().reduce(foldRgState, emptyProjection()).value?.diagnostic).toBeNull()
  })

  it('marks legacy scope passes stale in replay and checkpoint parsing, without changing Git or current fingerprints', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjections)
    const handle = await ctx.sessionProjections.register<'reviewGated', RgProjectionState>(rgProjectionDefinition)
    const scope = { root: '/workspace', paths: ['a'], fingerprint: 'a'.repeat(64), treeFingerprint: 'b'.repeat(64),
      treeDiagnostic: null, diagnostic: null, capturedAt: 1 }
    const completed = settleRun(reserveRun(task(), policy(), run('reviewer')), brandString<RgRunId>('reviewer-attempt'),
      { status: 'completed', report: pass(), diagnostic: null, scope }, true)
    const legacy = sessionState(completed)
    const session = ctx.sessions.create(SessionId('legacy-scope-review'))
    const legacyEvent = appendRecord(session, 'plugin:review-gated/state', { version: 1, state: legacy })
    expect(handle.stateOf(session).value?.task?.reviewStatus).toBe('stale')
    expect(ctx.sessionProjections.snapshot(session).values.reviewGated?.state?.task?.reviewStatus).toBe('stale')
    const restored = Session.create(SessionId('legacy-scope-restored'), session.snapshotEvents())
    expect(handle.stateOf(restored).value?.task?.reviewStatus).toBe('stale')
    const oldCheckpoint = { reviewGated: { ver: 1, seq: legacyEvent.seq, val: { value: legacy, hasRequested: false, failure: null } } }
    expect(ctx.sessionProjections.restoreFloor(oldCheckpoint)).toBe(0)
    expect(ctx.sessionProjections.viewCheckpoint(oldCheckpoint).reviewGated).toBeUndefined()
    const replay = ctx.sessionProjections.restore(
      oldCheckpoint, session.snapshotEvents(), SessionLogOffset(0), session.header, session.inheritedEventCount,
    )
    expect(replay.snapshot.values.reviewGated?.state?.task?.reviewStatus).toBe('stale')
    expect(replay.checkpoint.reviewGated?.ver).toBe(rgProjectionDefinition.stateVersion)
    const checkpoint = rgProjectionDefinition.stateSchema.parse({ ...emptyProjection(), value: legacy, taskReceipt: 'unproven', hasRequested: true })
    expect(checkpoint.value?.task?.reviewStatus).toBe('stale')
    const unverifiable = { ...completed, lastReview: { ...completed.lastReview!, scope: { ...scope, fingerprint: null } } }
    appendRecord(session, 'plugin:review-gated/state', { version: 1, state: sessionState(unverifiable) })
    expect(handle.stateOf(session).value?.task?.reviewStatus).toBe('stale')
    // A v2 generation can no longer authenticate a pass; only v3 does.
    const current = { ...completed, lastReview: { ...completed.lastReview!, scope: { ...scope, fingerprint: 'v2:' + 'a'.repeat(64) } } }
    appendRecord(session, 'plugin:review-gated/state', { version: 1, state: sessionState(current) })
    expect(handle.stateOf(session).value?.task?.reviewStatus).toBe('stale')
    const verifiable = { ...completed, lastReview: { ...completed.lastReview!, scope: { ...scope, fingerprint: 'v3:' + 'a'.repeat(64),
      treeFingerprint: 'v1:' + 'b'.repeat(64) } } }
    appendRecord(session, 'plugin:review-gated/state', { version: 1, state: sessionState(verifiable) })
    expect(handle.stateOf(session).value?.task?.reviewStatus).toBe('reported-pass')
    appendRecord(session, 'plugin:review-gated/state', { version: 1, state: sessionState({ ...verifiable, lastReview: { ...verifiable.lastReview, scope: null } }) })
    expect(handle.stateOf(session).value?.task?.reviewStatus).toBe('reported-pass')
  })

  it('replays complete state and produces the same checkpoint-plus-suffix state', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjections)
    const handle = await ctx.sessionProjections.register<'reviewGated', RgProjectionState>(rgProjectionDefinition)
    const session = ctx.sessions.create(SessionId('rg-projection'))
    appendRecord(session, 'plugin:review-gated/state', { version: 1, state: sessionState(task()) })
    const reserved = reserveRun(task(), policy(), run('reviewer'))
    appendRecord(session, 'plugin:review-gated/state', { version: 1, state: sessionState(reserved) })
    const schema = rgProjectionDefinition.stateSchema
    if (schema === undefined) throw new Error('RG projection requires a checkpoint schema')
    const checkpoint = schema.parse(handle.stateOf(session))
    const cursor = session.snapshotEvents().length
    const ended = settleRun(reserved, activeId(reserved), { status: 'completed', report: pass(), diagnostic: null, scope: null }, true)
    appendRecord(session, 'plugin:review-gated/state', { version: 1, state: sessionState(ended) })
    session.append('request/header', { header: { config: { provider: main.provider, model: main.model } }, reason: 'initial' })
    const repeatedHeader = session.append('request/header', {
      header: { config: { provider: main.provider, model: main.model } }, reason: 'resume',
    })
    const prior = handle.stateOf(session)
    expect(foldRgState(prior, repeatedHeader)).toBe(prior)
    const suffix = session.snapshotEvents().slice(cursor).reduce(foldRgState, checkpoint)
    const full = session.snapshotEvents().reduce(foldRgState, emptyProjection())
    expect(suffix).toEqual(full)
    expect(full).toEqual(handle.stateOf(session))
    expect(full.value?.task).toMatchObject({ active: null, reviewAttempts: 1, reviewStatus: 'reported-pass' })
    expect(full.hasRequested).toBe(true)
    const restored = Session.create(SessionId('rg-restored'), session.snapshotEvents())
    expect(handle.stateOf(restored)).toEqual(full)
    expect(ctx.sessionProjections.snapshot(session).values.reviewGated?.state).toEqual(full.value)
    appendRecord(session, 'plugin:review-gated/state', { version: 1, state: null })
    expect(handle.stateOf(session)).toEqual({ ...emptyProjection(), hasRequested: true })
  })

  it('keeps the fold poisoned after invalid durable data instead of accepting a later pass', () => {
    const session = Session.create(SessionId('rg-invalid'), [])
    const event = appendRecord(session, 'plugin:review-gated/state', { version: 1, state: sessionState(task()) })
    const invalid = durableEvents([{ ...event, data: { version: 2, state: null } }])[0]!
    const poisoned = foldRgState(emptyProjection(), invalid)
    expect(poisoned.failure).toContain('RG_STATE_INVALID')
    expect(foldRgState(poisoned, event)).toBe(poisoned)
  })
})
