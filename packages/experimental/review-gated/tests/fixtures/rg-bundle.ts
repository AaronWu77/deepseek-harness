/** Mount the real RG bundle with its package-owned Loader resolution base. */
import type { Context } from '@deepseek-ai/cordis'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { fileURLToPath } from 'node:url'
import { defaultSettings } from '../../src/config.ts'

const patch = new URL('../../cordis.patch.yml', import.meta.url)

/** Cordis fixture identity. */
export const name = 'rg-profile-bundle'
/** The real Loader owns every preset and its disposal. */
export const inject = ['loader']

/**
 * Load the bundle's declarations from its actual package directory.
 * @param ctx - Profile context that owns the mounted Loader group.
 */
export async function apply(ctx: Context): Promise<void> {
  const scoped = ctx.extend({ baseUrl: new URL('.', patch).href })
  const { Group } = await scoped.loader.import('@deepseek-ai/cordis-plugin-loader') as typeof import('@deepseek-ai/cordis-plugin-loader')
  const { composeEntries, loadOverlayPatches } = await scoped.loader.import('@deepseek-ai/dsh-app-boot') as typeof import('@deepseek-ai/dsh-app-boot')
  const entries: EntryOptions[] = composeEntries([loadOverlayPatches('rg-profile-bundle', fileURLToPath(patch))])
  const settings = entries.find(row => row.id === 'rg-settings')
  if (settings === undefined) throw new Error('Missing real RG settings row')
  settings.config = { settings: { ...defaultSettings(), configured: true,
    main: { candidates: [{ provider: 'rg-scripted', model: 'rg-main' }], default: { provider: 'rg-scripted', model: 'rg-main' } },
    worker: { candidates: [{ provider: 'rg-scripted', model: 'rg-worker' }], default: { provider: 'rg-scripted', model: 'rg-worker' } },
    reviewer: { mode: 'custom', pool: { candidates: [{ provider: 'rg-scripted', model: 'rg-reviewer' }], default: { provider: 'rg-scripted', model: 'rg-reviewer' } } } } }
  scoped.plugin(Group, entries)
}
