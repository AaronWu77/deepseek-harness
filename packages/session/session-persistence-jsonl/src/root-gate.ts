/** Root storage exclusion and callback-local evidence epochs. */
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  SessionAlreadyOwnedError, SessionMaintenanceDisabledError,
  type MaintenanceEpoch, type SessionMaintenanceGate, type SessionMaintenanceGateOptions,
} from '@deepseek-ai/dsh-session-persistence'
import { SessionWriteLease } from './lease.ts'
import { createDirectories, directoryChain, readIdentity } from './maintenance-fs.ts'

const LOCK_ID = SessionId('maintenance-root')

/** A blocked lifecycle operation or an unavailable root lock. */
export class SessionMaintenanceGateError extends HarnessError {
  /** @param reason - contention or lock failure. @param cause - original lock error, if any. */
  constructor(readonly reason: 'maintenance-gate' | 'io', cause?: unknown) {
    super(reason === 'maintenance-gate' ? 'Session maintenance gate is busy' : 'Session maintenance gate is unavailable',
      reason === 'maintenance-gate' ? 'SESSION_MAINTENANCE_GATE' : 'SESSION_MAINTENANCE_GATE_IO', { cause })
  }
}

interface ExclusiveScope {
  readonly gate: SessionMaintenanceGate
  readonly epoch: MaintenanceEpoch
  open: boolean
  work: Promise<unknown> | undefined
}

/** Owns root leases independently of the movable artifact directories. */
export class JsonlRootGate {
  private readonly context = new AsyncLocalStorage<ExclusiveScope>()
  private readonly path: string
  private active: ExclusiveScope | undefined

  /** @param enabled - opt-in. @param root - artifact root. @param lockRoot - stable lock directory. @param rootKey - backend root identifier. */
  constructor(private readonly enabled: boolean, private readonly root: string, private readonly lockRoot: string, private readonly rootKey: string) {
    this.path = join(lockRoot, 'root.lock')
  }

  private get current(): ExclusiveScope | undefined {
    const scope = this.context.getStore()
    return scope?.open === true ? scope : undefined
  }

  /** @returns the active callback's epoch, absent for outside or detached callers. */
  get epoch(): MaintenanceEpoch | undefined {
    return this.current?.epoch
  }

  /** @returns current root contention observed without creating any filesystem entries. */
  async status(): Promise<SessionMaintenanceGate> {
    if (!this.enabled) throw new SessionMaintenanceDisabledError()
    if (this.active !== undefined) return this.active.gate
    try {
      const lease = await this.acquire('root-shared', false)
      await this.release(lease)
      return { active: false, rootKey: this.rootKey }
    } catch (error) {
      if (error instanceof SessionMaintenanceGateError && error.reason === 'maintenance-gate') {
        return { active: true, rootKey: this.rootKey }
      }
      throw error
    }
  }

  /** @returns shared admission held until the caller releases it. */
  async enter(): Promise<() => Promise<void>> {
    const lease = await this.acquire('root-shared', true)
    return () => this.release(lease)
  }

  /**
   * @param holder - callback owner's display label.
   * @param fn - callback running under the new epoch.
   * @param options - optional cancellation before callback entry.
   * @returns the result after root ownership has been released.
   */
  async exclusive<T>(holder: string, fn: (epoch: MaintenanceEpoch) => Promise<T>, options?: SessionMaintenanceGateOptions): Promise<T> {
    if (!this.enabled) throw new SessionMaintenanceDisabledError()
    options?.signal?.throwIfAborted()
    const lease = await this.acquire('root-exclusive', true)
    const scope: ExclusiveScope = {
      gate: { active: true, holder, since: new Date().toISOString(), rootKey: this.rootKey },
      epoch: randomUUID() as MaintenanceEpoch, open: true, work: undefined,
    }
    this.active = scope
    try {
      options?.signal?.throwIfAborted()
      return await this.context.run(scope, () => fn(scope.epoch))
    } finally {
      scope.open = false
      if (scope.work !== undefined) await Promise.allSettled([scope.work])
      try {
        await this.release(lease)
      } finally {
        if (this.active === scope) this.active = undefined
      }
    }
  }

  /**
   * Prevent overlap between scans and mutations inside one owner callback.
   * @param fn - scoped operation.
   * @param unavailable - result when there is no usable idle callback scope.
   * @returns operation result or refusal.
   */
  async scoped<T>(fn: (epoch: MaintenanceEpoch) => Promise<T>, unavailable: () => T | Promise<T>): Promise<T> {
    const scope = this.current
    if (scope === undefined || scope.work !== undefined) return unavailable()
    const work = Promise.resolve().then(() => fn(scope.epoch))
    scope.work = work
    try {
      return await work
    } finally {
      scope.work = undefined
    }
  }

  private async acquire(mode: 'root-shared' | 'root-exclusive', create: boolean): Promise<SessionWriteLease | undefined> {
    try {
      const tree = await directoryChain(this.root)
      const canonical = await realpath(tree.path)
      const normalize = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path
      if (normalize(canonical) !== normalize(tree.path)) throw new Error('Session root has a noncanonical ancestor')
      if (create) await createDirectories(this.lockRoot)
      else if (!(await directoryChain(this.lockRoot)).exists) return undefined
      const file = await readIdentity(this.path)
      if (file !== undefined && (!file.isFile() || file.isSymbolicLink() || file.ino === 0n || file.nlink !== 1n)) {
        throw new Error('unsafe root lock file')
      }
      const lease = await SessionWriteLease.acquirePath(this.path, LOCK_ID, create, mode)
      if (create && lease === undefined) throw new Error('root lock was not created')
      return lease
    } catch (error) {
      throw new SessionMaintenanceGateError(error instanceof SessionAlreadyOwnedError ? 'maintenance-gate' : 'io', error)
    }
  }

  private async release(lease: SessionWriteLease | undefined): Promise<void> {
    try {
      await lease?.release()
    } catch (error) {
      throw new SessionMaintenanceGateError('io', error)
    }
  }
}
