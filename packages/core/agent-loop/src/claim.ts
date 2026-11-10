/** Durable protected-claim recovery and pending-input validation. */
import type { ClaimRecovery, ClaimWireState, InboxTarget } from '@deepseek-ai/dsh-agent'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { z } from 'zod'
import { isDeepStrictEqual } from 'node:util'

/** Persisted claim fold state, including pending input and the latest nonblocking disposition. */
interface ClaimProjection {
  readonly queue: Record<InboxTarget, readonly JsonValue[]>
  readonly turn: number
  readonly step: number
  readonly admission: { readonly messageId: string; readonly confirmed: boolean } | null
  readonly lastDisposition: ClaimWireState | null
  readonly claim: (ClaimRecovery & {
    readonly remaining: readonly string[]
    readonly admitted: readonly JsonValue[]
    readonly settled: boolean
    readonly view: ClaimWireState
  }) | null
}

const targetSchema = z.enum(['next-turn', 'next-step'])
const messageSchema = z.object({
  id: z.string().min(1), role: z.literal('user'),
  source: z.object({ kind: z.string().min(1) }).catchall(z.json()),
  content: z.array(z.json()),
}).catchall(z.json())
const inputSchema = z.object({ target: targetSchema, message: messageSchema }).strict()
const intentSchema = z.object({
  target: targetSchema, turn: z.number().int().positive(), step: z.number().int().positive(), inputs: z.array(inputSchema).min(1),
}).strict()
const settlementSchema = z.object({
  intentSeq: z.number().int().nonnegative(), outcome: z.enum(['entered', 'rejected', 'empty']), messages: z.array(messageSchema),
}).strict()
const viewSchema = z.object({
  intentSeq: z.number().int().nonnegative().transform(SessionSeq), target: targetSchema,
  turn: z.number(), step: z.number(), inputs: z.array(z.object({ target: targetSchema, message: z.json() })),
  phase: z.enum(['entered', 'unsettled', 'rejected', 'empty']),
})
const schema = z.object({
  turn: z.number().int().nonnegative(), step: z.number().int().nonnegative(),
  admission: z.object({ messageId: z.string(), confirmed: z.boolean() }).nullable(),
  lastDisposition: viewSchema.nullable(),
  queue: z.object({ 'next-turn': z.array(messageSchema), 'next-step': z.array(messageSchema) }),
  claim: z.object({
    intentSeq: z.number().int().nonnegative().transform(SessionSeq),
    target: targetSchema, turn: z.number().int().positive(), step: z.number().int().positive(),
    inputs: z.array(z.object({ target: targetSchema, message: messageSchema })).min(1),
    remaining: z.array(z.string()), admitted: z.array(messageSchema), settled: z.boolean(), view: viewSchema,
  }).nullable(),
}).superRefine((state, ctx) => {
  const pending = new Map<string, { target: InboxTarget; message: JsonValue }>()
  for (const target of ['next-step', 'next-turn'] as const) {
    for (const message of state.queue[target]) {
      const id = message.id
      if (pending.has(id)) ctx.addIssue({ code: 'custom', message: 'duplicate pending identity' })
      pending.set(id, { target, message })
    }
  }
  const claim = state.claim
  if (state.lastDisposition !== null
    && (claim !== null || (state.lastDisposition.phase !== 'empty' && state.lastDisposition.phase !== 'rejected'))) {
    ctx.addIssue({ code: 'custom', message: 'invalid claim disposition checkpoint' })
  }
  if (claim === null) return
  const ids = new Set<string>()
  for (const input of claim.inputs) {
    if (ids.has(input.message.id)) ctx.addIssue({ code: 'custom', message: 'duplicate claim identity' })
    ids.add(input.message.id)
    const queued = pending.get(input.message.id)
    const expectedPending = claim.remaining.includes(input.message.id)
    if (expectedPending !== (queued !== undefined) || (queued !== undefined && !isDeepStrictEqual(queued, input))) {
      ctx.addIssue({ code: 'custom', message: 'claim and pending input disagree' })
    }
  }
  if (new Set(claim.remaining).size !== claim.remaining.length || claim.remaining.some(id => !ids.has(id))
    || (claim.settled && claim.remaining.length !== 0) || claim.turn !== state.turn
    || (state.step !== claim.step && state.step + 1 !== claim.step)
    || !isDeepStrictEqual(claim.view, { intentSeq: claim.intentSeq, target: claim.target, turn: claim.turn, step: claim.step, inputs: claim.inputs, phase: claim.settled ? 'entered' : 'unsettled' })) {
    ctx.addIssue({ code: 'custom', message: 'invalid claim checkpoint' })
  }
})

/** Fold the claim and its pending identities; an unresolved claim is never replayed. */
export const claimProjectionDefinition = {
  key: 'agentClaim',
  stateVersion: 1,
  stateSchema: schema,
  init: (): ClaimProjection => ({
    queue: { 'next-turn': [], 'next-step': [] }, turn: 0, step: 0, admission: null, claim: null, lastDisposition: null,
  }),
  apply(state: ClaimProjection, event): ClaimProjection {
    switch (event.type) {
      case 'turn/start':
        if (state.claim !== null) throw new Error('cannot start a turn with an unsettled claim')
        return { ...state, turn: event.data.turn, step: 0 }
      case 'step/start': return { ...state, step: event.data.step }
      case 'agent/admission/opened': return { ...state, admission: { messageId: event.data.messageId, confirmed: false } }
      case 'agent/admission/confirmed': return { ...state, admission: { messageId: event.data.messageId, confirmed: true } }
      case 'agent/claim/intent': {
        const intent = intentSchema.parse(event.data)
        if (state.claim !== null || event.data.turn !== state.turn || event.data.step !== state.step + 1) throw new Error('invalid overlapping claim intent')
        const reserved = event.data.target === 'next-turn' && state.admission?.confirmed
          ? state.queue['next-turn'].find(message => messageSchema.parse(message).id === state.admission?.messageId) : undefined
        if (event.data.target === 'next-turn' && state.admission?.confirmed && reserved === undefined) {
          throw new Error('confirmed admission input is missing')
        }
        const expected = reserved === undefined ? [
          ...state.queue['next-step'].map(message => ({ target: 'next-step', message })),
          ...(event.data.target === 'next-turn' && state.queue['next-turn'][0] !== undefined
            ? [{ target: 'next-turn', message: state.queue['next-turn'][0] }] : []),
        ] : [{ target: 'next-turn', message: reserved }]
        if (!isDeepStrictEqual(expected, intent.inputs)) throw new Error('claim intent does not match ordered batch')
        const ids = new Set(intent.inputs.map(input => input.message.id))
        if (ids.size !== intent.inputs.length) throw new Error('claim intent has duplicate identities')
        const view: ClaimWireState = { ...intent, intentSeq: event.seq, phase: 'unsettled' }
        return {
          ...state, lastDisposition: null,
          claim: { ...intent, intentSeq: event.seq, remaining: [...ids], admitted: [], settled: false, view },
        }
      }
      case 'agent/inbox/spliced': {
        const { target, start, inserted } = event.data
        const list = state.queue[target]
        const count = event.data.removedCount ?? 0
        if (!Number.isSafeInteger(start) || start < 0 || start > list.length || !Number.isSafeInteger(count) || count < 0 || start + count > list.length) throw new Error('invalid claim inbox splice')
        const removed = list.slice(start, start + count)
        let claim = state.claim
        if (claim !== null) {
          const active = claim
          const claimed = removed.filter(item => active.remaining.includes(messageSchema.parse(item).id))
          if (claimed.length > 0 && (event.data.outcome !== undefined || inserted.length !== 0
            || claimed.length !== removed.length
            || claimed.some((item, index) => messageSchema.parse(item).id !== active.remaining[index]))) {
            throw new Error('protected claim input was replaced, cancelled, or claimed out of order')
          }
          if (inserted.some(item => active.inputs.some(input => messageSchema.parse(input.message).id === item.id))) {
            throw new Error('protected claim input was duplicated')
          }
          if (claimed.length > 0) {
            claim = { ...active, remaining: active.remaining.filter(id => !claimed.some(item => messageSchema.parse(item).id === id)) }
          }
        }
        const next = list.toSpliced(start, count, ...inserted.map(message => messageSchema.parse(message)))
        return { ...state, queue: { ...state.queue, [target]: next }, claim }
      }
      case 'user/message': {
        const admission = state.admission?.confirmed && state.admission.messageId === event.data.id ? null : state.admission
        if (state.claim === null) return admission === state.admission ? state : { ...state, admission }
        return { ...state, admission, claim: { ...state.claim, admitted: [...state.claim.admitted, messageSchema.parse(event.data)] } }
      }
      case 'agent/claim/settled': {
        const settlement = settlementSchema.parse(event.data)
        const claim = state.claim
        if (claim === null || claim.settled || claim.intentSeq !== event.data.intentSeq || claim.remaining.length !== 0
          || (event.data.outcome !== 'entered' && event.data.messages.length !== 0)
          || settlement.messages.length > claim.admitted.length
          || !isDeepStrictEqual(
            settlement.messages.length === 0 ? [] : claim.admitted.slice(-settlement.messages.length), settlement.messages,
          )) {
          throw new Error('invalid claim settlement')
        }
        if (event.data.outcome !== 'entered') {
          return { ...state, claim: null, lastDisposition: { ...claim.view, phase: event.data.outcome } }
        }
        return { ...state, claim: { ...claim, settled: true, view: { ...claim.view, phase: 'entered' } } }
      }
      case 'assistant/message':
        return state.claim?.settled && event.data.turn === state.claim.turn
          && event.data.step === state.claim.step && !event.data.interrupted
          ? { ...state, claim: null } : state
      case 'session/end-seed':
        if (event.data.inherited === true && state.claim !== null) throw new Error('cannot fork an unsettled claim')
        return state
      default: return state
    }
  },
  wire: {
    viewSchema: viewSchema.nullable(),
    view: (state: ClaimProjection) => state.claim?.view ?? state.lastDisposition,
    summary: false,
  },
} satisfies ProjectionDefinition<'agentClaim', ClaimProjection>

export type { ClaimProjection }
