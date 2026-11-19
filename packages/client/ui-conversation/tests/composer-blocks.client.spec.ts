import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { ComposerBlockRegistry } from '../src/client/input/blocks.ts'

const SESSION = 'blocked-session' as SessionId

describe('ComposerBlockRegistry', () => {
  it('republishes only when the copy changes', () => {
    const registry = new ComposerBlockRegistry()
    const listener = vi.fn()
    const store = registry.storeFor(SESSION)
    store.subscribe(listener)

    registry.set(SESSION, { reason: 'select a model first' })
    expect(store.getSnapshot()).toEqual({ reason: 'select a model first' })
    expect(listener).toHaveBeenCalledTimes(1)

    // Identical copy: no publication at all.
    registry.set(SESSION, { reason: 'select a model first' })
    expect(listener).toHaveBeenCalledTimes(1)

    registry.set(SESSION, undefined)
    expect(store.getSnapshot()).toBeUndefined()

    registry.forget(SESSION)
    expect(registry.storeFor(SESSION).getSnapshot()).toBeUndefined()
  })

  it('releases only the pending operation block, not another owner’s block', () => {
    const registry = new ComposerBlockRegistry()
    const store = registry.storeFor(SESSION)
    const releaseSelection = registry.hold(SESSION, { reason: 'saving selection' })
    expect(store.getSnapshot()).toEqual({ reason: 'saving selection' })

    registry.set(SESSION, { reason: 'viewer only' })
    releaseSelection()
    releaseSelection()
    expect(store.getSnapshot()).toEqual({ reason: 'viewer only' })

    const releaseFirst = registry.hold(SESSION, { reason: 'first operation' })
    const releaseSecond = registry.hold(SESSION, { reason: 'second operation' })
    registry.set(SESSION, undefined)
    expect(store.getSnapshot()).toEqual({ reason: 'first operation' })
    releaseFirst()
    expect(store.getSnapshot()).toEqual({ reason: 'second operation' })

    registry.forget(SESSION)
    const replacement = registry.storeFor(SESSION)
    registry.set(SESSION, { reason: 'new binding' })
    releaseSecond()
    expect(replacement.getSnapshot()).toEqual({ reason: 'new binding' })
  })
})
