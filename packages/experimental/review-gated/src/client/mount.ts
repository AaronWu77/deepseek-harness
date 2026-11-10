/** RG Remote lifecycle and browser contribution assembly. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-experimental-review-gated/remote'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { RemoteStreamCarrierError } from '@deepseek-ai/dsh-api-gateway/client'
import type { RgView } from './view.ts'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-remotes/types'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '../types.ts'
import { settingsSchema } from '../settings-schema.ts'
import { RgConfigController, type RgSettingsSection } from './config-controller.ts'
import { RgConfig } from './RgConfig.tsx'
import { RgDock } from './RgDock.tsx'
import { en, zh, type RgLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** RG role configuration and task status copy. */
    'review-gated': RgLocaleKey
  }
}

/** The Remote mount outlives UI dependencies such as the Session namespace. */
export const inject = ['remote']

const uiInject = ['remote.reviewGated', 'slots', 'locale', 'configForms', 'remote.session']

/**
 * Register the RG settings editor and projection-backed status strip.
 * @param ctx - browser plugin context; no Host implementation is imported.
 */
export function mountRgUi(ctx: Context): void {
  const connection = createSnapshotStore(0)
  ctx.effect(() => ctx.locale.register('review-gated', 'en', en), 'review-gated: English dictionary')
  ctx.effect(() => ctx.locale.register('review-gated', 'zh', zh), 'review-gated: Chinese dictionary')
  ctx.effect(() => ctx.configForms.registerDecoder('rg-settings', (value) => {
    const result = z.object({ settings: settingsSchema }).safeParse(value)
    return result.success ? result.data : undefined
  }), 'review-gated: settings decoder')
  const t = ctx.locale.bind('review-gated')
  ctx.slots.inject('settings.section', function* () {
    const controller = new RgConfigController(ctx.configForms.get<RgSettingsSection>('rg-settings'), async () => {
      const response = await ctx.remote.session.modelCatalog()
      if (!response.ok) throw new Error('RG model directory is unavailable')
      return response.value
    })
    yield () => { controller.dispose() }
    yield ctx.remote.$on('llm/adapters-updated', () => { controller.refreshCatalog() })
    yield ctx.remote.$on('llm/models-updated', () => { controller.refreshCatalog() })
    yield ctx.remote.$on('credentials/record-updated', () => { controller.refreshCatalog() })
    yield ctx.remote.$on('credentials/reference-updated', () => { controller.refreshCatalog() })
    yield ctx.on('connection/reset', () => { controller.resetConnection() })
    const face = controller.inject()
    yield ctx.slots.register({
      name: 'settings.section', id: 'review-gated', order: 11, label: () => t('modelsNav'),
      locale: 'review-gated', inject: () => face,
    }, RgConfig)
  })
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock', id: 'review-gated', order: 20, locale: 'review-gated',
    inject: (sessionId: SessionId) => ({
      hooks: { rgConnection: connection },
      watchView: (carrierFailed: () => void) => ctx.remote.$stream<RgView>({
        name: 'RG view stream',
        open: signal => ctx.remote.reviewGated.watchView({ sessionId }, signal),
        ended: () => new RemoteStreamCarrierError('RG view stream ended'),
        carrierFailed,
      }),
      newTask: async (objective: string, signal: AbortSignal): Promise<void> => {
        signal.throwIfAborted()
        const result = await ctx.remote.reviewGated.newTask(sessionId, objective)
        if (!result.ok) throw new Error(result.error.message)
      },
      leaveLocalGit: async (signal: AbortSignal): Promise<void> => {
        signal.throwIfAborted()
        const result = await ctx.remote.reviewGated.leaveLocalGit(sessionId)
        if (!result.ok) throw new Error(result.error.message)
      },
      authorizeLocalGit: async (scope: readonly string[], signal: AbortSignal): Promise<void> => {
        signal.throwIfAborted()
        const result = await ctx.remote.reviewGated.authorizeLocalGit(sessionId, scope, signal)
        if (!result.ok) throw new Error(result.error.message)
      },
      recheck: async (signal: AbortSignal): Promise<void> => {
        const result = await ctx.remote.reviewGated.recheck(sessionId, signal)
        if (!result.ok) throw new Error(result.error.message)
      },
    }),
  }, RgDock))
  ctx.on('connection/reset', () => { connection.set(connection.getSnapshot() + 1) })
}

/**
 * Install generated methods before creating the dependency-scoped UI consumer.
 * @param ctx - the owning browser plugin lifetime.
 * @param contribution - generated RG Remote definitions.
 * @returns the asynchronous disposer for UI and Remote contributions.
 */
export async function mountRg(ctx: Context, contribution: TypertRemoteContribution): Promise<() => Promise<void>> {
  const unmountRemote = await ctx.remote.$mount(contribution)
  const ui = ctx.inject(uiInject, mountRgUi)
  try {
    await ui
  } catch (error) {
    await ui.dispose()
    await unmountRemote()
    throw error
  }
  return async () => {
    await ui.dispose()
    await unmountRemote()
  }
}
