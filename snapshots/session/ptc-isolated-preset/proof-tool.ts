/** Real filesystem capability with a portable marker result for the Node SDK fixture. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-working-directory'

const { defineTool } = process.env.DSH_EXAMPLE_MODE === 'lib'
  ? await import('../../../packages/core/tools/lib/index.js')
  : await import('../../../packages/core/tools/src/index.ts')
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
export const name = 'snapshot-proof-tool'
export const inject = ['tools', 'fs', 'sandboxPolicy', 'workingDirectory']
/** Register the fixture's real atomic filesystem effect.
 * @param ctx Profile context with the filesystem provider.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'write_snapshot_proof', description: 'Write the fixed snapshot proof through the real filesystem provider.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(_args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('snapshot proof requires an Agent')
      const cwd = await ctx.workingDirectory.ensure(agent, exec.signal)
      const target = await ctx.fs.resolve('proof.txt', { cwd, signal: exec.signal })
      const policy = ctx.sandboxPolicy.resolve({ session: agent.session })
      await ctx.fs.writeText(target, 'isolated Node PTC SDK write complete\n', undefined, exec.signal, policy)
      return 'proof written'
    },
  }))
}
