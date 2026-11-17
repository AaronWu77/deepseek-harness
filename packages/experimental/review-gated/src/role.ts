/** Role-local PTC tools and request guards; all durable decisions belong to the RG service. */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { JsonSchemaNode, ToolDefinition } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from './runtime.ts'
import { RgError } from './errors.ts'
import { reviewWorkflow } from './review-workflow.ts'
import { handoffSchema } from './schemas.ts'

/** Cordis role contribution. */
export const name = 'review-gated-role'
/** PTC tools stay present even when the settings service is unavailable, so requests fail closed. */
export const inject = ['tools', 'systemPrompt', 'agents', 'sessions']
/** One preset-owned role, not a user-selectable model route. */
export interface Config { readonly role: 'main' | 'worker' | 'reviewer' }
/** The role is fixed by the bundle declaration. */
export const Config: Schema<Config> = Schema.object({ role: Schema.union(['main', 'worker', 'reviewer']).required() })

const text: JsonSchemaNode = { type: 'string', minLength: 1 }
const list: JsonSchemaNode = { type: 'array', items: text }
const handoffParameters: JsonSchemaNode = { type: 'object', additionalProperties: false,
  required: ['objective', 'acceptance', 'scope', 'constraints', 'facts', 'validation'],
  properties: { objective: text, acceptance: list, scope: list, constraints: list, facts: list, validation: list } }
const callSchema = z.object({
  handoff: handoffSchema, provider: z.string().min(1).exactOptional(), model: z.string().min(1).exactOptional(),
}).strict()
  .refine(value => (value.provider === undefined) === (value.model === undefined), 'Supply provider and model together.')

/** Tool names that change workspace content; a reviewer may never run one. */
const MUTATING_TOOLS = ['write', 'edit', 'apply_patch', 'str_replace_editor']

const mainGuidance = `# RG: work and independent review

Keep one RG task for the human's complete deliverable, including investigation, design, implementation, fixes, and validation. Clarifications and intermediate steps do not create fresh budgets. Investigate and prepare proposals directly when useful. Honor any request for design confirmation before implementation. Routine drafts do not need review; a design that is the final deliverable or a human-requested intermediate review may be reviewed. A human request to skip review is allowed; disclose the unreviewed delivery.

Workers are optional. Group related changes, integrate their results, and run available acceptance checks before independent delivery review. Do not pair every file or intermediate artifact with a worker and reviewer. With two review attempts, plan for initial acceptance and a necessary repair-and-re-review. Check rg_status for remaining attempts and committed results; when only one review remains, collect available evidence before using it.

Use rg_models to inspect exact role candidates and reasoning. Choose only listed provider/model pairs; omission uses the frozen default. Accepted failed or cancelled attempts still consume budget. Do not split the deliverable or reset or expand budgets to bypass a limit.

Every handoff includes requirements and clarifications, acceptance criteria, exact scope, constraints preserving user work, discovered facts, and validation. For reviewers, include actual checks and known gaps, not just future commands. Reviewers inspect the files independently, not just worker summaries. Do not copy secrets or irrelevant history.

Role tools start one-shot children without parent history. An id means started, not completed or passed. Continue independent read-only work while a role runs; end your turn when only waiting remains and its committed result will wake you. Do not poll, mutate its workspace, or send follow-up work to a completed role. Roles run serially.

Concrete defects belong in findings; unavailable validation belongs in unverified. Missing evidence is not a defect or a pass. Fix substantiated defects and gather available evidence before re-reviewing the integrated result. A pass applies only to its inspected scope/version; stale, missing, failed, cancelled, and inconclusive reports are not passes. Recheck scope with rg_status before delivery.

Final delivery states actual changes, validation, reviewer outcome and inspected scope, and unverified areas. Review does not grant permission or prove correctness; respect safety, approvals, and plan mode. If review budget is exhausted without a current pass, report completed work, concrete findings, and missing evidence, then wait for the human to decide. RG stops goal auto-continuation at the turn boundary without completing the goal.`

/** Install scoped role behavior without replacing the PTC executor.
 * @param ctx - owning preset scope.
 * @param config - fixed role identity.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.on('agent/pre-step', async ({ agent, modelSelection, signal, messages, turn, step }, next) => {
    const runtime = ctx.get('reviewGated')
    if (runtime === undefined) throw new RgError('RG_NOT_READY', 'RG is disabled or unavailable. Re-enable the plugin before continuing this Session.')
    // The runtime's child pre-step wrapper awaits the owned activation receipt before checking authority.
    if (config.role !== 'main') return next()
    const admissionContext = { signal, messages, turn, step }
    const canProceed = () => {
      try { runtime.assertRequest(agent, modelSelection, admissionContext); return true } catch (error) {
        const claim = runtime.claimOf(agent.session)
        if (error instanceof RgError && error.code === 'RG_BUSY' && !signal.aborted
          && claim?.phase === 'intent' && !claim.closed && claim.turn === turn && claim.step === step) return false
        throw error
      }
    }
    if (!canProceed()) return { kind: 'reject' }
    // RG owns the flushed intent around this waterfall and the settlement before model entry.
    return next()
  })
  ctx.effect(() => ctx.systemPrompt.section({ name: `review-gated:${config.role}`,
    order: ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT'),
    text: config.role === 'main' ? mainGuidance
      : 'This RG role is one-shot and PTC-only. Inspect the original human deliverable as well as the assigned scope. Report actual validation and unverified areas. A reviewer reports concrete defects in findings and unavailable evidence in unverified; do not invent a defect to describe an inaccessible page, or turn missing evidence into a pass. Submit the final report by calling tools.structured_output inside run_code; never call structured_output directly. Do not delegate further or assume completion grants permission to deliver.' }))
  // Pristine guards cover direct and nested PTC dispatch of the shipped delegation tools.
  // Arbitrary Service callers bypass this pre-allocation denial; the runtime rejects local
  // bypass children at pre-step and validates every RG-owned start before calling the manager.
  ctx.effect(() => ctx.tools.guard((exec) => {
    if (exec.name === 'send_message') return 'RG_UNAUTHORIZED_START: RG roles do not accept follow-up messages. Start a fresh role within the remaining budget.'
    if (exec.name === 'subagent' || exec.name.startsWith('subagent_') || exec.name === 'workflow'
      || (config.role !== 'main' && (exec.name === 'rg_worker' || exec.name === 'rg_reviewer'))) {
      return 'RG_UNAUTHORIZED_START: Use rg_worker or rg_reviewer from the RG main Agent; roles cannot delegate further.'
    }
    return undefined
  }))
  // A reviewer inspects; it does not edit. This denial is enforcement, not
  // guidance: it holds for direct calls and for nested PTC dispatches alike.
  if (config.role === 'reviewer') {
    ctx.effect(() => ctx.tools.guard(exec => MUTATING_TOOLS.includes(exec.name)
      ? 'The RG reviewer role is read-only. Report the needed change to the parent instead of making it.' : undefined))
  }
  if (config.role !== 'main') return
  ctx.effect(() => ctx.tools.guard((exec) => {
    if (exec.agent === undefined) return undefined
    const state = ctx.get('reviewGated')?.read(exec.agent.session)
    return state?.task?.active !== null && state?.task?.active !== undefined && ['write', 'edit', 'bash', 'pwsh'].includes(exec.name)
      ? 'RG has an active role. Keep parent work read-only until the role settles.' : undefined
  }))
  for (const role of ['worker', 'reviewer'] as const) {
    const definition: ToolDefinition = {
      name: `rg_${role}`, description: role === 'reviewer'
        ? 'Start one independent delivery or follow-up review after integration and available validation. Include actual validation and known gaps in the handoff; preserve capacity for necessary re-review. Intermediate review is only for a human-requested review. The id is a startup receipt, not a pass.'
        : 'Start useful bounded implementation work with a complete handoff and an authorized role model. Group related changes; a worker does not automatically need its own reviewer. The id is only a startup receipt; formal completion arrives later.',
      parameters: { type: 'object', additionalProperties: false, required: ['handoff'], properties: { handoff: handoffParameters, provider: text, model: text } },
      output: { schema: { type: 'object', additionalProperties: false, required: ['kind', 'subagentId', 'runId'],
        properties: { kind: { type: 'string', const: 'activation' }, subagentId: text, runId: text } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      async execute(input, exec) {
        if (exec.agent === undefined) throw new RgError('RG_NOT_READY', 'RG role tools require their coordinating Agent.')
        const args = callSchema.parse(input)
        const runtime = ctx.get('reviewGated')
        if (runtime === undefined) throw new RgError('RG_NOT_READY', 'Enable RG before starting a role.')
        const route = args.provider === undefined || args.model === undefined ? undefined : { provider: args.provider, model: args.model }
        return runtime.startRole(exec.agent, role, args.handoff, route, exec.signal)
      },
    }
    ctx.effect(() => ctx.tools.register(definition))
  }
  ctx.effect(() => ctx.tools.register({ name: 'rg_models',
    description: 'List exact configured RG role candidates, defaults, and fixed reasoning choices for this Session.',
    parameters: { type: 'object', additionalProperties: false, required: ['role'], properties: { role: { type: 'string', enum: ['main', 'worker', 'reviewer'] } } },
    output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute(input, exec) {
      const args = z.object({ role: z.enum(['main', 'worker', 'reviewer']) }).strict().parse(input)
      if (exec.agent === undefined) throw new RgError('RG_NOT_READY', 'RG model discovery requires an Agent.')
      const state = ctx.get('reviewGated')?.read(exec.agent.session)
      if (state?.policy === null || state?.policy === undefined) throw new RgError('RG_NOT_READY', 'This Session has no configured RG model policy.')
      return Promise.resolve(state.policy[args.role])
    } }))
  ctx.effect(() => ctx.tools.register({ name: 'rg_status',
    description: 'Read a bounded retained input claim preview when present; otherwise read this RG task, remaining attempts, and formal reports. Recheck the inspected scope before relying on a prior reviewer pass.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(input, exec) {
      z.object({}).strict().parse(input)
      if (exec.agent === undefined) throw new RgError('RG_NOT_READY', 'RG status requires an Agent.')
      const runtime = ctx.get('reviewGated')
      if (runtime === undefined) throw new RgError('RG_NOT_READY', 'Enable RG before reading its current task.')
      const claim = runtime.claimOf(exec.agent.session)
      if (claim === undefined) throw new RgError('RG_NOT_READY', 'The input claim record is unavailable. Inspect the Session before continuing.')
      const status = runtime.statusOf(exec.agent.session)
      if (status !== 'ready' || claim !== null) return runtime.claimReport(exec.agent.session, status === 'ready' ? null : status, claim)
      const state = await runtime.recheck(exec.agent, exec.signal)
      const git = runtime.readGit(exec.agent.session)
      if (state === null) return null
      const workflow = state.task === null || state.policy === null ? null : reviewWorkflow(state.task, state.policy)
      return git === null ? { ...state, workflow } : { state, localGitDelivery: git, workflow }
    } }))
}
