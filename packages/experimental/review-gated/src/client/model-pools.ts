/** Browser-only draft validation and joining of configured model routes with the catalog. */
import type { ModelProviderGroup } from '@deepseek-ai/dsh-api-remotes/client'
import type { RgModel, RgModelPool, RgSettings } from '../types.ts'

/** Editable role pools; reviewer may instead inherit the main pool. */
export type PoolRole = 'main' | 'worker' | 'reviewer'
/** Numeric RG settings shown by the form. */
export type LimitField = 'maxWorkerAttempts' | 'maxReviewAttempts' | 'maxHandoffChars' | 'maxReportChars' | 'maxScopeFiles' | 'maxScopeBytes'
/** A stored candidate with optional current directory metadata. */
export interface ModelRow extends RgModel {
  readonly key: string
  readonly providerName: string
  readonly modelName: string
  readonly available: boolean
  readonly saved: boolean
  readonly selected: boolean
  readonly isDefault: boolean
  readonly efforts: readonly { readonly id: string; readonly name: string }[]
}
/** Field errors are localized at the owning form. */
export type PoolError = 'poolRequired' | 'defaultRequired' | 'effortInvalid' | 'candidateUnavailable'

/**
 * Identify an exact route without parsing a provider-owned identifier.
 * @param route - exact provider and model.
 * @returns a local opaque lookup key.
 */
export function modelKey(route: Pick<RgModel, 'provider' | 'model'>): string {
  return JSON.stringify([route.provider, route.model])
}

/**
 * Read the explicit pool for a role, leaving inheritance to its owner.
 * @param settings - current draft.
 * @param role - role being edited.
 * @returns its pool, or the main pool for an inherited reviewer.
 */
export function poolOf(settings: RgSettings, role: PoolRole): RgModelPool {
  if (role !== 'reviewer') return settings[role]
  return settings.reviewer.mode === 'custom' ? settings.reviewer.pool : settings.main
}

/**
 * Join catalog candidates and saved-but-unavailable routes without dropping selections.
 * @param groups - successfully loaded directory groups.
 * @param retained - saved values to retain even when deselected in the draft.
 * @param pool - draft pool whose selection and default are rendered.
 * @returns catalog rows followed by missing saved routes.
 */
export function modelRows(groups: readonly ModelProviderGroup[], retained: RgModelPool, pool: RgModelPool): ModelRow[] {
  const missing = new Map([...retained.candidates, ...pool.candidates].map(route => [modelKey(route), route]))
  const saved = new Set(retained.candidates.map(modelKey))
  const selected = new Map(pool.candidates.map(route => [modelKey(route), route]))
  const defaultKey = pool.default === null ? null : modelKey(pool.default)
  const rows: ModelRow[] = groups.flatMap(group => group.models.map((model) => {
    const route = { provider: group.id, model: model.id }
    const key = modelKey(route)
    missing.delete(key)
    return {
      ...route, ...selected.get(key), key, providerName: group.name, modelName: model.name,
      available: true, saved: saved.has(key), selected: selected.has(key), isDefault: key === defaultKey,
      efforts: model.reasoning?.efforts ?? [],
    }
  }))
  for (const [key, route] of missing) rows.push({
    ...route, key, providerName: route.provider, modelName: route.model,
    available: false, saved: saved.has(key), selected: selected.has(key), isDefault: key === defaultKey, efforts: [],
  })
  return rows
}

/**
 * Validate choices that the editor can assess using the current directory.
 * @param pool - staged role policy.
 * @param rows - current model metadata, including unavailable stored candidates.
 * @returns a field error, or null when the pool can be submitted to the Host.
 */
export function poolError(pool: RgModelPool, rows: readonly ModelRow[]): PoolError | null {
  if (pool.candidates.length === 0) return 'poolRequired'
  if (rows.some(row => row.selected && !row.available && !row.saved)) return 'candidateUnavailable'
  const selectedDefault = pool.default
  if (selectedDefault === null || !pool.candidates.some(route => modelKey(route) === modelKey(selectedDefault))) return 'defaultRequired'
  if (rows.some(row => row.selected && row.available && row.reasoningEffort !== undefined
    && !row.efforts.some(effort => effort.id === row.reasoningEffort))) return 'effortInvalid'
  return null
}
