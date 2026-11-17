import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { scanZstdFrames } from '../src/zstd.ts'
import { splitZstdFrames } from '../src/zstd-stream.ts'

const MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD])
const WORK_BYTES = 64 * 1024

function header(descriptor: number): Buffer {
  const contentSizeFlag = descriptor >>> 6
  const single = (descriptor & 0x20) !== 0
  const dictionary = [0, 1, 2, 4][descriptor & 3]!
  const contentSize = contentSizeFlag === 0 ? (single ? 1 : 0) : 1 << contentSizeFlag
  return Buffer.concat([MAGIC, Buffer.from([descriptor]), Buffer.alloc((single ? 0 : 1) + dictionary + contentSize)])
}

function block(size: number, type: number, last: boolean): Buffer {
  const result = Buffer.alloc(3)
  result.writeUIntLE((size << 3) | (type << 1) | Number(last), 0, 3)
  return result
}

function frame(descriptor: number, body: Buffer = Buffer.from([1, 0, 0])): Buffer {
  return Buffer.concat([header(descriptor), body, (descriptor & 4) === 0 ? Buffer.alloc(0) : Buffer.alloc(4)])
}

function split(input: Buffer, at: number): Buffer[] {
  return [input.subarray(0, at), input.subarray(at)]
}

async function collect(chunks: Iterable<Uint8Array> | AsyncIterable<Uint8Array>, maxWorkBytes = WORK_BYTES): Promise<{
  frames: { start: number; end: number }[]
  tornStart?: number
  error?: string
  payloads: Buffer[]
}> {
  const frames: { start: number; end: number }[] = []
  const payloads: Buffer[] = []
  let current: { start: number; end: number; pieces: Buffer[] } | undefined
  try {
    for await (const item of splitZstdFrames(chunks, { maxWorkBytes })) {
      switch (item.type) {
        case 'frame-start':
          expect(current).toBeUndefined()
          current = { start: item.start, end: item.start, pieces: [] }
          break
        case 'frame-data':
          expect(current).toBeDefined()
          expect(item.start).toBe(current!.start)
          expect(item.offset).toBe(current!.end)
          expect(item.data.byteLength).toBeGreaterThan(0)
          expect(item.data.byteLength).toBeLessThanOrEqual(maxWorkBytes)
          current!.end += item.data.byteLength
          current!.pieces.push(Buffer.from(item.data))
          break
        case 'frame-end':
          expect(current).toBeDefined()
          expect(item.start).toBe(current!.start)
          expect(item.end).toBe(current!.end)
          frames.push({ start: item.start, end: item.end })
          payloads.push(Buffer.concat(current!.pieces))
          current = undefined
          break
        case 'frame-torn':
          expect(current).toBeDefined()
          expect(item.start).toBe(current!.start)
          expect(item.end).toBe(current!.end)
          payloads.push(Buffer.concat(current!.pieces))
          return { frames, tornStart: item.start, payloads }
      }
    }
    expect(current).toBeUndefined()
    return { frames, payloads }
  } catch (error: unknown) {
    if (!(error instanceof Error)) throw error
    return { frames, payloads, error: error.message }
  }
}

async function compare(input: Buffer, chunks: Iterable<Uint8Array> | AsyncIterable<Uint8Array>, maxWorkBytes = WORK_BYTES): Promise<void> {
  let expected: ReturnType<typeof scanZstdFrames> | undefined
  let error: string | undefined
  try { expected = scanZstdFrames(input) } catch (caught: unknown) {
    if (!(caught instanceof Error)) throw caught
    error = caught.message
  }
  const actual = await collect(chunks, maxWorkBytes)
  expect(actual.error).toBe(error)
  if (expected === undefined) return
  expect({ frames: actual.frames, ...(actual.tornStart === undefined ? {} : { tornStart: actual.tornStart }) }).toEqual(expected)
  const ranges = [...expected.frames, ...(expected.tornStart === undefined ? [] : [{ start: expected.tornStart, end: input.length }])]
  expect(actual.payloads).toEqual(ranges.map(range => input.subarray(range.start, range.end)))
}

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

describe('bounded Zstandard frame splitting', () => {
  it('matches all descriptor combinations and arbitrary truncation', async () => {
    for (let descriptor = 0; descriptor < 256; descriptor++) {
      const input = frame(descriptor)
      for (let end = 0; end <= input.length; end++) {
        const prefix = input.subarray(0, end)
        await compare(prefix, split(prefix, Math.floor(end / 2)))
      }
    }
  })

  it('matches every split point of each multi-frame prefix', async () => {
    const first = zstdCompressSync(Buffer.from('header\n'), { params: { [constants.ZSTD_c_checksumFlag]: 1 } })
    const second = zstdCompressSync(Buffer.from('one\ntwo\n'), { params: { [constants.ZSTD_c_checksumFlag]: 0 } })
    const input = Buffer.concat([first, second, frame(0x24)])
    for (let end = 0; end <= input.length; end++) {
      const prefix = input.subarray(0, end)
      for (let at = 0; at <= end; at++) await compare(prefix, split(prefix, at))
    }
  })

  it('preserves byte offsets through one-byte Uint8Array views', async () => {
    const input = Buffer.concat([frame(0x24), frame(0x20)])
    const backing = Buffer.concat([Buffer.from([99]), input, Buffer.from([88])])
    const view = new Uint8Array(backing.buffer, backing.byteOffset + 1, input.length)
    const pieces = Array.from({ length: view.byteLength }, (_, index) => view.subarray(index, index + 1))
    await compare(input, pieces, 3)
  })

  it('preserves framing across work limits smaller than a header', async () => {
    const input = Buffer.concat([frame(0x24), frame(0x20, Buffer.concat([block(5, 0, true), Buffer.alloc(5, 9)]))])
    for (const maxWorkBytes of [1, 2, 3, 4, 7]) {
      for (let at = 0; at <= input.length; at++) await compare(input, split(input, at), maxWorkBytes)
    }
  })

  it('matches raw, RLE, compressed, repeated and reserved blocks', async () => {
    const cases = [
      frame(0x20, Buffer.concat([block(5, 0, true), Buffer.alloc(5, 0x42)])),
      frame(0x20, Buffer.concat([block(0x1fffff, 1, true), Buffer.from([3])])),
      frame(0x20, Buffer.concat([block(0, 1, true), Buffer.from([3])])),
      frame(0x20, Buffer.concat([block(3, 2, false), Buffer.from([1, 2, 3]), block(0, 0, true)])),
      frame(0x20, block(0, 3, true)),
      Buffer.alloc(4), Buffer.concat([MAGIC, Buffer.from([8])]),
    ]
    for (const input of cases) {
      for (let end = 0; end <= input.length; end++) {
        const prefix = input.subarray(0, end)
        for (let at = 0; at <= end; at++) await compare(prefix, split(prefix, at))
      }
    }
  })

  it('matches deterministic corrupted inputs under varied chunking', async () => {
    const base = Buffer.concat([frame(0x24), frame(0x20, Buffer.concat([block(8, 0, true), Buffer.alloc(8, 1)]))])
    let seed = 0x2468ace
    for (let i = 0; i < 300; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      const input = Buffer.from(base)
      input[seed % input.length] = (seed >>> 8) & 0xff
      const pieces: Buffer[] = []
      for (let offset = 0; offset < input.length;) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
        const end = Math.min(input.length, offset + 1 + (seed % 9))
        pieces.push(input.subarray(offset, end))
        offset = end
      }
      await compare(input, pieces)
    }
  })

  it('returns frame-aligned slices consumable by the public decoder', async () => {
    const input = Buffer.concat([
      zstdCompressSync(Buffer.from('synthetic first'), { params: { [constants.ZSTD_c_checksumFlag]: 1 } }),
      zstdCompressSync(Buffer.from('synthetic second'), { params: { [constants.ZSTD_c_checksumFlag]: 1 } }),
    ])
    const result = await collect([input], 5)
    expect(result.error).toBeUndefined()
    expect(result.payloads.map(value => zstdDecompressSync(value).toString())).toEqual(['synthetic first', 'synthetic second'])
  })

  it('marks a structurally complete bad checksum as complete without claiming integrity', async () => {
    const bytes = zstdCompressSync(Buffer.from('synthetic'), { params: { [constants.ZSTD_c_checksumFlag]: 1 } })
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff
    const result = await collect([bytes])
    expect(result.frames).toEqual([{ start: 0, end: bytes.length }])
    expect(() => zstdDecompressSync(bytes)).toThrow()
  })

  it('forwards a large multi-block frame using borrowed bounded chunks', async () => {
    const chunk = Buffer.alloc(64 * 1024, 0x41)
    const blockSize = 1024 * 1024
    const blocks = 32
    let offered = 0
    async function* source() {
      yield header(0x20)
      for (let index = 0; index < blocks; index++) {
        yield block(blockSize, 0, index === blocks - 1)
        for (let part = 0; part < blockSize / chunk.length; part++) { offered++; yield chunk }
      }
    }
    let forwarded = 0
    let borrowed = 0
    let finished = false
    for await (const item of splitZstdFrames(source(), { maxWorkBytes: WORK_BYTES })) {
      if (item.type === 'frame-data') {
        forwarded += item.data.byteLength
        if (item.data.buffer === chunk.buffer) { borrowed++; expect(item.data.byteLength).toBeLessThanOrEqual(chunk.byteLength) }
        if (offered === 1) expect(forwarded).toBeLessThan(blockSize)
      }
      if (item.type === 'frame-end') {
        expect(item).toEqual({ type: 'frame-end', start: 0, end: header(0x20).length + blocks * (3 + blockSize) })
        finished = true
      }
    }
    expect(offered).toBe(512)
    expect(borrowed).toBeGreaterThanOrEqual(512)
    expect(forwarded).toBe(header(0x20).length + blocks * (3 + blockSize))
    expect(finished).toBe(true)
  })

  it('bounds work and yields with many blocks inside one input chunk', async () => {
    const empty = block(0, 0, false)
    const input = frame(0x20, Buffer.concat([...Array.from({ length: 5000 }, () => empty), block(0, 0, true)]))
    let yielded = false
    const heartbeat = new Promise<void>(resolve => setImmediate(() => { yielded = true; resolve() }))
    let bytes = 0
    for await (const item of splitZstdFrames([input], { maxWorkBytes: 128 })) {
      if (item.type === 'frame-data') {
        expect(item.data.byteLength).toBeLessThanOrEqual(128)
        bytes += item.data.byteLength
      }
      if (item.type === 'frame-end') expect(yielded).toBe(true)
    }
    await heartbeat
    expect(bytes).toBe(input.length)
  })

  it('shares the work budget across many tiny complete frames', async () => {
    const input = Buffer.concat(Array.from({ length: 2000 }, () => frame(0x20)))
    let yielded = false
    const heartbeat = new Promise<void>(resolve => setImmediate(() => { yielded = true; resolve() }))
    let frames = 0
    for await (const item of splitZstdFrames([input], { maxWorkBytes: 128 })) {
      if (item.type === 'frame-end' && ++frames === 2000) expect(yielded).toBe(true)
    }
    await heartbeat
    expect(frames).toBe(2000)
  })

  it('rejects invalid work budgets before pulling the source', async () => {
    for (const maxWorkBytes of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      let pulls = 0
      async function* source() { pulls++; yield frame(0x20) }
      await expect(splitZstdFrames(source(), { maxWorkBytes }).next()).rejects.toThrow(RangeError)
      expect(pulls).toBe(0)
    }
  })

  it('yields to the host on empty source chunks', async () => {
    let yielded = false
    const heartbeat = new Promise<void>(resolve => setImmediate(() => { yielded = true; resolve() }))
    async function* source() {
      yield Buffer.alloc(0)
      expect(yielded).toBe(true)
      yield frame(0x20)
    }
    const result = await collect(source())
    await heartbeat
    expect(result.error).toBeUndefined()
    expect(result.frames).toEqual([{ start: 0, end: frame(0x20).length }])
  })

  it('accepts cancellation while a source emits only empty chunks', async () => {
    const abort = new AbortController()
    const reason = new Error('synthetic cancellation')
    let closed = false
    async function* source() {
      try { for (let index = 0; index < 256; index++) yield Buffer.alloc(0) } finally { closed = true }
    }
    const stopped = new Promise<void>(resolve => setImmediate(() => { abort.abort(reason); resolve() }))
    await expect(splitZstdFrames(source(), { signal: abort.signal, maxWorkBytes: WORK_BYTES }).next()).rejects.toBe(reason)
    await stopped
    expect(closed).toBe(true)
  })

  it('respects pull backpressure and closes a source on early exit', async () => {
    let pulls = 0
    let closed = false
    async function* source() {
      try { pulls++; yield frame(0x20); pulls++; yield frame(0x20) } finally { closed = true }
    }
    const iterator = splitZstdFrames(source(), { maxWorkBytes: WORK_BYTES })
    expect((await iterator.next()).value).toMatchObject({ type: 'frame-start', start: 0 })
    expect(pulls).toBe(1)
    expect((await iterator.next()).value).toMatchObject({ type: 'frame-data', start: 0, offset: 0 })
    expect(pulls).toBe(1)
    expect((await iterator.next()).value).toMatchObject({ type: 'frame-end', start: 0 })
    expect(pulls).toBe(1)
    await iterator.return(undefined)
    expect(closed).toBe(true)
    expect(pulls).toBe(1)
  })

  it('does not inspect a later invalid frame when a consumer stops at the first end', async () => {
    const good = frame(0x20)
    const input = Buffer.concat([good, Buffer.alloc(4)])
    let closed = false
    async function* source() { try { yield input } finally { closed = true } }
    const parts: string[] = []
    for await (const item of splitZstdFrames(source(), { maxWorkBytes: WORK_BYTES })) {
      parts.push(item.type)
      if (item.type === 'frame-end') break
    }
    expect(parts).toEqual(['frame-start', 'frame-data', 'frame-end'])
    expect(closed).toBe(true)
    expect(scanZstdFrames(input, 1)).toEqual({ frames: [{ start: 0, end: good.length }] })
    expect(() => scanZstdFrames(input)).toThrow('invalid frame magic')
  })

  it('retains earlier complete frame markers when a later frame is corrupt', async () => {
    const good = frame(0x20)
    const input = Buffer.concat([good, MAGIC, Buffer.from([8])])
    const result = await collect([input])
    expect(result.frames).toEqual([{ start: 0, end: good.length }])
    expect(result.payloads).toEqual([good])
    expect(result.error).toBe('corrupt Zstandard session log: reserved frame-header bit at byte ' + (good.length + 4))
  })

  it('does not pull a source when already cancelled', async () => {
    const abort = new AbortController()
    const reason = new Error('synthetic cancellation')
    abort.abort(reason)
    let pulls = 0
    async function* source() { pulls++; yield frame(0x20) }
    await expect(splitZstdFrames(source(), { signal: abort.signal, maxWorkBytes: WORK_BYTES }).next()).rejects.toBe(reason)
    expect(pulls).toBe(0)
  })

  it('cancels a tentative frame and closes its source', async () => {
    const abort = new AbortController()
    const reason = new Error('synthetic cancellation')
    let closed = false
    async function* source() { try { yield frame(0x20) } finally { closed = true } }
    const iterator = splitZstdFrames(source(), { signal: abort.signal, maxWorkBytes: WORK_BYTES })
    expect((await iterator.next()).value).toMatchObject({ type: 'frame-start' })
    expect((await iterator.next()).value).toMatchObject({ type: 'frame-data' })
    abort.abort(reason)
    await expect(iterator.next()).rejects.toBe(reason)
    expect(closed).toBe(true)
  })

  it('cancels while processing one large input chunk', async () => {
    const abort = new AbortController()
    const reason = new Error('synthetic cancellation')
    const input = frame(0x20, Buffer.concat([...Array.from({ length: 1000 }, () => block(0, 0, false)), block(0, 0, true)]))
    let closed = false
    async function* source() { try { yield input } finally { closed = true } }
    const iterator = splitZstdFrames(source(), { signal: abort.signal, maxWorkBytes: 128 })
    expect((await iterator.next()).value).toMatchObject({ type: 'frame-start' })
    expect((await iterator.next()).value).toMatchObject({ type: 'frame-data' })
    const stopped = new Promise<void>(resolve => setImmediate(() => { abort.abort(reason); resolve() }))
    await expect(iterator.next()).rejects.toBe(reason)
    await stopped
    expect(closed).toBe(true)
  })

  it('waits for an uncooperative pending source before cancellation settles', async () => {
    const abort = new AbortController()
    const reason = new Error('synthetic cancellation')
    const entered = gate(); const release = gate()
    let closed = false
    async function* source() {
      try { yield MAGIC; entered.resolve(); await release.promise; yield Buffer.from([0]) } finally { closed = true }
    }
    const iterator = splitZstdFrames(source(), { signal: abort.signal, maxWorkBytes: WORK_BYTES })
    await iterator.next(); await iterator.next()
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
    expect(closed).toBe(true)
  })

  it('propagates cancellation while a cooperative source is blocked', async () => {
    const abort = new AbortController()
    const reason = new Error('synthetic cancellation')
    const entered = gate()
    let closed = false
    async function* source() {
      try {
        yield MAGIC
        await new Promise<void>((_resolve, reject) => {
          abort.signal.addEventListener('abort', () => { reject(abort.signal.reason) }, { once: true })
          entered.resolve()
        })
      } finally { closed = true }
    }
    const iterator = splitZstdFrames(source(), { signal: abort.signal, maxWorkBytes: WORK_BYTES })
    await iterator.next(); await iterator.next()
    const pending = iterator.next()
    await entered.promise
    abort.abort(reason)
    await expect(pending).rejects.toBe(reason)
    expect(closed).toBe(true)
  })

  it('propagates a source failure without inventing a torn marker', async () => {
    const reason = new Error('synthetic source failure')
    let closed = false
    async function* source() { try { yield MAGIC; throw reason } finally { closed = true } }
    const iterator = splitZstdFrames(source(), { maxWorkBytes: WORK_BYTES })
    expect((await iterator.next()).value).toMatchObject({ type: 'frame-start' })
    expect((await iterator.next()).value).toMatchObject({ type: 'frame-data' })
    await expect(iterator.next()).rejects.toBe(reason)
    expect(closed).toBe(true)
  })

  it('closes the source after a structural error', async () => {
    let closed = false
    async function* source() { try { yield Buffer.alloc(4) } finally { closed = true } }
    const iterator = splitZstdFrames(source(), { maxWorkBytes: WORK_BYTES })
    expect((await iterator.next()).value).toMatchObject({ type: 'frame-start' })
    await expect(iterator.next()).rejects.toThrow('invalid frame magic at byte 0')
    expect(closed).toBe(true)
  })
})
