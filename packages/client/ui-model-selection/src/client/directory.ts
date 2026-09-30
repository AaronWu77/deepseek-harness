/**
 * Per-session model directory: the ONE state both selection entries share.
 * The /model popup and composer seat combine one shared Host catalog with the
 * Session's durable selection projection, then submit through the same
 * selectModel call. A switch made in either entry updates this shared state.
 */
import type {
  ModelCatalogFailure, ModelProviderGroup, ModelSelection, ModelSelectionProjection,
} from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteResult, TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import type { ObservableSnapshot, SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ModelCatalogDirectory } from './catalog.ts'

/** Directory snapshot both entries render from. */
export interface ModelDirectoryState {
  /** Acknowledged pending choice, then saved selection; unavailable saved models remain visible. */
  current: ModelSelection | null
  /** Saved effort caption retained when the selected model is unavailable. */
  retainedEffort?: string
  /** Whether the current selection is present in the available catalog; null while unresolved. */
  routable: boolean | null
  /** Successfully loaded provider groups (last good load). */
  groups: readonly ModelProviderGroup[]
  /** Provider-local failures from the last load; usable groups stay usable. */
  failures: readonly ModelCatalogFailure[]
  /** Lifecycle of the in-flight operation. */
  status: 'idle' | 'loading' | 'ready' | 'selecting' | 'error'
  /** Selection submitted by the latest `select` until it settles; null otherwise. */
  pending: ModelSelection | null
  /** Whole-request or selection failure text; null when none. */
  error: string | null
}

interface PendingSelection {
  generation: number
  selection: ModelSelection
  base: ModelSelection | undefined
  acknowledged: boolean
}

function sameSelection(left: ModelSelection | undefined, right: ModelSelection | undefined): boolean {
  return left?.provider === right?.provider
    && left?.model === right?.model
    && left?.reasoningEffort === right?.reasoningEffort
}

/** One session's shared directory controller; disposed with the session scope. */
export class ModelDirectory {
  /** The shared snapshot both entries render from (uSES-safe store). */
  readonly store: SnapshotStore<ModelDirectoryState> = createSnapshotStore<ModelDirectoryState>({
    current: null, routable: null, groups: [], failures: [], status: 'idle', pending: null, error: null,
  })

  /** Latest selection operation owns state and presentation; older settlements are ignored. */
  private generation = 0
  private pendingSelection: PendingSelection | undefined
  private disposed = false
  private readonly unsubscribeCatalog: () => void
  private readonly unsubscribeSelection: () => void

  /**
   * @param sessions - the session wire face (captured from the plugin's root connection).
   * @param sessionId - the owning session.
   * @param available - whether this session may use Agent-bound model RPCs.
   * @param catalog - Host-generation catalog shared by every Session.
   * @param projected - durable model selection projected from Session history.
   */
  constructor(
    private readonly sessions: Pick<TypertClientRemote['session'], 'selectModel'>,
    private readonly sessionId: SessionId,
    private readonly available: () => boolean,
    private readonly catalog: Pick<ModelCatalogDirectory, 'store' | 'load' | 'reasoningFor'>,
    private readonly projected: ObservableSnapshot<unknown>,
  ) {
    this.unsubscribeCatalog = catalog.store.subscribe(() => { this.syncInputs() })
    this.unsubscribeSelection = projected.subscribe(() => { this.syncInputs() })
    this.syncInputs()
  }

  /**
   * Ensure the Host generation's shared available catalog is loaded.
   * @returns the fresh directory value.
   */
  async load(): Promise<ModelDirectoryState> {
    this.assertAvailable()
    await this.catalog.load()
    this.syncInputs()
    return this.store.getSnapshot()
  }

  /**
   * Select the complete provider/model/reasoning selection. A successful RPC
   * remains visible while the durable projection catches up; a conflicting
   * projection wins. Only the latest operation may publish a failure.
   * @param selection - provider, provider-owned model id, and optional adapter-owned effort.
   * @returns the active operation's outcome; a superseded settlement is a no-op success.
   */
  async select(selection: ModelSelection): Promise<RemoteResult<void>> {
    this.assertAvailable()
    const generation = ++this.generation
    const projected = modelSelectionProjection(this.projected.getSnapshot())
    const catalog = this.catalog.store.getSnapshot()
    const pending: PendingSelection = {
      generation,
      selection,
      base: projected?.next ?? catalog.value?.default,
      acknowledged: false,
    }
    this.pendingSelection = pending
    this.store.update((s) => { s.status = 'selecting'; s.pending = selection; s.error = null })
    try {
      const result = await this.sessions.selectModel({
        sessionId: this.sessionId,
        provider: selection.provider,
        model: selection.model,
        ...selection.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: selection.reasoningEffort },
      })
      if (this.disposed || generation !== this.generation) return { ok: true, value: undefined }
      if (!result.ok) {
        this.pendingSelection = undefined
        this.syncInputs()
        this.store.update((s) => {
          s.status = 'error'
          s.pending = null
          s.error = result.error.code + ': ' + result.error.message
        })
        return result
      }
      this.pendingSelection = {
        ...pending,
        selection: result.value.selected,
        acknowledged: true,
      }
      this.store.update((s) => { s.status = 'ready'; s.pending = null; s.error = null })
      this.syncInputs()
      return { ok: true, value: undefined }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const failure = new RemoteError('gateway/internal', message, {})
      if (this.disposed || generation !== this.generation) return { ok: true, value: undefined }
      this.pendingSelection = undefined
      this.syncInputs()
      this.store.update((s) => {
        s.status = 'error'
        s.pending = null
        s.error = failure.code + ': ' + failure.message
      })
      return { ok: false, error: failure }
    }
  }

  /**
   * Invalidate an in-flight selection response from the previous Host generation.
   */
  resetConnected(): void {
    if (this.disposed) return
    ++this.generation
    this.pendingSelection = undefined
    this.store.update((state) => {
      if (state.status === 'selecting') state.status = 'idle'
      state.current = null
      state.routable = null
      state.pending = null
      state.error = null
    })
    this.syncInputs()
  }

  /** Scope teardown: late settlements lose write access to the store. */
  dispose(): void {
    this.disposed = true
    this.pendingSelection = undefined
    this.unsubscribeSelection()
    this.unsubscribeCatalog()
  }

  private assertAvailable(): void {
    if (!this.available()) {
      throw new Error('model selection is unavailable for addressed subagent sessions')
    }
  }

  private syncInputs(): void {
    if (this.disposed) return
    const catalog = this.catalog.store.getSnapshot()
    const projected = modelSelectionProjection(this.projected.getSnapshot())
    const pending = this.pendingSelection?.generation === this.generation ? this.pendingSelection : undefined
    const intended = projected?.next ?? catalog.value?.default
    const reasoning = intended === undefined ? undefined : this.catalog.reasoningFor(intended)
    const effort = intended?.reasoningEffort ?? reasoning?.defaultEffort
    const retainedEffort = effort === undefined ? undefined
      : reasoning?.efforts.find(level => level.id === effort)?.name ?? effort
    if (catalog.status !== 'ready' || catalog.value === null || (projected === undefined && pending === undefined)) {
      this.store.set({
        current: this.store.getSnapshot().current,
        ...retainedEffort === undefined ? {} : { retainedEffort },
        routable: null,
        groups: catalog.value?.groups ?? [],
        failures: catalog.value?.failures ?? [],
        status: catalog.status === 'error' ? 'error' : 'loading',
        pending: this.store.getSnapshot().pending,
        error: catalog.error,
      })
      return
    }
    const projectedCurrent = projected?.next ?? catalog.value.default
    let selection = projectedCurrent
    if (pending !== undefined) {
      if (sameSelection(projectedCurrent, pending.selection)) {
        this.pendingSelection = undefined
      } else if (pending.base !== undefined && !sameSelection(projectedCurrent, pending.base)) {
        this.pendingSelection = undefined
      } else if (pending.acknowledged) {
        selection = pending.selection
      }
    }
    const selectedReasoning = this.catalog.reasoningFor(selection)
    const selectedEffort = selection.reasoningEffort ?? selectedReasoning?.defaultEffort
    const selectedRetainedEffort = selectedEffort === undefined ? undefined
      : selectedReasoning?.efforts.find(level => level.id === selectedEffort)?.name ?? selectedEffort
    const routable = catalog.value.groups.some(group => group.id === selection.provider
      && group.models.some(model => model.id === selection.model))
    this.store.set({
      current: selection,
      ...selectedRetainedEffort === undefined ? {} : { retainedEffort: selectedRetainedEffort },
      routable,
      groups: catalog.value.groups,
      failures: catalog.value.failures,
      status: this.store.getSnapshot().status === 'selecting'
        ? 'selecting'
        : 'ready',
      pending: this.store.getSnapshot().pending,
      error: null,
    })
  }
}

function modelSelectionProjection(value: unknown): ModelSelectionProjection | undefined {
  return value === undefined ? undefined : value as ModelSelectionProjection
}
