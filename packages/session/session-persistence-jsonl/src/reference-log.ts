/** Strict source-generation event reads without Session handles or migration. */
import { createReadStream } from 'node:fs'
import { KNOWN_SESSION_EVENT_TYPES, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { SessionFormatUnsupportedMigrationError, type SessionFormatArtifactDecoder, type SessionFormatMigrationContext } from '@deepseek-ai/dsh-session-format'
import {
  assertV4RowAdmission, RELEASED_V3_EVENT_TYPES, releasedV3SessionFormatCodec, releasedV4SessionFormatCodec,
} from '@deepseek-ai/dsh-session-format-v3-to-v4'
import type { ReferenceLogOptions, ReferenceLogSummary, SessionEventLike } from '@deepseek-ai/dsh-session-persistence'
import { type JsonlCompression } from './format.ts'
import { CorpusIncomplete, errno } from './maintenance-fs.ts'
import { decompressZstdFrame, scanZstdFrames } from './zstd.ts'

const MAX_RECORD_BYTES = 32 * 1024 * 1024
const MAX_FRAME_BYTES = 32 * 1024 * 1024
const MAX_HEADER_BYTES = 1024 * 1024
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

async function* readPlaintext(path: string, compression: JsonlCompression, signal?: AbortSignal): AsyncGenerator<Buffer> {
  const input = createReadStream(path, signal === undefined ? {} : { signal })
  if (compression === 'none') {
    yield* input
    return
  }
  let buffer = Buffer.allocUnsafe(64 * 1024)
  let used = 0
  let first = true
  for await (const chunk of input) {
    signal?.throwIfAborted()
    const needed = used + chunk.length
    if (needed > buffer.length) {
      const next = Buffer.allocUnsafe(Math.max(needed, buffer.length * 2))
      buffer.copy(next, 0, 0, used)
      buffer = next
    }
    chunk.copy(buffer, used)
    used = needed
    let offset = 0
    while (offset < used) {
      const view = buffer.subarray(offset, used)
      const frame = scanZstdFrames(view, 1).frames[0]
      const limit = first ? MAX_HEADER_BYTES : MAX_FRAME_BYTES
      if ((frame?.end ?? view.length) > limit) throw new CorpusIncomplete(first ? 'bad-header' : 'bad-event', 'Zstandard frame exceeds the reference-read size limit')
      if (frame === undefined) break
      const contents = await decompressZstdFrame(view.subarray(0, frame.end), limit)
      if (first && (contents.length === 0 || contents.indexOf(0x0A) !== contents.length - 1)) {
        throw new CorpusIncomplete('bad-header', 'first Zstandard frame must contain exactly one header line')
      }
      first = false
      yield contents
      offset += frame.end
    }
    if (offset !== 0) {
      buffer.copyWithin(0, offset, used)
      used -= offset
    }
  }
  if (used !== 0) throw new CorpusIncomplete('truncated', 'incomplete final Zstandard frame')
}

/**
 * Decode the selected physical file and emit individual source events, not an accumulated replay graph.
 * @param path - checked physical log path.
 * @param version - source generation identified by the corpus.
 * @param compression - selected physical encoding.
 * @param visit - synchronous observer; events are provisional until clean EOF.
 * @param requireActive - refuse delivery once the exclusive callback closes.
 * @param options - optional abort signal and event limit.
 * @returns counts in source-generation coordinates.
 */
export async function readReferenceLog(
  path: string, version: number, compression: JsonlCompression,
  visit: (event: SessionEventLike) => void, requireActive: () => void, options?: ReferenceLogOptions,
): Promise<ReferenceLogSummary> {
  const codec = version === 3 ? releasedV3SessionFormatCodec : version === 4 ? releasedV4SessionFormatCodec : undefined
  const known = version === 3 ? RELEASED_V3_EVENT_TYPES : KNOWN_SESSION_EVENT_TYPES
  if (codec === undefined) throw new CorpusIncomplete('unsupported-generation', 'unsupported reference log generation: ' + version)
  const signal = options?.signal
  const maxEvents = options?.maxEvents ?? Infinity
  if (options?.maxEvents !== undefined && (!Number.isSafeInteger(maxEvents) || maxEvents < 0)) {
    throw new CorpusIncomplete('event-limit', 'maxEvents must be a nonnegative safe integer')
  }
  let events = 0
  let decoder: SessionFormatArtifactDecoder | undefined
  let fragments: Buffer[] = []
  let bytes = 0
  const output: SessionFormatMigrationContext = {
    emitEvent(event) {
      requireActive()
      signal?.throwIfAborted()
      if (events >= maxEvents) throw new CorpusIncomplete('event-limit', 'reference log exceeds maxEvents')
      if (event.seq !== events) throw new CorpusIncomplete('bad-event', 'event sequence is not contiguous')
      if (!known.has(event.type) && event['ignorable'] !== true) {
        throw new CorpusIncomplete('unsupported-generation', 'unknown required event: ' + event.type)
      }
      try {
        visit({ ...event, ...(event['ignorable'] === true ? { ignorable: true } : {}) })
      } catch (error) {
        throw new CorpusIncomplete('visitor', error instanceof Error ? error.message : String(error))
      }
      events++
    },
    emitRun(run) {
      if (run.eventCount > maxEvents - events) throw new CorpusIncomplete('event-limit', 'reference log exceeds maxEvents')
      for (const event of run.expand()) this.emitEvent(event)
    },
  }
  try {
    requireActive()
    signal?.throwIfAborted()
    for await (const chunk of readPlaintext(path, compression, signal)) {
      requireActive()
      for (let start = 0; start < chunk.length;) {
        const end = chunk.indexOf(0x0A, start)
        const fragment = chunk.subarray(start, end === -1 ? chunk.length : end)
        bytes += fragment.length
        if (bytes > (decoder === undefined ? MAX_HEADER_BYTES : MAX_RECORD_BYTES)) {
          throw new CorpusIncomplete(decoder === undefined ? 'bad-header' : 'bad-event', 'JSONL record exceeds the reference-read size limit')
        }
        if (end === -1) {
          fragments.push(fragment)
          break
        }
        const line = fragments.length === 0 ? fragment : Buffer.concat([...fragments, fragment], bytes)
        fragments = []
        bytes = 0
        const value: unknown = JSON.parse(utf8.decode(line))
        if (decoder === undefined) decoder = codec.createDecoder(value, 'strict')
        else {
          if (version === 4) assertV4RowAdmission(value, known)
          decoder.decodeRow(value, output)
        }
        start = end + 1
      }
    }
    signal?.throwIfAborted()
    if (bytes !== 0) throw new CorpusIncomplete('truncated', 'unterminated final JSONL record')
    if (decoder === undefined) throw new CorpusIncomplete('bad-header', 'missing reference log header')
    return { events, inheritedEventCount: SessionLogOffset(decoder.finish(output)) }
  } catch (error) {
    if (signal?.aborted) throw new CorpusIncomplete('aborted', 'reference log read cancelled')
    if (error instanceof CorpusIncomplete) throw error
    if (error instanceof SessionFormatUnsupportedMigrationError) throw new CorpusIncomplete('unsupported-generation', error.message)
    const code = errno(error)
    if (code !== undefined && /^E[A-Z]+$/u.test(code)) throw error
    throw new CorpusIncomplete(decoder === undefined ? 'bad-header' : 'bad-event', error instanceof Error ? error.message : String(error))
  }
}
