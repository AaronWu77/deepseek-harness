/** Mount real RG presets with deterministic shell-free, clock-free fixture context. */
import type { Context } from '@deepseek-ai/cordis'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-working-directory'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { fileURLToPath } from 'node:url'
import { defaultSettings } from '../../../packages/experimental/review-gated/src/config.ts'

const patch = new URL('../../../packages/experimental/review-gated/cordis.patch.yml', import.meta.url)

/** Cordis fixture identity. */
export const name = 'review-gated-snapshot-bundle'
/** Resolve the bundle's declared packages through the running profile Loader. */
export const inject = ['loader', 'systemPrompt', 'workingDirectory']

/**
 * Load the shipped RG declarations without maintaining a second composition.
 * @param ctx - Scenario context; the Loader owns the mounted group and its disposal.
 */
export async function apply(ctx: Context): Promise<void> {
  const scoped = ctx.extend({ baseUrl: new URL('.', patch).href })
  const { Group }: typeof import('@deepseek-ai/cordis-plugin-loader') = await scoped.loader.import('@deepseek-ai/cordis-plugin-loader')
  const { composeEntries, loadOverlayPatches }: typeof import('@deepseek-ai/dsh-app-boot') = await scoped.loader.import('@deepseek-ai/dsh-app-boot')
  const entries: EntryOptions[] = composeEntries([loadOverlayPatches('review-gated snapshot', fileURLToPath(patch))])
  const disableHostInputs = (rows: PresetDefinition['plugins']): void => {
    for (const row of rows) {
      if (row.id === 'tool-bash' || row.id === 'tool-pwsh' || row.id === 'time-context') row.disabled = true
      if (row.group && Array.isArray(row.config)) disableHostInputs(row.config as PresetDefinition['plugins'])
    }
  }
  const provider = process.env.DSH_SNAPSHOT_PROVIDER
  const model = process.env.DSH_SNAPSHOT_MODEL
  if (provider === undefined || provider === '' || model === undefined || model === '') {
    throw new Error('RG snapshot requires explicit DSH_SNAPSHOT_PROVIDER and DSH_SNAPSHOT_MODEL')
  }
  const pool = () => ({ candidates: [{ provider, model, reasoningEffort: 'off' }], default: { provider, model } })
  for (const entry of entries) {
    if (entry.id === 'rg-settings' && entry.name === '@deepseek-ai/dsh-experimental-review-gated') {
      entry.config = { settings: { ...defaultSettings(), configured: true, main: pool(), worker: pool(),
        reviewer: { mode: 'custom', pool: pool() } } }
    } else if (entry.name === '@deepseek-ai/dsh-agent-preset') {
      disableHostInputs((entry.config as PresetDefinition).plugins)
    } else throw new Error('Unexpected declaration in the real RG bundle')
  }
  scoped.plugin(Group, entries)
  // Keep the real directory service; its JSON-quoted Windows spelling is not portable fixture input.
  ctx.on('agent/created', ({ agent }) => {
    agent.ctx.systemPrompt.context({
      name: 'working-directory:current',
      order: ctx.systemPrompt.getContextOrder('WORKING_DIRECTORY'),
      required: true,
      interpolate: false,
      text: () => `Current working directory: ${JSON.stringify(ctx.workingDirectory.get(agent.session).replaceAll('\\', '/'))}.`,
    })
  })
}
