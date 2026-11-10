/** Revision-fenced RG settings drafts; Host values remain the only persisted configuration. */
import type { ModelCatalog, ModelProviderGroup } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsFormScope, SettingsFormShell } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RgModelPool, RgSettings } from '../types.ts'
import { modelKey, modelRows, poolError, poolOf, type LimitField, type ModelRow, type PoolError, type PoolRole } from './model-pools.ts'

/** Host section served by the RG settings row. */
export interface RgSettingsSection { readonly settings: RgSettings }
/** Whole form snapshot; failures and conflicts stay visible beside the controls. */
export interface RgConfigState extends SettingsFormShell {
  readonly settings: RgSettings | null
  readonly configured: boolean
  readonly rows: Readonly<Record<PoolRole, readonly ModelRow[]>>
  readonly errors: Readonly<Record<PoolRole, PoolError | null>>
  readonly limits: Readonly<Record<LimitField, string>>
  readonly invalidLimits: readonly LimitField[]
  readonly catalogStatus: 'idle' | 'loading' | 'ready' | 'error'
  readonly partialCatalog: boolean
  readonly conflicted: boolean
  readonly uncertain: boolean
  readonly savedNotice: number | null
}
/** Data and callbacks injected into the settings section. */
export interface RgConfigFace {
  readonly hooks: { readonly rgConfig: HostObservable<RgConfigState> }
  readonly toggleModel: (role: PoolRole, key: string) => void
  readonly selectDefault: (role: PoolRole, key: string) => void
  readonly selectEffort: (role: PoolRole, key: string, effort: string | undefined) => void
  readonly setReviewerMode: (mode: 'inherit-main' | 'custom') => void
  readonly editLimit: (field: LimitField, text: string) => void
  readonly retryCatalog: () => void
  readonly save: () => void
  readonly discard: () => void
  readonly dismissSaved: () => void
  readonly acknowledgeUncertain: () => void
}

const LIMIT_FIELDS: readonly LimitField[] = ['maxWorkerAttempts', 'maxReviewAttempts', 'maxHandoffChars', 'maxReportChars', 'maxScopeFiles', 'maxScopeBytes']
const same = (left: RgSettings | undefined, right: RgSettings | undefined): boolean => JSON.stringify(left) === JSON.stringify(right)

/** A declaration-owned draft controller with lazy directory reads and no persistence outside ConfigForm. */
export class RgConfigController {
  private readonly store: SnapshotStore<RgConfigState>
  private readonly source: HostObservable<RgConfigState>
  private readonly unsubscribe: () => void
  private draft: RgSettings | undefined
  private customPool: RgModelPool | undefined
  private draftRevision: number | undefined
  private numbers: Partial<Record<LimitField, string>> = {}
  private groups: readonly ModelProviderGroup[] = []
  private catalogStatus: RgConfigState['catalogStatus'] = 'idle'
  private partialCatalog = false
  private catalogRequest: object | undefined
  private saving = false
  private failed = false
  private conflicted = false
  private uncertain = false
  private savedNotice: number | null = null
  private noticeSequence = 0
  private writeGeneration = 0
  private readers = 0
  private disposed = false

  /**
   * @param scope - the single RG Host settings namespace.
   * @param readCatalog - read-only model directory loader; it must not make a model request.
   */
  constructor(private readonly scope: SettingsFormScope<RgSettingsSection>, private readonly readCatalog: () => Promise<ModelCatalog>) {
    this.store = createSnapshotStore(this.snapshot())
    this.source = {
      getSnapshot: () => this.store.getSnapshot(),
      subscribe: (listener) => {
        const remove = this.store.subscribe(listener)
        this.readers += 1
        if (this.catalogStatus === 'idle') void this.loadCatalog()
        return () => {
          remove()
          this.readers -= 1
        }
      },
    }
    this.unsubscribe = scope.subscribe(() => {
      const current = scope.getSnapshot()
      if (current.status !== 'ready') {
        const uncertain = this.uncertain || this.saving
        this.clearDraft()
        this.uncertain = uncertain
        this.writeGeneration += 1
        this.saving = false
        this.savedNotice = null
      } else if (!this.saving && this.draft !== undefined && current.revision !== this.draftRevision) {
        if (same(current.value?.settings, this.desired())) this.clearDraft()
        else this.conflicted = true
      }
      this.publish()
    })
  }

  /**
   * Return the stable source and explicit mutation actions for the slot renderer.
   * @returns the form's private injection face.
   */
  inject(): RgConfigFace {
    return {
      hooks: { rgConfig: this.source },
      toggleModel: (role, key) => { this.updatePool(role, (pool) => {
        const row = this.rows(role).find(candidate => candidate.key === key)
        if (row === undefined || (!row.available && !row.selected)) return pool
        const existing = pool.candidates.some(candidate => modelKey(candidate) === key)
        const candidates = existing ? pool.candidates.filter(candidate => modelKey(candidate) !== key)
          : [...pool.candidates, { provider: row.provider, model: row.model }]
        const currentDefault = pool.default
        const defaultModel = currentDefault !== null && modelKey(currentDefault) === key && existing ? null
          : currentDefault ?? (pool.candidates.length === 0 && !existing ? { provider: row.provider, model: row.model } : null)
        return { candidates, default: defaultModel }
      }) },
      selectDefault: (role, key) => { this.updatePool(role, (pool) => {
        const route = pool.candidates.find(candidate => modelKey(candidate) === key)
        return route === undefined ? pool : { ...pool, default: { provider: route.provider, model: route.model } }
      }) },
      selectEffort: (role, key, effort) => { this.updatePool(role, (pool) => {
        const row = this.rows(role).find(candidate => candidate.key === key)
        if (row === undefined || !row.available || (effort !== undefined && !row.efforts.some(choice => choice.id === effort))) return pool
        return { ...pool, candidates: pool.candidates.map((route) => {
          if (modelKey(route) !== key) return route
          return { provider: route.provider, model: route.model, ...effort === undefined ? {} : { reasoningEffort: effort } }
        }) }
      }) },
      setReviewerMode: (mode) => {
        const draft = this.beginEdit()
        if (draft === undefined || draft.reviewer.mode === mode) return
        if (draft.reviewer.mode === 'custom') this.customPool = draft.reviewer.pool
        this.draft = { ...draft, reviewer: mode === 'inherit-main' ? { mode }
          : { mode, pool: this.customPool ?? draft.main } }
        this.publish()
      },
      editLimit: (field, text) => {
        if (this.beginEdit() === undefined) return
        this.numbers[field] = text
        this.publish()
      },
      retryCatalog: () => { this.refreshCatalog() },
      save: () => { void this.save() },
      discard: () => { this.discard() },
      dismissSaved: () => { this.savedNotice = null; this.publish() },
      acknowledgeUncertain: () => {
        if (this.scope.getSnapshot().status !== 'ready') return
        this.uncertain = false
        this.publish()
      },
    }
  }

  /** Reload visible model metadata after adapters, credentials, or the directory change. */
  refreshCatalog(): void {
    if (this.disposed) return
    this.catalogRequest = undefined
    this.catalogStatus = 'idle'
    if (this.readers > 0) void this.loadCatalog()
    else this.publish()
  }

  /** Discard Host-generation drafts and suppress late results after reconnecting. */
  resetConnection(): void {
    const uncertain = this.uncertain || this.saving
    this.writeGeneration += 1
    this.saving = false
    this.clearDraft()
    this.uncertain = uncertain
    this.savedNotice = null
    this.groups = []
    this.partialCatalog = false
    this.refreshCatalog()
  }

  /** Release subscriptions and retire all pending UI settlements. */
  dispose(): void {
    this.disposed = true
    this.writeGeneration += 1
    this.catalogRequest = undefined
    this.clearDraft()
    this.groups = []
    this.savedNotice = null
    this.unsubscribe()
  }

  private beginEdit(): RgSettings | undefined {
    const host = this.scope.getSnapshot()
    if (this.disposed || host.status !== 'ready' || !host.writable || this.saving || this.conflicted || host.value === undefined) return undefined
    if (this.draft === undefined) {
      this.draft = structuredClone(host.value.settings)
      this.draftRevision = host.revision
    }
    this.failed = false
    this.savedNotice = null
    return this.draft
  }

  private desired(): RgSettings | undefined {
    const value = this.draft ?? this.scope.getSnapshot().value?.settings
    if (value === undefined || this.draft === undefined) return value
    const limits = Object.fromEntries(LIMIT_FIELDS.map(field => [field, Number(this.numbers[field] ?? value[field])]))
    return { ...value, ...limits, configured: true }
  }

  private updatePool(role: PoolRole, transform: (pool: RgModelPool) => RgModelPool): void {
    const draft = this.beginEdit()
    if (draft === undefined || (role === 'reviewer' && draft.reviewer.mode !== 'custom')) return
    const pool = transform(poolOf(draft, role))
    this.draft = role === 'reviewer' ? { ...draft, reviewer: { mode: 'custom', pool } } : { ...draft, [role]: pool }
    this.publish()
  }

  private rows(role: PoolRole): ModelRow[] {
    const settings = this.desired()
    const saved = this.scope.getSnapshot().value?.settings
    if (settings === undefined || saved === undefined) return []
    return modelRows(this.groups, poolOf(saved, role), poolOf(settings, role))
  }

  private clearDraft(): void {
    this.draft = undefined
    this.customPool = undefined
    this.draftRevision = undefined
    this.numbers = {}
    this.failed = false
    this.conflicted = false
  }

  private discard(): void {
    this.writeGeneration += 1
    this.saving = false
    this.clearDraft()
    this.savedNotice = null
    this.publish()
  }

  private async save(): Promise<void> {
    const state = this.snapshot()
    const desired = this.desired()
    if (this.disposed || !state.available || !state.writable || !state.dirty || state.invalid
      || this.saving || desired === undefined) return
    const generation = this.writeGeneration
    this.saving = true
    this.failed = false
    this.uncertain = false
    this.publish()
    let transportFailed = false
    try {
      await this.scope.mutate([{ op: 'set', path: ['settings'], value: desired }], this.draftRevision)
    } catch (_error) {
      // A missing response does not establish whether the Host committed the write.
      transportFailed = true
    }
    if (!this.currentWrite(generation)) return
    this.saving = false
    if (same(this.scope.getSnapshot().value?.settings, desired)) {
      this.clearDraft()
      this.savedNotice = ++this.noticeSequence
    } else {
      this.failed = true
      this.uncertain = transportFailed
      this.conflicted = this.scope.getSnapshot().revision !== this.draftRevision
    }
    this.publish()
  }

  private async loadCatalog(): Promise<void> {
    const request = {}
    this.catalogRequest = request
    this.catalogStatus = 'loading'
    this.publish()
    try {
      const catalog = await this.readCatalog()
      if (!this.currentCatalog(request)) return
      this.groups = catalog.groups
      this.partialCatalog = catalog.failures.length > 0
      this.catalogStatus = 'ready'
    } catch (_error) {
      // Keep the last directory and saved routes visible while the request can be retried.
      if (!this.currentCatalog(request)) return
      this.catalogStatus = 'error'
    }
    this.catalogRequest = undefined
    this.publish()
  }

  private currentWrite(generation: number): boolean {
    return !this.disposed && generation === this.writeGeneration
  }

  private currentCatalog(request: object): boolean {
    return !this.disposed && request === this.catalogRequest
  }

  private snapshot(): RgConfigState {
    const host = this.scope.getSnapshot()
    const desired = this.desired()
    const settings = desired ?? null
    const rows = { main: this.rows('main'), worker: this.rows('worker'), reviewer: this.rows('reviewer') }
    const errors = { main: settings === null ? null : poolError(settings.main, rows.main),
      worker: settings === null ? null : poolError(settings.worker, rows.worker),
      reviewer: settings === null ? null : poolError(poolOf(settings, 'reviewer'), rows.reviewer) }
    const limits = Object.fromEntries(LIMIT_FIELDS.map(field => [field, this.numbers[field] ?? String(settings?.[field] ?? '')])) as Record<LimitField, string>
    const invalidLimits = LIMIT_FIELDS.filter((field) => {
      const value = Number(limits[field])
      return !Number.isSafeInteger(value) || value < 1
    })
    return { available: host.status === 'ready', writable: host.writable,
      dirty: this.draft !== undefined && !same(host.value?.settings, desired),
      invalid: !host.writable || this.conflicted || this.uncertain || settings === null
        || Object.values(errors).some(error => error !== null) || invalidLimits.length > 0,
      saving: this.saving, failed: this.failed, settings, configured: host.value?.settings.configured ?? false,
      rows, errors, limits, invalidLimits,
      catalogStatus: this.catalogStatus, partialCatalog: this.partialCatalog,
      conflicted: this.conflicted, uncertain: this.uncertain, savedNotice: this.savedNotice }
  }

  private publish(): void {
    if (!this.disposed) this.store.set(this.snapshot())
  }
}
