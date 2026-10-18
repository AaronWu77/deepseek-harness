/** Select the RG preset for the root Agent created by the headless driver. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'

/** Cordis fixture identity. */
export const name = 'rg-select-root-preset'
/** Services used by the initialization listener. */
export const inject = ['agentPresets']

/**
 * Bind the root Agent to RG before it accepts its first turn.
 * @param ctx - Composition context with the preset registry.
 */
export function apply(ctx: Context): void {
  ctx.on('agent/created', async ({ agent }) => {
    if (agent.session.header.parentSession !== undefined) return
    await ctx.agentPresets.select(agent, 'rg')
  }, { prepend: true })
}
