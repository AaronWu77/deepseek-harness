// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type { ModelCatalogDirectory, ModelCatalogState } from '../src/client/catalog.ts'
import { ModelDirectory } from '../src/client/directory.ts'
import type { ModelSelection, ModelSelectionProjection } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RemoteResult, TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'

const sid = 'model-race' as SessionId
const initial: ModelSelection = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }
const replacement: ModelSelection = { provider: 'deepseek-official', model: 'deepseek-v4-pro' }
const external: ModelSelection = { provider: 'external', model: 'external-model' }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept
    reject = decline
  })
  return { promise, resolve, reject }
}

function fixture(
  sessions: Pick<TypertClientRemote['session'], 'selectModel'>,
  next: ModelSelection | null = null,
) {
  const catalogState: ModelCatalogState = {
    value: {
      default: initial,
      routableProviders: ['deepseek-official', 'external'],
      groups: [],
      failures: [],
    },
    status: 'ready',
    error: null,
  }
  const catalogStore = createSnapshotStore(catalogState)
  const catalog = {
    store: catalogStore,
    load: async () => catalogStore.getSnapshot().value!,
  } as ModelCatalogDirectory
  const projection = createSnapshotStore<ModelSelectionProjection | undefined>({ lastUsed: null, next })
  const directory = new ModelDirectory(sessions, sid, () => true, catalog, projection)
  return { directory, projection }
}

type SelectWireResult = Awaited<ReturnType<TypertClientRemote['session']['selectModel']>>

const success: RemoteResult<void> = { ok: true, value: undefined }
const accepted = (selected: ModelSelection): SelectWireResult => ({ ok: true, value: { selected } })

describe('ModelDirectory selection lifecycle', () => {
  it('keeps an acknowledged choice visible until the durable projection confirms it', async () => {
    const operation = deferred<SelectWireResult>()
    const { directory, projection } = fixture({ selectModel: vi.fn(() => operation.promise) })

    const pending = directory.select(replacement)
    operation.resolve(accepted(replacement))
    await expect(pending).resolves.toEqual(success)
    expect(directory.store.getSnapshot()).toMatchObject({ current: replacement, status: 'ready' })

    projection.set({ lastUsed: null, next: replacement })
    expect(directory.store.getSnapshot()).toMatchObject({ current: replacement, status: 'ready' })
  })

  it('uses the Host-accepted selection while its projection catches up', async () => {
    const operation = deferred<SelectWireResult>()
    const { directory } = fixture({ selectModel: vi.fn(() => operation.promise) })
    const normalized = { ...replacement, reasoningEffort: 'high' }

    const pending = directory.select(replacement)
    operation.resolve(accepted(normalized))

    await expect(pending).resolves.toEqual(success)
    expect(directory.store.getSnapshot()).toMatchObject({ current: normalized, status: 'ready' })
  })

  it('does not publish an unacknowledged choice when the projection refreshes', async () => {
    const operation = deferred<SelectWireResult>()
    const { directory, projection } = fixture({ selectModel: vi.fn(() => operation.promise) })

    const pending = directory.select(replacement)
    projection.set({ lastUsed: null, next: initial })
    expect(directory.store.getSnapshot()).toMatchObject({ current: initial, status: 'selecting' })

    operation.resolve({
      ok: false,
      error: new RemoteError('gateway/internal', 'selection rejected', {}),
    })
    await expect(pending).resolves.toMatchObject({ ok: false })
    expect(directory.store.getSnapshot()).toMatchObject({
      current: initial,
      status: 'error',
      error: 'gateway/internal: selection rejected',
    })
  })

  it('accepts projection confirmation before the RPC settles', async () => {
    const operation = deferred<SelectWireResult>()
    const { directory, projection } = fixture({ selectModel: vi.fn(() => operation.promise) })

    const pending = directory.select(replacement)
    projection.set({ lastUsed: null, next: replacement })
    expect(directory.store.getSnapshot()).toMatchObject({ current: replacement, status: 'selecting' })

    operation.resolve(accepted(replacement))
    await pending
    expect(directory.store.getSnapshot()).toMatchObject({ current: replacement, status: 'ready' })
  })

  it('lets a conflicting durable projection replace an acknowledged choice', async () => {
    const operation = deferred<SelectWireResult>()
    const { directory, projection } = fixture({ selectModel: vi.fn(() => operation.promise) })

    const pending = directory.select(replacement)
    operation.resolve(accepted(replacement))
    await pending
    expect(directory.store.getSnapshot().current).toEqual(replacement)

    projection.set({ lastUsed: initial, next: external })
    expect(directory.store.getSnapshot()).toMatchObject({ current: external, status: 'ready' })
  })

  it('leaves the selecting state after a transport rejection and preserves the carrier message', async () => {
    const selectModel = vi.fn(async () => { throw new Error('connection reset') })
    const { directory } = fixture({ selectModel })

    const result = await directory.select(replacement)
    expect(result).toMatchObject({ ok: false, error: { code: 'gateway/internal', message: 'connection reset' } })
    expect(directory.store.getSnapshot()).toMatchObject({
      current: initial,
      status: 'error',
      error: 'gateway/internal: connection reset',
    })
  })

  it('ignores a superseded failure while the newer selection remains in flight', async () => {
    const operations: ReturnType<typeof deferred<SelectWireResult>>[] = []
    const selectModel = vi.fn(() => {
      const operation = deferred<SelectWireResult>()
      operations.push(operation)
      return operation.promise
    })
    const { directory } = fixture({ selectModel })

    const first = directory.select(replacement)
    const second = directory.select(external)
    operations[0]!.resolve({
      ok: false,
      error: new RemoteError('gateway/internal', 'older failure', {}),
    })
    await expect(first).resolves.toEqual(success)
    expect(directory.store.getSnapshot()).toMatchObject({ status: 'selecting', error: null })

    operations[1]!.resolve(accepted(external))
    await expect(second).resolves.toEqual(success)
    expect(directory.store.getSnapshot()).toMatchObject({ current: external, status: 'ready' })
  })

  it('revokes a late rejected settlement after a connection reset', async () => {
    const operation = deferred<SelectWireResult>()
    const { directory } = fixture({ selectModel: vi.fn(() => operation.promise) })
    const pending = directory.select(replacement)

    directory.resetConnected()
    const reset = directory.store.getSnapshot()
    operation.reject(new Error('old connection'))

    await expect(pending).resolves.toEqual(success)
    expect(directory.store.getSnapshot()).toEqual(reset)
  })

  it('revokes a late rejected settlement after disposal', async () => {
    const operation = deferred<SelectWireResult>()
    const { directory } = fixture({ selectModel: vi.fn(() => operation.promise) })
    const pending = directory.select(replacement)
    const beforeDispose = directory.store.getSnapshot()

    directory.dispose()
    operation.reject(new Error('disposed connection'))

    await expect(pending).resolves.toEqual(success)
    expect(directory.store.getSnapshot()).toEqual(beforeDispose)
  })
})
