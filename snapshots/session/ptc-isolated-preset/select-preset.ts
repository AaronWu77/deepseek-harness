/** Bind the shipped headless Agent to the configured public registry default. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'

/** Cordis fixture identity. */
export const name = 'headless-preset-selection'
/** Services used by the initialization listener. */
export const inject = ['agentPresets']

/** Select the deployment default before the Agent accepts its first turn.
 * @param ctx Ordinary profile plugin context.
 */
export function apply(ctx: Context): void {
  ctx.on('agent/created', async ({ agent }) => {
    await ctx.agentPresets.select(agent, ctx.agentPresets.defaultId)
  })
}
