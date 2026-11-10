/** Bounded, deterministic RG recovery without replaying role activations. */
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { brandNumber, brandString } from '@deepseek-ai/dsh-brand'
import type { AdmissionOwner } from '@deepseek-ai/dsh-agent'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { sessionStateSchema } from './schemas.ts'
import { settleRun } from './task.ts'
import type { RgRunId, RgSessionState, RgTaskId } from './types.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Complete RG policy, ownership, and latest-task state after one accepted change. */
    'review-gated/state': { readonly version: 1; readonly state: RgSessionState | null }
    /** Prepared task bound to an open exclusive admission. */
    'review-gated/task-prepared': { readonly version: 1; readonly messageId: MessageId; readonly input: string; readonly state: RgSessionState }
    /** Direct task prepared for the matching protected claim. */
    'review-gated/direct-task-prepared': { readonly version: 1; readonly intentSeq: SessionSeq; readonly messageId: MessageId; readonly state: RgSessionState }
    /** Candidate result awaiting the Session durability barrier. */
    'review-gated/result-prepared': { readonly version: 1; readonly taskId: RgTaskId; readonly runId: RgRunId; readonly childId: SessionId; readonly scopeMatches: boolean; readonly state: RgSessionState }
    /** Confirms that the matching candidate passed the Session durability barrier. */
    'review-gated/result-confirmed': { readonly version: 1; readonly taskId: RgTaskId; readonly runId: RgRunId; readonly childId: SessionId }
  }
}

/** Attribution for exclusive RG task admissions. */
export const RG_TASK_ADMISSION_OWNER = brandString<AdmissionOwner>('review-gated/task')

/** Pending task input remains unusable until matching durable admission or historical message evidence. */
const LEGACY_TASK_SAVE_UNCERTAIN = 'RG_TASK_SAVE_UNCERTAIN: the task or its message may not be saved reliably. Inspect the Session before continuing.'
/** Diagnostic for task input whose persisted delivery cannot be established. */
export const TASK_SAVE_UNCERTAIN = `${LEGACY_TASK_SAVE_UNCERTAIN} Inspect retained work, then open a new RG Session if the outcome cannot be established.`

function isUncertainTaskSave(diagnostic: string | null): boolean {
  return diagnostic === TASK_SAVE_UNCERTAIN || diagnostic === LEGACY_TASK_SAVE_UNCERTAIN
}

/** Private replay bookkeeping; a null public view does not erase request history. */
export interface RgProjectionState {
  readonly value: RgSessionState | null
  readonly hasRequested: boolean
  readonly failure: string | null
  readonly taskAdmission: { readonly messageId: MessageId; readonly taskId: RgTaskId | null; readonly index: number | null } | null
  readonly taskInputText: string | null
  readonly directClaim: {
    readonly intentSeq: SessionSeq
    readonly messageId: MessageId
    readonly objective: string | null
    readonly limit: number
    readonly admitted: 0 | 1 | 2
    readonly phase: 'intent' | 'prepared' | 'settled'
  } | null
  readonly pending: {
    readonly taskId: RgTaskId
    readonly runId: RgRunId
    readonly childId: SessionId
    readonly scopeMatches: boolean
    readonly state: RgSessionState
  } | null
}

/** Old workspace fingerprints cannot authenticate a current review result. */
function normalizeLegacyState(value: RgSessionState | null): RgSessionState | null {
  if (value === null) return null
  if (value.diagnostic?.startsWith(LEGACY_TASK_SAVE_UNCERTAIN) && !value.diagnostic.startsWith(TASK_SAVE_UNCERTAIN)) {
    value = { ...value, diagnostic: value.diagnostic.replace(LEGACY_TASK_SAVE_UNCERTAIN, TASK_SAVE_UNCERTAIN) }
  }
  const task = value.task
  const scope = task?.lastReview?.scope
  if (task?.reviewStatus !== 'reported-pass' || scope === null || scope === undefined) return value
  // Only a complete declared-scope plus whole-tree identity can authenticate a
  // current pass; older fingerprint generations and trees that could not be
  // hashed within the budgets stay stale rather than passing on a partial view.
  // Only the current declared-scope generation authenticates a pass. The tree
  // identity is an additional signal, not a requirement: a workspace exceeding
  // the inspection budget must not silently invalidate every earlier review.
  return /^v3:[a-f0-9]{64}$/.test(scope.fingerprint ?? '') ? value : { ...value, task: { ...task, reviewStatus: 'stale' } }
}

const identitySchema = z.object({ version: z.literal(1), taskId: z.string().min(1).transform(brandString<RgTaskId>),
  runId: z.string().min(1).transform(brandString<RgRunId>), childId: z.string().min(1).transform(SessionId) })
const confirmedSchema = identitySchema.strict()
const preparedSchema = identitySchema.extend({ scopeMatches: z.boolean(), state: sessionStateSchema }).strict()
const pendingSchema = identitySchema.omit({ version: true }).extend({ scopeMatches: z.boolean(), state: sessionStateSchema }).strict()
const taskAdmissionSchema = z.object({ messageId: z.string().min(1).transform(brandString<MessageId>),
  taskId: z.string().min(1).transform(brandString<RgTaskId>).nullable(), index: z.number().int().nonnegative().nullable() }).strict()
const taskPreparedSchema = z.object({ version: z.literal(1), messageId: z.string().min(1).transform(brandString<MessageId>),
  input: z.string(), state: sessionStateSchema }).strict()

/** Admit a validated event position; the schema already proved a non-negative safe integer. */
const claimSeq = (value: number): SessionSeq => brandNumber<SessionSeq>(value)

const directClaimSchema = z.object({ intentSeq: z.number().int().nonnegative().transform(claimSeq),
  messageId: z.string().min(1).transform(brandString<MessageId>), objective: z.string().min(1).nullable(),
  limit: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  admitted: z.union([z.literal(0), z.literal(1), z.literal(2)]), phase: z.enum(['intent', 'prepared', 'settled']) }).strict()
const directPreparedSchema = z.object({ version: z.literal(1), intentSeq: z.number().int().nonnegative().transform(claimSeq),
  messageId: z.string().min(1).transform(brandString<MessageId>), state: sessionStateSchema }).strict()
const claimMessageSchema = z.object({ id: z.string().min(1).transform(brandString<MessageId>), role: z.literal('user'),
  source: z.object({ kind: z.string().min(1) }).loose(),
  content: z.array(z.json()) }).loose()
const claimIntentSchema = z.object({ target: z.enum(['next-turn', 'next-step']), turn: z.number().int().positive(),
  step: z.number().int().positive(), inputs: z.array(z.object({ target: z.enum(['next-turn', 'next-step']), message: claimMessageSchema }).strict()).min(1) }).strict()
const claimSettlementSchema = z.object({ intentSeq: z.number().int().nonnegative().transform(claimSeq),
  outcome: z.enum(['entered', 'rejected', 'empty']), messages: z.array(claimMessageSchema) }).strict()

/** Trim joined text without retaining an oversized objective or trailing whitespace. */
function boundedObjective(content: z.output<typeof claimMessageSchema>['content'], limit: number): string | null {
  let result = ''
  let whitespace = ''
  let overflow = false
  let first = true
  for (const block of content) {
    if (block === null || typeof block !== 'object' || Array.isArray(block)) return null
    if (block.type !== 'text') continue
    if (typeof block.text !== 'string') return null
    const pieces = first ? [block.text] : ['\n', block.text]
    first = false
    for (const text of pieces) for (const char of text) {
      if (char.trim() === '') {
        if (result !== '' && !overflow) {
          if (result.length + whitespace.length + char.length > limit) overflow = true
          else whitespace += char
        }
      } else {
        if (overflow || result.length + whitespace.length + char.length > limit) return null
        result += whitespace + char
        whitespace = ''
      }
    }
  }
  return result
}

function validCandidate(current: RgSessionState | null, candidateData: z.output<typeof pendingSchema>): boolean {
  const { taskId, runId, childId, scopeMatches, state: candidate } = candidateData
  const active = current?.task?.active
  const last = active?.role === 'worker' ? candidate.task?.lastWorker : candidate.task?.lastReview
  if (current?.role !== 'main' || current.policy === null || current.task?.id !== taskId
    || active?.id !== runId || active.childId !== childId || active.status !== 'saving'
    || last?.id !== runId || last.childId !== childId || last.role !== active.role
    || last.status !== 'completed' || last.report?.kind !== active.role) return false
  const expected = sessionStateSchema.parse({ ...current, task: settleRun(current.task, runId,
    { status: last.status, report: last.report, diagnostic: last.diagnostic, scope: last.scope }, scopeMatches) })
  return JSON.stringify(expected) === JSON.stringify(candidate)
}

/** Apply one committed event without performing I/O or starting a child.
 * @param state - checkpoint or prior fold value.
 * @param event - committed Session event.
 * @returns the same reference for unrelated events.
 */
export function foldRgState(state: RgProjectionState, event: SessionEvent): RgProjectionState {
  if (event.type === 'request/header') return state.hasRequested ? state : { ...state, hasRequested: true }
  if (state.failure !== null) return state
  if (event.type === 'session/end-seed' || (event.type === 'turn/end' && event.data.reason.kind === 'aborted')) {
    if (event.type === 'session/end-seed' && event.data.inherited === true && state.directClaim?.phase === 'prepared') {
      return { ...state, failure: 'RG_STATE_INVALID: seeded task has no durable input.' }
    }
    if (event.type === 'session/end-seed' && event.data.inherited === true
      && (state.taskAdmission !== null || state.value?.diagnostic?.startsWith('RG_TASK_SAVE_UNCERTAIN:'))) {
      return { ...state, pending: null, failure: 'RG_STATE_INVALID: seeded task has no durable input.' }
    }
    return state.pending === null ? state : { ...state, pending: null }
  }
  const value = state.value
  if (event.type === 'user/message' && state.directClaim?.phase !== 'prepared' && state.taskAdmission === null && value?.role === 'main' && value.task !== null
    && isUncertainTaskSave(value.diagnostic)) {
    const message = event.data
    if (message.id === value.task.originMessageId && z.literal('user').safeParse(message.role).success && message.source.kind === 'user'
      && message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n').trim() === value.task.objective) {
      return { ...state, value: { ...value, diagnostic: null } }
    }
  }
  const invalid = () => ({ ...state, value: null, pending: null, taskAdmission: null, taskInputText: null, directClaim: null, failure: `RG_STATE_INVALID: event ${event.seq}` })
  const direct = state.directClaim
  if (event.type === 'agent/claim/intent') {
    if (direct !== null && direct.phase !== 'settled') return invalid()
    if (value?.role !== 'main' || value.policy === null || value.task !== null || value.diagnostic !== null
      || state.taskAdmission !== null || state.pending !== null) {
      return direct?.phase === 'settled' ? { ...state, directClaim: null } : state
    }
    const parsed = claimIntentSchema.safeParse(event.data)
    if (!parsed.success) return invalid()
    for (const input of parsed.data.inputs) {
      const message = input.message
      if (message.source.kind !== 'user') continue
      const objective = boundedObjective(message.content, value.policy.maxHandoffChars)
      if (objective === '') continue
      return { ...state, directClaim: { intentSeq: event.seq, messageId: message.id, objective, limit: value.policy.maxHandoffChars, admitted: 0, phase: 'intent' } }
    }
    return direct === null ? state : { ...state, directClaim: null }
  }
  if (event.type === 'review-gated/direct-task-prepared') {
    const parsed = directPreparedSchema.safeParse(event.data)
    if (!parsed.success || direct === null || direct.phase !== 'intent' || direct.objective === null
      || direct.intentSeq !== parsed.data.intentSeq || direct.messageId !== parsed.data.messageId
      || value?.role !== 'main' || value.policy === null || value.task !== null || value.diagnostic !== null
      || state.pending !== null || state.taskAdmission !== null || direct.objective.length > value.policy.maxHandoffChars) return invalid()
    const candidate = parsed.data.state
    const task = candidate.task
    if (!isDeepStrictEqual(candidate, event.data.state) || task === null || task.originMessageId !== direct.messageId
      || task.objective !== direct.objective
      || task.workRevision !== 0 || task.workerAttempts !== 0 || task.reviewAttempts !== 0
      || task.active !== null || task.lastWorker !== null || task.lastReview !== null || task.reviewStatus !== 'not-reviewed'
      || candidate.diagnostic !== TASK_SAVE_UNCERTAIN
      || !isDeepStrictEqual({ ...value, task, diagnostic: TASK_SAVE_UNCERTAIN }, candidate)) return invalid()
    return { ...state, value: candidate, directClaim: { ...direct, phase: 'prepared' } }
  }
  if (event.type === 'user/message' && direct !== null) {
    const parsed = claimMessageSchema.safeParse(event.data)
    if (!parsed.success) return invalid()
    if (parsed.data.id !== direct.messageId) return state
    if (direct.phase === 'settled') return invalid()
    const admitted = parsed.data.source.kind === 'user' && direct.admitted === 0 ? 1 : 2
    return { ...state, directClaim: { ...direct, admitted } }
  }
  if (event.type === 'agent/claim/settled' && direct !== null) {
    if (direct.phase === 'settled') return event.data.intentSeq === direct.intentSeq ? invalid() : state
    if (direct.phase === 'intent') return event.data.intentSeq === direct.intentSeq ? { ...state, directClaim: null } : state
    const parsed = claimSettlementSchema.safeParse(event.data)
    if (!parsed.success) return invalid()
    const matching = parsed.data.messages.filter(message => message.id === direct.messageId)
    if (parsed.data.intentSeq !== direct.intentSeq || parsed.data.outcome !== 'entered' || direct.admitted !== 1
      || matching.length !== 1 || matching[0]?.role !== 'user' || matching[0].source.kind !== 'user'
      || value?.task?.originMessageId !== direct.messageId || value.diagnostic !== TASK_SAVE_UNCERTAIN) return invalid()
    return { ...state, value: { ...value, diagnostic: null }, directClaim: { ...direct, phase: 'settled' } }
  }
  if (direct?.phase === 'prepared' && (event.type === 'review-gated/state' || event.type === 'agent/admission/opened'
    || event.type === 'review-gated/task-prepared' || event.type === 'review-gated/result-prepared'
    || event.type === 'review-gated/result-confirmed')) return invalid()
  if (event.type === 'agent/admission/opened' && event.data.owner === RG_TASK_ADMISSION_OWNER) {
    if (state.taskAdmission !== null || state.pending !== null || value?.role !== 'main' || value.policy === null
      || value.diagnostic !== null || value.task?.active != null) return invalid()
    return { ...state, value: { ...value, diagnostic: TASK_SAVE_UNCERTAIN },
      taskAdmission: { messageId: event.data.messageId, taskId: null, index: null } }
  }
  if (event.type === 'review-gated/task-prepared') {
    const parsed = taskPreparedSchema.safeParse(event.data)
    const admission = state.taskAdmission
    if (!parsed.success || admission === null || admission.taskId !== null || value?.role !== 'main'
      || parsed.data.messageId !== admission.messageId) return invalid()
    const candidate = parsed.data.state
    const task = candidate.task
    if (task === null || task.originMessageId !== admission.messageId || task.objective.trim() !== task.objective
      || task.objective === '' || parsed.data.input.trim() !== task.objective || task.workRevision !== 0 || task.workerAttempts !== 0 || task.reviewAttempts !== 0
      || task.active !== null || task.lastWorker !== null || task.lastReview !== null || task.reviewStatus !== 'not-reviewed'
      || candidate.diagnostic !== TASK_SAVE_UNCERTAIN
      || JSON.stringify({ ...value, task }) !== JSON.stringify(candidate)) return invalid()
    return { ...state, value: candidate, taskInputText: parsed.data.input, taskAdmission: { ...admission, taskId: task.id } }
  }
  if (event.type === 'agent/inbox/spliced' && state.taskAdmission !== null && event.data.target === 'next-turn') {
    const admission = state.taskAdmission
    const { start, inserted } = event.data
    const removed = event.data.removedCount ?? 0
    const matching = inserted.filter(message => message.id === admission.messageId)
    const message = matching[0]
    if (message !== undefined) {
      if (matching.length !== 1 || admission.index !== null || admission.taskId === null
        || !z.literal('user').safeParse(message.role).success || message.source.kind !== 'user'
        || message.content.length !== 1 || message.content[0]?.type !== 'text' || message.content[0].text !== state.taskInputText) return invalid()
      return { ...state, taskAdmission: { ...admission, index: start + inserted.indexOf(message) } }
    }
    if (admission.index === null) return state
    if (admission.index >= start && admission.index < start + removed) return invalid()
    const index = admission.index < start ? admission.index : admission.index - removed + inserted.length
    return index === admission.index ? state : { ...state, taskAdmission: { ...admission, index } }
  }
  if (event.type === 'agent/admission/confirmed' && event.data.owner === RG_TASK_ADMISSION_OWNER) {
    const admission = state.taskAdmission
    if (admission === null || admission.taskId === null || admission.index === null || admission.messageId !== event.data.messageId
      || value?.task?.id !== admission.taskId || value.task.originMessageId !== admission.messageId
      || value.diagnostic !== TASK_SAVE_UNCERTAIN) return invalid()
    return { ...state, value: { ...value, diagnostic: null }, taskAdmission: null }
  }
  if (event.type === 'review-gated/state') {
    if (state.taskAdmission !== null) return invalid()
    const parsed = z.object({ version: z.literal(1), state: sessionStateSchema.nullable() }).strict().safeParse(event.data)
    if (!parsed.success) return invalid()
    let next = normalizeLegacyState(parsed.data.state)
    if (value?.diagnostic?.startsWith('RG_TASK_SAVE_UNCERTAIN:') && value.task !== null) {
      if (next?.task?.id !== value.task.id || next.task.originMessageId !== value.task.originMessageId
        || next.task.objective !== value.task.objective) return invalid()
      if (next.diagnostic === null || (isUncertainTaskSave(next.diagnostic) && !isUncertainTaskSave(value.diagnostic))) {
        next = { ...next, diagnostic: value.diagnostic }
      } else if (!next.diagnostic.startsWith('RG_TASK_SAVE_UNCERTAIN:')) return invalid()
    }
    return { ...state, value: next, pending: null, taskInputText: next?.task?.id === value?.task?.id ? state.taskInputText : null }
  }
  if (event.type === 'review-gated/result-prepared') {
    const parsed = preparedSchema.safeParse(event.data)
    if (!parsed.success || state.pending !== null) return invalid()
    const { taskId, runId, childId, scopeMatches, state: candidate } = parsed.data
    const pending = { taskId, runId, childId, scopeMatches, state: candidate }
    if (!validCandidate(state.value, pending)) return invalid()
    return { ...state, pending }
  }
  if (event.type === 'review-gated/result-confirmed') {
    const parsed = confirmedSchema.safeParse(event.data)
    const pending = state.pending
    if (!parsed.success || pending === null || parsed.data.taskId !== pending.taskId
      || parsed.data.runId !== pending.runId || parsed.data.childId !== pending.childId) return invalid()
    return { ...state, value: normalizeLegacyState(pending.state), pending: null }
  }
  return state
}

/** One owner for RG Session policy and current task; historical runs stay in the log. */
export const rgProjectionDefinition = {
  key: 'reviewGated', stateVersion: 6,
  stateSchema: z.object({ value: sessionStateSchema.nullable(), hasRequested: z.boolean(), failure: z.string().nullable(),
    pending: pendingSchema.nullable(), taskAdmission: taskAdmissionSchema.nullable(), taskInputText: z.string().nullable(),
    directClaim: directClaimSchema.nullable() }).strict()
    .superRefine((state, context) => {
      const direct = state.directClaim
      if (direct !== null && ((direct.objective !== null
        && (direct.objective.trim() !== direct.objective || direct.objective.length > direct.limit))
        || (direct.phase !== 'intent' && direct.objective === null)
        || (direct.phase === 'settled' && direct.admitted !== 1)
        || (direct.phase === 'prepared' && (state.value?.role !== 'main' || state.value.policy === null
          || state.value.diagnostic !== TASK_SAVE_UNCERTAIN || state.value.task?.originMessageId !== direct.messageId
          || state.value.task.objective !== direct.objective || direct.objective.length > state.value.policy.maxHandoffChars
          || state.value.task.workRevision !== 0 || state.value.task.workerAttempts !== 0 || state.value.task.reviewAttempts !== 0
          || state.value.task.active !== null || state.value.task.lastWorker !== null || state.value.task.lastReview !== null
          || state.value.task.reviewStatus !== 'not-reviewed' || state.taskAdmission !== null || state.pending !== null)))) {
        context.addIssue({ code: 'custom', message: 'Invalid direct claim checkpoint.' })
      }
      if (state.pending !== null && !validCandidate(state.value, state.pending)) context.addIssue({ code: 'custom', message: 'Invalid prepared RG result.' })
      if (state.taskInputText !== null && (state.value?.task == null || state.taskInputText.trim() !== state.value.task.objective)) {
        context.addIssue({ code: 'custom', message: 'Invalid prepared RG input.' })
      }
      if (state.taskAdmission !== null && (state.value?.role !== 'main' || state.value.diagnostic !== TASK_SAVE_UNCERTAIN
        || (state.taskAdmission.index !== null && state.taskAdmission.taskId === null)
        || (state.taskAdmission.taskId !== null && (state.taskInputText === null || state.value.task?.id !== state.taskAdmission.taskId
          || state.value.task.originMessageId !== state.taskAdmission.messageId)))) {
        context.addIssue({ code: 'custom', message: 'Invalid prepared RG task.' })
      }
    })
    .transform(state => ({ ...state, value: normalizeLegacyState(state.value) })),
  init: () => ({ value: null, hasRequested: false, failure: null, pending: null,
    taskAdmission: null, taskInputText: null, directClaim: null }),
  apply: foldRgState,
  wire: { viewSchema: sessionStateSchema.nullable(), view: (state: RgProjectionState) => state.value },
} satisfies ProjectionDefinition<'reviewGated', RgProjectionState>
