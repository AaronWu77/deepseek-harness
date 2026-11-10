import type { Context } from '@deepseek-ai/cordis'
import { SESSION_FLUSH_DURABLE } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'

/** Install an in-memory test double that saves each complete Session prefix before acknowledging it. */
export function installTestPersistence(ctx: Context): void {
  const snapshots = new Map<SessionId, { header: SessionHeader; inheritedEventCount: SessionLogOffset; events: readonly SessionEvent[] }>()
  ctx.on('session/flush', (session) => {
    const events = structuredClone(session.snapshotEvents())
    snapshots.set(session.id, { header: session.header, inheritedEventCount: session.inheritedEventCount, events })
    return SESSION_FLUSH_DURABLE
  })
}
