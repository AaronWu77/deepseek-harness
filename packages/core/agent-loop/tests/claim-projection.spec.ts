import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AdmissionOwner } from '@deepseek-ai/dsh-agent'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { claimProjectionDefinition } from '../src/claim.ts'

const message = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

function fixture() {
  const session = Session.create(SessionId('claim-fold-test'))
  const a = message('a')
  const b = message('b')
  const turn = session.append('turn/start', { turn: 1 })
  const inserted = session.append('agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [a, b] })
  const intent = session.append('agent/claim/intent', {
    target: 'next-step', turn: 1, step: 1,
    inputs: [{ target: 'next-step', message: a }, { target: 'next-step', message: b }],
  })
  const opened = claimProjectionDefinition.apply(
    claimProjectionDefinition.apply(claimProjectionDefinition.init(), turn), inserted,
  )
  const active = claimProjectionDefinition.apply(opened, intent)
  return { session, a, b, turn, inserted, intent, opened, active }
}

describe('claim projection validation', () => {
  it('checks checkpoint identities, views, and pending input', () => {
    const { active } = fixture()
    const schema = claimProjectionDefinition.stateSchema
    expect(schema.safeParse(active).success).toBe(true)
    const duplicateQueue = schema.parse(active)
    duplicateQueue.queue['next-turn'].push(duplicateQueue.queue['next-step'][0]!)
    expect(schema.safeParse(duplicateQueue).success).toBe(false)
    const badDisposition = schema.parse(active)
    if (badDisposition.claim === null) throw new Error('missing claim')
    badDisposition.lastDisposition = { ...badDisposition.claim.view, phase: 'entered' }
    expect(schema.safeParse(badDisposition).success).toBe(false)
    const duplicateClaim = schema.parse(active)
    if (duplicateClaim.claim === null) throw new Error('missing claim')
    duplicateClaim.claim.inputs.push(duplicateClaim.claim.inputs[0]!)
    expect(schema.safeParse(duplicateClaim).success).toBe(false)
    const missingQueued = schema.parse(active)
    missingQueued.queue['next-step'].shift()
    expect(schema.safeParse(missingQueued).success).toBe(false)
    const alteredQueued = schema.parse(active)
    alteredQueued.queue['next-step'][0]!.content = []
    expect(schema.safeParse(alteredQueued).success).toBe(false)
    const duplicateRemaining = schema.parse(active)
    if (duplicateRemaining.claim === null) throw new Error('missing claim')
    duplicateRemaining.claim.remaining.push(duplicateRemaining.claim.remaining[0]!)
    expect(schema.safeParse(duplicateRemaining).success).toBe(false)
    const settledPending = schema.parse(active)
    if (settledPending.claim === null) throw new Error('missing claim')
    settledPending.claim.settled = true
    expect(schema.safeParse(settledPending).success).toBe(false)
    const differentTurn = schema.parse(active)
    differentTurn.turn++
    expect(schema.safeParse(differentTurn).success).toBe(false)
    const differentStep = schema.parse(active)
    differentStep.step += 3
    expect(schema.safeParse(differentStep).success).toBe(false)
    const differentView = schema.parse(active)
    if (differentView.claim === null) throw new Error('missing claim')
    differentView.claim.view.phase = 'entered'
    expect(schema.safeParse(differentView).success).toBe(false)
    const dispositionOnly = schema.parse(active)
    if (dispositionOnly.claim === null) throw new Error('missing claim')
    dispositionOnly.lastDisposition = { ...dispositionOnly.claim.view, phase: 'unsettled' }
    dispositionOnly.claim = null
    expect(schema.safeParse(dispositionOnly).success).toBe(false)
  })

  it('rejects invalid intent, splice, and settlement histories', () => {
    const { session, a, b, intent, opened, active, turn } = fixture()
    const apply = (...args: Parameters<typeof claimProjectionDefinition.apply>) => claimProjectionDefinition.apply(...args)
    expect(() => apply(active, turn)).toThrow('unsettled claim')
    expect(() => apply(active, intent)).toThrow('overlapping claim')
    const wrongTurn = session.append('agent/claim/intent', { ...intent.data, turn: 2 })
    expect(() => apply(opened, wrongTurn)).toThrow('overlapping claim')
    const owner = brandString<AdmissionOwner>('test')
    const openedAdmission = session.append('agent/admission/opened', { owner, messageId: a.id })
    const confirmedAdmission = session.append('agent/admission/confirmed', { owner, messageId: a.id })
    const missingReserved = apply(apply(opened, openedAdmission), confirmedAdmission)
    const nextTurn = session.append('agent/claim/intent', { ...intent.data, target: 'next-turn' })
    expect(() => apply(missingReserved, nextTurn)).toThrow('admission input is missing')
    const duplicateQueue = session.append('agent/inbox/spliced', { target: 'next-step', start: 1, removedCount: 1, inserted: [a] })
    const duplicateState = apply(opened, duplicateQueue)
    const duplicateIntent = session.append('agent/claim/intent', {
      ...intent.data, inputs: [{ target: 'next-step', message: a }, { target: 'next-step', message: a }],
    })
    expect(() => apply(duplicateState, duplicateIntent)).toThrow('duplicate identities')
    const badSplice = session.append('agent/inbox/spliced', { target: 'next-step', start: 9, removedCount: 1, inserted: [] })
    expect(() => apply(active, badSplice)).toThrow('invalid claim inbox splice')
    const replace = session.append('agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 1, inserted: [a] })
    expect(() => apply(active, replace)).toThrow('replaced, cancelled')
    const duplicate = session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [a] })
    expect(() => apply(active, duplicate)).toThrow('duplicated')
    const early = session.append('agent/claim/settled', { intentSeq: intent.seq, outcome: 'rejected', messages: [] })
    expect(() => apply(active, early)).toThrow('invalid claim settlement')
    expect(() => apply(opened, early)).toThrow('invalid claim settlement')
    const removeA = session.append('agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 1, inserted: [] })
    const removeB = session.append('agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 1, inserted: [] })
    const removed = apply(apply(active, removeA), removeB)
    const wrongSeq = session.append('agent/claim/settled', { intentSeq: SessionSeq(99), outcome: 'rejected', messages: [] })
    expect(() => apply(removed, wrongSeq)).toThrow('invalid claim settlement')
    const rejectedWithUser = session.append('agent/claim/settled', { intentSeq: intent.seq, outcome: 'rejected', messages: [a] })
    expect(() => apply(removed, rejectedWithUser)).toThrow('invalid claim settlement')
    const missingUser = session.append('agent/claim/settled', { intentSeq: intent.seq, outcome: 'entered', messages: [a] })
    expect(() => apply(removed, missingUser)).toThrow('invalid claim settlement')
    const logged = session.append('user/message', a, { surfaceOp: 'append' })
    const confirmed = { ...opened, admission: { messageId: a.id, confirmed: true } }
    expect(apply(confirmed, logged).admission).toBeNull()
    expect(apply(opened, logged)).toBe(opened)
    expect(apply({ ...removed, admission: confirmed.admission }, logged).admission).toBeNull()
    const withUser = apply(removed, logged)
    const differentUser = session.append('agent/claim/settled', { intentSeq: intent.seq, outcome: 'entered', messages: [b] })
    expect(() => apply(withUser, differentUser)).toThrow('invalid claim settlement')
    const entered = apply(withUser, missingUser)
    expect(claimProjectionDefinition.stateSchema.safeParse(entered).success).toBe(true)
    expect(() => apply(entered, missingUser)).toThrow('invalid claim settlement')
    const assistant = session.append('assistant/message', {
      turn: 1, step: 1, message: createAssistantMessage({ content: [], source: { provider: 'mock', model: 'mock' } }), stream: [],
    }, { surfaceOp: 'append' })
    const interrupted = session.append('assistant/message', { ...assistant.data, interrupted: true }, { surfaceOp: 'append' })
    expect(apply(entered, interrupted).claim).not.toBeNull()
    expect(apply(entered, assistant).claim).toBeNull()
  })
})
