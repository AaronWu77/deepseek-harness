/** Process-local admission and drain for reference-producing operations. */
import { HarnessError } from '@deepseek-ai/dsh-error'
import type { ReferenceProducerBusy as Busy } from '@deepseek-ai/dsh-subagent'

class ReferenceProducerBusy extends HarnessError implements Busy {
  readonly reason = 'busy'

  constructor(readonly phase: Busy['phase'], message: string) {
    super(message, 'REFERENCE_PRODUCER_BUSY' satisfies Busy['code'])
    this.name = 'ReferenceProducerBusy'
  }
}

/** Maintenance cannot acquire this producer scope until its deployment opts in. */
export class ReferenceQuiescenceDisabled extends HarnessError {
  readonly reason = 'disabled'

  /** @param producer - diagnostic name of the service that has not opted in. */
  constructor(producer: string) {
    super(producer + ' reference producer coordination is disabled', 'REFERENCE_QUIESCENCE_DISABLED')
    this.name = 'ReferenceQuiescenceDisabled'
  }
}

const DEFAULT_DRAIN_TIMEOUT_MS = 30_000
const MAX_DRAIN_TIMEOUT_MS = 2_147_483_647

/** A producer service owns one instance per mount and admits work before its first asynchronous step. */
export class ReferenceProducerGate {
  private holder: string | undefined
  private admitted = 0
  private onDrained: (() => void) | undefined

  /** @param onRelease - resumes archive requests deferred by this producer. */
  constructor(private readonly onRelease: () => void) {}

  /** Whether new producer operations must not enter. */
  get held(): boolean {
    return this.holder !== undefined
  }

  /**
   * Admit one producer operation synchronously before it queues work.
   * @returns a permit to release only when that operation settles, including its cleanup.
   * @throws {ReferenceProducerBusy} while a maintenance scope owns admission.
   */
  admit(): Disposable {
    this.assertUnheld()
    this.admitted++
    let released = false
    return { [Symbol.dispose]: () => {
      if (released) return
      released = true
      if (--this.admitted === 0) this.onDrained?.()
    } }
  }

  /**
   * @param fn - producer operation to admit before it starts or joins a queue.
   * @returns The result after the admitted operation settles.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    using _permit = this.admit()
    return await fn()
  }

  /**
   * Refuse competing callers without waiting; drain earlier operations and hold new admissions closed through the callback.
   * @param holder - diagnostic name of the maintenance caller.
   * @param fn - work to finish before producer admission reopens.
   * @param options - cancellation before entry and optional drain deadline.
   * @returns the callback result.
   * @throws {ReferenceProducerBusy} when already held or the drain deadline expires.
   */
  async withQuiescence<T>(holder: string, fn: (scope: Readonly<{ holder: string }>) => Promise<T>, options?: { signal?: AbortSignal; drainTimeoutMs?: number }): Promise<T> {
    options?.signal?.throwIfAborted()
    this.assertUnheld()
    const timeoutMs = options?.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_DRAIN_TIMEOUT_MS) {
      throw new RangeError('drainTimeoutMs must be a non-negative safe timer duration')
    }
    this.holder = holder
    try {
      if (this.admitted !== 0) await this.drain(timeoutMs, options?.signal)
      options?.signal?.throwIfAborted()
      return await fn({ holder })
    } finally {
      this.holder = undefined
      this.onRelease()
    }
  }

  private assertUnheld(): void {
    if (this.holder !== undefined) {
      throw new ReferenceProducerBusy('held', 'reference producer admission is held by ' + this.holder)
    }
  }

  private async drain(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    const timedOut = () => new ReferenceProducerBusy('drain-timeout', 'admitted reference producers did not settle before the drain deadline')
    if (timeoutMs === 0) throw timedOut()
    const { promise, resolve, reject } = Promise.withResolvers<void>()
    const abort = () => reject(signal?.reason)
    this.onDrained = resolve
    const timeout = setTimeout(() => reject(timedOut()), timeoutMs)
    signal?.addEventListener('abort', abort, { once: true })
    try {
      await promise
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
      this.onDrained = undefined
    }
  }
}
