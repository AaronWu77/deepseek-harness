/** Internal bounded raw-row scanning; outputs are tentative until later validation. */
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionHeader, SessionLogOffset as SessionLogOffsetType } from '@deepseek-ai/dsh-session'
import type { SessionFormatArtifactDecoder, SessionFormatEvent, SessionFormatEventRun, SessionFormatMigrationContext, SessionFormatRecovery } from '@deepseek-ai/dsh-session-format'
import { createTentativeV4Decoder, SessionLogRowReader } from './format.ts'

/** Limits for one decompressed current-format artifact, including its header. */
export interface TentativeScanLimits {
  /** Largest physical record, including its terminating newline if present. */
  readonly maxRecordBytes: number
  /** Largest total decompressed input, including a torn suffix. */
  readonly maxDecompressedBytes: number
  /** Largest number of emitted logical events. */
  readonly maxEvents: number
  /** Input bytes, physical rows, emitted events, and expanded source references combined. */
  readonly maxWork: number
}

/** One logical event that has not passed whole-artifact or storage validation. */
export interface TentativeSessionEvent {
  readonly kind: 'tentative'
  readonly event: SessionFormatEvent
}

/** Controls for a caller-owned, synchronous tentative scan. */
export interface TentativeScanOptions {
  readonly limits: TentativeScanLimits
  /** Receives each emitted event synchronously; the caller must discard it on any later failure. */
  readonly onEvent: (value: TentativeSessionEvent) => void
  readonly signal?: AbortSignal
  readonly recovery?: SessionFormatRecovery
}

/** Failure raised before accepting bytes or work above a caller-provided limit. */
export class TentativeScanLimitError extends Error {
  constructor(readonly limit: keyof TentativeScanLimits) {
    super('tentative session scan exceeded ' + limit + ' budget')
    this.name = 'TentativeScanLimitError'
  }
}

/** Header, cursors, and final inherited cut; not an artifact validation result. */
export interface TentativeScanResult {
  readonly kind: 'tentative'
  readonly meta: SessionHeader
  readonly inheritedEventCount: SessionLogOffsetType
  readonly committedBytes: number
  readonly inputBytes: number
  readonly eventCount: number
}

/**
 * Incremental plaintext v4 scanner with bounded record, input, event and expansion costs.
 * Caller controls chunk scheduling; cancellation is checked at each row and event.
 * @internal
 */
export class TentativeSessionLogScanner {
  private readonly limits: TentativeScanLimits
  private readonly signal: AbortSignal | undefined
  private readonly onEvent: TentativeScanOptions['onEvent']
  private readonly meta: SessionHeader
  private readonly decoder: SessionFormatArtifactDecoder
  private readonly rows: SessionLogRowReader
  private readonly output: SessionFormatMigrationContext
  private buffer = Buffer.alloc(0)
  private buffered = 0
  private inputBytes: number
  private committedBytes: number
  private eventCount = 0
  private work = 0
  private status: 'ready' | 'busy' | 'finished' | 'failed' = 'ready'
  private outputFailure = false

  /**
   * @param headerRecord - Exactly one newline-terminated current-format physical header.
   * @param options - Budgets, synchronous tentative sink, optional cancellation and recovery policy.
   */
  constructor(headerRecord: Buffer, options: TentativeScanOptions) {
    for (const [key, value] of Object.entries(options.limits)) {
      if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('tentative scan limit ' + key + ' must be a nonnegative safe integer')
    }
    this.limits = { ...options.limits }
    this.signal = options.signal
    this.onEvent = options.onEvent
    this.signal?.throwIfAborted()
    if (headerRecord.length > this.limits.maxRecordBytes) throw new TentativeScanLimitError('maxRecordBytes')
    if (headerRecord.length > this.limits.maxDecompressedBytes) throw new TentativeScanLimitError('maxDecompressedBytes')
    this.charge(headerRecord.length)
    this.charge(1)
    const parsed = createTentativeV4Decoder(headerRecord)
    this.meta = parsed.meta
    this.decoder = parsed.decoder
    this.inputBytes = headerRecord.length
    this.committedBytes = headerRecord.length
    this.output = {
      emitEvent: (event) => { this.emit(event) },
      emitRun: (run) => { this.emitRun(run) },
    }
    this.rows = new SessionLogRowReader((row) => {
      this.chargeReferences(row)
      this.decoder.decodeRow(row, this.output)
    }, options.recovery ?? 'recoverable', error =>
      error instanceof TentativeScanLimitError || this.outputFailure || this.signal?.aborted === true)
  }

  /**
   * Scan the next decompressed chunk. A failed write ends the scanner; emitted events remain tentative.
   * @param chunk - Bytes following all previous input. Retained fragments are copied before return.
   */
  write(chunk: Buffer): void {
    this.run(() => {
      if (chunk.length > this.limits.maxDecompressedBytes - this.inputBytes) throw new TentativeScanLimitError('maxDecompressedBytes')
      this.charge(chunk.length)
      const start = this.inputBytes
      this.inputBytes += chunk.length
      let from = 0
      for (let newline = chunk.indexOf(0x0A); newline !== -1; newline = chunk.indexOf(0x0A, from)) {
        this.signal?.throwIfAborted()
        const fragment = chunk.subarray(from, newline)
        if (fragment.length + 1 > this.limits.maxRecordBytes - this.buffered) throw new TentativeScanLimitError('maxRecordBytes')
        let line = fragment
        if (this.buffered !== 0) {
          this.append(fragment)
          line = this.buffer.subarray(0, this.buffered)
        }
        this.charge(1)
        if (this.rows.consume(line)) this.committedBytes = start + newline + 1
        this.buffered = 0
        from = newline + 1
      }
      this.append(chunk.subarray(from))
    })
  }

  /** Finish the decoder and return tentative metadata without claiming relationship validation. */
  finish(): TentativeScanResult {
    const result = this.run(() => ({
      kind: 'tentative' as const,
      meta: this.meta,
      inheritedEventCount: SessionLogOffset(this.decoder.finish(this.output)),
      committedBytes: this.committedBytes,
      inputBytes: this.inputBytes,
      eventCount: this.eventCount,
    }))
    this.status = 'finished'
    return result
  }

  private run<T>(operation: () => T): T {
    if (this.status !== 'ready') {
      const status = this.status
      if (status === 'busy') this.status = 'failed'
      throw new Error('tentative session scanner is ' + status + ' and cannot continue')
    }
    this.status = 'busy'
    try {
      this.signal?.throwIfAborted()
      const value = operation()
      this.signal?.throwIfAborted()
      this.assertBusy()
      this.status = 'ready'
      return value
    } catch (error: unknown) {
      this.status = 'failed'
      throw error
    }
  }

  private assertBusy(): void {
    if (this.status !== 'busy') throw new Error('tentative session scanner failed during a reentrant operation')
  }

  private charge(amount: number): void {
    if (amount > this.limits.maxWork - this.work) throw new TentativeScanLimitError('maxWork')
    this.work += amount
  }

  private append(part: Buffer): void {
    if (part.length > this.limits.maxRecordBytes - this.buffered) throw new TentativeScanLimitError('maxRecordBytes')
    if (part.length === 0) return
    const needed = this.buffered + part.length
    if (needed > this.buffer.length) {
      const capacity = Math.min(this.limits.maxRecordBytes, Math.max(needed, 64, this.buffer.length * 2))
      const next = Buffer.allocUnsafe(capacity)
      this.buffer.copy(next, 0, 0, this.buffered)
      this.buffer = next
    }
    part.copy(this.buffer, this.buffered)
    this.buffered = needed
  }

  /** Charge potential source-range expansion before the codec allocates its decoded array. */
  private chargeReferences(row: unknown): void {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) return
    const sources = (row as Record<string, unknown>)['sourceEventSeqs']
    if (!Array.isArray(sources)) return
    for (const source of sources) {
      if (Array.isArray(source) && source.length === 2) {
        const [start, end] = source
        if (typeof start === 'number' && typeof end === 'number' && Number.isSafeInteger(start)
          && Number.isSafeInteger(end) && start >= 0 && end >= start) {
          const difference = end - start
          if (difference >= this.limits.maxWork - this.work) throw new TentativeScanLimitError('maxWork')
          this.charge(difference + 1)
          continue
        }
      }
      this.charge(1)
    }
  }

  private emit(event: SessionFormatEvent): void {
    if (this.eventCount >= this.limits.maxEvents) throw new TentativeScanLimitError('maxEvents')
    this.charge(1)
    try {
      this.signal?.throwIfAborted()
      this.onEvent({ kind: 'tentative', event })
      this.signal?.throwIfAborted()
      this.assertBusy()
    } catch (error: unknown) {
      this.outputFailure = true
      throw error
    }
    this.eventCount += 1
  }

  private emitRun(run: SessionFormatEventRun): void {
    if (run.eventCount > this.limits.maxEvents - this.eventCount) throw new TentativeScanLimitError('maxEvents')
    if (run.eventCount > this.limits.maxWork - this.work) throw new TentativeScanLimitError('maxWork')
    this.signal?.throwIfAborted()
    for (const event of run.expand()) this.emit(event)
  }
}
