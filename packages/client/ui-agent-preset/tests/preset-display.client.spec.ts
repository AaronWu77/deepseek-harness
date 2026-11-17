import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { describe, expect, it, vi } from 'vitest'
import { en } from '../src/client/locales.ts'
import { createPresetDisplayRegistry, displayPreset } from '../src/client/preset-display.ts'

const contribution = {
  match: { id: 'example', name: 'Example', description: 'Original' },
  description: { en: 'Translated', zh: '中文说明' },
}
const t = (key: keyof typeof en) => en[key]

describe('preset description contributions', () => {
  it('matches all declaration fields, preserves built-ins, switches language, and removes contributions', () => {
    const ctx = new Context()
    const locale = new LocaleRuntime(ctx)
    const { registry, source } = createPresetDisplayRegistry()
    const changed = vi.fn()
    const stop = source.subscribe(changed)
    const resolve = (preset: typeof contribution.match) => displayPreset(preset, t, source.getSnapshot(), text => locale.resolveText(text))
    expect(resolve(contribution.match).description).toBe('Original')
    const dispose = registry.register(contribution)
    expect(resolve(contribution.match).description).toBe('Translated')
    locale.setLocale('zh')
    expect(resolve(contribution.match).description).toBe('中文说明')
    for (const field of ['id', 'name', 'description'] as const) {
      const custom = { ...contribution.match, [field]: 'Changed' }
      expect(resolve(custom).description).toBe(custom.description)
    }
    expect(displayPreset({ id: 'standard' }, t, source.getSnapshot(), text => locale.resolveText(text)).description)
      .toBe(en.presetStandardDescription)
    dispose()
    dispose()
    expect(resolve(contribution.match).description).toBe('Original')
    expect(changed).toHaveBeenCalledTimes(2)
    stop()
  })

  it('rejects duplicate matches without removing the existing owner', () => {
    const { registry, source } = createPresetDisplayRegistry()
    const dispose = registry.register(contribution)
    expect(() => registry.register(contribution)).toThrow('already matches')
    expect(source.getSnapshot()).toHaveLength(1)
    dispose()
    expect(source.getSnapshot()).toHaveLength(0)
    expect(() => registry.register(contribution)).not.toThrow()
  })
})
