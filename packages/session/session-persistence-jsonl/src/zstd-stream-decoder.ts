/** Internal bounded, seekable decoding for structurally framed Zstandard logs. */

import { createHash, type Hash } from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { scheduler } from 'node:timers/promises'
import { constants, createZstdDecompress, type ZstdOptions } from 'node:zlib'
import { splitZstdFrames } from './zstd-stream.ts'

/** Positional reads of one caller-owned, stable, seekable source. */
export interface ZstdRangeSource {
  /**
   * Read exactly [start, end) from the same source used for all ranges.
   * Multiple iterators may be active while a scan is paused.
   * @param start - inclusive byte position.
   * @param end - exclusive byte position.
   * @param options - cancellation and the maximum yielded chunk size.
   * @returns the requested bytes in order.
   */
  readRange(start: number, end: number, options: { signal: AbortSignal; maxChunkBytes: number }): AsyncIterable<Uint8Array>
}

/** Per-operation limits; all byte and size values are safe integers. */
export interface ZstdStreamDecodeOptions {
  /** Size of the pinned source snapshot. */
  size: number
  /** Maximum source size; successful scans may read it twice. */
  maxCompressedBytes: number
  /** Maximum decoded bytes, including tentative discarded output. */
  maxDecodedBytes: number
  /** Maximum source chunk size and compressed scan work per host yield. */
  maxInputChunkBytes: number
  /** Maximum emitted data chunk size; at least Node's Z_MIN_CHUNK. */
  maxOutputChunkBytes: number
  /** Maximum Zstandard window as log2(bytes), from 10 through 31. */
  maxWindowLog: number
  /** Cancels the operation and is forwarded to every range reader. */
  signal?: AbortSignal
}

/** Source failure or disagreement with the requested exact range. */
export class ZstdRangeReadError extends Error {
  override readonly name = 'ZstdRangeReadError'
}

/** One caller-selected resource budget. */
export type ZstdStreamLimit = 'maxCompressedBytes' | 'maxDecodedBytes' | 'maxInputChunkBytes' | 'maxWindowLog' | 'maxFrames'

/** A caller-selected resource budget was exceeded. */
export class ZstdStreamLimitError extends Error {
  override readonly name = 'ZstdStreamLimitError'

  constructor(readonly limit: ZstdStreamLimit, options?: ErrorOptions) {
    super(`Zstandard ${limit} limit exceeded`, options)
  }
}

/**
 * Decoded frame candidates. Frame positions are absolute and end is exclusive;
 * data offset is relative to the frame's decoded bytes. Data is tentative until
 * frame-end or a recoverable frame-torn, and callers must discard all data for
 * a failed frame or an unrecoverable frame-torn.
 */
export type ZstdDecodedPart =
  | { type: 'frame-start'; start: number; end: number }
  | { type: 'frame-data'; start: number; offset: number; data: Uint8Array }
  | { type: 'frame-end'; start: number; end: number }
  | { type: 'frame-torn'; start: number; end: number; recoverable: boolean }

interface RangeFailure { error?: Error }
interface DecodedBudget { used: number }

type PipelineResult = { ok: true } | { ok: false; error: unknown }

function validateOptions(options: ZstdStreamDecodeOptions): void {
  for (const [name, value] of [
    ['size', options.size], ['maxCompressedBytes', options.maxCompressedBytes], ['maxDecodedBytes', options.maxDecodedBytes],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative safe integer`)
  }
  if (!Number.isSafeInteger(options.maxInputChunkBytes) || options.maxInputChunkBytes <= 0) {
    throw new RangeError('maxInputChunkBytes must be a positive safe integer')
  }
  if (!Number.isSafeInteger(options.maxOutputChunkBytes) || options.maxOutputChunkBytes < constants.Z_MIN_CHUNK) {
    throw new RangeError(`maxOutputChunkBytes must be at least ${constants.Z_MIN_CHUNK}`)
  }
  if (!Number.isInteger(options.maxWindowLog) || options.maxWindowLog < 10 || options.maxWindowLog > 31) {
    throw new RangeError('maxWindowLog must be between 10 and 31')
  }
  if (options.size > options.maxCompressedBytes) throw new ZstdStreamLimitError('maxCompressedBytes')
}

function rangeError(message: string, failure: RangeFailure, cause?: unknown): Error {
  const error = cause === undefined ? new ZstdRangeReadError(message) : new ZstdRangeReadError(message, { cause })
  failure.error = error
  return error
}

function throwRangeFailure(message: string, failure: RangeFailure, signal: AbortSignal, error: unknown): never {
  if (signal.aborted) {
    const reason = signal.reason
    if (error === reason || (error instanceof Error && error.name === 'AbortError' && error.cause === reason)) throw reason
    const sourceError = new ZstdRangeReadError(message, { cause: error })
    const combined = new AggregateError([reason, sourceError], 'Zstandard byte range failed during cancellation')
    failure.error = combined
    throw combined
  }
  throw rangeError(message, failure, error)
}

async function* checkedRange(
  source: ZstdRangeSource, start: number, end: number, signal: AbortSignal, maxChunkBytes: number, failure: RangeFailure,
): AsyncGenerator<Buffer, void, void> {
  let iterator: AsyncIterator<Uint8Array>
  try {
    iterator = source.readRange(start, end, { signal, maxChunkBytes })[Symbol.asyncIterator]()
  } catch (error: unknown) {
    throwRangeFailure('unable to open requested Zstandard byte range', failure, signal, error)
  }
  let received = 0
  let done = false
  let failed = false
  let primaryError: unknown
  try {
    for (;;) {
      signal.throwIfAborted()
      let next: IteratorResult<Uint8Array>
      try { next = await iterator.next() } catch (error: unknown) {
        throwRangeFailure('unable to read requested Zstandard byte range', failure, signal, error)
      }
      signal.throwIfAborted()
      if (next.done) { done = true; break }
      const chunk = next.value
      if (chunk.byteLength > maxChunkBytes) {
        const error = new ZstdStreamLimitError('maxInputChunkBytes')
        failure.error = error
        throw error
      }
      if (chunk.byteLength > end - start - received) throw rangeError('Zstandard byte range exceeded its requested length', failure)
      received += chunk.byteLength
      if (chunk.byteLength === 0) {
        await scheduler.yield()
        continue
      }
      // Distinct range iterators may reuse the same source-owned scratch buffer.
      yield Buffer.from(chunk)
    }
    if (received !== end - start) throw rangeError('Zstandard byte range ended before its requested length', failure)
  } catch (error: unknown) {
    failed = true
    primaryError = error
    throw error
  } finally {
    if (!done && iterator.return !== undefined) {
      try { await iterator.return() } catch (error: unknown) {
        const closeError = new ZstdRangeReadError('unable to close requested Zstandard byte range', { cause: error })
        if (failed) {
          const combined = new AggregateError([primaryError, closeError], 'Zstandard byte range and cleanup both failed')
          failure.error = combined
          throw combined
        }
        failure.error = closeError
        throw closeError
      }
    }
  }
}

function isWindowLimit(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ZSTD_error_frameParameter_windowTooLarge'
}

const TORN_DATA_ERRORS: ReadonlySet<string> = new Set([
  'Z_DATA_ERROR', 'Z_BUF_ERROR', 'ZSTD_error_prefix_unknown', 'ZSTD_error_version_unsupported',
  'ZSTD_error_frameParameter_unsupported', 'ZSTD_error_corruption_detected', 'ZSTD_error_checksum_wrong',
  'ZSTD_error_literals_headerWrong', 'ZSTD_error_dictionary_corrupted', 'ZSTD_error_dictionary_wrong',
  'ZSTD_error_tableLog_tooLarge', 'ZSTD_error_maxSymbolValue_tooLarge', 'ZSTD_error_maxSymbolValue_tooSmall',
  'ZSTD_error_srcSize_wrong',
])

function isTornDecodeFailure(error: unknown): boolean {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' && TORN_DATA_ERRORS.has(error.code)
}

async function* decodeFrame(
  source: ZstdRangeSource, start: number, end: number, torn: boolean, options: ZstdStreamDecodeOptions,
  parentSignal: AbortSignal, budget: DecodedBudget,
): AsyncGenerator<ZstdDecodedPart, void, void> {
  const controller = new AbortController()
  const forwardAbort = () => controller.abort(parentSignal.reason)
  if (parentSignal.aborted) forwardAbort()
  else parentSignal.addEventListener('abort', forwardAbort, { once: true })
  const failure: RangeFailure = {}
  let input: Readable
  try {
    input = Readable.from(checkedRange(source, start, end, controller.signal, options.maxInputChunkBytes, failure), {
      objectMode: false, highWaterMark: options.maxInputChunkBytes,
    })
  } catch (error: unknown) {
    controller.abort()
    parentSignal.removeEventListener('abort', forwardAbort)
    throw error
  }
  const decoderOptions: ZstdOptions & { readableHighWaterMark: number; writableHighWaterMark: number } = {
    chunkSize: options.maxOutputChunkBytes,
    readableHighWaterMark: options.maxOutputChunkBytes,
    writableHighWaterMark: options.maxInputChunkBytes,
    params: { [constants.ZSTD_d_windowLogMax]: options.maxWindowLog },
    ...(torn ? { finishFlush: constants.ZSTD_e_flush } : {}),
  }
  let decoder: ReturnType<typeof createZstdDecompress>
  try { decoder = createZstdDecompress(decoderOptions) } catch (error: unknown) {
    controller.abort()
    input.destroy()
    parentSignal.removeEventListener('abort', forwardAbort)
    throw error
  }
  let decoderError: unknown
  decoder.on('error', (error) => {
    if (!controller.signal.aborted) {
      decoderError = error
      controller.abort(error)
    }
  })
  const settled: Promise<PipelineResult> = pipeline(input, decoder, { signal: controller.signal }).then(
    () => ({ ok: true }), error => ({ ok: false, error }),
  )
  let processingError: unknown
  let frameOffset = 0
  let failed = false
  let primaryError: unknown
  try {
    const reader = (decoder as AsyncIterable<Buffer>)[Symbol.asyncIterator]()
    for (;;) {
      let next: IteratorResult<Buffer>
      try { next = await reader.next() } catch (error: unknown) { processingError = error; break }
      if (next.done) break
      const chunk = next.value
      parentSignal.throwIfAborted()
      if (chunk.byteLength > options.maxDecodedBytes - budget.used) {
        throw new ZstdStreamLimitError('maxDecodedBytes')
      }
      budget.used += chunk.byteLength
      for (let position = 0; position < chunk.byteLength; position += options.maxOutputChunkBytes) {
        const data = chunk.subarray(position, Math.min(chunk.byteLength, position + options.maxOutputChunkBytes))
        yield { type: 'frame-data', start, offset: frameOffset, data }
        frameOffset += data.byteLength
        parentSignal.throwIfAborted()
      }
    }
    const result = await settled
    parentSignal.throwIfAborted()
    if (failure.error !== undefined) throw failure.error
    const cause = decoderError ?? processingError ?? (result.ok ? undefined : result.error)
    if (isWindowLimit(cause)) throw new ZstdStreamLimitError('maxWindowLog', { cause })
    if (cause !== undefined) {
      if (decoderError === undefined || !isTornDecodeFailure(cause)) throw cause
      if (torn) { yield { type: 'frame-torn', start, end, recoverable: false }; return }
      throw new Error(`corrupt Zstandard session log: frame at byte ${start} failed validation`, { cause })
    }
    if (!torn && decoder.bytesWritten !== end - start) {
      throw new Error(`corrupt Zstandard session log: frame at byte ${start} was not consumed completely`)
    }
    if (torn) yield { type: 'frame-torn', start, end, recoverable: true }
    else yield { type: 'frame-end', start, end }
  } catch (error: unknown) {
    failed = true
    primaryError = error
    throw error
  } finally {
    controller.abort()
    input.destroy()
    decoder.destroy()
    await settled
    parentSignal.removeEventListener('abort', forwardAbort)
    if (failure.error !== undefined && failure.error !== primaryError) {
      if (failed) throw new AggregateError([primaryError, failure.error], 'Zstandard frame and source cleanup both failed')
      throw failure.error
    }
  }
}

/**
 * Scan frame boundaries, then decode each exact range using one public Zstd
 * stream. Complete frames require normal EOF and validate any checksum; only a
 * structurally torn last frame uses prefix flush. Recognized torn data errors
 * produce an unrecoverable marker; unknown codec, range and budget errors fail.
 * Range buffers are copied so a replay cannot overwrite the paused scanner.
 *
 * The caller owns the source and must use one pinned descriptor with positional
 * reads and verify its identity, revision and size before committing results.
 * A frame-end validates neither Session records nor source stability; callers
 * must stage the entire operation until iteration and revalidation succeed.
 * Output data is borrowed until the next iterator call. Limits are captured
 * when iteration begins. The compressed limit bounds source size; successful
 * scans may read each source byte twice. The decoded limit includes tentative
 * data that may later be discarded; stream buffers may hold additional bounded
 * data before the limit is observed. These limits are not a hard RSS cap. No
 * frame-count or elapsed-time limit is imposed; callers requiring a deadline
 * must supply a cancellation signal.
 *
 * Early return and cancellation abort and await owned streams and request source
 * iterator closure. A source blocked in next() must respond to the supplied
 * signal or otherwise settle before teardown can finish.
 *
 * @param source - stable same-descriptor positional range reader.
 * @param inputOptions - explicit byte, chunk, window and cancellation limits.
 * @returns tentative frame data and validated structural dispositions.
 */
export async function* decodeZstdFrames(
  source: ZstdRangeSource, inputOptions: ZstdStreamDecodeOptions,
): AsyncGenerator<ZstdDecodedPart, void, void> {
  const options = { ...inputOptions }
  options.signal?.throwIfAborted()
  validateOptions(options)
  const controller = new AbortController()
  const forwardAbort = () => controller.abort(options.signal?.reason)
  if (options.signal?.aborted) forwardAbort()
  else options.signal?.addEventListener('abort', forwardAbort, { once: true })
  const failure: RangeFailure = {}
  const scanner = splitZstdFrames(checkedRange(source, 0, options.size, controller.signal, options.maxInputChunkBytes, failure), {
    maxWorkBytes: options.maxInputChunkBytes, signal: controller.signal,
  })
  const budget: DecodedBudget = { used: 0 }
  let failed = false
  let primaryError: unknown
  try {
    for await (const part of scanner) {
      if (part.type !== 'frame-end' && part.type !== 'frame-torn') continue
      controller.signal.throwIfAborted()
      yield { type: 'frame-start', start: part.start, end: part.end }
      controller.signal.throwIfAborted()
      yield* decodeFrame(source, part.start, part.end, part.type === 'frame-torn', options, controller.signal, budget)
    }
    controller.signal.throwIfAborted()
    if (failure.error !== undefined) throw failure.error
  } catch (error: unknown) {
    failed = true
    primaryError = error
    throw error
  } finally {
    controller.abort()
    let closeFailed = false
    let closeError: unknown
    try { await scanner.return(undefined) } catch (error: unknown) { closeFailed = true; closeError = error }
    finally { options.signal?.removeEventListener('abort', forwardAbort) }
    if (failure.error !== undefined && failure.error !== primaryError) {
      if (!closeFailed) { closeFailed = true; closeError = failure.error }
      else if (closeError !== failure.error) closeError = new AggregateError([closeError, failure.error], 'Zstandard scanner cleanup failed')
    }
    if (closeFailed && closeError !== primaryError) {
      if (failed) throw new AggregateError([primaryError, closeError], 'Zstandard scan and source cleanup both failed')
      throw closeError
    }
  }
}

/** Limits for a two-pass replay that withholds unrecoverable torn output. */
export interface ZstdVerifiedDecodeOptions extends ZstdStreamDecodeOptions {
  /** Maximum number of frame summaries retained between passes. */
  maxFrames: number
}

type FrameDisposition = 'complete' | 'recoverable' | 'discard'
interface FrameSummary {
  start: number
  end: number
  disposition: FrameDisposition
  digest: string
}

function dispositionOf(part: Extract<ZstdDecodedPart, { type: 'frame-end' | 'frame-torn' }>): FrameDisposition {
  return part.type === 'frame-end' ? 'complete' : part.recoverable ? 'recoverable' : 'discard'
}

/**
 * Validate a bounded snapshot before replaying its decoded frame data. Plaintext
 * from an unrecoverable torn frame is never replayed to the consumer. Frame
 * ranges, dispositions, and retained decoded hashes must match between passes.
 * A recoverable torn prefix is not checksum-validated; a later extension can
 * invalidate it and requires a fresh scan, not incremental reuse.
 *
 * Both passes count toward maxDecodedBytes, including discarded plaintext.
 * At most maxFrames fixed-size summaries and the decoder's bounded buffers are
 * retained; a successful scan can read each compressed source byte four times.
 * Emitted data remains tentative: a replay, checksum, limit, sink, cancellation,
 * or later source-witness failure requires discarding the entire operation.
 * This is not an incremental cache and does not establish source immutability.
 * Callers must pin the descriptor, keep its bytes unchanged throughout the scan,
 * and revalidate its identity and revision before replacing a previous result.
 * Matching size or a weak timestamp alone cannot exclude mutation or ABA. Early
 * exit closes the active underlying iterator.
 *
 * @param source - caller-owned positional reader for one stable snapshot.
 * @param inputOptions - snapshot, chunk, work and retained-frame limits.
 * @returns tentative frame parts with failed torn-frame data withheld.
 * @internal
 */
export async function* decodeVerifiedZstdFrames(
  source: ZstdRangeSource, inputOptions: ZstdVerifiedDecodeOptions,
): AsyncGenerator<ZstdDecodedPart, void, void> {
  const options = { ...inputOptions }
  options.signal?.throwIfAborted()
  validateOptions(options)
  if (!Number.isSafeInteger(options.maxFrames) || options.maxFrames < 0) throw new RangeError('maxFrames must be a non-negative safe integer')
  const summaries: FrameSummary[] = []
  let digest: Hash | undefined
  let start = 0
  let end = 0
  let decoded = 0
  for await (const part of decodeZstdFrames(source, options)) {
    if (part.type === 'frame-start') {
      if (summaries.length >= options.maxFrames) throw new ZstdStreamLimitError('maxFrames')
      start = part.start
      end = part.end
      digest = createHash('sha256')
    } else if (part.type === 'frame-data') {
      decoded += part.data.byteLength
      // oxlint-disable-next-line typescript/no-non-null-assertion -- Loop bounds guarantee the index.
      digest!.update(part.data)
    } else {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- Loop bounds guarantee the index.
      summaries.push({ start, end, disposition: dispositionOf(part), digest: digest!.digest('hex') })
      digest = undefined
    }
  }
  let index = 0
  let expected: FrameSummary | undefined
  for await (const part of decodeZstdFrames(source, { ...options, maxDecodedBytes: options.maxDecodedBytes - decoded })) {
    if (part.type === 'frame-start') {
      expected = summaries[index]
      if (expected === undefined || part.start !== expected.start || part.end !== expected.end) {
        throw new ZstdRangeReadError('Zstandard frames changed during verified replay')
      }
      digest = createHash('sha256')
      yield part
    } else if (part.type === 'frame-data') {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- Loop bounds guarantee the index.
      digest!.update(part.data)
      // oxlint-disable-next-line typescript/no-non-null-assertion -- The frame-start branch precedes these parts.
      if (expected!.disposition !== 'discard') yield part
    } else {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- The frame-start branch precedes these parts.
      const actual = digest!.digest('hex')
      if (expected === undefined || dispositionOf(part) !== expected.disposition
        || (expected.disposition !== 'discard' && actual !== expected.digest)) {
        throw new ZstdRangeReadError('Zstandard frame data changed during verified replay')
      }
      digest = undefined
      expected = undefined
      index++
      yield part
    }
  }
  if (index !== summaries.length) throw new ZstdRangeReadError('Zstandard frames changed during verified replay')
}
