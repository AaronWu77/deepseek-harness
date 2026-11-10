/** Recover the outstanding exclusive first-claim reservation. */
import type { AdmissionOwner } from '@deepseek-ai/dsh-agent'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { brandString } from '@deepseek-ai/dsh-brand'
import { z } from 'zod'

/** Projected outstanding reservation; index tracks its location in next-turn. */
export interface AdmissionProjection {
  readonly owner: AdmissionOwner
  readonly messageId: MessageId
  readonly confirmed: boolean
  readonly index: number | null
}

const admissionSchema: z.ZodType<AdmissionProjection | null> = z.object({
  owner: z.string().transform(brandString<AdmissionOwner>),
  messageId: z.string().transform(brandString<MessageId>),
  confirmed: z.boolean(),
  index: z.number().int().nonnegative().nullable(),
}).nullable()

/** Recover a held reservation without retaining the pending-message history. */
export const admissionProjectionDefinition = {
  key: 'agentAdmission',
  stateVersion: 1,
  stateSchema: admissionSchema,
  init: (): AdmissionProjection | null => null,
  apply(state, event) {
    switch (event.type) {
      case 'agent/admission/opened':
        if (state !== null) throw new Error('overlapping exclusive admissions')
        return { ...event.data, confirmed: false, index: null }
      case 'agent/admission/confirmed':
        if (state === null || state.confirmed || state.index === null
          || state.owner !== event.data.owner || state.messageId !== event.data.messageId) {
          throw new Error('invalid exclusive admission confirmation')
        }
        return { ...state, confirmed: true }
      case 'user/message':
        if (state?.confirmed && state.index === null && event.data.id === state.messageId) return null
        return state
      case 'session/end-seed':
        if (event.data.inherited === true && state !== null) {
          throw new Error('cannot fork an outstanding exclusive admission')
        }
        return state
      case 'agent/inbox/spliced': {
        if (state === null || event.data.target !== 'next-turn') return state
        const { start, inserted } = event.data
        const removed = event.data.removedCount ?? 0
        const insertedAt = inserted.findIndex(message => message.id === state.messageId)
        if (state.index === null) {
          if (state.confirmed && insertedAt >= 0) throw new Error('claimed admission input was reinserted')
          return insertedAt < 0 ? state : { ...state, index: start + insertedAt }
        }
        if (state.index >= start && state.index < start + removed) {
          if (!state.confirmed) throw new Error('unconfirmed admission input was removed')
          if (removed !== 1 || inserted.length !== 0 || event.data.outcome !== undefined) {
            throw new Error('invalid exclusive admission claim')
          }
          return { ...state, index: null }
        }
        const index = state.index < start ? state.index : state.index - removed + inserted.length
        return index === state.index ? state : { ...state, index }
      }
      default:
        return state
    }
  },
} satisfies ProjectionDefinition<'agentAdmission', AdmissionProjection | null>
