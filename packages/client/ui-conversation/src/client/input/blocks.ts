/**
 * Composer blocks: the one way another plugin stops a session's input.
 *
 * The composer cannot read the plugins that would know — the dependency runs
 * ui-model-selection → ui-conversation, never back — so a blocker pushes here and the
 * bar reads its own session's store. A block carries the localized reason it
 * exists, because the plugin that raised it owns that copy; the composer only
 * knows how to render an inert textarea with a placeholder, exactly as it
 * already does for a session with no workspace.
 *
 * This is an affordance, not enforcement: the Host refuses a prompt it cannot
 * route regardless of what any client disables.
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ComposerBlock, ComposerBlocks } from '../contract/composer-blocks.ts'

interface SessionBlocks {
  base?: ComposerBlock | undefined
  held: Map<symbol, ComposerBlock>
  store: SnapshotStore<ComposerBlock | undefined>
}

/** The per-session composer-block registry (one instance per plugin fiber). */
export class ComposerBlockRegistry implements ComposerBlocks {
  private readonly sessions = new Map<SessionId, SessionBlocks>()

  /** @inheritdoc */
  set(sessionId: SessionId, block: ComposerBlock | undefined): void {
    const entry = this.entryFor(sessionId)
    entry.base = block
    this.publish(entry)
  }

  /** @inheritdoc */
  hold(sessionId: SessionId, block: ComposerBlock): () => void {
    const entry = this.entryFor(sessionId)
    const id = Symbol()
    entry.held.set(id, block)
    this.publish(entry)
    return () => {
      if (entry.held.delete(id) && this.sessions.get(sessionId) === entry) this.publish(entry)
    }
  }

  /** @inheritdoc */
  storeFor(sessionId: SessionId): SnapshotStore<ComposerBlock | undefined> {
    return this.entryFor(sessionId).store
  }

  /** @inheritdoc */
  forget(sessionId: SessionId): void {
    this.sessions.delete(sessionId)
  }

  private publish(entry: SessionBlocks): void {
    const block = entry.base ?? entry.held.values().next().value
    if (entry.store.getSnapshot()?.reason !== block?.reason) entry.store.set(block)
  }

  private entryFor(sessionId: SessionId): SessionBlocks {
    const existing = this.sessions.get(sessionId)
    if (existing !== undefined) return existing
    const entry = { held: new Map<symbol, ComposerBlock>(), store: createSnapshotStore<ComposerBlock | undefined>(undefined) }
    this.sessions.set(sessionId, entry)
    return entry
  }
}
