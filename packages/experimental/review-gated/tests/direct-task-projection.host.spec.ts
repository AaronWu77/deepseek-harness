/** Recovery of a direct human task across protected-claim checkpoints. */
import { appendRecord, durableEvents, recordOf } from './records.ts'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { createAssistantMessage, createUserMessage, MessageId } from '@deepseek-ai/dsh-llm'
import SessionStore, { pluginRecordOf, Session, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import { describe, expect, it, onTestFinished } from 'vitest'
import { capturePolicy, defaultSettings } from '../src/config.ts'
import { foldRgState, rgClaimPreview, rgProjectionDefinition, rgProjectionView, rgProjectionViewSchema, TASK_SAVE_UNCERTAIN } from '../src/projection.ts'
import type { RgProjectionState } from '../src/projection.ts'
import type { RgSessionState, RgTaskId } from '../src/types.ts'

const route = { provider: 'fixture', model: 'fixture' }
const pool = { candidates: [route], default: route }
const policy = capturePolicy({ ...defaultSettings(), configured: true, main: pool, worker: pool, maxHandoffChars: 32 })
const empty: RgSessionState = { role: 'main', policy, parentSessionId: null, taskId: null, runId: null, task: null, diagnostic: null }
const human = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

function fixture(text = '  original task  ') {
  const session = Session.create(SessionId('direct-task-projection'))
  const input = human(text)
  appendRecord(session, 'plugin:review-gated/state', { version: 1, state: empty })
  session.append('turn/start', { turn: 1 })
  session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [input] })
  const intent = appendRecord(session, 'plugin:review-gated/claim', { version: 1, phase: 'intent', target: 'next-turn', turn: 1, step: 1,
    inputs: [{ target: 'next-turn', message: input }] })
  session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })
  const state: RgSessionState = { ...empty, diagnostic: TASK_SAVE_UNCERTAIN, task: {
    id: brandString<RgTaskId>('direct-task'), originMessageId: input.id, objective: text.trim(), workRevision: 0,
    workerAttempts: 0, reviewAttempts: 0, active: null, lastWorker: null, lastReview: null, reviewStatus: 'not-reviewed',
  } }
  return { session, input, intent, state }
}

function appendPrepared(f: ReturnType<typeof fixture>) {
  const event = appendRecord(f.session, 'plugin:review-gated/direct-task-prepared', { version: 1, intentSeq: f.intent.seq, messageId: f.input.id, state: f.state })
  f.session.append('step/start', { turn: 1, step: 1 })
  return event
}

const fold = (session: Session) => session.snapshotEvents().reduce(foldRgState, rgProjectionDefinition.init())

describe('direct task projection', () => {
  it.each(['rejected', 'empty'] as const)('settles an unprepared claim as %s without accepting a task', (outcome) => {
    const session = Session.create(SessionId(`rg-${outcome}`))
    appendRecord(session, 'plugin:review-gated/state', { version: 1, state: empty })
    session.append('turn/start', { turn: 1 })
    const intent = appendRecord(session, 'plugin:review-gated/claim', { version: 1, phase: 'intent', turn: 1, step: 1,
      inputs: [{ message: human('ordinary input') }] })
    expect(fold(session).claim).not.toHaveProperty('target')
    expect(fold(session).taskAdmission).toMatchObject({ intentSeq: intent.seq, taskId: null })
    expect(fold(session).value?.diagnostic).toBeNull()
    appendRecord(session, 'plugin:review-gated/claim-settled', { version: 1, phase: 'settled', intentSeq: intent.seq, outcome, messages: [] })
    const settled = fold(session)
    expect(settled).toMatchObject({ failure: null, taskAdmission: null, directClaim: null, claim: { phase: outcome } })
    expect(settled.value).toEqual(empty)
    expect(rgProjectionDefinition.stateSchema.parse(settled)).toEqual(settled)
  })

  it('does not diagnose an inherited unprepared claim as an uncertain task save', () => {
    const f = fixture()
    const childId = SessionId('direct-unprepared-inherited')
    const child = Session.create(childId, f.session.snapshotEvents(), { ...f.session.header, id: childId, isSeeded: true }, f.session.seq)
    const inherited = fold(child)
    expect(inherited).toMatchObject({ failure: null, taskAdmission: { intentSeq: f.intent.seq, taskId: null } })
    expect(inherited.value).toEqual(empty)
    expect(rgProjectionDefinition.stateSchema.parse(inherited)).toEqual(inherited)
  })

  it('retains the original objective while trusting the same-id admitted rewrite at settlement', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjections)
    await ctx.sessionProjections.register<'reviewGated', RgProjectionState>(rgProjectionDefinition)
    const f = fixture()
    const prepared = appendPrepared(f)
    expect(prepared.ignorable).toBe(true)
    const rewritten = { ...f.input, content: [{ type: 'text' as const, text: 'trusted rewrite' }] }
    f.session.append('user/message', rewritten, { surfaceOp: 'append' })
    expect(fold(f.session).value?.diagnostic).toBe(TASK_SAVE_UNCERTAIN)
    appendRecord(f.session, 'plugin:review-gated/claim-settled', { version: 1, phase: 'settled', intentSeq: f.intent.seq, outcome: 'entered', messages: [rewritten] })
    const events = f.session.snapshotEvents()
    const full = ctx.sessionProjections.restore({}, events, SessionLogOffset(0), f.session.header, f.session.inheritedEventCount)
    expect(full.snapshot.values.reviewGated?.state).toMatchObject({ diagnostic: null, task: { objective: 'original task', originMessageId: f.input.id } })
    expect(full.snapshot.values.reviewGated?.claim).toEqual({ intentSeq: f.intent.seq, turn: 1, step: 1,
      phase: 'entered', text: '  original task  ', truncated: false, otherContent: false })
    expect(full.snapshot.values.reviewGated).toMatchObject({ failed: false, ready: false, taskReceipt: 'proven' })
    for (let cut = 0; cut <= events.length; cut++) {
      const prefix = ctx.sessionProjections.restore(
        {}, events.slice(0, cut), SessionLogOffset(0), f.session.header, f.session.inheritedEventCount)
      const suffix = ctx.sessionProjections.restore(
        prefix.checkpoint, events.slice(cut), SessionLogOffset(cut), f.session.header, f.session.inheritedEventCount)
      expect(suffix.checkpoint.reviewGated?.val).toEqual(full.checkpoint.reviewGated?.val)
      expect(suffix.snapshot.values.reviewGated).toEqual(full.snapshot.values.reviewGated)
    }
    for (let cut = prepared.seq + 1; cut < events.length; cut++) {
      const id = SessionId(`direct-fork-${cut}`)
      const fork = Session.create(id, events.slice(0, cut), { ...f.session.header, id, isSeeded: true }, SessionLogOffset(cut))
      expect(fold(fork).failure).toContain('RG_STATE_INVALID')
    }
    const row = full.checkpoint.reviewGated
    if (row === undefined) throw new Error('Missing RG checkpoint')
    const old = { reviewGated: { ...row, ver: 5 } }
    expect(ctx.sessionProjections.restoreFloor(old)).toBe(0)
    const replay = ctx.sessionProjections.restore(old, events, SessionLogOffset(0), f.session.header, f.session.inheritedEventCount)
    expect(replay.snapshot.values.reviewGated).toEqual(full.snapshot.values.reviewGated)
  })

  it('rejects malformed checkpoints and preserves failure across all suffix cuts', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjections)
    await ctx.sessionProjections.register<'reviewGated', RgProjectionState>(rgProjectionDefinition)
    const f = fixture()
    appendPrepared(f)
    const before = f.session.snapshotEvents()
    const prefix = ctx.sessionProjections.restore({}, before, SessionLogOffset(0), f.session.header, f.session.inheritedEventCount)
    const row = prefix.checkpoint.reviewGated
    if (row === undefined) throw new Error('Missing RG checkpoint')
    const malformed = { reviewGated: { ...row, val: { directClaim: { phase: 'prepared' } } } }
    expect(ctx.sessionProjections.viewCheckpoint(malformed).reviewGated).toBeUndefined()
    expect(() => ctx.sessionProjections.restore(
      malformed, before, SessionLogOffset(0), f.session.header, f.session.inheritedEventCount)).toThrow()
    expect(() => ctx.sessionProjections.restore(
      malformed, [], SessionLogOffset(before.length), f.session.header, f.session.inheritedEventCount)).toThrow()
    expect(ctx.sessionProjections.restore({}, before, SessionLogOffset(0), f.session.header, f.session.inheritedEventCount)
      .snapshot.values.reviewGated).toEqual(prefix.snapshot.values.reviewGated)
    f.session.append('user/message', f.input, { surfaceOp: 'append' })
    appendRecord(f.session, 'plugin:review-gated/claim-settled', { version: 1, phase: 'settled', intentSeq: f.intent.seq, outcome: 'entered', messages: [] })
    const events = f.session.snapshotEvents()
    const full = ctx.sessionProjections.restore({}, events, SessionLogOffset(0), f.session.header, f.session.inheritedEventCount)
    expect(full.snapshot.values.reviewGated?.state).toBeNull()
    expect(fold(f.session).failure).toContain('RG_STATE_INVALID')
    for (let cut = 0; cut <= events.length; cut++) {
      const part = ctx.sessionProjections.restore(
        {}, events.slice(0, cut), SessionLogOffset(0), f.session.header, f.session.inheritedEventCount)
      const suffix = ctx.sessionProjections.restore(
        part.checkpoint, events.slice(cut), SessionLogOffset(cut), f.session.header, f.session.inheritedEventCount)
      expect(suffix.checkpoint.reviewGated?.val).toEqual(full.checkpoint.reviewGated?.val)
    }
    expect(f.session.snapshotEvents()).toEqual(events)
  })

  it('rejects mismatched preparation identities, policy, and task initialization', () => {
    const f = fixture()
    const prior = fold(f.session)
    const event = appendPrepared(f)
    const record = recordOf(event)
    if (record?.type !== 'plugin:review-gated/direct-task-prepared') throw new Error('Missing prepared task')
    const changed = (data: unknown) => durableEvents([{ ...event, data }])[0]!
    expect(foldRgState(prior, changed({ ...record.data, version: 2 })).failure).toContain('RG_STATE_INVALID')
    expect(foldRgState(prior, changed({ ...record.data, intentSeq: SessionSeq(999) })).failure).toContain('RG_STATE_INVALID')
    expect(foldRgState(prior, changed({ ...record.data, messageId: MessageId('other') })).failure).toContain('RG_STATE_INVALID')
    if (f.state.task === null) throw new Error('missing task')
    for (const task of [
      { ...f.state.task, objective: 'wrong' },
      { ...f.state.task, objective: ' original task ' },
      { ...f.state.task, originMessageId: MessageId('other') },
      { ...f.state.task, workerAttempts: 1 },
    ]) expect(foldRgState(prior, changed({ ...record.data, state: { ...f.state, task } })).failure).toContain('RG_STATE_INVALID')
    expect(foldRgState(prior, changed({ ...record.data, state: { ...f.state, policy: { ...policy, maxHandoffChars: 31 } } })).failure).toContain('RG_STATE_INVALID')
  })

  it('fails closed on missing, duplicate, rejected, mismatched, and unrelated evidence', () => {
    const f = fixture()
    appendPrepared(f)
    const prepared = fold(f.session)
    const logged = f.session.append('user/message', f.input, { surfaceOp: 'append' })
    const once = foldRgState(prepared, logged)
    const entered = appendRecord(f.session, 'plugin:review-gated/claim-settled', { version: 1, phase: 'settled', intentSeq: f.intent.seq, outcome: 'entered', messages: [f.input] })
    expect(foldRgState(prepared, entered).failure).toContain('RG_STATE_INVALID')
    expect(foldRgState(foldRgState(once, logged), entered).failure).toContain('RG_STATE_INVALID')
    const settledRecord = recordOf(entered)
    if (settledRecord?.type !== 'plugin:review-gated/claim-settled') throw new Error('Missing settlement')
    const changed = (data: unknown) => durableEvents([{ ...entered, data }])[0]!
    expect(foldRgState(once, changed({ ...settledRecord.data, intentSeq: SessionSeq(999) })).failure).toContain('RG_STATE_INVALID')
    expect(foldRgState(once, changed({ ...settledRecord.data, outcome: 'rejected', messages: [] })).failure).toContain('RG_STATE_INVALID')
    expect(foldRgState(once, changed({ ...settledRecord.data, messages: [] })).failure).toContain('RG_STATE_INVALID')
    expect(foldRgState(once, changed({ ...settledRecord.data, messages: [f.input, f.input] })).failure).toContain('RG_STATE_INVALID')
    expect(foldRgState(once, changed({ ...settledRecord.data, messages: [{ ...f.input, source: { kind: 'system-prompt' } }] })).failure).toContain('RG_STATE_INVALID')
    expect(foldRgState(foldRgState(prepared, { ...logged, data: { ...logged.data, source: { kind: 'system-prompt' } } }), entered).failure).toContain('RG_STATE_INVALID')
    const settled = foldRgState(once, entered)
    expect(foldRgState(settled, entered).failure).toContain('RG_STATE_INVALID')
    expect(foldRgState(settled, logged).failure).toContain('RG_STATE_INVALID')
    const stateEvent = appendRecord(f.session, 'plugin:review-gated/state', { version: 1, state: f.state })
    expect(foldRgState(prepared, stateEvent).failure).toContain('RG_STATE_INVALID')
    expect(foldRgState(prepared, f.intent).failure).toContain('RG_STATE_INVALID')
    const childId = SessionId('direct-pending-fork')
    const prefix = f.session.snapshotEvents().slice(0, 6)
    const fork = Session.create(childId, prefix, { ...f.session.header, id: childId, isSeeded: true }, SessionLogOffset(prefix.length))
    expect(fold(fork).failure).toContain('RG_STATE_INVALID')
  })

  it('rejects oversized objectives without retaining input and accepts large outer whitespace', () => {
    const f = fixture('x'.repeat(33))
    expect(fold(f.session).directClaim).toMatchObject({ objective: null })
    expect(JSON.stringify(fold(f.session).directClaim)).not.toContain('x'.repeat(33))
    appendPrepared(f)
    expect(fold(f.session).failure).toContain('RG_STATE_INVALID')
    const spaced = fixture(' '.repeat(10000) + 'ok' + ' '.repeat(10000))
    expect(fold(spaced.session).directClaim?.objective).toBe('ok')
    appendPrepared(spaced)
    expect(fold(spaced.session).failure).toBeNull()
  })

  it('finds the first nonblank human input across a mixed ordered claim', () => {
    const session = Session.create(SessionId('direct-mixed-input'))
    const system = { ...human('not a human task'), source: { kind: 'system-prompt' as const } }
    const blank = human('  \n  ')
    const first = human('  selected  ')
    const later = human('later')
    appendRecord(session, 'plugin:review-gated/state', { version: 1, state: empty })
    session.append('turn/start', { turn: 1 })
    appendRecord(session, 'plugin:review-gated/claim', { version: 1, phase: 'intent', target: 'next-turn', turn: 1, step: 1, inputs: [system, blank, first, later]
      .map(message => ({ target: 'next-step' as const, message })) })
    expect(fold(session).directClaim).toMatchObject({ messageId: first.id, objective: 'selected' })
    const oversized = human('x'.repeat(33))
    const tooLarge = Session.create(SessionId('direct-oversized-first'))
    appendRecord(tooLarge, 'plugin:review-gated/state', { version: 1, state: empty })
    tooLarge.append('turn/start', { turn: 1 })
    appendRecord(tooLarge, 'plugin:review-gated/claim', { version: 1, phase: 'intent', target: 'next-step', turn: 1, step: 1,
      inputs: [oversized, later].map(message => ({ target: 'next-step' as const, message })) })
    expect(fold(tooLarge).directClaim).toMatchObject({ messageId: oversized.id, objective: null })
  })

  it('ignores blank and image-only inputs without creating a task', () => {
    const session = Session.create(SessionId('direct-blank-image'))
    const blank = human(' \t ')
    const image = createUserMessage({ content: [{ type: 'image', attachment: {
      attachmentId: AttachmentId('sha256:abc'), mediaType: 'image/png', bytes: 1, width: 1, height: 1,
    } }], source: { kind: 'user' } })
    appendRecord(session, 'plugin:review-gated/state', { version: 1, state: empty })
    session.append('turn/start', { turn: 1 })
    appendRecord(session, 'plugin:review-gated/claim', { version: 1, phase: 'intent', target: 'next-step', turn: 1, step: 1,
      inputs: [blank, image].map(message => ({ target: 'next-step' as const, message })) })
    expect(fold(session).directClaim).toBeNull()
    expect(fold(session).value?.task).toBeNull()
  })

  it('rejects inconsistent direct-claim checkpoint data', () => {
    const f = fixture()
    appendPrepared(f)
    const current = fold(f.session)
    const direct = current.directClaim
    if (direct === null) throw new Error('missing direct claim')
    const schema = rgProjectionDefinition.stateSchema
    expect(schema.safeParse(current).success).toBe(true)
    expect(schema.safeParse({ ...current, taskReceipt: 'proven' }).success).toBe(false)
    expect(schema.safeParse({ ...current, directClaim: { ...direct, messageId: 'wrong' } }).success).toBe(false)
    expect(schema.safeParse({ ...current, directClaim: { ...direct, objective: ' '.repeat(50) } }).success).toBe(false)
    expect(schema.safeParse({ ...current, directClaim: { ...direct, phase: 'settled', admitted: 0 } }).success).toBe(false)
  })

  it('rejects every inconsistent direct-task preparation and admission record', () => {
    // Each case is one durable record that the fold must refuse instead of
    // guessing an owner, an index, or a task identity.
    const prepared = () => {
      const f = fixture()
      appendPrepared(f)
      return f
    }
    // A task-prepared event without the opening admission cannot be attributed.
    const noAdmission = prepared()
    const preparedEvent = noAdmission.session.snapshotEvents().find(event => pluginRecordOf(event)?.type === 'plugin:review-gated/direct-task-prepared')
    const preparedRecord = preparedEvent === undefined ? undefined : recordOf(preparedEvent)
    if (preparedEvent === undefined || preparedRecord?.type !== 'plugin:review-gated/direct-task-prepared') throw new Error('missing prepared event')
    const state = fold(prepared().session)
    const variants: unknown[] = [
      { ...preparedRecord.data, version: 2 },
      { ...preparedRecord.data, messageId: MessageId('other') },
      { ...preparedRecord.data, state: { ...state.value, task: null } },
      { ...preparedRecord.data, state: { ...state.value, diagnostic: null } },
      { ...preparedRecord.data, state: { ...state.value, task: { ...state.value!.task!, workRevision: 1 } } },
    ]
    for (const data of variants) {
      expect(foldRgState({ ...state, directClaim: { ...state.directClaim!, phase: 'intent' } }, durableEvents([{ ...preparedEvent, data }])[0]!).failure)
        .toContain('RG_STATE_INVALID')
    }
    // A settlement at another intent cannot settle or invalidate an unprepared claim.
    const earlier = durableEvents([{ type: 'plugin:review-gated/claim-settled', ignorable: true, time: preparedEvent.time,
      seq: SessionSeq(preparedEvent.seq - 1), data: { version: 1, phase: 'settled', intentSeq: SessionSeq(999), outcome: 'entered', messages: [] } }])[0]!
    expect(foldRgState({ ...state, directClaim: { ...state.directClaim!, phase: 'intent' } }, earlier).failure).toBeNull()
  })

  it('rejects malformed claim intents and malformed direct-claim checkpoints', () => {
    const session = Session.create(SessionId('direct-malformed-events'))
    appendRecord(session, 'plugin:review-gated/state', { version: 1, state: empty })
    session.append('turn/start', { turn: 1 })
    const input = human('task')
    const intent = appendRecord(session, 'plugin:review-gated/claim', { version: 1, phase: 'intent', target: 'next-turn', turn: 1, step: 1,
      inputs: [{ target: 'next-turn', message: input }] })
    const folded = fold(session)
    expect(folded.directClaim).toMatchObject({ messageId: input.id })
    const intentRecord = recordOf(intent)
    if (intentRecord?.type !== 'plugin:review-gated/claim') throw new Error('missing claim intent')
    for (const content of [[7], [{ type: 'text' }], [[]]]) {
      const broken = durableEvents([{ ...intent, seq: SessionSeq(intent.seq + 1),
        data: { ...intentRecord.data, inputs: [{ message: { ...input, content } }] } }])[0]!
      expect(foldRgState(folded, broken).failure).toContain('RG_STATE_INVALID')
    }
    const f = fixture()
    appendPrepared(f)
    const current = fold(f.session)
    const direct = current.directClaim
    if (direct === null) throw new Error('missing direct claim')
    const schema = rgProjectionDefinition.stateSchema
    expect(schema.safeParse({ ...current, value: { ...current.value!, diagnostic: null } }).success).toBe(false)
    expect(schema.safeParse({ ...current, value: { ...current.value!, role: 'reviewer' } }).success).toBe(false)
    expect(schema.safeParse({ ...current, taskAdmission: { messageId: direct.messageId,
      taskId: brandString<RgTaskId>('other'), intentSeq: f.intent.seq } }).success).toBe(false)
    expect(schema.safeParse({ ...current, taskInputText: 'unrelated' }).success).toBe(false)
  })
})

function genericTaskFixture() {
  const original = fixture()
  const session = Session.create(SessionId('generic-task-receipt'))
  appendRecord(session, 'plugin:review-gated/state', { version: 1, state: { ...original.state, diagnostic: null } })
  session.append('turn/start', { turn: 1 })
  const intent = appendRecord(session, 'plugin:review-gated/claim', { version: 1, phase: 'intent', turn: 1, step: 1,
    inputs: [{ message: original.input }],
  })
  return { ...original, session, intent }
}

function appendEntered(f: ReturnType<typeof fixture>) {
  f.session.append('user/message', f.input, { surfaceOp: 'append' })
  appendRecord(f.session, 'plugin:review-gated/claim-settled', {
    version: 1, phase: 'settled', intentSeq: f.intent.seq, outcome: 'entered', messages: [f.input],
  })
}

function appendAnswer(session: Session) {
  session.append('assistant/message', { turn: 1, step: 1,
    message: createAssistantMessage({ content: [{ type: 'text', text: 'done' }], source: route }), stream: [],
  }, { surfaceOp: 'append' })
}

describe('RG-owned wire readiness and receipt', () => {
  it('bounds original-input previews by text and inspection budgets without inferring a target', () => {
    const claim = fold(fixture().session).claim
    if (claim === null) throw new Error('missing original claim')
    const preview = (texts: string[]) => rgClaimPreview({ ...claim, inputs: [{ message: createUserMessage({
      content: texts.map(text => ({ type: 'text' as const, text })), source: { kind: 'user' },
    }) }] })
    expect(preview(['', 'first', '', 'last'])).toEqual({ phase: 'unsettled', text: 'first\n\nlast', truncated: false, otherContent: false })
    expect(preview(['x'.repeat(8192)])).toMatchObject({ text: 'x'.repeat(8192), truncated: false, otherContent: false })
    expect(preview(['x'.repeat(8193)])).toMatchObject({ text: 'x'.repeat(8192), truncated: true, otherContent: true })
    expect(preview(['x'.repeat(8191), 'y'])).toMatchObject({ text: 'x'.repeat(8191) + '\n', truncated: true, otherContent: true })
    expect(preview(Array.from({ length: 8191 }, () => ''))).toMatchObject({ text: '', truncated: false, otherContent: false })
    expect(preview(Array.from({ length: 8192 }, () => ''))).toMatchObject({ text: '', truncated: true, otherContent: true })
    const image = createUserMessage({ content: [{ type: 'image', attachment: {
      attachmentId: AttachmentId('sha256:preview'), mediaType: 'image/png', bytes: 1, width: 1, height: 1,
    } }], source: { kind: 'user' } })
    expect(rgClaimPreview({ ...claim, inputs: [{ message: image }, { message: human('visible') }] })).toEqual({
      phase: 'unsettled', text: 'visible', truncated: false, otherContent: true,
    })
    const wire = rgProjectionView(fold(fixture().session))
    expect(wire.claim).not.toHaveProperty('target')
    expect(wire.claim).not.toHaveProperty('inputs')
    expect(wire.claim).not.toHaveProperty('ready')
  })

  it('keeps an unproven task unavailable after its entered claim clears on assistant output', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjections)
    await ctx.sessionProjections.register<'reviewGated', RgProjectionState>(rgProjectionDefinition)
    const f = genericTaskFixture()
    f.session.append('step/start', { turn: 1, step: 1 })
    appendEntered(f)
    expect(rgProjectionView(fold(f.session))).toMatchObject({ taskReceipt: 'unproven', ready: false, claim: { phase: 'entered' } })
    appendAnswer(f.session)
    const complete = fold(f.session)
    const wire = rgProjectionView(complete)
    expect(wire).toMatchObject({ state: { task: { id: f.state.task!.id }, diagnostic: null },
      claim: null, failed: false, taskReceipt: 'unproven', ready: false })
    const events = f.session.snapshotEvents()
    for (let cut = 0; cut <= events.length; cut++) {
      const prefix = ctx.sessionProjections.restore({}, events.slice(0, cut), SessionLogOffset(0),
        f.session.header, f.session.inheritedEventCount)
      const restored = ctx.sessionProjections.restore(prefix.checkpoint, events.slice(cut), SessionLogOffset(cut),
        f.session.header, f.session.inheritedEventCount)
      expect(restored.snapshot.values.reviewGated).toEqual(wire)
      expect(restored.checkpoint.reviewGated?.ver).toBe(11)
    }
    appendRecord(f.session, 'plugin:review-gated/state', { version: 1, state: { ...f.state, diagnostic: null } })
    f.session.append('user/message', f.input, { surfaceOp: 'append' })
    expect(rgProjectionView(fold(f.session))).toMatchObject({ claim: null, taskReceipt: 'unproven', ready: false })
  })

  it('preserves proven receipts only across the same task identity and never proves legacy input incidentally', () => {
    const f = fixture()
    appendPrepared(f)
    expect(fold(f.session).taskReceipt).toBe('unproven')
    appendEntered(f)
    appendAnswer(f.session)
    const proven = fold(f.session)
    expect(rgProjectionView(proven)).toMatchObject({ taskReceipt: 'proven', ready: true, claim: null })
    const task = proven.value!.task!
    for (const replacement of [
      { ...task, id: brandString<RgTaskId>('different-task') },
      { ...task, originMessageId: MessageId('different-input') },
      { ...task, objective: 'different objective' },
    ]) {
      const event = appendRecord(f.session, 'plugin:review-gated/state', { version: 1, state: { ...proven.value!, task: replacement } })
      expect(rgProjectionView(foldRgState(proven, event))).toMatchObject({ ready: false, taskReceipt: 'unproven' })
    }
    const same = appendRecord(f.session, 'plugin:review-gated/state', { version: 1, state: { ...proven.value!, task: { ...task, workRevision: 1 } } })
    expect(rgProjectionView(foldRgState(proven, same))).toMatchObject({ ready: true, taskReceipt: 'proven' })
    const clear = appendRecord(f.session, 'plugin:review-gated/state', { version: 1, state: empty })
    const cleared = foldRgState(proven, clear)
    expect(rgProjectionView(cleared)).toMatchObject({ ready: true, taskReceipt: 'none' })
    const legacy = Session.create(SessionId('legacy-receipt'))
    appendRecord(legacy, 'plugin:review-gated/state', { version: 1, state: f.state })
    legacy.append('user/message', f.input, { surfaceOp: 'append' })
    expect(rgProjectionView(fold(legacy))).toMatchObject({ state: { diagnostic: null }, ready: false, taskReceipt: 'unproven' })
    expect(rgProjectionDefinition.stateSchema.safeParse({ ...proven, taskReceipt: 'none' }).success).toBe(false)
    expect(rgProjectionDefinition.stateSchema.safeParse({ ...cleared, taskReceipt: 'proven' }).success).toBe(false)
  })

  it('matches durable readiness for every reachable claim, receipt, task, and failure branch', () => {
    const rows: { name: string; state: RgProjectionState; ready: boolean; failed?: boolean }[] = []
    const add = (name: string, session: Session, ready: boolean, failed = false) => rows.push({ name, state: fold(session), ready, failed })
    rows.push({ name: 'no RG', state: rgProjectionDefinition.init(), ready: true })
    const f = fixture()
    add('open human claim without task', f.session, false)
    appendPrepared(f)
    add('prepared task', f.session, false)
    appendEntered(f)
    add('entered proven task', f.session, false)
    appendAnswer(f.session)
    add('proven task without claim', f.session, true)
    const ready = fold(f.session)
    const task = ready.value!.task!
    const active = { id: brandString<import('../src/types.ts').RgRunId>('receipt-run'), childId: SessionId('receipt-child'),
      role: 'worker' as const, workRevision: 1, selection: route, status: 'saving' as const, report: null, diagnostic: null, scope: null }
    const saving = appendRecord(f.session, 'plugin:review-gated/state', { version: 1, state: {
      ...ready.value!, task: { ...task, workRevision: 1, workerAttempts: 1, active },
    } })
    rows.push({ name: 'saving result', state: foldRgState(ready, saving), ready: false })
    const diagnostic = appendRecord(f.session, 'plugin:review-gated/state', { version: 1, state: { ...ready.value!, diagnostic: 'Unavailable' } })
    rows.push({ name: 'diagnostic', state: foldRgState(ready, diagnostic), ready: false })
    for (const outcome of ['empty', 'rejected'] as const) for (const sameOrigin of [false, true]) {
      const session = Session.create(SessionId(`${outcome}-${sameOrigin}`), f.session.snapshotEvents().slice(0, saving.seq))
      session.append('turn/start', { turn: 2 })
      const input = sameOrigin ? f.input : human('different input')
      const intent = appendRecord(session, 'plugin:review-gated/claim', { version: 1, phase: 'intent', turn: 2, step: 1, inputs: [{ message: input }] })
      appendRecord(session, 'plugin:review-gated/claim-settled', { version: 1, phase: 'settled', intentSeq: intent.seq, outcome, messages: [] })
      add(`${outcome} ${sameOrigin ? 'task origin' : 'unrelated input'}`, session, !sameOrigin)
    }
    const absent = fixture()
    appendRecord(absent.session, 'plugin:review-gated/claim-settled', { version: 1, phase: 'settled', intentSeq: absent.intent.seq, outcome: 'empty', messages: [] })
    add('empty without task', absent.session, true)
    const unproven = genericTaskFixture()
    unproven.session.append('step/start', { turn: 1, step: 1 })
    appendEntered(unproven)
    add('entered unproven task', unproven.session, false)
    appendAnswer(unproven.session)
    add('cleared unproven claim', unproven.session, false)
    appendRecord(unproven.session, 'plugin:review-gated/claim-settled', { version: 1, phase: 'settled', intentSeq: SessionSeq(0), outcome: 'empty', messages: [] })
    add('failed projection', unproven.session, false, true)
    const inherited = fixture()
    appendPrepared(inherited)
    inherited.session.append('session/end-seed', { inherited: true })
    add('failed prepared task', inherited.session, false, true)
    for (const row of rows) {
      const wire = rgProjectionView(row.state)
      expect(wire.ready, row.name).toBe(row.ready)
      expect(wire.failed, row.name).toBe(row.failed ?? false)
      expect(wire.taskReceipt, row.name).toBe(row.state.taskReceipt)
      expect(rgProjectionViewSchema.parse(wire), row.name).toEqual(wire)
      expect(rgProjectionDefinition.stateSchema.parse(row.state), row.name).toEqual(row.state)
      if (wire.ready) {
        expect(wire.failed, row.name).toBe(false)
        expect(wire.state?.diagnostic ?? null, row.name).toBeNull()
        expect(wire.state?.task?.active?.status, row.name).not.toBe('saving')
        expect(['unsettled', 'entered'], row.name).not.toContain(wire.claim?.phase)
        expect(wire.taskReceipt, row.name).toBe(wire.state?.task == null ? 'none' : 'proven')
      }
    }
  })

  it('distinguishes absent state from failure and validates only the bounded wire fields', () => {
    const clean = rgProjectionView(rgProjectionDefinition.init())
    expect(clean).toEqual({ state: null, claim: null, failed: false, ready: true, taskReceipt: 'none' })
    const failed = rgProjectionView({ ...rgProjectionDefinition.init(), failure: 'private failure detail' })
    expect(failed).toEqual({ state: null, claim: null, failed: true, ready: false, taskReceipt: 'none' })
    expect(JSON.stringify(failed)).not.toContain('private failure detail')
    const wire = rgProjectionView(fold(fixture().session))
    for (const invalid of [
      { ...wire, failure: 'detail' }, { ...wire, ready: undefined }, { ...wire, failed: undefined },
      { ...wire, taskReceipt: 'unknown' }, { ...wire, claim: { ...wire.claim, text: 'x'.repeat(8193) } },
      { ...wire, claim: { ...wire.claim, inputs: [] } }, { ...wire, claim: { ...wire.claim, ready: false } },
      { ...wire, claim: { ...wire.claim, target: 'next-turn' } },
    ]) expect(rgProjectionViewSchema.safeParse(invalid).success).toBe(false)
  })
})
