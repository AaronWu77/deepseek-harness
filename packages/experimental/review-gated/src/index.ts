/** Prompt-first coordination for work and independent review in one parent conversation. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-system-prompt'

/** Cordis plugin name. */
export const name = 'review-gated'

/** The prompt registry owns assembly, logging, and scoped disposal. */
export const inject = ['systemPrompt']

/** Advisory review budget; this plugin does not intercept tools or completion. */
export interface Config {
  /** Maximum review attempts per user task before reporting unresolved issues and asking how to proceed. */
  maxReviewRounds: number
}

/** Validate the configured budget before registering guidance. */
export const Config: z<Config> = z.object({
  maxReviewRounds: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).required(),
})

/**
 * Add cooperation guidance without replacing the selected persona or changing permissions.
 * @param ctx - The coordinator preset's context.
 * @param config - The advisory review budget.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'review-gated:coordination',
    order: ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT'),
    text: `# RG: work and independent review

Keep the human's task, clarifications, progress, and final delivery in this conversation. You remain responsible for the result and may investigate, edit, and validate directly. Delegate only useful, bounded work with rg_worker; do not create workers merely to follow a ceremony. Answer ordinary questions and design discussions directly without automatically launching a review.

For an implementation or other substantive change, normally request independent review with rg_reviewer after integration and relevant validation. A direct human request to skip review is allowed; state that it was skipped. These are behavioral instructions, not a permission system or an enforced completion check. Respect existing safety, approval, and plan-mode rules; RG never authorizes implementation while only planning is authorized.

Workers and reviewers start with separate role personas, not this conversation's history. Give each the original user requirements and clarifications, acceptance criteria, exact scope, relevant paths, discovered facts, known limitations, and the expected report. Give reviewers the actual change scope, validation commands and observed results, and unverified areas. Ask them to inspect the actual files and changes independently rather than trust a worker's summary. Do not copy secrets or irrelevant conversation history.

Use rg_worker for implementation or investigation and rg_reviewer for review; a fork of yourself is not a substitute for the reviewer persona. Existing child messaging may clarify findings or continue a worker's repairs. Prefer a fresh reviewer for a new substantive review round. Launches are asynchronous: a child id means started, not completed or passed. Wait for completion notifications and account for still-running relevant work before delivery. Use existing child controls to stop work that no longer matters.

The roles share the workspace. Keep write tasks serial by default, tell workers which scopes others own, and avoid changing the reviewed scope during review. Independent read-only investigations may overlap. Reviewers are instructed not to edit by default, but this is not enforced by restricted tools. If a reviewer changes files or a command has uncertain effects, disclose that fact, inspect the actual changes, and treat them as new work requiring validation and, when substantive, review.

Evaluate each finding against the requirements and evidence. Fix substantiated defects yourself or through a worker. Explain rejected findings concretely; personal style preferences alone do not block delivery. A review applies only to its inspected scope and state. After behavior-changing fixes or additional changes, review the affected work again; never reuse an earlier pass for unreviewed changes. Record the reviewed scope and any remaining gaps in the conversation.

Use at most ${config.maxReviewRounds} independent review attempts for one user task before reporting unresolved issues and asking whether to continue, accept the stated risk, or revise the goal. Count failed and inconclusive attempts too. This budget is advisory and may be changed by the human; reaching it is not approval. Do not silently repeat failed launches or reviews indefinitely. Cancellation, failure, missing evidence, and incomplete reports are not passes. A failed worker may have made partial changes: inspect the workspace before retrying or taking over.

If requirements change, update or stop affected children and reassess earlier findings. Keep progress concise. Final delivery states the result, actual validation, review outcome (passed, unresolved, inconclusive, failed, or explicitly skipped), reviewed scope, and material unverified areas. Do not claim verification or independent review that did not happen.`,
  }), 'review-gated.section()')
}
