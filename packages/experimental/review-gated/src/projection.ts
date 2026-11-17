/** Bounded, deterministic RG recovery without replaying role activations. */
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { brandNumber, brandString } from '@deepseek-ai/dsh-brand'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import { pluginRecordOf, type SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { sessionStateSchema } from './schemas.ts'
import { claimRecordSchema, claimMessageSchema, claimSettledRecordSchema, directPreparedRecordSchema,
  resultConfirmedRecordSchema, resultPreparedRecordSchema, stateRecordSchema, taskPreparedRecordSchema } from './records.ts'
import { settleRun } from './task.ts'
import type { RgProjectionView, RgRunId, RgSessionState, RgTaskId, RgView } from './types.ts'
import type { SessionId } from '@deepseek-ai/dsh-session'

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
  /** Receipt established by an exact prepared task and its entered input batch. */
  readonly taskReceipt: 'none' | 'proven' | 'unproven'
  readonly hasRequested: boolean
  readonly failure: string | null
  readonly turn: number
  readonly step: number
  readonly claim: z.output<typeof claimStateSchema> | null
  /** An open human-claim batch that may become a task, not itself a pending save.
   * A non-null taskId identifies prepared task input; consumers also inspect diagnostic.
   */
  readonly taskAdmission: { readonly intentSeq: SessionSeq; readonly messageId: MessageId; readonly taskId: RgTaskId | null } | null
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

const pendingSchema = resultPreparedRecordSchema.omit({ version: true }).strict()
const taskAdmissionSchema = z.object({ intentSeq: z.number().int().nonnegative().transform(brandNumber<SessionSeq>),
  messageId: z.string().min(1).transform(brandString<MessageId>),
  taskId: z.string().min(1).transform(brandString<RgTaskId>).nullable() }).strict()
const claimStateSchema = claimRecordSchema.omit({ version: true, phase: true }).extend({
  intentSeq: z.number().int().nonnegative().transform(brandNumber<SessionSeq>),
  phase: z.enum(['intent', 'entered', 'rejected', 'empty']), started: z.boolean(), closed: z.boolean(),
  recorded: z.array(claimMessageSchema),
}).strict()

/** Admit a validated event position; the schema already proved a non-negative safe integer. */
const claimSeq = (value: number): SessionSeq => brandNumber<SessionSeq>(value)

const directClaimSchema = z.object({ intentSeq: z.number().int().nonnegative().transform(claimSeq),
  messageId: z.string().min(1).transform(brandString<MessageId>), objective: z.string().min(1).nullable(),
  limit: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  admitted: z.union([z.literal(0), z.literal(1), z.literal(2)]), phase: z.enum(['intent', 'prepared', 'settled']) }).strict()

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
  const record = pluginRecordOf(event)
  if (event.type === 'request/header') return state.hasRequested ? state : { ...state, hasRequested: true }
  if (state.failure !== null) return state
  const invalid = (): RgProjectionState => ({ ...state, value: null, taskReceipt: 'none', pending: null, taskAdmission: null, taskInputText: null, directClaim: null, claim: null,
    failure: `RG_STATE_INVALID: event ${record?.seq ?? event.seq}` })
  const claim = state.claim
  if (event.type === 'turn/start') return { ...state, turn: event.data.turn, step: 0 }
  if (event.type === 'step/start') {
    if (event.data.turn !== state.turn || event.data.step !== state.step + 1
      || (claim?.phase === 'intent' && (claim.started || claim.closed || claim.turn !== event.data.turn || claim.step !== event.data.step))) return invalid()
    return { ...state, step: event.data.step, claim: claim?.phase === 'intent' ? { ...claim, started: true } : claim }
  }
  if (event.type === 'step/end' || event.type === 'turn/end') {
    const pending = event.type === 'turn/end' && event.data.reason.kind === 'aborted' ? null : state.pending
    if ((claim === null || claim.closed) && pending === state.pending) return state
    return { ...state, pending, claim: claim === null || claim.closed ? claim : { ...claim, closed: true } }
  }
  if (event.type === 'assistant/message' && claim?.phase === 'entered' && !event.data.interrupted
    && event.data.turn === claim.turn && event.data.step === claim.step) return { ...state, claim: null }
  if (event.type === 'session/end-seed') {
    if (event.data.inherited && state.directClaim?.phase === 'prepared') {
      return { ...state, failure: 'RG_STATE_INVALID: seeded task has no durable input.' }
    }
    if (event.data.inherited
      && (state.taskAdmission?.taskId != null || state.value?.diagnostic?.startsWith('RG_TASK_SAVE_UNCERTAIN:'))) {
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
      return { ...state, value: { ...value, diagnostic: null }, taskReceipt: 'unproven' }
    }
  }
  const direct = state.directClaim
  if (record?.type === 'plugin:review-gated/claim') {
    const parsed = claimRecordSchema.safeParse(record.data)
    if (!parsed.success || claim?.phase === 'intent' || (direct !== null && direct.phase !== 'settled')
      || state.taskAdmission !== null || parsed.data.turn !== state.turn || parsed.data.step !== state.step + 1
      || new Set(parsed.data.inputs.map(input => input.message.id)).size !== parsed.data.inputs.length) return invalid()
    const { version: _version, phase: _phase, ...intent } = parsed.data
    const next: RgProjectionState = { ...state, directClaim: null,
      claim: { ...intent, intentSeq: record.seq, phase: 'intent', started: false, closed: false, recorded: [] } }
    if (value?.role !== 'main' || value.policy === null || value.diagnostic !== null
      || value.task?.active != null || state.pending !== null) return next
    for (const input of intent.inputs) {
      const message = input.message
      if (message.source.kind !== 'user') continue
      const objective = boundedObjective(message.content, value.policy.maxHandoffChars)
      if (objective === '') continue
      return { ...next, taskAdmission: { intentSeq: record.seq, messageId: message.id, taskId: null },
        directClaim: value.task !== null ? null : { intentSeq: record.seq, messageId: message.id, objective,
          limit: value.policy.maxHandoffChars, admitted: 0, phase: 'intent' } }
    }
    return next
  }
  if (event.type === 'user/message' && (claim?.phase === 'intent' || direct !== null)) {
    const parsed = claimMessageSchema.safeParse(event.data)
    if (!parsed.success) return invalid()
    if (direct?.phase === 'settled' && parsed.data.id === direct.messageId) return invalid()
    // Only claim-owned identities participate; loop context is regenerated before commit.
    const recordable = claim?.phase === 'intent' && claim.started && !claim.closed
      && claim.inputs.some(input => input.message.id === parsed.data.id)
    if (recordable && (state.turn !== claim.turn || state.step !== claim.step
      || claim.recorded.some(message => message.id === parsed.data.id))) return invalid()
    const next = recordable ? { ...state, claim: { ...claim, recorded: [...claim.recorded, parsed.data] } } : state
    if (direct === null || parsed.data.id !== direct.messageId || !claim?.started || claim.closed) return next
    const admitted = parsed.data.source.kind === 'user' && direct.admitted === 0 ? 1 : 2
    return { ...next, directClaim: { ...direct, admitted } }
  }
  if (record?.type === 'plugin:review-gated/claim-settled') {
    const parsed = claimSettledRecordSchema.safeParse(record.data)
    if (!parsed.success || claim === null) return invalid()
    // A stale disposition cannot settle the current task. Preserve nonblocking
    // unrelated settlements only while no task is waiting for acceptance.
    if (parsed.data.intentSeq !== claim.intentSeq) {
      return direct?.phase === 'prepared' || state.taskAdmission?.taskId != null ? invalid() : state
    }
    if (claim.phase !== 'intent' || claim.closed) return invalid()
    const entered = parsed.data.outcome === 'entered'
    if (entered ? !claim.started || parsed.data.messages.length === 0
      || new Set(parsed.data.messages.map(message => message.id)).size !== parsed.data.messages.length
      || !isDeepStrictEqual(parsed.data.messages, claim.recorded)
      : parsed.data.messages.length !== 0 || claim.recorded.length !== 0) return invalid()
    const admission = state.taskAdmission
    if (direct?.phase === 'prepared') {
      const matching = parsed.data.messages.filter(message => message.id === direct.messageId)
      if (!entered || direct.intentSeq !== claim.intentSeq || direct.admitted !== 1
        || matching.length !== 1 || matching[0]?.source.kind !== 'user'
        || value?.task?.originMessageId !== direct.messageId || value.diagnostic !== TASK_SAVE_UNCERTAIN) return invalid()
      return { ...state, value: { ...value, diagnostic: null }, taskReceipt: 'proven', directClaim: { ...direct, phase: 'settled' },
        claim: { ...claim, phase: parsed.data.outcome } }
    }
    if (admission?.taskId != null) {
      const matching = parsed.data.messages.filter(message => message.id === admission.messageId)
      if (!entered || admission.intentSeq !== claim.intentSeq || matching.length !== 1 || matching[0]?.source.kind !== 'user'
        || value?.task?.id !== admission.taskId || value.task.originMessageId !== admission.messageId
        || value.diagnostic !== TASK_SAVE_UNCERTAIN) return invalid()
      return { ...state, value: { ...value, diagnostic: null }, taskReceipt: 'proven', taskAdmission: null, directClaim: null,
        claim: { ...claim, phase: parsed.data.outcome } }
    }
    return { ...state, taskAdmission: null, directClaim: null, claim: { ...claim, phase: parsed.data.outcome } }
  }
  // The input was removed from the inbox before the intent. Requeueing it is
  // not model-entry evidence, regardless of any diagnostic target on the intent.
  if (event.type === 'agent/inbox/spliced' && claim?.phase === 'intent'
    && event.data.inserted.some(message => claim.inputs.some(input => input.message.id === message.id))) return invalid()
  switch (record?.type) {
    case 'plugin:review-gated/direct-task-prepared': {
      const parsed = directPreparedRecordSchema.safeParse(record.data)
      if (!parsed.success || direct === null || direct.phase !== 'intent' || direct.objective === null
        || direct.intentSeq !== parsed.data.intentSeq || direct.messageId !== parsed.data.messageId
        || value?.role !== 'main' || value.policy === null || value.task !== null || value.diagnostic !== null
        || state.pending !== null || claim?.phase !== 'intent' || claim.closed || claim.intentSeq !== direct.intentSeq
        || state.taskAdmission?.intentSeq !== direct.intentSeq || state.taskAdmission.messageId !== direct.messageId
        || state.taskAdmission.taskId !== null || direct.objective.length > value.policy.maxHandoffChars) return invalid()
      const candidate = parsed.data.state
      const task = candidate.task
      if (!isDeepStrictEqual(parsed.data, record.data) || task === null || task.originMessageId !== direct.messageId
        || task.objective !== direct.objective
        || task.workRevision !== 0 || task.workerAttempts !== 0 || task.reviewAttempts !== 0
        || task.active !== null || task.lastWorker !== null || task.lastReview !== null || task.reviewStatus !== 'not-reviewed'
        || candidate.diagnostic !== TASK_SAVE_UNCERTAIN
        || !isDeepStrictEqual({ ...value, task, diagnostic: TASK_SAVE_UNCERTAIN }, candidate)) return invalid()
      return { ...state, value: candidate, taskReceipt: 'unproven', taskAdmission: null, directClaim: { ...direct, phase: 'prepared' } }
    }
    case 'plugin:review-gated/task-prepared': {
      if (direct?.phase === 'prepared') return invalid()
      const parsed = taskPreparedRecordSchema.safeParse(record.data)
      const admission = state.taskAdmission
      if (!parsed.success || admission === null || admission.taskId !== null || value?.role !== 'main' || value.policy === null
        || state.pending !== null || claim?.phase !== 'intent' || claim.closed || admission.intentSeq !== claim.intentSeq
        || parsed.data.intentSeq !== admission.intentSeq || parsed.data.messageId !== admission.messageId) return invalid()
      const original = claim.inputs.find(input => input.message.id === admission.messageId)?.message
      const candidate = parsed.data.state
      const task = candidate.task
      if (original?.source.kind !== 'user' || original.content.length !== 1
        || !isDeepStrictEqual(original.content[0], { type: 'text', text: parsed.data.input })
        || task === null || task.originMessageId !== admission.messageId || task.objective.trim() !== task.objective
        || task.objective === '' || task.objective.length > value.policy.maxHandoffChars
        || parsed.data.input.trim() !== task.objective || task.workRevision !== 0 || task.workerAttempts !== 0 || task.reviewAttempts !== 0
        || task.active !== null || task.lastWorker !== null || task.lastReview !== null || task.reviewStatus !== 'not-reviewed'
        || candidate.diagnostic !== TASK_SAVE_UNCERTAIN || !isDeepStrictEqual(parsed.data, record.data)
        || !isDeepStrictEqual({ ...value, task, diagnostic: TASK_SAVE_UNCERTAIN }, candidate)) return invalid()
      return { ...state, value: candidate, taskReceipt: 'unproven', directClaim: null, taskInputText: parsed.data.input, taskAdmission: { ...admission, taskId: task.id } }
    }
    case 'plugin:review-gated/state': {
      if (direct?.phase === 'prepared' || state.taskAdmission !== null) return invalid()
      const parsed = stateRecordSchema.safeParse(record.data)
      if (!parsed.success) return invalid()
      let next = normalizeLegacyState(parsed.data.state)
      if (value?.diagnostic?.startsWith('RG_TASK_SAVE_UNCERTAIN:') && value.task !== null) {
        if (next?.task?.id !== value.task.id || next.task.originMessageId !== value.task.originMessageId
          || next.task.objective !== value.task.objective) return invalid()
        if (next.diagnostic === null || (isUncertainTaskSave(next.diagnostic) && !isUncertainTaskSave(value.diagnostic))) {
          next = { ...next, diagnostic: value.diagnostic }
        } else if (!next.diagnostic.startsWith('RG_TASK_SAVE_UNCERTAIN:')) return invalid()
      }
      // A removed log scan's proof belongs in folded state; missing evidence must
      // fail closed. Generic state and legacy normalization cannot establish receipt.
      const sameTask = next?.task != null && next.task.id === value?.task?.id
        && next.task.originMessageId === value.task.originMessageId && next.task.objective === value.task.objective
      const taskReceipt = next?.task == null ? 'none' : sameTask ? state.taskReceipt : 'unproven'
      return { ...state, value: next, taskReceipt, pending: null, taskInputText: sameTask ? state.taskInputText : null }
    }
    case 'plugin:review-gated/result-prepared': {
      if (direct?.phase === 'prepared') return invalid()
      const parsed = resultPreparedRecordSchema.safeParse(record.data)
      if (!parsed.success || state.pending !== null) return invalid()
      const { taskId, runId, childId, scopeMatches, state: candidate } = parsed.data
      const pending = { taskId, runId, childId, scopeMatches, state: candidate }
      if (!validCandidate(state.value, pending)) return invalid()
      return { ...state, pending }
    }
    case 'plugin:review-gated/result-confirmed': {
      if (direct?.phase === 'prepared') return invalid()
      const parsed = resultConfirmedRecordSchema.safeParse(record.data)
      const pending = state.pending
      if (!parsed.success || pending === null || parsed.data.taskId !== pending.taskId
        || parsed.data.runId !== pending.runId || parsed.data.childId !== pending.childId) return invalid()
      return { ...state, value: normalizeLegacyState(pending.state), pending: null }
    }
    // Events owned by core or other plugins do not establish RG claim facts.
    default: return state
  }
}

/** Durable claim input whose content is untrusted persisted data. */
export interface RgPreviewInput {
  /** Inbox slot the input was claimed from, when the record names one. */
  readonly target?: 'next-turn' | 'next-step'
  /** Original message as stored; its fields need runtime inspection. */
  readonly message: unknown
}

/** Claim batch as read back from storage, safe to preview without trusting its contents. */
export interface RgPreviewClaim {
  /** Log position of the intent that claimed this batch. */
  readonly intentSeq: SessionSeq
  /** Slot the batch was claimed from, when the record names one. */
  readonly target?: 'next-turn' | 'next-step'
  /** Turn that claimed the batch. */
  readonly turn: number
  /** Step that claimed the batch. */
  readonly step: number
  /** Settlement phase when a durable settlement exists. */
  readonly phase?: 'intent' | 'entered' | 'rejected' | 'empty'
  /** Original inputs in claim order. */
  readonly inputs: readonly RgPreviewInput[]
}

/** Bounded original-input preview shared by live reports and cold projection views.
 * @param claim - RG-owned original batch, never its rewritten admitted messages.
 * @returns the public disposition and at most 8192 characters after at most 8192 inspected values.
 */
export function rgClaimPreview(claim: RgPreviewClaim | null): RgView['claim'] {
  if (claim === null) return null
  let text = ''
  let truncated = false
  let otherContent = false
  let examined = 0
  inputs: for (const input of claim.inputs) {
    if (++examined > 8192) { truncated = true; otherContent = true; break }
    const stored = input.message
    const content = stored !== null && typeof stored === 'object' && !Array.isArray(stored)
      ? (stored as { readonly content?: unknown }).content : undefined
    if (!Array.isArray(content)) {
      otherContent = true
      continue
    }
    for (const part of content as readonly unknown[]) {
      if (++examined > 8192) { truncated = true; otherContent = true; break inputs }
      if (part === null || typeof part !== 'object' || Array.isArray(part)) {
        otherContent = true
        continue
      }
      const block = part as { readonly type?: unknown; readonly text?: unknown }
      if (block.type !== 'text' || typeof block.text !== 'string') {
        otherContent = true
        continue
      }
      const value = block.text
      if (text !== '') {
        if (text.length < 8192) text += '\n'
        else truncated = true
      }
      const remaining = Math.max(0, 8192 - text.length)
      text += value.slice(0, remaining)
      if (value.length > remaining) { truncated = true; otherContent = true; break inputs }
    }
  }
  const phase = claim.phase ?? 'intent'
  return { phase: phase === 'intent' ? 'unsettled' : phase, text, truncated, otherContent }
}

/** Wire validation excludes raw claim inputs and bounds the retained preview. */
export const rgProjectionViewSchema = z.object({
  state: sessionStateSchema.nullable(), failed: z.boolean(), ready: z.boolean(),
  taskReceipt: z.enum(['none', 'proven', 'unproven']), claim: z.object({
    intentSeq: z.number().int().nonnegative().transform(brandNumber<SessionSeq>),
    turn: z.number().int().nonnegative(), step: z.number().int().nonnegative(),
    phase: z.enum(['unsettled', 'entered', 'rejected', 'empty']),
    text: z.string().max(8192), truncated: z.boolean(), otherContent: z.boolean(),
  }).strict().nullable(),
}).strict()

/** Shared durable readiness for live and cold consumers; live operations add their own lifecycle guards.
 * @param state - the RG projection's current fold state.
 * @returns whether RG-owned durable facts permit ordinary task use.
 */
export function rgProjectionReady(state: RgProjectionState): boolean {
  const claim = state.claim
  const rejectedOrigin = (claim?.phase === 'rejected' || claim?.phase === 'empty')
    && claim.inputs.some(input => input.message.id === state.value?.task?.originMessageId)
  return state.failure === null && state.taskAdmission === null && claim?.phase !== 'intent' && claim?.phase !== 'entered'
    && !rejectedOrigin && state.value?.diagnostic == null && state.value?.task?.active?.status !== 'saving'
    && (state.value?.task == null || state.taskReceipt === 'proven')
}

/** Publish claim authority without requiring an Agent or replaying events in consumers.
 * @param state - the RG projection's current fold state.
 * @returns the current state, readiness, and bounded original-input recovery summary.
 */
export function rgProjectionView(state: RgProjectionState): RgProjectionView {
  const claim = state.claim
  const preview = rgClaimPreview(claim)
  return { state: state.failure === null ? state.value : null, failed: state.failure !== null,
    ready: rgProjectionReady(state), taskReceipt: state.taskReceipt,
    claim: claim === null || preview === null ? null : {
      ...preview, intentSeq: claim.intentSeq, turn: claim.turn, step: claim.step,
    } }
}

/** One owner for RG Session policy and current task; historical runs stay in the log. */
export const rgProjectionDefinition = {
  key: 'reviewGated', stateVersion: 11,
  stateSchema: z.object({ value: sessionStateSchema.nullable(), taskReceipt: z.enum(['none', 'proven', 'unproven']),
    hasRequested: z.boolean(), failure: z.string().nullable(),
    turn: z.number().int().nonnegative(), step: z.number().int().nonnegative(), claim: claimStateSchema.nullable(),
    pending: pendingSchema.nullable(), taskAdmission: taskAdmissionSchema.nullable(), taskInputText: z.string().nullable(),
    directClaim: directClaimSchema.nullable() }).strict()
    .superRefine((state, context) => {
      if ((state.value?.task == null) !== (state.taskReceipt === 'none')
        || ((state.directClaim?.phase === 'prepared' || state.taskAdmission?.taskId != null) && state.taskReceipt !== 'unproven')) {
        context.addIssue({ code: 'custom', message: 'Unbound RG task receipt.' })
      }
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
      const claim = state.claim
      if (claim !== null && (new Set(claim.inputs.map(input => input.message.id)).size !== claim.inputs.length
        || new Set(claim.recorded.map(message => message.id)).size !== claim.recorded.length
        || claim.recorded.some(message => !claim.inputs.some(input => input.message.id === message.id))
        || (!claim.started && claim.recorded.length !== 0)
        || (!claim.closed && (claim.turn !== state.turn || claim.step !== state.step + (claim.started ? 0 : 1)))
        || (claim.phase === 'entered' && (!claim.started || claim.recorded.length === 0))
        || ((claim.phase === 'rejected' || claim.phase === 'empty') && claim.recorded.length !== 0))) {
        context.addIssue({ code: 'custom', message: 'Invalid RG claim checkpoint.' })
      }
      if (direct !== null && direct.phase !== 'settled') {
        const original = claim?.inputs.find(input => input.message.id === direct.messageId)?.message
        if (claim?.phase !== 'intent' || direct.intentSeq !== claim.intentSeq || original?.source.kind !== 'user'
          || boundedObjective(original.content, direct.limit) !== direct.objective
          || (direct.phase === 'intent' && (state.taskAdmission?.intentSeq !== direct.intentSeq || state.taskAdmission.messageId !== direct.messageId))) {
          context.addIssue({ code: 'custom', message: 'Unbound direct RG claim.' })
        }
      }
      const admission = state.taskAdmission
      if (admission !== null && (state.value?.role !== 'main' || state.value.policy === null
        || claim?.phase !== 'intent' || claim.intentSeq !== admission.intentSeq
        || !claim.inputs.some(input => input.message.id === admission.messageId && input.message.source.kind === 'user')
        || (admission.taskId !== null && (state.value.diagnostic !== TASK_SAVE_UNCERTAIN || state.taskInputText === null
          || state.value.task?.id !== admission.taskId || state.value.task.originMessageId !== admission.messageId
          || state.value.task.objective.length > state.value.policy.maxHandoffChars
          || state.value.task.workRevision !== 0 || state.value.task.workerAttempts !== 0 || state.value.task.reviewAttempts !== 0
          || state.value.task.active !== null || state.value.task.lastWorker !== null || state.value.task.lastReview !== null
          || state.value.task.reviewStatus !== 'not-reviewed'
          || !claim.inputs.some(input => input.message.id === admission.messageId
            && isDeepStrictEqual(input.message.content, [{ type: 'text', text: state.taskInputText }])))))) {
        context.addIssue({ code: 'custom', message: 'Invalid prepared RG task.' })
      }
    })
    .transform(state => ({ ...state, value: normalizeLegacyState(state.value) })),
  init: () => ({ value: null, taskReceipt: 'none', hasRequested: false, failure: null, pending: null, turn: 0, step: 0, claim: null,
    taskAdmission: null, taskInputText: null, directClaim: null }),
  apply: foldRgState,
  wire: { viewSchema: rgProjectionViewSchema, view: rgProjectionView },
} satisfies ProjectionDefinition<'reviewGated', RgProjectionState>
