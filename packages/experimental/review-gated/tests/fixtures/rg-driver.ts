/** Observe the real RG composition when launched through the shipped dsh headless profile. */
import type { Context } from '@deepseek-ai/cordis'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-tools'

/** Ordinary test-only Loader plugin, not an executable application. */
export const name = 'rg-profile-observer'
/** Observe product registrations without constructing a replacement runtime. */
export const inject = ['agents', 'agentPresets', 'tools']

/** Attach health observations before the headless runner accepts its task.
 * @param ctx - real shipped profile composition.
 */
export function apply(ctx: Context): void {
  ctx.on('agent/created', async ({ agent }) => {
    process.stdout.write(`${JSON.stringify({ type: 'agent_health', sessionId: agent.id, preset: ctx.agentPresets.composedPreset(agent.ctx),
      tools: ctx.tools.definitions(scopeOf(agent.ctx)).map(tool => tool.name) })}\n`)
    if (agent.session.header.parentSession !== undefined) return
    const presets = await ctx.agentPresets.compositionInventory()
    process.stdout.write(`${JSON.stringify({ type: 'preset_health', presets })}\n`)
    for (const id of ['rg', 'rg-worker', 'rg-reviewer']) {
      await using scope = await ctx.agentPresets.acquireScope(id)
      process.stdout.write(`${JSON.stringify({ type: 'scope_health', preset: id, tools: ctx.tools.definitions(scope.key).map(tool => tool.name) })}\n`)
    }
  })
}
