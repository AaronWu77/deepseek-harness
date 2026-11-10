/** Shared RG settings transport and deterministic asynchronous state helpers. */
import { expect, onTestFinished, vi } from 'vitest'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-remotes/client'
import type { SettingsFormScope, SettingsFormScopeSnapshot } from '@deepseek-ai/dsh-client-ui-primitives'
import { RgConfigController, type RgConfigFace, type RgConfigState, type RgSettingsSection } from '../src/client/config-controller.ts'
import type { RgSettings } from '../src/types.ts'

export const main = { provider: 'alpha', model: 'smart' }
export const worker = { provider: 'alpha', model: 'fast' }
export const catalog: ModelCatalog = {
  default: main, routableProviders: ['alpha'], failures: [],
  groups: [{ id: 'alpha', name: 'Alpha', models: [
    { id: 'smart', name: 'Smart', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } },
    { id: 'fast', name: 'Fast' },
  ] }],
}
export function settings(): RgSettings {
  return { configured: true,
    main: { candidates: [{ ...main, reasoningEffort: 'high' }], default: main },
    worker: { candidates: [worker], default: worker }, reviewer: { mode: 'inherit-main' },
    maxWorkerAttempts: 2, maxReviewAttempts: 2, maxHandoffChars: 1000, maxReportChars: 1000, maxScopeFiles: 100, maxScopeBytes: 100000 }
}

export function fixture(options: {
  writable?: boolean
  value?: RgSettings
  readCatalog?: () => Promise<ModelCatalog>
  subscribe?: boolean
} = {}) {
  let snapshot: SettingsFormScopeSnapshot<RgSettingsSection> = { status: 'ready', value: { settings: options.value ?? settings() },
    base: {}, user: {}, revision: 1, writable: options.writable ?? true }
  const listeners = new Set<() => void>()
  const publish = (next: Partial<SettingsFormScopeSnapshot<RgSettingsSection>>) => {
    snapshot = { ...snapshot, ...next }
    for (const listener of [...listeners]) listener()
  }
  const update = (value: RgSettings, revision = (snapshot.revision ?? 0) + 1) => {
    snapshot = { ...snapshot, value: { settings: value }, revision }
    for (const listener of [...listeners]) listener()
  }
  const mutate = vi.fn<SettingsFormScope<RgSettingsSection>['mutate']>(async (ops) => {
    expect(ops).toHaveLength(1)
    const op = ops[0]
    if (op === undefined || op.op !== 'set') throw new Error('expected one set')
    expect(op.path).toEqual(['settings'])
    update(op.value as RgSettings)
    return true
  })
  const scope: SettingsFormScope<RgSettingsSection> = { getSnapshot: () => snapshot,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } }, mutate }
  const readCatalog = vi.fn(options.readCatalog ?? (async () => catalog))
  const controller = new RgConfigController(scope, readCatalog)
  const face = controller.inject()
  let remove = options.subscribe === false ? undefined : face.hooks.rgConfig.subscribe(() => {})
  onTestFinished(() => { remove?.(); controller.dispose() })
  return { controller, face, scope, mutate, readCatalog, update, publish, listenerCount: () => listeners.size, current: () => snapshot,
    read: () => face.hooks.rgConfig.getSnapshot(),
    close: () => { remove?.(); remove = undefined },
    open: () => { remove ??= face.hooks.rgConfig.subscribe(() => {}) },
  }
}

export function waitForState(face: RgConfigFace, predicate: (state: RgConfigState) => boolean): Promise<RgConfigState> {
  return new Promise((resolve) => {
    const check = () => {
      const state = face.hooks.rgConfig.getSnapshot()
      if (predicate(state)) { remove(); resolve(state) }
    }
    const remove = face.hooks.rgConfig.subscribe(check)
    check()
  })
}
