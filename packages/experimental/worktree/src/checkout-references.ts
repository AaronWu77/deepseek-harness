/** Resolve checkout references from strict Session logs and read-only Git registration queries. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Evidence, MaintenanceEpoch, SessionEventLike, SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { CREATED_RECORD, createdWorktreeSchema } from './projection.ts'
import { checkoutIdentity, registration, type GitCommands } from './removal.ts'
import type { CreatedWorktree } from './types.ts'

/** A registered checkout created by, inherited by, or containing the working directory of a Session. Every item blocks. */
export interface CheckoutReference {
  readonly sessionId: SessionId
  readonly kind: 'owned' | 'inherited' | 'cwd'
  readonly path: string
}

const stale = { state: 'unknown', reason: { code: 'stale-epoch' } } as const

/**
 * Resolve blocking Session checkout dependencies without opening a Session, changing Git, or reading projection caches.
 * @param ctx - execution-world filesystem and working-directory providers.
 * @param persistence - backend owning the epoch, strict retained corpus and header reads.
 * @param epoch - active exclusive maintenance scope.
 * @param sessionIds - owning or referring Session identities.
 * @param pool - configured relative worktree directory.
 * @param git - confined runners for read-only Git commands.
 * @param signal - cancellation of host reads.
 * @returns complete registered checkout dependencies or unknown on incomplete reads or identity mismatch.
 */
export async function inspectCheckoutReferences(
  ctx: Pick<Context, 'fs' | 'workingDirectory'>,
  persistence: Pick<SessionPersistence, 'isMaintenanceEpochActive' | 'inspectReferenceCorpus' | 'inspectReferenceLog' | 'stat'>,
  epoch: MaintenanceEpoch, sessionIds: readonly SessionId[], pool: string, git: GitCommands, signal: AbortSignal,
): Promise<Evidence<CheckoutReference>> {
  if (!persistence.isMaintenanceEpochActive(epoch)) return stale
  const corpus = await persistence.inspectReferenceCorpus({ epoch, includeTrash: true })
  if (!persistence.isMaintenanceEpochActive(epoch)) return stale
  if (corpus.state === 'unknown') return corpus
  if (corpus.epoch !== epoch) return stale
  const items: CheckoutReference[] = []
  const byId = new Map(corpus.items.map(item => [item.id, item]))
  for (const sessionId of new Set(sessionIds)) {
    const artifact = byId.get(sessionId)
    if (artifact === undefined) {
      return { state: 'unknown', reason: { code: 'artifact-ref', detail: 'No retained Worktree Session: ' + sessionId } }
    }
    const rows: SessionEventLike[] = []
    const log = await persistence.inspectReferenceLog(epoch, artifact, event => {
      if (event.type === CREATED_RECORD || event.type === 'working-directory/change') rows.push(event)
    }, { signal })
    if (!persistence.isMaintenanceEpochActive(epoch)) return stale
    if (log.state === 'unknown') return log
    if (log.epoch !== epoch) return stale
    const [summary] = log.items
    if (summary === undefined || log.items.length !== 1) {
      return { state: 'unknown', reason: { code: 'bad-event', detail: 'Missing Worktree log summary: ' + sessionId } }
    }
    let cwd: string | undefined
    const created: { worktree: CreatedWorktree; kind: 'owned' | 'inherited' }[] = []
    for (const row of rows) {
      if (row.type === 'working-directory/change') {
        const data = row.data
        if (typeof data !== 'object' || data === null || !('cwd' in data) || typeof data.cwd !== 'string' || data.cwd.length === 0) {
          return { state: 'unknown', reason: { code: 'bad-event', detail: 'Invalid working-directory record: ' + sessionId } }
        }
        cwd = data.cwd
      } else {
        const parsed = createdWorktreeSchema.safeParse(row.data)
        if (!parsed.success || row.ignorable !== true) {
          return { state: 'unknown', reason: { code: 'bad-event', detail: 'Invalid Worktree creation: ' + sessionId } }
        }
        created.push({ worktree: parsed.data, kind: row.seq >= summary.inheritedEventCount ? 'owned' : 'inherited' })
      }
    }
    if (cwd === undefined) {
      // The strict corpus does not expose initial cwd. The header-only active reader can supply it only at the same revision.
      const stored = artifact.location.kind === 'active' ? await persistence.stat(sessionId, { signal }) : undefined
      if (!persistence.isMaintenanceEpochActive(epoch)) return stale
      if (stored?.header.id !== sessionId || stored.revision !== artifact.revision) return unresolved(sessionId)
      cwd = stored.header.cwd ?? ctx.workingDirectory.defaultDirectory
    }
    const current = await ctx.fs.resolve(cwd, { signal })
    cwd = ctx.fs.processPath(current)
    let knownCwd = false
    for (const { worktree, kind } of created) {
      if (!persistence.isMaintenanceEpochActive(epoch)) return stale
      const identity = await checkoutIdentity(ctx, pool, worktree, git.read, signal)
      if (identity === null) return unresolved(worktree.path)
      const fields = await registration(ctx, worktree, identity.target, git.scan, signal)
      if (!fields?.includes('branch refs/heads/' + worktree.branch) || fields.some(field => field === 'prunable' || field.startsWith('prunable '))
        || (await ctx.fs.lstat(worktree.path, undefined, signal))?.type !== 'directory') return unresolved(worktree.path)
      items.push({ sessionId, kind, path: worktree.path })
      if (ctx.fs.contains(identity.target, current)) {
        items.push({ sessionId, kind: 'cwd', path: worktree.path })
        knownCwd = true
      }
    }
    if (!knownCwd) {
      // Query the known cwd, not the filesystem tree. Main checkouts have the same Git and common directories.
      const result = await git.read(cwd, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir', '--show-toplevel'])
      const [gitDir, commonDir, root, extra] = result.stdout.trimEnd().split(/\r?\n/)
      if (!gitDir || !commonDir || !root || extra !== undefined) return unresolved(cwd)
      // A primary Git directory can be a nested repository inside an unobserved linked checkout.
      if (gitDir === commonDir && created.length === 0) return unresolved(cwd)
      if (gitDir !== commonDir) {
        const target = await ctx.fs.resolve(root, { signal })
        const path = ctx.fs.processPath(target)
        const fields = await registration(ctx, { repositoryRoot: path }, target, git.scan, signal)
        if (fields === undefined || fields.some(field => field === 'prunable' || field.startsWith('prunable '))) return unresolved(cwd)
        items.push({ sessionId, kind: 'cwd', path })
      }
    }
  }
  return persistence.isMaintenanceEpochActive(epoch) ? { state: 'complete', epoch, items } : stale
}

function unresolved(detail: string): Evidence<never> {
  return { state: 'unknown', reason: { code: 'unstable', detail: 'Cannot resolve Worktree checkout or cwd: ' + detail } }
}
