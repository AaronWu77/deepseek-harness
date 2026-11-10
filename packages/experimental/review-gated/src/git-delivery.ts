/** Owns local Git delivery authorization, retained resources, and bounded operation lifetimes. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import type { WorktreeService } from '@deepseek-ai/dsh-experimental-worktree'
import type {} from '@deepseek-ai/dsh-experimental-worktree'
import type {} from '@deepseek-ai/dsh-working-directory'
import { GitExecutor, GitExecutorError } from './git-executor.ts'
import type { GitExecutorConfig, GitInspection } from './git-executor.ts'
import { gitStateSchema, type RgGitProjectionState } from './git-projection.ts'
import type { RgCandidateId, RgGitState } from './git-types.ts'
import type { RgHandoff, RgPolicy, RgRun, RgRunId, RgTask, RgWorkerReport } from './types.ts'
import { RgError } from './errors.ts'

interface Backend { readonly executor: GitExecutor; readonly worktrees: WorktreeService }
interface Operation { readonly control: AbortController; readonly done: Promise<void> }
/** Current checkout equality excludes mutable refs in the source repository. */
function sameRepository(left: GitInspection, right: GitInspection): boolean {
  return left.root === right.root && left.gitDir === right.gitDir && left.commonDir === right.commonDir
}
/** Normalize human/tool JSON paths; Git pathspec syntax never reaches Git as an expression.
 * @param paths - explicit repository-relative paths.
 * @returns unique literal paths, or a visible policy refusal.
 */
export function localGitScope(paths: readonly string[]): string[] {
  if (paths.length === 0) throw new RgError('RG_GIT_AUTH_REQUIRED', 'Choose at least one repository-relative file or directory for local Git delivery.')
  return [...new Set(paths.map((raw) => {
    const path = raw.trim().replace(/[/]$/, '')
    if (path === '.') return path
    if (!path || /[\\:\0\r\n]/.test(path) || path.startsWith('/')
      || path.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) {
      throw new RgError('RG_GIT_AUTH_REQUIRED', 'Use literal repository-relative paths without parent traversal or Git metadata.')
    }
    return path
  }))].sort()
}

function scopeExceedsLimit(paths: readonly string[], limit: number): boolean {
  let remaining = limit - 2 - Math.max(0, paths.length - 1)
  if (remaining < 0) return true
  for (const path of paths) {
    if (path.length > remaining - 2) return true
    remaining -= JSON.stringify(path).length
    if (remaining < 0) return true
  }
  return false
}

/** Resource owner nested under the existing RG service; it never creates or manages Agents. */
export class LocalGitDelivery {
  private backend: Backend | undefined
  private readonly operations = new Map<Agent, Set<Operation>>()
  private readonly queues = new Map<string, Promise<void>>()
  private closing = false

  constructor(private readonly ctx: Context, config: GitExecutorConfig,
    private readonly projection: ProjectionHandle<RgGitProjectionState>, cancelRoles: () => Promise<void>) {
    ctx.inject(['worktrees', 'subprocess', 'sandbox', 'sandboxPolicy'], (child) => {
      const backend: Backend = { executor: new GitExecutor(child, config), worktrees: child.worktrees }
      this.backend = backend
      child.effect(() => async () => {
        if (this.backend === backend) this.backend = undefined
        const outcomes = await Promise.allSettled([cancelRoles(), this.cancelAll()])
        const failures: unknown[] = []
        for (const outcome of outcomes) if (outcome.status === 'rejected') failures.push(outcome.reason)
        if (failures.length > 0) throw new AggregateError(failures, 'Local Git backend cleanup failed')
      })
    })
  }

  /** Read prepared delivery facts without I/O.
   * @param session - prepared owner Session.
   * @returns the current task's grant and candidate, or null in workspace mode.
   */
  read(session: Session): RgGitState | null {
    const state = this.projection.stateOf(session)
    if (state.failure !== null) throw new RgError('RG_NOT_READY', state.failure)
    return state.value
  }

  /** Whether an accepted Git operation still owns the parent.
   * @param parent - exact live owner.
   * @returns true until all accepted command and flush work settles.
   */
  busy(parent: Agent): boolean { return (this.operations.get(parent)?.size ?? 0) !== 0 }

  /** Capture an explicit human grant; this does not allocate, stage, commit, fetch, or publish.
   * @param parent - idle coordinating Agent checked by the Remote owner.
   * @param task - unused current human task.
   * @param policy - frozen RG model and scope limits.
   * @param paths - human-approved repository-relative scope.
   * @param signal - cancellation before a committed grant.
   * @param assertCurrent - revalidate the owner and task after repository inspection.
   * @returns the committed local-only authorization.
   */
  authorize(
    parent: Agent, task: RgTask, policy: RgPolicy, paths: readonly string[], signal: AbortSignal, assertCurrent: () => void,
  ): Promise<RgGitState> {
    if (this.read(parent.session) !== null) throw new RgError('RG_GIT_AUTH_REQUIRED', 'This task already has a local Git delivery grant.')
    if (paths.length > policy.maxScopeFiles || scopeExceedsLimit(paths, policy.maxHandoffChars)) {
      throw new RgError('RG_GIT_AUTH_REQUIRED', 'The complete local Git scope exceeds this Session’s configured limits.')
    }
    const scope = localGitScope(paths)
    return this.operate(parent, signal, async (control, backend) => {
      const source = await backend.executor.inspect(parent, this.ctx.workingDirectory.get(parent.session), control)
      control.throwIfAborted()
      assertCurrent()
      if (this.read(parent.session) !== null) {
        throw new RgError('RG_GIT_AUTH_REQUIRED', 'This task already has a local Git delivery grant.')
      }
      const state: RgGitState = { taskId: task.id, configurationHash: policy.configurationHash, status: 'authorized', source, scope,
        worktreeName: 'rg-' + randomUUID(), workspace: null, candidate: null, binding: null, diagnostic: null }
      await this.save(parent.session, state)
      if (JSON.stringify(this.read(parent.session)) !== JSON.stringify(state)) {
        throw new RgError('RG_GIT_CHANGED', 'The local Git grant changed during authorization. Inspect the Session before continuing.')
      }
      return state
    })
  }

  /** Refuse new tasks or roles while an outcome needs human inspection.
   * @param parent - exact coordinating owner.
   */
  assertSettled(parent: Agent): void {
    const state = this.read(parent.session)
    if (this.busy(parent)) throw new RgError('RG_BUSY', 'Wait for the accepted local Git operation to settle.')
    if (state !== null && ['unknown', 'interrupted', 'failed'].includes(state.status)) {
      throw new RgError('RG_GIT_UNKNOWN', 'Inspect the retained Git worktree, then explicitly leave local Git delivery before beginning new work.')
    }
  }

  /** Clear a completed grant, retaining every checkout, branch, and commit.
   * @param session - owner Session.
   */
  clear(session: Session): void {
    if (this.read(session) !== null) session.append('review-gated/git-state', { version: 1, state: null })
  }

  /** Recover facts only; interrupted operations are never replayed.
   * @param parent - initialized coordinating Agent.
   * @param task - restored current RG task.
   */
  recover(parent: Agent, task: RgTask | null): void {
    const state = this.read(parent.session)
    if (state === null || this.busy(parent)) return
    const completedReview = state.status === 'candidate' && state.binding?.role === 'reviewer'
      && state.binding.runId === task?.lastReview?.id && task.lastReview.status === 'completed'
      && task.lastReview.report?.kind === 'reviewer' && state.binding.candidateId === state.candidate?.id
    const settledCandidate = state.candidate === null || (state.candidate.workerRunId === task?.lastWorker?.id
      && task.lastWorker.status === 'completed' && task.lastWorker.report?.kind === 'worker'
      && task.lastWorker.report.outcome === 'completed')
    if (state.taskId !== task?.id || (state.binding !== null && !completedReview) || !settledCandidate
      || ['preparing', 'working', 'finalizing', 'reviewing'].includes(state.status)
      || task.active !== null && state.candidate?.workerRunId === task.active.id) {
      this.commit(parent.session, { ...state, status: 'interrupted', binding: null,
        diagnostic: 'Local Git delivery was interrupted. Retained worktrees, branches, index entries, and commits must be inspected; nothing was rolled back or replayed.' })
    }
  }

  /** Validate local Git requirements before reserving a role attempt.
   * @param parent - current live parent.
   * @param task - current human task.
   * @param policy - frozen limits and route policy.
   * @param role - selected one-shot role.
   * @param handoff - model-provided assignment.
   * @returns null in workspace mode or the current local-only grant.
   */
  preflight(parent: Agent, task: RgTask, policy: RgPolicy, role: 'worker' | 'reviewer', handoff: RgHandoff): RgGitState | null {
    const state = this.read(parent.session)
    if (state === null) return null
    this.assertGrant(state, task, policy)
    if (this.closing || this.backend === undefined) {
      throw new RgError('RG_GIT_UNAVAILABLE', 'Local Git delivery requires the worktrees, subprocess, sandbox, and sandboxPolicy services.')
    }
    const requested = localGitScope(handoff.scope)
    if (JSON.stringify(requested) !== JSON.stringify(state.scope)) {
      throw new RgError('RG_GIT_AUTH_REQUIRED', 'The role handoff must cover the entire human-authorized Git scope, so its report cannot be mistaken for a broader review.')
    }
    if (role === 'reviewer' && (state.candidate === null || state.candidate.workerRunId !== task.lastWorker?.id)) {
      throw new RgError('RG_GIT_CHANGED', 'A Git review requires the current Host-verified worker candidate.')
    }
    return state
  }

  /** Prepare the exact role workspace after its durable RG budget reservation.
   * @param parent - live parent, whose original permission root is preserved.
   * @param task - task holding the accepted run.
   * @param policy - frozen configuration and capture limits.
   * @param run - accepted one-shot role identity.
   * @param handoff - complete role requirements.
   * @param signal - accepted operation lifetime.
   * @returns null in workspace mode, otherwise the prepared cwd and immutable context.
   */
  prepare(parent: Agent, task: RgTask, policy: RgPolicy, run: RgRun, handoff: RgHandoff,
    signal: AbortSignal): Promise<{ cwd: string; context: string } | null> {
    const state = this.preflight(parent, task, policy, run.role, handoff)
    if (state === null) return Promise.resolve(null)
    return this.operate(parent, signal, async (control, backend) => {
      return this.exclusive(state.source.commonDir, control, async () => {
        const source = await backend.executor.inspect(parent, this.ctx.workingDirectory.get(parent.session), control)
        if (!sameRepository(source, state.source)) throw new RgError('RG_GIT_CHANGED', 'The parent no longer addresses the authorized source repository.')
        const reviewer = run.role === 'reviewer'
        const candidate = state.candidate
        if (candidate !== null) await backend.executor.verifyCandidate(parent, candidate, policy, control)
        if (JSON.stringify(this.read(parent.session)) !== JSON.stringify(state)) {
          throw new RgError('RG_GIT_CHANGED', 'The local Git grant changed during checkout preparation.')
        }
        const checkoutName = reviewer ? 'rg-review-' + randomUUID() : state.worktreeName
        const binding = { runId: run.id, role: run.role,
          candidateId: reviewer ? candidate?.id ?? null : null, checkoutName, checkout: null }
        const preparing: RgGitState = { ...state, status: reviewer ? 'reviewing' : 'preparing',
          candidate: reviewer ? candidate : null, binding, diagnostic: null }
        await this.save(parent.session, preparing)
        if (JSON.stringify(this.read(parent.session)) !== JSON.stringify(preparing)) {
          throw new RgError('RG_GIT_CHANGED', 'The local Git grant changed during checkout preparation.')
        }
        let allocating = false
        try {
          let checkout = state.workspace
          if (reviewer || checkout === null) {
            allocating = true
            const allocated = await backend.worktrees.provision(parent, { name: checkoutName,
              from: reviewer && candidate !== null ? candidate.headOid : state.source.headOid, detached: reviewer }, control)
            allocating = false
            checkout = await backend.executor.inspect(parent, allocated.path, control)
            if (checkout.commonDir !== state.source.commonDir || !checkout.linkedWorktree
              || checkout.headOid !== (reviewer ? candidate?.headOid : state.source.headOid)) {
              throw new RgError('RG_GIT_CHANGED', 'The allocated checkout does not belong to the authorized repository and exact commit.')
            }
          } else {
            const actual = await backend.executor.inspect(parent, checkout.root, control)
            if (!sameRepository(actual, checkout) || actual.branch !== checkout.branch || actual.headOid !== checkout.headOid) {
              throw new RgError('RG_GIT_CHANGED', 'The retained task checkout no longer has its expected branch and commit.')
            }
          }
          if (reviewer && candidate !== null) {
            await backend.executor.verifyCandidate(parent, { ...candidate, inspection: checkout }, policy, control)
          }
          const current = this.require(parent, task.id, run.id)
          if (JSON.stringify(current) !== JSON.stringify(preparing)) {
            throw new RgError('RG_GIT_CHANGED', 'The local Git grant changed during checkout preparation.')
          }
          const ready: RgGitState = { ...current, status: reviewer ? 'reviewing' : 'working',
            workspace: reviewer ? state.workspace : checkout, binding: { ...binding, checkout } }
          await this.save(parent.session, ready)
          if (JSON.stringify(this.read(parent.session)) !== JSON.stringify(ready)) {
            throw new RgError('RG_GIT_CHANGED', `The Git grant changed while preparing the retained checkout at ${checkout.root}. Inspect it before continuing.`)
          }
          return { cwd: checkout.root, context: JSON.stringify({ delivery: 'local-git', repository: state.source.root,
            scope: state.scope, baseOid: state.source.headOid, candidateId: reviewer ? candidate?.id ?? null : null,
            headOid: reviewer ? candidate?.headOid : checkout.headOid,
            instructions: reviewer ? 'Inspect this exact committed version. Do not modify or commit files.'
              : 'Change only the assigned files. Do not stage, commit, push, create PRs, or change Git refs; the Host finalizes verified local changes. Original uncommitted source changes are not present.' }) }
        } catch (error) { await this.fail(parent, error, state, run.id, allocating); throw error }
      })
    })
  }

  /** Finalize a completed bounded worker report into a verified local commit.
   * @param parent - coordinating owner.
   * @param runId - exact accepted worker reservation.
   * @param policy - frozen capture limits.
   * @param report - already bounded, formally captured worker report.
   * @param signal - role lifetime; no commit starts after cancellation.
   */
  finalize(parent: Agent, runId: RgRunId, policy: RgPolicy, report: RgWorkerReport, signal: AbortSignal): Promise<void> {
    const state = this.read(parent.session)
    if (state === null) return Promise.resolve()
    return this.operate(parent, signal, async (control, backend) => {
      const current = this.require(parent, state.taskId, runId)
      if (current.workspace === null || current.binding?.role !== 'worker') throw new RgError('RG_GIT_CHANGED', 'No prepared Git worker workspace belongs to this result.')
      const workspace = current.workspace
      await this.exclusive(current.source.commonDir, control, async () => {
        if (JSON.stringify(this.read(parent.session)) !== JSON.stringify(current)) {
          throw new RgError('RG_GIT_CHANGED', 'The local Git grant changed before finalization.')
        }
        const finalizing = { ...current, status: 'finalizing' as const }
        await this.save(parent.session, finalizing)
        if (JSON.stringify(this.read(parent.session)) !== JSON.stringify(finalizing)) {
          throw new RgError('RG_GIT_CHANGED', 'The local Git grant changed before finalization.')
        }
        let committed = false
        try {
          const result = await backend.executor.finalize(parent, workspace, current.source.headOid,
            workspace.headOid, current.scope, 'RG local delivery ' + String(runId), policy, control)
          committed = true
          const lostGrant = () => new RgError('RG_GIT_UNKNOWN',
            `The Git grant changed after commit ${result.headOid} was verified in ${result.inspection.root}. Inspect the retained checkout; no rollback was performed.`)
          if (JSON.stringify(this.read(parent.session)) !== JSON.stringify(finalizing)) throw lostGrant()
          const candidate = { id: brandString<RgCandidateId>('rg-candidate-' + randomUUID()), workerRunId: runId,
            inspection: result.inspection, baseOid: result.baseOid, headOid: result.headOid, treeOid: result.treeOid,
            scope: result.scope, scopeIdentity: result.scopeIdentity, validation: [...report.validation] }
          const published: RgGitState = { ...current, workspace: result.inspection, candidate, binding: null,
            status: 'candidate', diagnostic: null }
          await this.save(parent.session, published)
          if (JSON.stringify(this.read(parent.session)) !== JSON.stringify(published)) throw lostGrant()
        } catch (error) { await this.fail(parent, error, state, runId, committed, committed); throw error }
      })
    })
  }

  /** Check the worker candidate, the independent review checkout, and then the worker candidate again.
   * These sequential reads are not an atomic two-checkout snapshot or a write-permission restriction.
   * External writers can change either checkout after its final check.
   * @param parent - coordinating owner.
   * @param runId - current or last reviewer identity.
   * @param policy - frozen capture limits.
   * @param signal - cancellation.
   * @returns whether all observed candidate checks and the current candidate/reviewer binding match.
   */
  verifyReview(parent: Agent, runId: RgRunId, policy: RgPolicy, signal: AbortSignal): Promise<boolean> {
    const state = this.read(parent.session)
    if (state?.candidate === null || state?.candidate === undefined || state.binding?.runId !== runId
      || state.binding.role !== 'reviewer' || state.binding.candidateId !== state.candidate.id || state.binding.checkout === null) return Promise.resolve(false)
    const candidate = state.candidate
    const checkout = state.binding.checkout
    return this.operate(parent, signal, async (control, backend) => {
      try {
        await backend.executor.verifyCandidate(parent, candidate, policy, control)
        await backend.executor.verifyCandidate(parent, { ...candidate, inspection: checkout }, policy, control)
        await backend.executor.verifyCandidate(parent, candidate, policy, control)
        const current = this.read(parent.session)
        if (current === null || JSON.stringify(current) !== JSON.stringify(state)) return false
        if (current.status === 'reviewing') await this.save(parent.session, { ...current, status: 'candidate' })
        return true
      } catch (error) {
        control.throwIfAborted()
        if (error instanceof RgError && error.code === 'RG_GIT_UNKNOWN') throw error
        const current = this.read(parent.session)
        if (current !== null && JSON.stringify(current) === JSON.stringify(state)) {
          await this.save(parent.session, { ...current, status: 'candidate', diagnostic: error instanceof Error ? error.message : 'The Git candidate could not be verified.' })
        }
        return false
      }
    })
  }

  /** Preserve interrupted worker changes without creating a successful candidate.
   * @param parent - coordinating owner.
   * @param runId - accepted reservation.
   */
  async failedRun(parent: Agent, runId: RgRunId): Promise<void> {
    const state = this.read(parent.session)
    if (state?.binding?.runId !== runId || state.status === 'unknown' || state.status === 'failed') return
    await this.save(parent.session, { ...state, binding: null, status: 'interrupted',
      diagnostic: 'The Git role did not produce a verified delivery. Its checkout and any partial changes were retained; inspect them before explicitly leaving this delivery.' })
  }

  /** Abort accepted operations and await their last process and durable settlement.
   * @param parent - exact owner being disposed.
   */
  async cancelParent(parent: Agent): Promise<void> {
    const operations = [...this.operations.get(parent) ?? []]
    for (const operation of operations) operation.control.abort(new Error('The local Git owner was disposed.'))
    await Promise.allSettled(operations.map(operation => operation.done))
  }

  /** Stop admission and join all accepted Git operations without removing retained resources. */
  async close(): Promise<void> { this.closing = true; await this.cancelAll() }

  private async cancelAll(): Promise<void> { await Promise.all([...this.operations.keys()].map(parent => this.cancelParent(parent))) }
  private assertGrant(state: RgGitState, task: RgTask, policy: RgPolicy): void {
    if (state.taskId !== task.id || state.configurationHash !== policy.configurationHash
      || ['unknown', 'failed', 'interrupted'].includes(state.status)) throw new RgError('RG_GIT_AUTH_REQUIRED', 'This local Git grant is not usable for the current task and policy.')
  }
  private require(parent: Agent, taskId: RgTask['id'], runId: RgRunId): RgGitState {
    const state = this.read(parent.session)
    if (state === null || state.taskId !== taskId || state.binding?.runId !== runId) {
      throw new RgError('RG_GIT_CHANGED', 'The local Git reservation no longer belongs to this role result.')
    }
    return state
  }
  private commit(session: Session, state: RgGitState): void { session.append('review-gated/git-state', { version: 1, state }) }
  private async save(session: Session, state: RgGitState): Promise<void> {
    this.commit(session, state)
    const published = this.read(session)
    const owned = JSON.stringify(published) === JSON.stringify(gitStateSchema.parse(state))
    try {
      if (!await this.ctx.sessions.flush(session)) throw new Error('No Session writer completed the flush')
    } catch (error) {
      const diagnostic = 'The local Git save outcome is unknown. Inspect the Session and retained worktrees, branches, index entries, and commits before continuing.'
      if (owned && published !== null && JSON.stringify(this.read(session)) === JSON.stringify(published)) this.commit(session, { ...published, status: 'unknown', diagnostic })
      this.ctx.logger.error('RG local Git save failed: %s', error)
      throw new RgError('RG_GIT_UNKNOWN', diagnostic)
    }
  }
  private async fail(parent: Agent, error: unknown, grant: RgGitState, runId: RgRunId,
    uncertain = false, committed = false): Promise<void> {
    const state = this.read(parent.session)
    if (state === null || state.status === 'unknown' || state.taskId !== grant.taskId || state.worktreeName !== grant.worktreeName
      || (state.binding?.runId !== runId && !(committed && state.candidate?.workerRunId === runId))) return
    await this.save(parent.session, { ...state, binding: null,
      status: uncertain || error instanceof GitExecutorError && error.effect === 'unknown' ? 'unknown' : 'failed',
      diagnostic: error instanceof Error ? error.message : 'Local Git delivery failed; inspect its retained resources.' })
  }
  private operate<T>(parent: Agent, signal: AbortSignal, action: (signal: AbortSignal, backend: Backend) => Promise<T>): Promise<T> {
    if (this.closing || this.backend === undefined) throw new RgError('RG_GIT_UNAVAILABLE', 'Local Git delivery requires the worktrees, subprocess, sandbox, and sandboxPolicy services.')
    if (this.busy(parent)) throw new RgError('RG_BUSY', 'Wait for the current local Git operation to settle.')
    signal.throwIfAborted()
    const backend = this.backend
    const control = new AbortController()
    const done = Promise.withResolvers<void>()
    const operation: Operation = { control, done: done.promise }
    const operations = this.operations.get(parent) ?? new Set<Operation>()
    operations.add(operation)
    this.operations.set(parent, operations)
    return action(AbortSignal.any([signal, control.signal]), backend).finally(() => {
      operations.delete(operation)
      this.operations.delete(parent)
      done.resolve()
    })
  }
  private async exclusive<T>(key: string, signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    const prior = this.queues.get(key) ?? Promise.resolve()
    const done = Promise.withResolvers<void>()
    const tail = prior.then(() => done.promise)
    this.queues.set(key, tail)
    try { await prior; signal.throwIfAborted(); return await action() } finally {
      done.resolve()
      if (this.queues.get(key) === tail) this.queues.delete(key)
    }
  }
}
