/** Role-local PTC tools and request guards; all durable decisions belong to the RG service. */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { JsonSchemaNode, ToolDefinition } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from './runtime.ts'
import { RgError } from './errors.ts'
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

const mainGuidance = `# RG: work and independent review

Keep the human task, clarifications, progress, and delivery in this conversation. Answer ordinary questions directly. For substantive changes, delegate only useful bounded work with rg_worker, integrate and validate the result, then normally request a fresh rg_reviewer. You may work directly; do not spawn roles merely for ceremony. A direct human request to skip review is allowed and must be reported.

Use rg_models to inspect each role's exact candidates and configured reasoning. Only choose listed provider/model pairs; omitted selection uses that role's frozen default. The role budget is machine-counted, includes failed and cancelled accepted attempts, and cannot be reset by the model. Use rg_status to read remaining attempts and committed results.

Every handoff must contain original requirements and clarifications, acceptance criteria, exact file/directory scope, constraints preserving user work, discovered facts, and actual validation evidence or commands to perform. Reviewers inspect actual files independently rather than trust worker summaries. Do not copy secrets or irrelevant conversation history.

Both role tools start one-shot children with no parent conversation. A child id means started, not completed or passed. Continue independent read-only work while it runs, and stop your turn when only waiting remains; the committed result wakes you. Do not poll or send follow-up work to a completed role; each new attempt consumes budget. Write tasks and review are serial. During a role run, do not mutate its workspace.

Evaluate findings against requirements and evidence. Fix substantiated defects within budget, and use a fresh reviewer after changes. An old pass applies only to its inspected scope/version; stale, missing, failed, cancelled, or inconclusive reports are not passes. Recheck review scope with rg_status before delivery.

Final delivery states actual changes, validation, reviewer-reported outcome and inspected scope, and material unverified areas. Review is not proof of correctness or a permission grant. Respect safety, approvals, and plan mode. If budget is exhausted, report unresolved work and ask the human whether to begin a new task; never silently expand budget or claim a review that did not happen.`

/** Install scoped role behavior without replacing the PTC executor.
 * @param ctx - owning preset scope.
 * @param config - fixed role identity.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.on('agent/pre-step', async ({ agent, modelSelection, signal, messages }, next) => {
    const runtime = ctx.get('reviewGated')
    if (runtime === undefined) throw new RgError('RG_NOT_READY', 'RG is disabled or unavailable. Re-enable the plugin before continuing this Session.')
    const admissionContext = { signal, messages }
    const canProceed = () => {
      try { runtime.assertRequest(agent, modelSelection, admissionContext); return true } catch (error) {
        if (error instanceof RgError && error.code === 'RG_BUSY' && !signal.aborted
          && agent.claimProtectionStatus === 'saving' && agent.claimRecovery != null) return false
        throw error
      }
    }
    if (!canProceed()) return { kind: 'reject' }
    const state = JSON.stringify(runtime.read(agent.session))
    const selected = JSON.stringify(agent.model.current())
    try {
      if (!await ctx.sessions.flush(agent.session)) throw new Error('No Session writer completed the flush')
    } catch (error) {
      ctx.logger.error('RG request checkpoint failed: %s', error)
      throw new RgError('RG_NOT_READY', 'The Session save outcome is uncertain. Inspect the Session and workspace before continuing.')
    }
    signal.throwIfAborted()
    if (ctx.get('reviewGated') === undefined) throw new RgError('RG_NOT_READY', 'RG is unavailable after saving the Session. Inspect the Session before continuing.')
    if (!canProceed()) return { kind: 'reject' }
    if (JSON.stringify(runtime.read(agent.session)) !== state || JSON.stringify(agent.model.current()) !== selected) {
      throw new RgError('RG_NOT_READY', 'The RG task or model changed while saving the Session. Inspect the Session before continuing.')
    }
    return next()
  })
  ctx.effect(() => ctx.systemPrompt.section({ name: `review-gated:${config.role}`,
    order: ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT'),
    text: config.role === 'main' ? mainGuidance
      : 'This RG role is one-shot and PTC-only. Inspect the assigned requirements and workspace. Report actual validation and unverified areas. Submit the final report by calling tools.structured_output inside run_code; never call structured_output directly. Do not delegate further or assume completion grants permission to deliver.' }))
  if (config.role !== 'main') return
  ctx.effect(() => ctx.tools.guard((exec) => {
    if (exec.agent === undefined) return undefined
    const state = ctx.get('reviewGated')?.read(exec.agent.session)
    return state?.task?.active !== null && state?.task?.active !== undefined && ['write', 'edit', 'bash', 'pwsh'].includes(exec.name)
      ? 'RG has an active role. Keep parent work read-only until the role settles.' : undefined
  }))
  for (const role of ['worker', 'reviewer'] as const) {
    const definition: ToolDefinition = {
      name: `rg_${role}`, description: `Start one fresh RG ${role} using a complete handoff and an authorized role model. The returned id is only a startup receipt; formal completion arrives later.`,
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
      const claimStatus = exec.agent.claimProtectionStatus
      const claimRecovery = exec.agent.claimRecovery
      if (claimStatus === undefined) throw new RgError('RG_NOT_READY', 'Protected input claims are unavailable. Inspect the Session before continuing.')
      if (claimStatus !== null || claimRecovery != null) return runtime.claimReport(exec.agent.session, claimStatus, claimRecovery ?? null)
      const claim = runtime.claimOf(exec.agent.session)
      if (claim != null) return runtime.claimReport(exec.agent.session, claimStatus, claim)
      if (claim === undefined) throw new RgError('RG_NOT_READY', 'The input claim record is unavailable. Inspect the Session before continuing.')
      const state = await runtime.recheck(exec.agent, exec.signal)
      const git = runtime.readGit(exec.agent.session)
      return git === null ? state : { state, localGitDelivery: git }
    } }))
}
