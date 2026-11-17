/** Client-only preset description contributions. */
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { BuiltInPresetCopyKey, PresetDisplaySource, PresetDisplayText } from '@deepseek-ai/dsh-agent-preset-registry/display'
import { isBuiltInPreset, presetDisplayText } from '@deepseek-ai/dsh-agent-preset-registry/display'

/** Translations for a preset declaration's exact published metadata. */
export interface PresetDisplayContribution {
  /** All three fields must match the published preset. */
  readonly match: { readonly id: string; readonly name: string; readonly description: string }
  /** Display-only text; English is the fallback. */
  readonly description: { readonly en: string; readonly [locale: string]: string }
}

/** Optional Client-only display contributions, owned by their registering plugins. */
export interface PresetDisplayRegistry {
  /**
   * Register one exact match. Duplicate matches fail without replacing the owner.
   * @param contribution - Declaration identity and localized display description.
   * @returns An idempotent disposer that removes this contribution.
   */
  register(contribution: PresetDisplayContribution): () => void
}

/** Create a per-plugin-instance registry and observable contribution list.
 * @returns The registration API and its live display snapshot.
 */
export function createPresetDisplayRegistry(): {
  registry: PresetDisplayRegistry
  source: ObservableSnapshot<readonly PresetDisplayContribution[]>
} {
  const source = createSnapshotStore<readonly PresetDisplayContribution[]>([])
  const same = (a: PresetDisplayContribution['match'], b: PresetDisplayContribution['match']): boolean =>
    a.id === b.id && a.name === b.name && a.description === b.description
  return {
    source,
    registry: {
      register(contribution) {
        if (source.getSnapshot().some(entry => same(entry.match, contribution.match))) {
          throw new Error('A preset display contribution already matches this declaration')
        }
        const entry: PresetDisplayContribution = {
          match: { ...contribution.match }, description: { ...contribution.description },
        }
        source.set([...source.getSnapshot(), entry])
        let active = true
        return () => {
          if (!active) return
          active = false
          source.set(source.getSnapshot().filter(item => item !== entry))
        }
      },
    },
  }
}

/** Resolve registered descriptions without replacing built-in or unmatched metadata.
 * @param preset - Published preset metadata.
 * @param t - Built-in preset dictionary lookup.
 * @param contributions - Current registered descriptions.
 * @param resolveText - Locale-aware description lookup.
 * @returns The display name and description.
 */
export function displayPreset(
  preset: PresetDisplaySource,
  t: (key: BuiltInPresetCopyKey) => string,
  contributions: readonly PresetDisplayContribution[],
  resolveText: (text: PresetDisplayContribution['description']) => string,
): PresetDisplayText {
  const result = presetDisplayText(preset, t)
  if (isBuiltInPreset(preset)) return result
  const entry = contributions.find(item => item.match.id === preset.id && item.match.name === preset.name
    && item.match.description === preset.description)
  return entry === undefined ? result : { ...result, description: resolveText(entry.description) }
}
