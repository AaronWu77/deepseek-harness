/** Portable model-facing directory facts for keyless PI snapshot inputs. */
import { sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-working-directory'

/** Loader identity for the PI snapshots' portable input fixture. */
export const name = 'snapshot-pi-ai-inputs'

/** Services owning the current directory and its model-facing representation. */
export const inject = ['systemPrompt', 'workingDirectory']

/** Keep the effective directory while presenting one filesystem spelling on every host.
 * @param ctx - fixture owner registering per-agent input contributions.
 */
export function apply(ctx: Context): void {
  ctx.on('agent/created', ({ agent }) => {
    ctx.effect(() => agent.ctx.systemPrompt.context({
      name: 'working-directory:current', order: ctx.systemPrompt.getContextOrder('WORKING_DIRECTORY'),
      required: true, interpolate: false,
      text: () => 'Current working directory: '
        + JSON.stringify(ctx.workingDirectory.get(agent.session).split(sep).join('/')) + '.',
    }), 'portable fixture directory context')
  })
}
