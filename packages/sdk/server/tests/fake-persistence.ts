/** Snapshot complete Sessions to simulate acknowledged persistence in SDK unit tests. */
import type { Context } from '@deepseek-ai/cordis'
import { SESSION_FLUSH_DURABLE } from '@deepseek-ai/dsh-session'

/** Install a Session-scoped test writer.
 * @param ctx - test context owning the listener and snapshots.
 */
export function mountSnapshotPersistence(ctx: Context): void {
  const snapshots = new WeakMap<object, { header: object; events: readonly object[] }>()
  ctx.on('session/flush', (session) => {
    snapshots.set(session, structuredClone({ header: session.header, events: session.snapshotEvents() }))
    return SESSION_FLUSH_DURABLE
  })
}
