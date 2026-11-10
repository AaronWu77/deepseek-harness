/** Immutable Session model policy and exact-route authorization. */
import { z } from 'zod'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm/brand'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { ModelSelection, SessionModelPolicy } from './types.ts'

const selectionSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  reasoningEffort: z.string().min(1).transform(ReasoningEffortId).exactOptional(),
})

/** Compare an exact route, including an explicitly absent reasoning effort. */
function sameSelection(left: ModelSelection, right: ModelSelection): boolean {
  return left.provider === right.provider && left.model === right.model
    && left.reasoningEffort === right.reasoningEffort
}

const policySchema = z.object({
  allowedSelections: z.array(selectionSchema).min(1),
  defaultSelection: selectionSchema,
  rememberDefault: z.boolean(),
}).superRefine((policy, ctx) => {
  if (!policy.allowedSelections.some(choice => sameSelection(choice, policy.defaultSelection))) {
    ctx.addIssue({ code: 'custom', path: ['defaultSelection'], message: 'default selection must be an allowed choice' })
  }
  const seen = new Set<string>()
  for (const [index, selection] of policy.allowedSelections.entries()) {
    const route = JSON.stringify([selection.provider, selection.model])
    if (seen.has(route)) ctx.addIssue({ code: 'custom', path: ['allowedSelections', index], message: 'model routes must be unique' })
    seen.add(route)
  }
})

/** Host authorization and the request watermark that freezes it. */
export interface ModelPolicyState {
  /** Complete recorded policy, or null for ordinary unrestricted selection. */
  readonly policy: SessionModelPolicy | null
  /** Whether a model request has already been recorded, including fork history. */
  readonly hasRequests: boolean
}

/**
 * Recorded policy; authorization cannot change after the first request.
 * @internal Registered by AgentRegistry, which owns all production reads.
 */
export const modelPolicyProjectionDefinition: Required<ProjectionDefinition<'modelSelectionPolicy', ModelPolicyState>> = {
  key: 'modelSelectionPolicy',
  stateVersion: 1,
  stateSchema: z.object({ policy: policySchema.nullable(), hasRequests: z.boolean() }),
  init: () => ({ policy: null, hasRequests: false }),
  apply: (state, event) => {
    if (event.type === 'request/header') return state.hasRequests ? state : { ...state, hasRequests: true }
    if (event.type !== 'model/selection-policy') return state
    if (state.policy === null && event.data.policy === null) return state
    if (state.policy !== null && event.data.policy !== null && sameModelPolicy(state.policy, event.data.policy)) return state
    if (state.hasRequests) throw new Error('Session model policy cannot change after the first request')
    return { ...state, policy: event.data.policy }
  },
  wire: { viewSchema: policySchema.nullable(), view: state => state.policy, summary: false },
}

/**
 * Compare complete immutable policies without depending on object identity.
 * @param left - recorded policy.
 * @param right - proposed policy.
 * @returns whether the policies have identical ordered choices, default and persistence behavior.
 */
export function sameModelPolicy(left: SessionModelPolicy, right: SessionModelPolicy): boolean {
  return left.rememberDefault === right.rememberDefault
    && sameSelection(left.defaultSelection, right.defaultSelection)
    && left.allowedSelections.length === right.allowedSelections.length
    && left.allowedSelections.every((choice, index) => {
      const other = right.allowedSelections[index]
      return other !== undefined && sameSelection(choice, other)
    })
}

/**
 * Check policy invariants before committing a new authorization.
 * @param policy - complete policy to record.
 * @throws when choices are empty, duplicate routes exist, or the default is not allowed.
 */
export function assertModelPolicy(policy: SessionModelPolicy): void {
  if (policy.allowedSelections.length === 0) throw new Error('Session model policy requires at least one allowed choice')
  if (!policy.allowedSelections.some(choice => sameSelection(choice, policy.defaultSelection))) {
    throw new Error('Session model policy default must be an allowed choice')
  }
  const routes = new Set(policy.allowedSelections.map(choice => JSON.stringify([choice.provider, choice.model])))
  if (routes.size !== policy.allowedSelections.length) throw new Error('Session model policy routes must be unique')
}

/** Rejected model selection, distinct from provider availability failures. */
export class ModelPolicyViolationError extends Error {
  /** Stable policy rejection code. */
  readonly code = 'MODEL_SELECTION_NOT_ALLOWED'

  /**
   * @param selection - exact provider/model/effort choice rejected by the Session policy.
   */
  constructor(readonly selection: Readonly<ModelSelection>) {
    super(`model ${selection.provider}/${selection.model} with the requested reasoning effort is not allowed for this Session`)
    this.name = 'ModelPolicyViolationError'
  }
}

/**
 * Enforce a recorded policy on the complete final model selection.
 * @param policy - Session policy, or null when no policy was recorded.
 * @param selection - exact effective route, including absent effort.
 * @throws ModelPolicyViolationError when the complete choice is outside the recorded policy.
 */
export function assertModelPolicySelection(policy: SessionModelPolicy | null, selection: Readonly<ModelSelection>): void {
  if (policy !== null && !policy.allowedSelections.some(choice => sameSelection(choice, selection))) {
    throw new ModelPolicyViolationError({ ...selection })
  }
}
