/** Internal incremental structural framing for concatenated Zstandard logs. */

import { scheduler } from 'node:timers/promises'

const ZSTD_MAGIC = 0xFD2FB528

type Phase = 'between' | 'magic' | 'descriptor' | 'header' | 'block-header' | 'block-body' | 'checksum'

/**
 * A frame's borrowed bytes and structural disposition. Start and offset are
 * absolute byte positions; end is exclusive. An end marker does not validate
 * compressed data or its checksum. Data belonging to a frame without an end
 * marker is tentative and must not be committed.
 */
export type ZstdFramePart =
  | { type: 'frame-start'; start: number }
  | { type: 'frame-data'; start: number; offset: number; data: Uint8Array }
  | { type: 'frame-end'; start: number; end: number }
  | { type: 'frame-torn'; start: number; end: number }

/**
 * Split a concatenated Zstandard byte stream without retaining whole frames.
 *
 * Input chunks and emitted data are borrowed. The producer must keep a chunk
 * unchanged until it is pulled again; a consumer retaining emitted data past
 * the next iterator call must copy it. The splitter keeps at most one pulled
 * chunk and does not limit memory retained by the source. It pulls on demand
 * and requests and awaits the source iterator's return() when available on
 * early return or parser failure. It does not impose a total byte, frame, or
 * time limit, and never validates a checksum.
 *
 * At most maxWorkBytes input bytes are parsed between host yields, and no
 * emitted data part exceeds that limit. Empty input chunks also yield.
 * Cancellation is checked before pulling and at each output boundary. A
 * source blocked in its own next() must observe the same signal or otherwise
 * settle before cancellation can finish. An aborted or failed scan cannot
 * establish an end or torn disposition for its unfinished frame.
 *
 * @param source - contiguous bytes in source order, including empty chunks.
 * @param options - work budget and optional cancellation shared with a blocking source.
 * @returns frame boundaries and borrowed frame bytes in input order.
 */
export async function* splitZstdFrames(
  source: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  options: { maxWorkBytes: number; signal?: AbortSignal },
): AsyncGenerator<ZstdFramePart, void, void> {
  const { maxWorkBytes, signal } = options
  let phase: Phase = 'between'
  let offset = 0
  let frameStart = 0
  let magic = 0
  let magicBytes = 0
  let remaining = 0
  let checksum = false
  let blockHeader = 0
  let blockBytes = 0
  let lastBlock = false
  let workBytes = 0

  signal?.throwIfAborted()
  if (!Number.isSafeInteger(maxWorkBytes) || maxWorkBytes <= 0) {
    throw new RangeError('maxWorkBytes must be a positive safe integer')
  }
  for await (const chunk of source) {
    signal?.throwIfAborted()
    if (chunk.byteLength > Number.MAX_SAFE_INTEGER - offset) {
      throw new RangeError('Zstandard stream exceeds the safe byte-offset range')
    }
    if (chunk.byteLength === 0) {
      await scheduler.yield()
      workBytes = 0
      signal?.throwIfAborted()
      continue
    }
    let position = 0
    while (position < chunk.byteLength) {
      signal?.throwIfAborted()
      if (phase === 'between') {
        frameStart = offset
        magic = 0
        magicBytes = 0
        phase = 'magic'
        yield { type: 'frame-start', start: frameStart }
        signal?.throwIfAborted()
      }
      const start = position
      const partStart = offset
      const limit = Math.min(chunk.byteLength, position + (maxWorkBytes - workBytes))
      while (position < limit && phase !== 'between') {
        switch (phase) {
          case 'magic': {
            const count = Math.min(4 - magicBytes, limit - position)
            // oxlint-disable-next-line typescript/no-non-null-assertion -- Loop bounds guarantee the index.
            for (let i = 0; i < count; i++) magic |= chunk[position + i]! << ((magicBytes + i) * 8)
            magicBytes += count
            position += count
            offset += count
            if (magicBytes === 4) {
              if ((magic >>> 0) !== ZSTD_MAGIC) {
                throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${frameStart}`)
              }
              phase = 'descriptor'
            }
            break
          }
          case 'descriptor': {
            // oxlint-disable-next-line typescript/no-non-null-assertion -- Loop bounds guarantee the index.
            const descriptor = chunk[position]!
            position++
            offset++
            if ((descriptor & 0x18) !== 0) {
              throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`)
            }
            const contentSizeFlag = descriptor >>> 6
            const singleSegment = (descriptor & 0x20) !== 0
            checksum = (descriptor & 0x04) !== 0
            const dictionaryFlag = descriptor & 0x03
            const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
            const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
            remaining = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
            blockHeader = 0
            blockBytes = 0
            phase = remaining === 0 ? 'block-header' : 'header'
            break
          }
          case 'header': {
            const count = Math.min(remaining, limit - position)
            remaining -= count
            position += count
            offset += count
            if (remaining === 0) phase = 'block-header'
            break
          }
          case 'block-header': {
            const count = Math.min(3 - blockBytes, limit - position)
            // oxlint-disable-next-line typescript/no-non-null-assertion -- Loop bounds guarantee the index.
            for (let i = 0; i < count; i++) blockHeader |= chunk[position + i]! << ((blockBytes + i) * 8)
            blockBytes += count
            position += count
            offset += count
            if (blockBytes === 3) {
              lastBlock = (blockHeader & 1) !== 0
              const blockType = (blockHeader >>> 1) & 0x03
              if (blockType === 0x03) {
                throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`)
              }
              remaining = blockType === 0x01 ? 1 : blockHeader >>> 3
              blockHeader = 0
              blockBytes = 0
              if (remaining !== 0) phase = 'block-body'
              else if (!lastBlock) phase = 'block-header'
              else if (checksum) { phase = 'checksum'; remaining = 4 }
              else phase = 'between'
            }
            break
          }
          case 'block-body': {
            const count = Math.min(remaining, limit - position)
            remaining -= count
            position += count
            offset += count
            if (remaining === 0) {
              if (!lastBlock) phase = 'block-header'
              else if (checksum) { phase = 'checksum'; remaining = 4 }
              else phase = 'between'
            }
            break
          }
          case 'checksum': {
            const count = Math.min(remaining, limit - position)
            remaining -= count
            position += count
            offset += count
            if (remaining === 0) phase = 'between'
            break
          }
        }
      }
      workBytes += position - start
      if (position > start) {
        yield { type: 'frame-data', start: frameStart, offset: partStart, data: chunk.subarray(start, position) }
        signal?.throwIfAborted()
      }
      if (phase === 'between') {
        yield { type: 'frame-end', start: frameStart, end: offset }
        signal?.throwIfAborted()
      }
      if (workBytes === maxWorkBytes) {
        await scheduler.yield()
        workBytes = 0
        signal?.throwIfAborted()
      }
    }
  }
  signal?.throwIfAborted()
  if (phase !== 'between') yield { type: 'frame-torn', start: frameStart, end: offset }
}
