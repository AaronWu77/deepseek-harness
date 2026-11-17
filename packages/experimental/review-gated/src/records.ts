/** Ignorable RG records and validation of claim-owned task admission. */
import { z } from 'zod'
import { brandNumber, brandString } from '@deepseek-ai/dsh-brand'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionSeq } from '@deepseek-ai/dsh-session'
import type { RgGitState } from './git-types.ts'
import { sessionStateSchema } from './schemas.ts'
import type { RgRunId, RgSessionState, RgTaskId } from './types.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    /** Complete RG policy, ownership, and latest-task state after one accepted change. */
    'plugin:review-gated/state': { readonly version: 1; readonly state: RgSessionState | null }
    /** Prepared task bound to the intent that carried its exact human input. */
    'plugin:review-gated/task-prepared': { readonly version: 1; readonly intentSeq: SessionSeq; readonly messageId: MessageId; readonly input: string; readonly state: RgSessionState }
    /** Direct task prepared for the matching RG claim. */
    'plugin:review-gated/direct-task-prepared': { readonly version: 1; readonly intentSeq: SessionSeq; readonly messageId: MessageId; readonly state: RgSessionState }
    /** Git delivery state, including an explicit clear of a prior grant. */
    'plugin:review-gated/git-state': { readonly version: 1; readonly state: RgGitState | null }
    /** Candidate result awaiting the Session durability barrier. */
    'plugin:review-gated/result-prepared': { readonly version: 1; readonly taskId: RgTaskId; readonly runId: RgRunId; readonly childId: SessionId; readonly scopeMatches: boolean; readonly state: RgSessionState }
    /** Confirms that the matching candidate passed the Session durability barrier. */
    'plugin:review-gated/result-confirmed': { readonly version: 1; readonly taskId: RgTaskId; readonly runId: RgRunId; readonly childId: SessionId }
    /** Post-claim pre-step batch; optional targets are diagnostic, never evidence of reservation. */
    'plugin:review-gated/claim': { readonly version: 1; readonly phase: 'intent'; readonly target?: 'next-turn' | 'next-step'; readonly turn: number; readonly step: number; readonly inputs: readonly { readonly target?: 'next-turn' | 'next-step'; readonly message: unknown }[] }
    /** Disposition of the exact intent; absence of settlement remains uncertain. */
    'plugin:review-gated/claim-settled': { readonly version: 1; readonly phase: 'settled'; readonly intentSeq: SessionSeq; readonly outcome: 'entered' | 'rejected' | 'empty'; readonly messages: readonly unknown[] }
  }
}

/** Full RG state record, including explicit removal. */
export const stateRecordSchema = z.object({ version: z.literal(1), state: sessionStateSchema.nullable() }).strict()
/** Prepared task and its exact intent and human input. */
export const taskPreparedRecordSchema = z.object({ version: z.literal(1),
  intentSeq: z.number().int().nonnegative().transform(brandNumber<SessionSeq>),
  messageId: z.string().min(1).transform(brandString<MessageId>), input: z.string(), state: sessionStateSchema }).strict()
/** Prepared direct task bound to the authoritative claim sequence. */
export const directPreparedRecordSchema = z.object({ version: z.literal(1),
  intentSeq: z.number().int().nonnegative().transform(brandNumber<SessionSeq>),
  messageId: z.string().min(1).transform(brandString<MessageId>), state: sessionStateSchema }).strict()
/** Independent confirmation identifies, but does not duplicate, the prepared result. */
export const resultConfirmedRecordSchema = z.object({ version: z.literal(1), taskId: z.string().min(1).transform(brandString<RgTaskId>),
  runId: z.string().min(1).transform(brandString<RgRunId>), childId: z.string().min(1).transform(SessionId) }).strict()
/** Candidate result awaiting durable confirmation. */
export const resultPreparedRecordSchema = resultConfirmedRecordSchema
  .extend({ scopeMatches: z.boolean(), state: sessionStateSchema }).strict()
/** Human or harness input; arbitrary content is validated before text extraction. */
export const claimMessageSchema = z.object({ id: z.string().min(1).transform(brandString<MessageId>), role: z.literal('user'),
  source: z.object({ kind: z.string().min(1) }).loose(), content: z.array(z.json()) }).loose()
/** Intent identity and original ordered inputs, without inferred inbox targets. */
export const claimRecordSchema = z.object({ version: z.literal(1), phase: z.literal('intent'),
  target: z.enum(['next-turn', 'next-step']).exactOptional(), turn: z.number().int().positive(), step: z.number().int().positive(),
  inputs: z.array(z.object({ target: z.enum(['next-turn', 'next-step']).exactOptional(), message: claimMessageSchema }).strict()).min(1),
}).strict()
/** Settlement names the committed intent and the complete admitted batch. */
export const claimSettledRecordSchema = z.object({ version: z.literal(1), phase: z.literal('settled'),
  intentSeq: z.number().int().nonnegative().transform(brandNumber<SessionSeq>),
  outcome: z.enum(['entered', 'rejected', 'empty']), messages: z.array(claimMessageSchema),
}).strict()
