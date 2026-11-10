/** Recovery of a direct human task across protected-claim checkpoints. */
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { createUserMessage, MessageId } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import { describe, expect, it, onTestFinished } from 'vitest'
import { capturePolicy, defaultSettings } from '../src/config.ts'
import { foldRgState, rgProjectionDefinition, TASK_SAVE_UNCERTAIN } from '../src/projection.ts'
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
  session.append('review-gated/state', { version: 1, state: empty })
  session.append('turn/start', { turn: 1 })
  session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [input] })
  const intent = session.append('agent/claim/intent', { target: 'next-turn', turn: 1, step: 1,
    inputs: [{ target: 'next-turn', message: input }] })
  session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })
  const state: RgSessionState = { ...empty, diagnostic: TASK_SAVE_UNCERTAIN, task: {
    id: brandString<RgTaskId>('direct-task'), originMessageId: input.id, objective: text.trim(), workRevision: 0,
    workerAttempts: 0, reviewAttempts: 0, active: null, lastWorker: null, lastReview: null, reviewStatus: 'not-reviewed',
  } }
  return { session, input, intent, state }
}

function appendPrepared(f: ReturnType<typeof fixture>) {
  return f.session.append('review-gated/direct-task-prepared', { version: 1, intentSeq: f.intent.seq, messageId: f.input.id, state: f.state })
}

const fold = (session: Session) => session.snapshotEvents().reduce(foldRgState, rgProjectionDefinition.init())

describe('direct task projection', () => {
  it('retains the original objective while trusting the same-id admitted rewrite at settlement', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjections)
    await ctx.sessionProjections.register<'reviewGated', RgProjectionState>(rgProjectionDefinition)
    const f = fixture()
    const prepared = appendPrepared(f)
    expect(prepared.ignorable).toBeUndefined()
    const rewritten = { ...f.input, content: [{ type: 'text' as const, text: 'trusted rewrite' }] }
    f.session.append('user/message', rewritten, { surfaceOp: 'append' })
    expect(fold(f.session).value?.diagnostic).toBe(TASK_SAVE_UNCERTAIN)
    f.session.append('agent/claim/settled', { intentSeq: f.intent.seq, outcome: 'entered', messages: [rewritten] })
    const events = f.session.snapshotEvents()
    const full = ctx.sessionProjections.restore({}, events, SessionLogOffset(0), f.session.header, f.session.inheritedEventCount)
    expect(full.snapshot.values.reviewGated).toMatchObject({ diagnostic: null, task: { objective: 'original task', originMessageId: f.input.id } })
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
    f.session.append('agent/claim/settled', { intentSeq: f.intent.seq, outcome: 'entered', messages: [] })
    const events = f.session.snapshotEvents()
    const full = ctx.sessionProjections.restore({}, events, SessionLogOffset(0), f.session.header, f.session.inheritedEventCount)
    expect(full.snapshot.values.reviewGated).toBeNull()
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
    const malformed = { ...event, data: { ...event.data, version: 2 } }
    // @ts-expect-error -- malformed persisted events are not typed producer inputs.
    expect(foldRgState(prior, malformed).failure).toContain('RG_STATE_INVALID')
    expect(foldRgState(prior, { ...event, data: { ...event.data, intentSeq: SessionSeq(999) } }).failure).toContain('RG_STATE_INVALID')
    expect(foldRgState(prior, { ...event, data: { ...event.data, messageId: MessageId('other') } }).failure).toContain('RG_STATE_INVALID')
    if (f.state.task === null) throw new Error('missing task')
    for (const task of [
      { ...f.state.task, objective: 'wrong' },
      { ...f.state.task, objective: ' original task ' },
      { ...f.state.task, originMessageId: MessageId('other') },
      { ...f.state.task, workerAttempts: 1 },
    ]) expect(foldRgState(prior, { ...event, data: { ...event.data, state: { ...f.state, task } } }).failure).toContain('RG_STATE_INVALID')
    expect(foldRgState(prior, { ...event, data: { ...event.data, state: { ...f.state, policy: { ...policy, maxHandoffChars: 31 } } } }).failure).toContain('RG_STATE_INVALID')
  })

  it('fails closed on missing, duplicate, rejected, mismatched, and unrelated evidence', () => {
    const f = fixture()
    appendPrepared(f)
    const prepared = fold(f.session)
    const logged = f.session.append('user/message', f.input, { surfaceOp: 'append' })
    const once = foldRgState(prepared, logged)
    const entered = f.session.append('agent/claim/settled', { intentSeq: f.intent.seq, outcome: 'entered', messages: [f.input] })
    expect(foldRgState(prepared, entered).failure).toContain('RG_STATE_INVALID')
    expect(foldRgState(foldRgState(once, logged), entered).failure).toContain('RG_STATE_INVALID')
    expect(foldRgState(once, { ...entered, data: { ...entered.data, intentSeq: SessionSeq(999) } }).failure).toContain('RG_STATE_INVALID')
    expect(foldRgState(once, { ...entered, data: { ...entered.data, outcome: 'rejected', messages: [] } }).failure).toContain('RG_STATE_INVALID')
    expect(foldRgState(once, { ...entered, data: { ...entered.data, messages: [] } }).failure).toContain('RG_STATE_INVALID')
    expect(foldRgState(once, { ...entered, data: { ...entered.data, messages: [f.input, f.input] } }).failure).toContain('RG_STATE_INVALID')
    expect(foldRgState(once, { ...entered, data: { ...entered.data, messages: [{ ...f.input, source: { kind: 'system-prompt' } }] } }).failure).toContain('RG_STATE_INVALID')
    expect(foldRgState(foldRgState(prepared, { ...logged, data: { ...logged.data, source: { kind: 'system-prompt' } } }), entered).failure).toContain('RG_STATE_INVALID')
    const settled = foldRgState(once, entered)
    expect(foldRgState(settled, entered).failure).toContain('RG_STATE_INVALID')
    expect(foldRgState(settled, logged).failure).toContain('RG_STATE_INVALID')
    const stateEvent = f.session.append('review-gated/state', { version: 1, state: f.state })
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
    session.append('review-gated/state', { version: 1, state: empty })
    session.append('agent/claim/intent', { target: 'next-turn', turn: 1, step: 1, inputs: [system, blank, first, later]
      .map(message => ({ target: 'next-step' as const, message })) })
    expect(fold(session).directClaim).toMatchObject({ messageId: first.id, objective: 'selected' })
    const oversized = human('x'.repeat(33))
    const tooLarge = Session.create(SessionId('direct-oversized-first'))
    tooLarge.append('review-gated/state', { version: 1, state: empty })
    tooLarge.append('agent/claim/intent', { target: 'next-step', turn: 1, step: 1,
      inputs: [oversized, later].map(message => ({ target: 'next-step' as const, message })) })
    expect(fold(tooLarge).directClaim).toMatchObject({ messageId: oversized.id, objective: null })
  })

  it('ignores blank and image-only inputs without creating a task', () => {
    const session = Session.create(SessionId('direct-blank-image'))
    const blank = human(' \t ')
    const image = createUserMessage({ content: [{ type: 'image', attachment: {
      attachmentId: AttachmentId('sha256:abc'), mediaType: 'image/png', bytes: 1, width: 1, height: 1,
    } }], source: { kind: 'user' } })
    session.append('review-gated/state', { version: 1, state: empty })
    session.append('agent/claim/intent', { target: 'next-step', turn: 1, step: 1,
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
    expect(schema.safeParse({ ...current, directClaim: { ...direct, messageId: 'wrong' } }).success).toBe(false)
    expect(schema.safeParse({ ...current, directClaim: { ...direct, objective: ' '.repeat(50) } }).success).toBe(false)
    expect(schema.safeParse({ ...current, directClaim: { ...direct, phase: 'settled', admitted: 0 } }).success).toBe(false)
  })

  it('rejects malformed claim intents and malformed direct-claim checkpoints', () => {
    const session = Session.create(SessionId('direct-malformed-events'))
    session.append('review-gated/state', { version: 1, state: empty })
    const input = human('task')
    session.append('agent/claim/intent', { target: 'next-turn', turn: 1, step: 1,
      inputs: [{ target: 'next-turn', message: input }] })
    const folded = fold(session)
    expect(folded.directClaim).toMatchObject({ messageId: input.id })
    const intent = session.snapshotEvents().filter(event => event.type === 'agent/claim/intent').at(-1)
    if (intent === undefined) throw new Error('missing claim intent')
    for (const content of [[7], [{ type: 'text' }], [[]]]) {
      const broken = { ...intent, seq: SessionSeq(intent.seq + 1),
        data: { ...intent.data, inputs: [{ target: 'next-turn' as const, message: { ...input, content } }] } }
      // @ts-expect-error -- malformed persisted events are not typed producer inputs.
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
      taskId: brandString<RgTaskId>('other'), index: 0 } }).success).toBe(false)
    expect(schema.safeParse({ ...current, taskInputText: 'unrelated' }).success).toBe(false)
  })
})
