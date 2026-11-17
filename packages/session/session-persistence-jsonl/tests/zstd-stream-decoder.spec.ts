import { Context } from '@deepseek-ai/cordis'
import { SessionId, SESSION_FORMAT_VERSION, type SessionHeader } from '@deepseek-ai/dsh-session'
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { getEventListeners } from 'node:events'
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as JsonlSessionPersistence from '../src/index.ts'
import { scanLog, toHeaderLine } from '../src/format.ts'
import { scanZstdFrames } from '../src/zstd.ts'
import { decodeVerifiedZstdFrames, decodeZstdFrames, ZstdRangeReadError, ZstdStreamLimitError } from '../src/zstd-stream-decoder.ts'
import type { ZstdRangeSource, ZstdStreamDecodeOptions } from '../src/zstd-stream-decoder.ts'
import { oneTurnLog } from '../../session-persistence/tests/contract.ts'

const MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD])

function compressed(input: string | Uint8Array, checksum = true): Buffer {
  return zstdCompressSync(input, { params: { [constants.ZSTD_c_checksumFlag]: Number(checksum) } })
}

function block(size: number, type: number, last: boolean): Buffer {
  const result = Buffer.alloc(3)
  result.writeUIntLE((size << 3) | (type << 1) | Number(last), 0, 3)
  return result
}

function malformedTornAfterOutput(): Buffer {
  return Buffer.concat([
    MAGIC, Buffer.from([0x64, 0x00, 0x0f]),
    block(4096, 0, false), Buffer.alloc(4096, 0x61),
    block(4, 2, true), Buffer.alloc(4, 0xff),
  ])
}

function settings(size: number, overrides: Partial<ZstdStreamDecodeOptions> = {}): ZstdStreamDecodeOptions {
  return { size, maxCompressedBytes: size, maxDecodedBytes: 8 * 1024 * 1024, maxInputChunkBytes: 128,
    maxOutputChunkBytes: 64, maxWindowLog: 23, ...overrides }
}

class MemoryRange implements ZstdRangeSource {
  readonly calls: { start: number; end: number }[] = []
  active = 0
  closed = 0
  constructor(readonly bytes: Buffer, readonly chunkBytes = 31) {}
  readRange(start: number, end: number, options: { signal: AbortSignal; maxChunkBytes: number }):
  AsyncIterable<Uint8Array> {
    this.calls.push({ start, end })
    // oxlint-disable-next-line typescript/no-this-alias -- The returned generator needs this instance after the method returns.
    const self = this
    return (async function* () {
      self.active++
      try {
        for (let pos = start; pos < end; pos += Math.min(self.chunkBytes, options.maxChunkBytes)) {
          options.signal.throwIfAborted()
          yield self.bytes.subarray(pos, Math.min(end, pos + self.chunkBytes, pos + options.maxChunkBytes))
        }
      } finally { self.active--; self.closed++ }
    })()
  }
}

type CollectedFrame = { start: number; end: number; kind: 'complete' | 'torn'; recoverable: boolean; data: Buffer }
async function collect(source: ZstdRangeSource, options: ZstdStreamDecodeOptions): Promise<CollectedFrame[]> {
  const frames: CollectedFrame[] = []
  let current: { start: number; end: number; offset: number; pieces: Buffer[] } | undefined
  for await (const item of decodeZstdFrames(source, options)) {
    switch (item.type) {
      case 'frame-start':
        expect(current).toBeUndefined()
        current = { start: item.start, end: item.end, offset: 0, pieces: [] }
        break
      case 'frame-data':
        expect(current).toBeDefined()
        expect(item.start).toBe(current!.start)
        expect(item.offset).toBe(current!.offset)
        expect(item.data.byteLength).toBeGreaterThan(0)
        expect(item.data.byteLength).toBeLessThanOrEqual(options.maxOutputChunkBytes)
        current!.offset += item.data.byteLength
        current!.pieces.push(Buffer.from(item.data))
        break
      case 'frame-end':
        expect(current).toBeDefined()
        expect({ start: item.start, end: item.end }).toEqual({ start: current!.start, end: current!.end })
        frames.push({ start: item.start, end: item.end, kind: 'complete', recoverable: true, data: Buffer.concat(current!.pieces) })
        current = undefined
        break
      case 'frame-torn':
        expect(current).toBeDefined()
        expect({ start: item.start, end: item.end }).toEqual({ start: current!.start, end: current!.end })
        frames.push({ start: item.start, end: item.end, kind: 'torn', recoverable: item.recoverable, data: Buffer.concat(current!.pieces) })
        current = undefined
        break
    }
  }
  expect(current).toBeUndefined()
  return frames
}

function hasCause(error: unknown, expected: Error): boolean {
  if (error === expected) return true
  if (error instanceof AggregateError) return error.errors.some((item: unknown) => hasCause(item, expected))
  return error instanceof Error && error.cause !== undefined && hasCause(error.cause, expected)
}

function hasMessage(error: unknown, text: string): boolean {
  if (error instanceof AggregateError && error.errors.some((item: unknown) => hasMessage(item, text))) return true
  return error instanceof Error && (error.message.includes(text) || hasMessage(error.cause, text))
}

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

describe('bounded Zstandard frame replay', () => {
  it('accepts an empty source at zero frame and decoded budgets', async () => {
    const source = new MemoryRange(Buffer.alloc(0))
    const parts: string[] = []
    for await (const item of decodeVerifiedZstdFrames(source, { ...settings(0), maxFrames: 0, maxDecodedBytes: 0 })) parts.push(item.type)
    expect(parts).toEqual([])
    expect(source.active).toBe(0)
    const invalid = new MemoryRange(Buffer.alloc(0))
    await expect(decodeVerifiedZstdFrames(invalid, { ...settings(0), maxFrames: -1 }).next()).rejects.toThrow('maxFrames')
    expect(invalid.calls).toEqual([])
  })

  it('closes the scanner and publishes nothing when the frame-summary budget fails', async () => {
    const input = Buffer.concat([compressed('one'), compressed('two')])
    const source = new MemoryRange(input, 7)
    const output: string[] = []
    const scan = async () => {
      for await (const item of decodeVerifiedZstdFrames(source, { ...settings(input.length), maxFrames: 1 })) output.push(item.type)
    }
    await expect(scan()).rejects.toMatchObject({ name: 'ZstdStreamLimitError', limit: 'maxFrames' })
    expect(output).toEqual([])
    expect(source.active).toBe(0)
  })

  it.each([1, 2, 7, 31, 128])('replays identical frame parts with %i-byte source chunks', async (chunkBytes) => {
    const first = compressed('one\n')
    const second = compressed('two\n', false)
    const last = compressed('three\n')
    const input = Buffer.concat([first, second, last.subarray(0, last.length - 1)])
    const source = new MemoryRange(input, chunkBytes)
    const frames = new Map<number, Buffer[]>()
    const dispositions: string[] = []
    for await (const item of decodeVerifiedZstdFrames(source, { ...settings(input.length), maxFrames: 3 })) {
      if (item.type === 'frame-start') frames.set(item.start, [])
      else if (item.type === 'frame-data') frames.get(item.start)!.push(Buffer.from(item.data))
      else if (item.type === 'frame-end') dispositions.push('complete')
      else dispositions.push(item.recoverable ? 'recoverable' : 'discard')
    }
    expect(dispositions).toEqual(['complete', 'complete', 'recoverable'])
    expect([...frames.values()].map(parts => Buffer.concat(parts).toString())).toEqual(['one\n', 'two\n', 'three\n'])
    expect(source.active).toBe(0)
  })

  it('closes an active second pass when a verified consumer stops early', async () => {
    const input = compressed('prefix '.repeat(300))
    const source = new MemoryRange(input, 7)
    const controller = new AbortController()
    const iterator = decodeVerifiedZstdFrames(source, { ...settings(input.length), maxFrames: 1, signal: controller.signal })
    expect((await iterator.next()).value).toMatchObject({ type: 'frame-start' })
    await iterator.return(undefined)
    expect(source.active).toBe(0)
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })

  it('fails the whole replay when a same-sized source changes between passes', async () => {
    const before = compressed('alpha\n')
    const after = compressed('bravo\n')
    expect(after.length).toBe(before.length)
    let calls = 0
    let active = 0
    const source: ZstdRangeSource = { readRange(start, end, options) {
      const snapshot = ++calls <= 2 ? before : after
      return (async function* () {
        active++
        try {
          for (let pos = start; pos < end; pos += options.maxChunkBytes) {
            options.signal.throwIfAborted()
            yield snapshot.subarray(pos, Math.min(end, pos + options.maxChunkBytes))
          }
        } finally { active-- }
      })()
    } }
    const tentative: Buffer[] = []
    const visible: Buffer[] = [Buffer.from('previous committed snapshot')]
    const scan = async () => {
      for await (const item of decodeVerifiedZstdFrames(source, { ...settings(before.length), maxFrames: 1 })) {
        if (item.type === 'frame-data') tentative.push(Buffer.from(item.data))
      }
      visible.splice(0, visible.length, ...tentative)
    }
    await expect(scan()).rejects.toBeInstanceOf(ZstdRangeReadError)
    expect(Buffer.concat(tentative)).toEqual(Buffer.from('bravo\n'))
    expect(visible).toEqual([Buffer.from('previous committed snapshot')])
    expect(active).toBe(0)
  })

  it('rejects a bad complete-frame checksum before publishing any verified replay data', async () => {
    const first = compressed('first\n')
    const bad = compressed('second\n')
    bad[bad.length - 1] = bad[bad.length - 1]! ^ 0xff
    const input = Buffer.concat([first, bad])
    const source = new MemoryRange(input, 7)
    const output: Buffer[] = []
    const scan = async () => {
      for await (const item of decodeVerifiedZstdFrames(source, { ...settings(input.length), maxFrames: 2 })) {
        if (item.type === 'frame-data') output.push(Buffer.from(item.data))
      }
    }
    await expect(scan()).rejects.toThrow(/validation|corrupt|checksum/i)
    expect(output).toEqual([])
    expect(source.active).toBe(0)
  })

  it('propagates cancellation during verified replay and closes owned sources', async () => {
    const input = compressed('decoded frame contents '.repeat(100))
    const source = new MemoryRange(input, 7)
    const controller = new AbortController()
    const reason = new Error('synthetic consumer cancellation')
    const tentative: Buffer[] = []
    const scan = async () => {
      for await (const item of decodeVerifiedZstdFrames(source, { ...settings(input.length), maxFrames: 1, signal: controller.signal })) {
        if (item.type === 'frame-data') { tentative.push(Buffer.from(item.data)); controller.abort(reason) }
      }
    }
    await expect(scan()).rejects.toBe(reason)
    expect(tentative.length).toBeGreaterThan(0)
    expect(source.active).toBe(0)
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })

  it('withholds an unrecoverable torn frame even when the codec emitted plaintext first', async () => {
    const first = compressed('first\n')
    const input = Buffer.concat([first, malformedTornAfterOutput()])
    const raw = await collect(new MemoryRange(input, 64), settings(input.length))
    expect(raw[1]).toMatchObject({ kind: 'torn', recoverable: false })
    expect(raw[1]!.data.length).toBeGreaterThan(0)
    const source = new MemoryRange(input, 64)
    const byFrame = new Map<number, Buffer[]>()
    const dispositions: string[] = []
    for await (const item of decodeVerifiedZstdFrames(source, { ...settings(input.length), maxFrames: 2 })) {
      if (item.type === 'frame-start') byFrame.set(item.start, [])
      if (item.type === 'frame-data') byFrame.get(item.start)!.push(Buffer.from(item.data))
      if (item.type === 'frame-end') dispositions.push('complete')
      if (item.type === 'frame-torn') dispositions.push(item.recoverable ? 'recoverable' : 'discard')
    }
    expect(dispositions).toEqual(['complete', 'discard'])
    expect(Buffer.concat(byFrame.get(0)!)).toEqual(Buffer.from('first\n'))
    expect(Buffer.concat(byFrame.get(first.length)!)).toEqual(Buffer.alloc(0))
    expect(source.active).toBe(0)
  })

  it('bounds frame summaries and the combined decoded work of both passes', async () => {
    const input = Buffer.concat([compressed('first'), compressed('second')])
    const decoded = Buffer.byteLength('firstsecond')
    const run = async (maxFrames: number, maxDecodedBytes: number) => {
      const source = new MemoryRange(input)
      const output: Buffer[] = []
      for await (const item of decodeVerifiedZstdFrames(source, { ...settings(input.length), maxFrames, maxDecodedBytes })) {
        if (item.type === 'frame-data') output.push(Buffer.from(item.data))
      }
      expect(source.active).toBe(0)
      return Buffer.concat(output).toString()
    }
    expect(await run(2, 2 * decoded)).toBe('firstsecond')
    await expect(run(1, 2 * decoded)).rejects.toMatchObject({ name: 'ZstdStreamLimitError', limit: 'maxFrames' })
    await expect(run(2, 2 * decoded - 1)).rejects.toMatchObject({ name: 'ZstdStreamLimitError', limit: 'maxDecodedBytes' })
  })

  it('decodes concatenated frames independently with every source chunk size', async () => {
    const data = Buffer.concat([compressed('first\n'), compressed('second\n', false), compressed('third\n')])
    const structural = scanZstdFrames(data).frames
    for (const chunkBytes of [1, 2, 3, 7, 31, 128, data.length]) {
      const source = new MemoryRange(data, chunkBytes)
      const frames = await collect(source, settings(data.length))
      expect(frames.map(item => ({ start: item.start, end: item.end }))).toEqual(structural)
      expect(frames.map(item => item.data.toString())).toEqual(['first\n', 'second\n', 'third\n'])
      expect(frames.every(item => item.kind === 'complete')).toBe(true)
      expect(source.calls).toEqual([{ start: 0, end: data.length }, ...structural])
      expect(source.active).toBe(0)
    }
  })

  it('matches the one-shot torn-prefix oracle at every final-frame byte', async () => {
    const first = compressed('first\n')
    const tail = compressed(Buffer.from('several recoverable records\n'.repeat(80)))
    for (let cut = 1; cut < tail.length; cut++) {
      const input = Buffer.concat([first, tail.subarray(0, cut)])
      const source = new MemoryRange(input, 3)
      const result = await collect(source, settings(input.length))
      expect(result).toHaveLength(2)
      expect(result[0]).toMatchObject({ kind: 'complete', data: Buffer.from('first\n') })
      let oracle: Buffer | undefined
      try {
        oracle = zstdDecompressSync(tail.subarray(0, cut), { finishFlush: constants.ZSTD_e_flush })
      } catch (_error) {
        // The prefix is not decodable on its own.
      }
      if (oracle === undefined) expect(result[1]).toMatchObject({ kind: 'torn', recoverable: false })
      else expect(result[1]).toMatchObject({ kind: 'torn', recoverable: true, data: oracle })
      expect(source.active).toBe(0)
    }
  })

  it.each([
    [1, false], [1, true], [2, false], [2, true], [7, false], [7, true],
    [64, false], [64, true], [128, false], [128, true],
  ] as const)('matches noisy torn-prefix recovery with %i-byte chunks and checksum %s', async (chunkBytes, checksum) => {
    const noise = Buffer.alloc(4096)
    let state = 0x6a09e667
    for (let index = 0; index < noise.length; index++) {
      state ^= state << 13; state ^= state >>> 17; state ^= state << 5
      noise[index] = state & 0xff
    }
    const first = compressed('first\n')
    const tail = compressed(noise, checksum)
    const cuts = new Set([1, 2, 3, 4, 5, Math.floor(tail.length / 4), Math.floor(tail.length / 2),
      Math.floor(tail.length * 3 / 4), tail.length - 1])
    for (const cut of cuts) {
      const input = Buffer.concat([first, tail.subarray(0, cut)])
      let oracle: Buffer | undefined
      try {
        oracle = zstdDecompressSync(tail.subarray(0, cut), { finishFlush: constants.ZSTD_e_flush })
      } catch (_error) {
        // The prefix is not decodable on its own.
      }
      const source = new MemoryRange(input, chunkBytes)
      const result = await collect(source, settings(input.length))
      if (oracle === undefined) expect(result[1]).toMatchObject({ kind: 'torn', recoverable: false })
      else expect(result[1]).toMatchObject({ kind: 'torn', recoverable: true, data: oracle })
      expect(source.active).toBe(0)
    }
  })

  it('streams a long high-expansion frame within the output chunk budget', async () => {
    const length = 4 * 1024 * 1024
    const frame = compressed(Buffer.alloc(length, 0x61))
    const source = new MemoryRange(frame, 17)
    let bytes = 0
    let parts = 0
    let maximum = 0
    for await (const item of decodeZstdFrames(source, settings(frame.length, {
      maxDecodedBytes: length, maxOutputChunkBytes: 1024,
    }))) {
      if (item.type !== 'frame-data') continue
      bytes += item.data.byteLength
      parts++
      maximum = Math.max(maximum, item.data.byteLength)
      expect(item.data.every(value => value === 0x61)).toBe(true)
    }
    expect(bytes).toBe(length)
    expect(parts).toBeGreaterThan(1)
    expect(maximum).toBeLessThanOrEqual(1024)
    expect(source.active).toBe(0)
  })

  it('rejects a complete frame with a bad checksum', async () => {
    const first = compressed('first\n')
    const bad = compressed('bad checksum\n')
    bad[bad.length - 1] = bad[bad.length - 1]! ^ 0xff
    const input = Buffer.concat([first, bad])
    expect(scanZstdFrames(input).frames).toHaveLength(2)
    const source = new MemoryRange(input, 2)
    await expect(collect(source, settings(input.length))).rejects.toThrow('failed validation')
    expect(source.active).toBe(0)
  })

  it('rejects a structurally complete malformed compressed block after tentative output', async () => {
    const frame = Buffer.concat([malformedTornAfterOutput(), Buffer.alloc(4)])
    expect(scanZstdFrames(frame).frames).toEqual([{ start: 0, end: frame.length }])
    expect(() => zstdDecompressSync(frame)).toThrow()
    const source = new MemoryRange(frame, 64)
    let tentative = 0
    const read = async () => {
      for await (const item of decodeZstdFrames(source, settings(frame.length))) {
        if (item.type === 'frame-data') tentative += item.data.byteLength
      }
    }
    await expect(read()).rejects.toThrow('failed validation')
    expect(tentative).toBeGreaterThan(0)
    expect(source.active).toBe(0)
  })

  it('reports a structurally torn undecodable prefix without claiming a frame', async () => {
    const first = compressed('first\n')
    const input = Buffer.concat([first, Buffer.from([0xff])])
    expect(scanZstdFrames(input).tornStart).toBe(first.length)
    const source = new MemoryRange(input)
    const result = await collect(source, settings(input.length))
    expect(result).toHaveLength(2)
    expect(result[1]).toMatchObject({ kind: 'torn', recoverable: false })
    expect(source.active).toBe(0)
  })

  it('discards tentative torn output if the decoder later fails', async () => {
    const first = compressed('first\n')
    const input = Buffer.concat([first, malformedTornAfterOutput()])
    expect(scanZstdFrames(input).tornStart).toBe(first.length)
    expect(() => zstdDecompressSync(input.subarray(first.length), { finishFlush: constants.ZSTD_e_flush })).toThrow()
    const source = new MemoryRange(input, 64)
    const result = await collect(source, settings(input.length))
    expect(result[1]).toMatchObject({ kind: 'torn', recoverable: false })
    expect(result[1]!.data.length).toBeGreaterThan(0)
    expect(source.active).toBe(0)
  })

  it('matches the existing readZstdPrefix oracle for valid and broken torn logs', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(JsonlSessionPersistence, { root: join(tmpdir(), 'synthetic-zstd-oracle-unused') })
      const read: unknown = Reflect.get(ctx.sessionPersistence, 'readZstdPrefix')
      if (typeof read !== 'function') throw new Error('private test oracle unavailable')
      const header: SessionHeader = { id: SessionId('synthetic-only'), version: SESSION_FORMAT_VERSION, createdAt: 1, isSeeded: false }
      const headerFrame = compressed(JSON.stringify(toHeaderLine(header)) + '\n')
      const events = oneTurnLog().slice(0, 2)
      const eventFrame = compressed(events.map(event => JSON.stringify(event)).join('\n') + '\n')
      const cases = [Buffer.concat([headerFrame, eventFrame]),
        Buffer.concat([headerFrame, eventFrame.subarray(0, eventFrame.length - 1)]),
        Buffer.concat([headerFrame, malformedTornAfterOutput()])]
      for (const input of cases) {
        const oracle: unknown = await read.call(ctx.sessionPersistence, input)
        const frames = await collect(new MemoryRange(input, 11), settings(input.length))
        const bytes = Buffer.concat(frames.filter(frame => frame.kind === 'complete' || frame.recoverable).map(frame => frame.data))
        expect(oracle).toMatchObject({ events: scanLog(bytes).events })
      }
    } finally { await ctx.fiber.dispose() }
  })

  it('treats scanner short reads as source errors, not torn frames', async () => {
    const input = compressed('synthetic')
    const source: ZstdRangeSource = { readRange: async function* (start, end) { yield input.subarray(start, Math.max(start, end - 1)) } }
    await expect(collect(source, settings(input.length))).rejects.toBeInstanceOf(ZstdRangeReadError)
  })

  it('treats replay short reads as source errors, not torn frames', async () => {
    const input = Buffer.concat([compressed('first'), compressed('second')])
    let calls = 0
    const source: ZstdRangeSource = { readRange: async function* (start, end) {
      calls++
      yield input.subarray(start, calls === 1 ? end : end - 1)
    } }
    await expect(collect(source, settings(input.length))).rejects.toBeInstanceOf(ZstdRangeReadError)
  })

  it('rejects range overreads and oversized source chunks', async () => {
    const input = compressed('synthetic')
    const overread: ZstdRangeSource = { readRange: async function* (start, end) {
      yield Buffer.concat([input.subarray(start, end), Buffer.from([0])])
    } }
    await expect(collect(overread, settings(input.length))).rejects.toBeInstanceOf(ZstdRangeReadError)
    const tooLarge: ZstdRangeSource = { readRange: async function* (start, end) { yield input.subarray(start, end) } }
    await expect(collect(tooLarge, settings(input.length, { maxInputChunkBytes: 1 }))).rejects.toBeInstanceOf(ZstdStreamLimitError)
  })

  it('rejects a replay overread that arrives in a separate chunk', async () => {
    const input = compressed('synthetic')
    let calls = 0
    const source: ZstdRangeSource = { readRange: async function* (start, end) {
      calls++
      yield input.subarray(start, end)
      if (calls === 2) yield Buffer.from([0])
    } }
    await expect(collect(source, settings(input.length))).rejects.toBeInstanceOf(ZstdRangeReadError)
  })

  it('allows cancellation during repeated empty range chunks', async () => {
    const abort = new AbortController()
    const reason = new Error('synthetic cancellation')
    let active = 0
    const source: ZstdRangeSource = { readRange: async function* () {
      active++
      try { for (let index = 0; index < 256; index++) yield Buffer.alloc(0) } finally { active-- }
    } }
    const iterator = decodeZstdFrames(source, settings(1, { signal: abort.signal }))
    const stopped = new Promise<void>(resolve => setImmediate(() => { abort.abort(reason); resolve() }))
    await expect(iterator.next()).rejects.toBe(reason)
    await stopped
    expect(active).toBe(0)
  })

  it('rejects invalid options before requesting a byte range', async () => {
    const input = compressed('synthetic')
    const source = new MemoryRange(input)
    const invalid: Partial<ZstdStreamDecodeOptions>[] = [
      { size: -1 }, { size: Number.NaN }, { maxCompressedBytes: -1 }, { maxDecodedBytes: -1 },
      { maxInputChunkBytes: 0 }, { maxOutputChunkBytes: 63 }, { maxWindowLog: 9 }, { maxWindowLog: 32 },
    ]
    for (const override of invalid) await expect(collect(source, settings(input.length, override))).rejects.toBeInstanceOf(RangeError)
    expect(source.calls).toHaveLength(0)
  })

  it('accepts an empty input and an empty frame with zero decoded-byte budget', async () => {
    const empty = new MemoryRange(Buffer.alloc(0))
    expect(await collect(empty, settings(0, { maxDecodedBytes: 0 }))).toEqual([])
    const frame = compressed(Buffer.alloc(0))
    const source = new MemoryRange(frame)
    expect(await collect(source, settings(frame.length, { maxDecodedBytes: 0 }))).toMatchObject([
      { kind: 'complete', data: Buffer.alloc(0) },
    ])
    expect(source.active).toBe(0)
  })

  it('rejects a replay frame whose decoder silently leaves trailing bytes', async () => {
    const input = compressed('a longer synthetic frame with extra bytes')
    const shorter = compressed('x')
    expect(shorter.length).toBeLessThan(input.length)
    const replacement = Buffer.concat([shorter, Buffer.alloc(input.length - shorter.length)])
    let calls = 0
    const source: ZstdRangeSource = { readRange: async function* (start, end) {
      calls++
      yield (calls === 1 ? input : replacement).subarray(start, end)
    } }
    await expect(collect(source, settings(input.length))).rejects.toThrow()
  })

  it('rejects input and decompressed budgets instead of inventing zero usage', async () => {
    const input = compressed('x'.repeat(200))
    const source = new MemoryRange(input)
    await expect(collect(source, settings(input.length, { maxCompressedBytes: input.length - 1 })))
      .rejects.toBeInstanceOf(ZstdStreamLimitError)
    expect(source.calls).toHaveLength(0)
    await expect(collect(source, settings(input.length, { maxDecodedBytes: 199 }))).rejects.toBeInstanceOf(ZstdStreamLimitError)
    expect(source.active).toBe(0)
    expect((await collect(source, settings(input.length, { maxDecodedBytes: 200 })))[0]?.data.length).toBe(200)
  })

  it('enforces the decoder window budget', async () => {
    const input = compressed(Buffer.alloc(2 * 1024 * 1024, 0x61))
    const source = new MemoryRange(input)
    await expect(collect(source, settings(input.length, { maxWindowLog: 10 }))).rejects.toBeInstanceOf(ZstdStreamLimitError)
    expect(source.active).toBe(0)
  })

  it('keeps the original resource budget if the caller mutates its options', async () => {
    const input = compressed(Buffer.alloc(4096, 0x61))
    const source = new MemoryRange(input, 4)
    const options = settings(input.length, { maxDecodedBytes: 128 })
    const iterator = decodeZstdFrames(source, options)
    expect((await iterator.next()).value).toMatchObject({ type: 'frame-start' })
    expect((await iterator.next()).value).toMatchObject({ type: 'frame-data' })
    options.maxDecodedBytes = 4096
    const remaining = async () => { for await (const _item of iterator) { /* Drain until the original limit refuses. */ } }
    await expect(remaining()).rejects.toMatchObject({ name: 'ZstdStreamLimitError', limit: 'maxDecodedBytes' })
    expect(source.active).toBe(0)
  })

  it('applies decoded-byte budgets across every frame and tentative tail', async () => {
    const input = Buffer.concat([compressed('first'), compressed('second')])
    const source = new MemoryRange(input)
    await expect(collect(source, settings(input.length, { maxDecodedBytes: 10 }))).rejects.toMatchObject({
      name: 'ZstdStreamLimitError', limit: 'maxDecodedBytes',
    })
    expect((await collect(source, settings(input.length, { maxDecodedBytes: 11 }))).map(frame => frame.data.toString()))
      .toEqual(['first', 'second'])
    const torn = Buffer.concat([compressed('first'), malformedTornAfterOutput()])
    await expect(collect(new MemoryRange(torn, 64), settings(torn.length, { maxDecodedBytes: 68 }))).rejects.toMatchObject({
      name: 'ZstdStreamLimitError', limit: 'maxDecodedBytes',
    })
  })

  it('reports a window limit for a torn frame instead of discarding it', async () => {
    const frame = compressed(Buffer.alloc(2 * 1024 * 1024, 0x61))
    const input = frame.subarray(0, frame.length - 1)
    expect(scanZstdFrames(input).tornStart).toBe(0)
    const source = new MemoryRange(input)
    await expect(collect(source, settings(input.length, { maxWindowLog: 10 }))).rejects.toMatchObject({
      name: 'ZstdStreamLimitError', limit: 'maxWindowLog',
    })
    expect(source.active).toBe(0)
  })

  it('replays overlapping ranges on one synthetic read-only file descriptor', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-zstd-seek-'))
    const path = join(directory, 'fixture.zstd')
    let close: (() => Promise<void>) | undefined
    try {
      const input = Buffer.concat([compressed('first\n'), compressed('second\n')])
      await writeFile(path, input)
      const handle = await open(path, 'r')
      close = () => handle.close()
      const source: ZstdRangeSource = { readRange: async function* (start, end, options) {
        const scratch = Buffer.alloc(options.maxChunkBytes)
        for (let position = start; position < end;) {
          options.signal.throwIfAborted()
          const result = await handle.read(scratch, 0, Math.min(scratch.length, end - position), position)
          if (result.bytesRead === 0) return
          position += result.bytesRead
          yield scratch.subarray(0, result.bytesRead)
        }
      } }
      const result = await collect(source, settings(input.length, { maxInputChunkBytes: 11 }))
      expect(result.map(frame => frame.data.toString())).toEqual(['first\n', 'second\n'])
      expect((await handle.read(Buffer.alloc(1), 0, 1, 0)).bytesRead).toBe(1)
    } finally {
      await close?.()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('does not overwrite the paused scan buffer when ranges share scratch storage', async () => {
    const input = Buffer.concat([compressed('first\n'), compressed('second\n')])
    const scratch = Buffer.alloc(input.length)
    const calls: { start: number; end: number }[] = []
    const source: ZstdRangeSource = { readRange: async function* (start, end) {
      calls.push({ start, end })
      input.copy(scratch, 0, start, end)
      yield scratch.subarray(0, end - start)
    } }
    const frames = await collect(source, settings(input.length, { maxInputChunkBytes: input.length }))
    expect(frames.map(frame => frame.data.toString())).toEqual(['first\n', 'second\n'])
    expect(calls).toHaveLength(3)
  })

  it('propagates a range source error while replaying a torn frame', async () => {
    const first = compressed('first\n')
    const input = Buffer.concat([first, MAGIC.subarray(0, 3)])
    const failure = new Error('synthetic range failure')
    let calls = 0
    const source: ZstdRangeSource = { readRange: async function* (start, end) {
      calls++
      if (calls === 3) throw failure
      yield input.subarray(start, end)
    } }
    await expect(collect(source, settings(input.length))).rejects.toMatchObject({ name: 'ZstdRangeReadError', cause: failure })
  })

  it('propagates a consumer-thrown error and quiesces owned ranges', async () => {
    const input = compressed(Buffer.alloc(128 * 1024, 0x61))
    const source = new MemoryRange(input, 4)
    const abort = new AbortController()
    const thrown = new Error('synthetic consumer failure')
    const iterator = decodeZstdFrames(source, settings(input.length, { signal: abort.signal }))
    expect((await iterator.next()).value).toMatchObject({ type: 'frame-start' })
    expect((await iterator.next()).value).toMatchObject({ type: 'frame-data' })
    const pending = iterator.throw(thrown)
    const watchdog = new Promise<void>(resolve => setImmediate(() => { abort.abort(new Error('watchdog')); resolve() }))
    await expect(pending).rejects.toBe(thrown)
    await watchdog
    expect(source.active).toBe(0)
  })

  it('honors backpressure when a consumer pauses after decoded output', async () => {
    const bytes = Buffer.alloc(512 * 1024)
    let state = 0x12345678
    for (let index = 0; index < bytes.length; index++) {
      state ^= state << 13; state ^= state >>> 17; state ^= state << 5
      bytes[index] = state & 0xff
    }
    const input = compressed(bytes)
    let reads = 0
    let replayBytes = 0
    const source: ZstdRangeSource = { readRange: async function* (start, end, options) {
      const current = ++reads
      for (let position = start; position < end; position += options.maxChunkBytes) {
        options.signal.throwIfAborted()
        const chunk = input.subarray(position, Math.min(end, position + options.maxChunkBytes))
        if (current === 2) replayBytes += chunk.length
        yield chunk
      }
    } }
    const entered = gate(); const release = gate()
    let first = true
    const consuming = (async () => {
      let total = 0
      for await (const item of decodeZstdFrames(source, settings(input.length, { maxInputChunkBytes: 4096 }))) {
        if (item.type !== 'frame-data') continue
        total += item.data.byteLength
        if (first) { first = false; entered.resolve(); await release.promise }
      }
      return total
    })()
    await entered.promise
    try {
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(replayBytes).toBeLessThan(input.length)
    } finally { release.resolve() }
    expect(await consuming).toBe(bytes.length)
  })

  it('preserves scan-source cleanup failure alongside a frame validation error', async () => {
    const input = compressed('synthetic frame')
    input[input.length - 1] = input[input.length - 1]! ^ 0xff
    const cleanup = new Error('synthetic scan cleanup failure')
    let calls = 0
    let active = 0
    const source: ZstdRangeSource = { readRange: async function* (start, end) {
      const range = ++calls
      active++
      try { yield input.subarray(start, end) } finally {
        active--
        if (range === 1) throw cleanup
      }
    } }
    let failure: unknown
    try { await collect(source, settings(input.length)) } catch (error: unknown) { failure = error }
    expect(failure).toBeInstanceOf(Error)
    expect(hasCause(failure, cleanup)).toBe(true)
    expect(hasMessage(failure, 'failed validation')).toBe(true)
    expect(active).toBe(0)
  })

  it('surfaces a replay source cleanup failure on early consumer break', async () => {
    const bytes = Buffer.alloc(256 * 1024)
    let state = 0x6a09e667
    for (let index = 0; index < bytes.length; index++) {
      state ^= state << 13; state ^= state >>> 17; state ^= state << 5
      bytes[index] = state & 0xff
    }
    const input = compressed(bytes)
    const cleanup = new Error('synthetic cleanup failure')
    let calls = 0
    let active = 0
    const source: ZstdRangeSource = { readRange: async function* (start, end, options) {
      const range = ++calls
      active++
      try {
        for (let pos = start; pos < end; pos += options.maxChunkBytes) {
          options.signal.throwIfAborted()
          yield input.subarray(pos, Math.min(end, pos + options.maxChunkBytes))
        }
      } finally {
        active--
        if (range === 2) throw cleanup
      }
    } }
    const consume = async () => {
      for await (const item of decodeZstdFrames(source, settings(input.length, { maxInputChunkBytes: 4096 }))) {
        if (item.type === 'frame-data') break
      }
    }
    let failure: unknown
    try { await consume() } catch (error: unknown) { failure = error }
    expect(failure).toBeInstanceOf(Error)
    expect(hasCause(failure, cleanup)).toBe(true)
    expect(active).toBe(0)
  })

  it('detaches cancellation listeners after successful and failed scans', async () => {
    const input = compressed('synthetic')
    const outer = new AbortController()
    const signals = new Set<AbortSignal>()
    let bad = false
    let calls = 0
    const source: ZstdRangeSource = { readRange: async function* (start, end, options) {
      signals.add(options.signal)
      calls++
      yield input.subarray(start, bad && calls === 2 ? end - 1 : end)
    } }
    await collect(source, settings(input.length, { signal: outer.signal }))
    expect(getEventListeners(outer.signal, 'abort')).toHaveLength(0)
    for (const signal of signals) expect(getEventListeners(signal, 'abort')).toHaveLength(0)
    signals.clear(); bad = true; calls = 0
    await expect(collect(source, settings(input.length, { signal: outer.signal }))).rejects.toBeInstanceOf(ZstdRangeReadError)
    expect(getEventListeners(outer.signal, 'abort')).toHaveLength(0)
    for (const signal of signals) expect(getEventListeners(signal, 'abort')).toHaveLength(0)
  })

  it('does not open any range for an already-cancelled operation', async () => {
    const input = compressed('synthetic')
    const source = new MemoryRange(input)
    const abort = new AbortController()
    const reason = new Error('synthetic cancellation')
    abort.abort(reason)
    await expect(decodeZstdFrames(source, settings(input.length, { signal: abort.signal })).next()).rejects.toBe(reason)
    expect(source.calls).toHaveLength(0)
  })

  it('keeps borrowed output stable until the next consumer pull', async () => {
    const noise = Buffer.alloc(16384)
    for (let index = 0; index < noise.length; index++) noise[index] = (index * 73 + (index >>> 3)) & 0xff
    const input = compressed(noise)
    const source = new MemoryRange(input)
    const iterator = decodeZstdFrames(source, settings(input.length))
    try {
      expect((await iterator.next()).value).toMatchObject({ type: 'frame-start' })
      const next = await iterator.next()
      if (next.done || next.value.type !== 'frame-data') throw new Error('expected synthetic decoded bytes')
      const borrowed = next.value.data
      const original = Buffer.from(borrowed)
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(borrowed).toEqual(original)
    } finally { await iterator.return(undefined) }
    expect(source.active).toBe(0)
  })

  it('closes scan and replay ranges when the consumer breaks', async () => {
    const input = compressed(Buffer.alloc(256 * 1024, 0x61))
    const source = new MemoryRange(input, 4)
    for await (const item of decodeZstdFrames(source, settings(input.length))) {
      if (item.type === 'frame-data') break
    }
    expect(source.active).toBe(0)
    expect(source.closed).toBe(2)
  })

  it('isolates cancellation between concurrent scans', async () => {
    const input = compressed('independent')
    const abort = new AbortController()
    const reason = new Error('cancel only the first scan')
    const entered = gate()
    let active = 0
    const blocked: ZstdRangeSource = { readRange: async function* (_start, _end, options) {
      active++
      try {
        await new Promise<void>((_resolve, reject) => {
          options.signal.addEventListener('abort', () => { reject(options.signal.reason) }, { once: true })
          entered.resolve()
        })
      } finally { active-- }
    } }
    const pending = collect(blocked, settings(input.length, { signal: abort.signal }))
    await entered.promise
    const independent = collect(new MemoryRange(input, 3), settings(input.length))
    abort.abort(reason)
    await expect(pending).rejects.toBe(reason)
    expect((await independent)[0]).toMatchObject({ kind: 'complete', data: Buffer.from('independent') })
    expect(active).toBe(0)
  })

  it('cancels and awaits a blocked cooperative scan source', async () => {
    const abort = new AbortController()
    const reason = new Error('synthetic cancellation')
    const entered = gate()
    let active = 0
    const source: ZstdRangeSource = { readRange: async function* (_start, _end, options) {
      active++
      try {
        await new Promise<void>((_resolve, reject) => {
          options.signal.addEventListener('abort', () => { reject(options.signal.reason) }, { once: true })
          entered.resolve()
        })
      } finally { active-- }
    } }
    const iterator = decodeZstdFrames(source, settings(10, { signal: abort.signal }))
    const pending = iterator.next()
    await entered.promise
    abort.abort(reason)
    await expect(pending).rejects.toBe(reason)
    expect(active).toBe(0)
  })

  it('waits for an uncooperative replay source before cancellation settles', async () => {
    const input = compressed('synthetic')
    const abort = new AbortController()
    const reason = new Error('synthetic cancellation')
    const entered = gate(); const release = gate()
    let calls = 0
    let active = 0
    const source: ZstdRangeSource = { readRange: async function* (start, end) {
      calls++; active++
      try {
        if (calls === 1) { yield input.subarray(start, end); return }
        entered.resolve(); await release.promise
        yield input.subarray(start, end)
      } finally { active-- }
    } }
    const iterator = decodeZstdFrames(source, settings(input.length, { signal: abort.signal }))
    expect((await iterator.next()).value).toMatchObject({ type: 'frame-start' })
    const pending = iterator.next()
    await entered.promise
    let settled = false
    void pending.then(() => { settled = true }, () => { settled = true })
    try {
      abort.abort(reason)
      await Promise.resolve(); await Promise.resolve()
      expect(settled).toBe(false)
    } finally { release.resolve() }
    await expect(pending).rejects.toBe(reason)
    expect(active).toBe(0)
  })

  it('preserves a source cleanup failure that races cancellation', async () => {
    const input = compressed('synthetic')
    const abort = new AbortController()
    const reason = new Error('synthetic cancellation')
    const cleanup = new Error('synthetic cleanup during cancellation')
    const entered = gate()
    let calls = 0
    let active = 0
    const source: ZstdRangeSource = { readRange: async function* (start, end, options) {
      const range = ++calls
      active++
      try {
        if (range === 1) { yield input.subarray(start, end); return }
        await new Promise<void>((_resolve, reject) => {
          options.signal.addEventListener('abort', () => { reject(options.signal.reason) }, { once: true })
          entered.resolve()
        })
      } finally {
        active--
        if (range === 2) throw cleanup
      }
    } }
    const iterator = decodeZstdFrames(source, settings(input.length, { signal: abort.signal }))
    expect((await iterator.next()).value).toMatchObject({ type: 'frame-start' })
    const pending = iterator.next()
    await entered.promise
    abort.abort(reason)
    let failure: unknown
    try { await pending } catch (error: unknown) { failure = error }
    expect(hasCause(failure, reason)).toBe(true)
    expect(hasCause(failure, cleanup)).toBe(true)
    expect(active).toBe(0)
  })

  it('cancels and awaits a blocked cooperative replay source', async () => {
    const input = compressed('synthetic')
    const abort = new AbortController()
    const reason = new Error('synthetic cancellation')
    const entered = gate()
    let calls = 0
    let active = 0
    const source: ZstdRangeSource = { readRange: async function* (start, end, options) {
      calls++; active++
      try {
        if (calls === 1) { yield input.subarray(start, end); return }
        await new Promise<void>((_resolve, reject) => {
          options.signal.addEventListener('abort', () => { reject(options.signal.reason) }, { once: true })
          entered.resolve()
        })
      } finally { active-- }
    } }
    const iterator = decodeZstdFrames(source, settings(input.length, { signal: abort.signal }))
    expect((await iterator.next()).value).toMatchObject({ type: 'frame-start' })
    const pending = iterator.next()
    await entered.promise
    abort.abort(reason)
    await expect(pending).rejects.toBe(reason)
    expect(active).toBe(0)
  })
})
