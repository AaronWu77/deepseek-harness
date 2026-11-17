import { constants, zstdCompressSync } from 'node:zlib'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionFormatEvent } from '@deepseek-ai/dsh-session-format'
import { SessionFormatUnsupportedError, validateStoredEvents } from '@deepseek-ai/dsh-session-persistence'
import { describe, expect, it, vi } from 'vitest'
import { meta, oneTurnLog } from '../../session-persistence/tests/contract.ts'
import { scanLog, SessionLogScanner, toHeaderLine } from '../src/format.ts'
import { TentativeSessionLogScanner } from '../src/format-stream.ts'
import type { TentativeScanLimits } from '../src/format-stream.ts'
import { decodeVerifiedZstdFrames, decodeZstdFrames } from '../src/zstd-stream-decoder.ts'
import type { ZstdRangeSource } from '../src/zstd-stream-decoder.ts'

const limits: TentativeScanLimits = {
  maxRecordBytes: 16_384, maxDecompressedBytes: 131_072, maxEvents: 1_000, maxWork: 1_000_000,
}
const line = (value: unknown): Buffer => Buffer.from(JSON.stringify(value) + '\n')
const header = (seeded = false): Buffer => line(toHeaderLine({ ...meta('synthetic-stream'), isSeeded: seeded }, SessionLogOffset(0)))
const bodyOf = (rows: readonly unknown[]): Buffer => Buffer.concat(rows.map(line))
const smallEvents = () => [oneTurnLog()[0], { ...oneTurnLog()[5], seq: 1 }]

function failureOf(action: () => void): unknown {
  try { action() } catch (error: unknown) { return error }
  throw new Error('expected the operation to fail')
}

function expectTerminal(scanner: TentativeSessionLogScanner): void {
  expect(() => scanner.write(Buffer.alloc(0))).toThrow(/failed|finished|terminal|closed/)
  expect(() => scanner.finish()).toThrow(/failed|finished|terminal|closed/)
}

function scannerFor(head: Buffer, overrides: Partial<TentativeScanLimits> = {}) {
  const events: SessionFormatEvent[] = []
  const scanner = new TentativeSessionLogScanner(head, { limits: { ...limits, ...overrides }, onEvent: (output) => { expect(output.kind).toBe('tentative'); events.push(output.event) } })
  return { scanner, events }
}


function frame(data: Buffer): Buffer {
  return zstdCompressSync(data, { params: { [constants.ZSTD_c_checksumFlag]: 1 } })
}

function memorySource(bytes: Buffer, step = 17): ZstdRangeSource {
  return { async *readRange(start, end, options) {
    for (let position = start; position < end; position += Math.min(step, options.maxChunkBytes)) {
      options.signal.throwIfAborted()
      yield bytes.subarray(position, Math.min(end, position + step, position + options.maxChunkBytes))
    }
  } }
}

function tornAfterValidRow(row: Buffer): Buffer {
  const raw = Buffer.alloc(4096, 0x20)
  if (row.length > raw.length) throw new Error('synthetic row too long')
  row.copy(raw)
  const blockHeader = (size: number, type: number, last: boolean): Buffer => {
    const block = Buffer.alloc(3)
    block.writeUIntLE((size << 3) | (type << 1) | Number(last), 0, 3)
    return block
  }
  return Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x64, 0x00, 0x0f]),
    blockHeader(4096, 0, false), raw, blockHeader(4, 2, true), Buffer.alloc(4, 0xff)])
}

async function scannedFrameRows(bytes: Buffer, verified = true, chunkBytes = 17): Promise<SessionFormatEvent[]> {
  const { scanner, events } = scannerFor(header())
  const options = { size: bytes.length, maxCompressedBytes: bytes.length, maxDecodedBytes: 131_072,
    maxInputChunkBytes: 64, maxOutputChunkBytes: 64, maxWindowLog: 23 }
  const source = memorySource(bytes, chunkBytes)
  const frames = verified ? decodeVerifiedZstdFrames(source, { ...options, maxFrames: 16 }) : decodeZstdFrames(source, options)
  for await (const item of frames) if (item.type === 'frame-data') scanner.write(Buffer.from(item.data))
  scanner.finish()
  return events
}

describe('bounded tentative v4 row scanning', () => {
  it.each([1, 2, 17, 64])('scans a header and row split across frames with %i-byte input chunks', async (chunkBytes) => {
    const head = header()
    const [first, second] = smallEvents()
    const firstRow = line(first)
    const secondRow = line(second)
    const input = Buffer.concat([
      frame(head.subarray(0, 13)),
      frame(Buffer.concat([head.subarray(13), firstRow.subarray(0, 11)])),
      frame(Buffer.concat([firstRow.subarray(11), secondRow])),
    ])
    const events: SessionFormatEvent[] = []
    let scanner: TentativeSessionLogScanner | undefined
    let pending = Buffer.alloc(0)
    const options = { size: input.length, maxCompressedBytes: input.length, maxDecodedBytes: 131_072,
      maxInputChunkBytes: 64, maxOutputChunkBytes: 64, maxWindowLog: 23, maxFrames: 3 }
    for await (const item of decodeVerifiedZstdFrames(memorySource(input, chunkBytes), options)) {
      if (item.type !== 'frame-data') continue
      let data = Buffer.from(item.data)
      if (scanner === undefined) {
        const newline = data.indexOf(0x0a)
        const prefix = newline === -1 ? data : data.subarray(0, newline + 1)
        if (prefix.length > limits.maxRecordBytes - pending.length) throw new Error('synthetic header exceeds bound')
        pending = Buffer.concat([pending, prefix])
        if (newline === -1) continue
        scanner = new TentativeSessionLogScanner(pending, { limits, onEvent: (value) => { events.push(value.event) } })
        data = data.subarray(newline + 1)
      }
      scanner.write(data)
    }
    expect(scanner).toBeDefined()
    const result = scanner!.finish()
    const old = scanLog(Buffer.concat([head, firstRow, secondRow]))
    expect(events).toEqual(old.events)
    expect(result.committedBytes).toBe(old.committedBytes)
  })

  it('cancels a scanner sink during replay without committing its tentative row', async () => {
    const input = frame(line(smallEvents()[0]))
    const controller = new AbortController()
    const reason = new Error('synthetic sink cancellation')
    const staged: SessionFormatEvent[] = []
    const visible = ['previous snapshot']
    let active = 0
    const source: ZstdRangeSource = { async *readRange(start, end, options) {
      active++
      try {
        for (let position = start; position < end; position += options.maxChunkBytes) {
          options.signal.throwIfAborted()
          yield input.subarray(position, Math.min(end, position + options.maxChunkBytes))
        }
      } finally { active-- }
    } }
    const scanner = new TentativeSessionLogScanner(header(), { limits, signal: controller.signal, onEvent: (value) => {
      staged.push(value.event)
      controller.abort(reason)
    } })
    const scan = async () => {
      const options = { size: input.length, maxCompressedBytes: input.length, maxDecodedBytes: 131_072,
        maxInputChunkBytes: 64, maxOutputChunkBytes: 64, maxWindowLog: 23, maxFrames: 1, signal: controller.signal }
      for await (const item of decodeVerifiedZstdFrames(source, options)) if (item.type === 'frame-data') scanner.write(Buffer.from(item.data))
      scanner.finish()
      visible.splice(0, visible.length, 'new snapshot')
    }
    await expect(scan()).rejects.toBe(reason)
    expect(staged).toHaveLength(1)
    expect(visible).toEqual(['previous snapshot'])
    expect(active).toBe(0)
    expectTerminal(scanner)
  })

  it('never feeds rolled-back torn plaintext rows to the append-only scanner', async () => {
    const [first, invalid] = smallEvents()
    const input = Buffer.concat([frame(line(first)), tornAfterValidRow(line(invalid))])
    expect(await scannedFrameRows(input, false)).toEqual([first, invalid])
    for (const chunkBytes of [1, 2, 7, 17, 64]) expect(await scannedFrameRows(input, true, chunkBytes)).toEqual([first])
  })

  it('replaces whole tentative snapshots on torn extension, completion, truncation and bad CRC', async () => {
    const [first, second] = smallEvents()
    const base = frame(line(first))
    const tail = frame(line(second))
    const input = (length: number) => Buffer.concat([base, tail.subarray(0, length)])
    let visible = await scannedFrameRows(input(tail.length - 1))
    expect(visible).toEqual([first, second])
    visible = await scannedFrameRows(input(tail.length))
    expect(visible).toEqual([first, second])
    visible = await scannedFrameRows(input(4))
    expect(visible).toEqual([first])
    visible = await scannedFrameRows(input(tail.length))
    const beforeFailure = visible
    const corrupt = Buffer.from(tail)
    corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 0xff
    await expect(scannedFrameRows(Buffer.concat([base, corrupt]))).rejects.toThrow(/validation|checksum|corrupt/i)
    expect(visible).toBe(beforeFailure)
    expect(visible).toEqual([first, second])
  })

  it('emits tentative events during writes and matches the existing scanner for a valid log', () => {
    const head = header()
    const rows = smallEvents()
    const body = bodyOf(rows)
    const expected = scanLog(Buffer.concat([head, body]))
    const { scanner, events } = scannerFor(head)
    scanner.write(line(rows[0]))
    expect(events).toEqual([rows[0]])
    scanner.write(line(rows[1]))
    const result = scanner.finish()
    expect(result).toMatchObject({ kind: 'tentative', meta: expected.meta, inheritedEventCount: expected.inheritedEventCount,
      committedBytes: expected.committedBytes, inputBytes: head.length + body.length, eventCount: expected.events.length })
    expect(events).toEqual(expected.events)
    expect(() => scanner.write(Buffer.alloc(0))).toThrow(/finished|closed|terminal/)
  })

  it('matches existing decoding across every byte boundary and copies reused input', () => {
    const head = header()
    const body = Buffer.from(oneTurnLog().map(event => JSON.stringify(event)).join('\n').replace('hi', '你好🌿') + '\n')
    const expected = scanLog(Buffer.concat([head, body]))
    const { scanner, events } = scannerFor(head)
    for (const byte of body) {
      const chunk = Buffer.from([byte])
      scanner.write(chunk)
      chunk.fill(0)
    }
    const result = scanner.finish()
    expect(events).toEqual(expected.events)
    expect(result.committedBytes).toBe(expected.committedBytes)
    expect(result.inheritedEventCount).toBe(expected.inheritedEventCount)
  })

  it('uses the final inherited end-seed cut from decoder.finish', () => {
    const head = header(true)
    const markers = [0, 1].map(seq => ({ type: 'session/end-seed', seq, time: seq + 1, data: { inherited: true } }))
    const body = bodyOf(markers)
    const expected = scanLog(Buffer.concat([head, body]))
    const { scanner, events } = scannerFor(head)
    scanner.write(body)
    expect(scanner.finish().inheritedEventCount).toBe(1)
    expect(events).toEqual(expected.events)
    expect(expected.inheritedEventCount).toBe(1)
  })

  it('preserves an unterminated physical tail without emitting it', () => {
    const head = header()
    const body = Buffer.concat([line(smallEvents()[0]), Buffer.from('torn-你好')])
    const expected = scanLog(Buffer.concat([head, body]))
    const { scanner, events } = scannerFor(head)
    scanner.write(body)
    const result = scanner.finish()
    expect(events).toEqual(expected.events)
    expect(result.committedBytes).toBe(expected.committedBytes)
    expect(result.inputBytes).toBe(head.length + body.length)
  })

  it('keeps a recoverable invalid suffix tentative and matches the old prefix', () => {
    const head = header()
    const body = Buffer.concat([line(smallEvents()[0]), Buffer.from('{bad json\n'), line({ type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } })])
    const expected = scanLog(Buffer.concat([head, body]))
    const { scanner, events } = scannerFor(head)
    scanner.write(body)
    const result = scanner.finish()
    expect(events).toEqual(expected.events)
    expect(result.committedBytes).toBe(expected.committedBytes)
  })

  it('throws the original committed error when a later turn/end closes a bad suffix', () => {
    const head = header()
    const body = Buffer.concat([line(smallEvents()[0]), Buffer.from('{bad json\n'), line({ ...oneTurnLog()[5], seq: 1 })])
    expect(() => scanLog(Buffer.concat([head, body]))).toThrow(/unparsable committed event/)
    const { scanner } = scannerFor(head)
    expect(() => scanner.write(body)).toThrow(/unparsable committed event/)
    expect(() => scanner.finish()).toThrow(/terminal|failed|closed/)
  })

  it('retains native hard admission even after a recoverable invalid row', () => {
    const head = header()
    const retired = { type: 'user/message', seq: 0, time: 1, surfaceOp: 'append', data: { id: 'user', role: 'user',
      source: { kind: 'user' }, content: [{ type: 'tool-result', toolCallId: 'call', content: [{ type: 'text', text: 'x' }] }] } }
    const body = Buffer.concat([Buffer.from('{bad json\n'), line(retired)])
    expect(() => scanLog(Buffer.concat([head, body]))).toThrow(/released tool-result wrapper/)
    const { scanner } = scannerFor(head)
    expect(() => scanner.write(body)).toThrow(/released tool-result wrapper/)
    expectTerminal(scanner)
  })

  it('refuses a future format header before examining its shape', () => {
    const raw = line({ version: 999, id: 'future' })
    expect(() => new SessionLogScanner(raw)).toThrow(/format v999|newer/)
    expect(() => scannerFor(raw)).toThrow(/format v999|newer/)
  })

  it('does not claim cross-event relationship validation', () => {
    const head = header()
    const body = line({ type: 'turn/end', seq: 0, time: 1, data: { turn: 1, reason: { kind: 'completed' } } })
    expect(() => scanLog(Buffer.concat([head, body]))).toThrow()
    const { scanner, events } = scannerFor(head)
    scanner.write(body)
    expect(events).toHaveLength(1)
    expect(scanner.finish().kind).toBe('tentative')
  })

  it('enforces exact and plus-one per-record and decompressed byte limits', () => {
    const head = header()
    const body = bodyOf(smallEvents())
    const maxRecordBytes = Math.max(head.length, ...smallEvents().map(row => line(row).length))
    const ok = scannerFor(head, { maxRecordBytes, maxDecompressedBytes: head.length + body.length })
    ok.scanner.write(body)
    expect(ok.scanner.finish().kind).toBe('tentative')
    expect(() => {
      const over = scannerFor(head, { maxRecordBytes: maxRecordBytes - 1 })
      over.scanner.write(body)
    }).toThrow(/budget|limit/i)
    const bytes = scannerFor(head, { maxDecompressedBytes: head.length + body.length - 1 })
    expect(() => bytes.scanner.write(body)).toThrow(/budget|limit/i)
  })

  it('enforces event and cumulative work limits at exact boundaries', () => {
    const head = header()
    const body = bodyOf(smallEvents())
    const work = head.length + 1 + body.length + 2 + 2
    const exact = scannerFor(head, { maxEvents: 2, maxWork: work })
    exact.scanner.write(body)
    expect(exact.scanner.finish().eventCount).toBe(2)
    const events = scannerFor(head, { maxEvents: 1 })
    expect(() => events.scanner.write(body)).toThrow(/budget|limit/i)
    const exhausted = scannerFor(head, { maxWork: work - 1 })
    expect(() => exhausted.scanner.write(body)).toThrow(/budget|limit/i)
  })

  it('rejects an expanding sourceEventSeqs range before codec allocation', () => {
    const head = header()
    const forged = line({ type: 'future/opaque', ignorable: true, seq: 20_000, time: 1,
      data: {}, sourceEventSeqs: [[0, 19_999]] })
    const { scanner, events } = scannerFor(head, { maxWork: 10_000 })
    expect(() => scanner.write(forged)).toThrow(/budget|limit/i)
    expect(events).toEqual([])
    expect(() => scanner.finish()).toThrow(/terminal|failed|closed/)
  })

  it('preserves unknown and fallback rows as tentative for the owning storage validator', () => {
    const head = header()
    const examples: unknown[][] = [
      [{ type: 'future/required', seq: 0, time: 1, data: {} }],
      [smallEvents()[0], { type: 'request/header', seq: 1, time: 2,
        data: { reason: 'fallback', header: { config: {} } } }],
    ]
    for (const rows of examples) {
      const body = bodyOf(rows)
      const old = scanLog(Buffer.concat([head, body]))
      expect(() => validateStoredEvents(old.meta, old.events)).toThrow(SessionFormatUnsupportedError)
      const { scanner, events } = scannerFor(head)
      scanner.write(body)
      expect(scanner.finish().kind).toBe('tentative')
      expect(events).toEqual(old.events)
    }
  })

  it('preserves unknown ignorable rows for downstream acceptance', () => {
    const head = header()
    const body = line({ type: 'future/optional', ignorable: true, seq: 0, time: 1, data: { opaque: 'value' } })
    const old = scanLog(Buffer.concat([head, body]))
    expect(() => validateStoredEvents(old.meta, old.events)).not.toThrow()
    const { scanner, events } = scannerFor(head)
    scanner.write(body)
    expect(scanner.finish().kind).toBe('tentative')
    expect(events).toEqual(old.events)
  })

  it('does not validate a suppressed unknown tail as a committed event', () => {
    const head = header()
    const body = Buffer.concat([line(smallEvents()[0]), Buffer.from('{bad json\n'),
      line({ type: 'future/required', seq: 1, time: 2, data: {} })])
    const old = scanLog(Buffer.concat([head, body]))
    expect(() => validateStoredEvents(old.meta, old.events)).not.toThrow()
    const { scanner, events } = scannerFor(head)
    scanner.write(body)
    expect(scanner.finish().committedBytes).toBe(old.committedBytes)
    expect(events).toEqual(old.events)
  })

  it('refuses retired mandatory row types even after a recoverable error', () => {
    const head = header()
    const body = Buffer.concat([Buffer.from('{bad json\n'), line({ type: 'tool/code-dispatch', seq: 0, time: 1, data: {} })])
    expect(() => scanLog(Buffer.concat([head, body]))).toThrow(SessionFormatUnsupportedError)
    const { scanner } = scannerFor(head)
    expect(() => scanner.write(body)).toThrow(SessionFormatUnsupportedError)
    expectTerminal(scanner)
  })

  it('charges source range expansion exactly and preserves decoded values', () => {
    const head = header()
    const user = oneTurnLog()[1]
    const body = bodyOf([smallEvents()[0], user, { ...user, seq: 2, time: 3, sourceEventSeqs: [[0, 1]] }])
    const expected = scanLog(Buffer.concat([head, body]))
    const work = head.length + 1 + body.length + 3 + 3 + 2
    const { scanner, events } = scannerFor(head, { maxWork: work })
    scanner.write(body)
    expect(scanner.finish().kind).toBe('tentative')
    expect(events).toEqual(expected.events)
    expect(events[2]?.sourceEventSeqs).toEqual([0, 1])
    const over = scannerFor(head, { maxWork: work - 1 })
    expect(() => over.scanner.write(body)).toThrow(/maxWork/)
  })

  it('bounds an event record split before its newline', () => {
    const head = header()
    const row = line({ type: 'future/opaque', ignorable: true, seq: 0, time: 1, data: { text: 'x'.repeat(head.length) } })
    const exact = scannerFor(head, { maxRecordBytes: row.length })
    exact.scanner.write(row.subarray(0, row.length - 1))
    exact.scanner.write(row.subarray(row.length - 1))
    expect(exact.scanner.finish().eventCount).toBe(1)
    const over = scannerFor(head, { maxRecordBytes: row.length - 1 })
    over.scanner.write(row.subarray(0, row.length - 1))
    expect(() => over.scanner.write(row.subarray(row.length - 1))).toThrow(/maxRecordBytes/)
  })

  it('uses the existing non-fatal UTF-8 replacement semantics', () => {
    const head = header()
    const body = Buffer.concat([Buffer.from('{"type":"future/opaque","ignorable":true,"seq":0,"time":1,"data":{"text":"'),
      Buffer.from([0xe4, 0xb8]), Buffer.from('"}}\n')])
    const expected = scanLog(Buffer.concat([head, body]))
    const { scanner, events } = scannerFor(head)
    for (const byte of body) scanner.write(Buffer.from([byte]))
    expect(scanner.finish().kind).toBe('tentative')
    expect(events).toEqual(expected.events)
  })

  it('enforces strict row recovery and final seed consistency', () => {
    const head = header()
    const strict = new TentativeSessionLogScanner(head, { limits, onEvent: () => {}, recovery: 'strict' })
    expect(() => strict.write(Buffer.from('null\n'))).toThrow(/invalid committed event/)
    expect(() => strict.finish()).toThrow(/failed|terminal/)
    const seeded = scannerFor(header(true))
    expect(() => seeded.scanner.finish()).toThrow(/seeded Session lacks/)
    expectTerminal(seeded.scanner)
  })

  it('keeps every budget failure terminal', () => {
    const head = header()
    const cases: Array<{ overrides: Partial<TentativeScanLimits>; bytes: Buffer; limit: string }> = [
      { overrides: { maxRecordBytes: head.length }, bytes: Buffer.alloc(head.length + 1, 0x61), limit: 'maxRecordBytes' },
      { overrides: { maxDecompressedBytes: head.length + 1 }, bytes: Buffer.from('xx'), limit: 'maxDecompressedBytes' },
      { overrides: { maxEvents: 0 }, bytes: line(smallEvents()[0]), limit: 'maxEvents' },
      { overrides: { maxWork: head.length + 1 }, bytes: Buffer.from('x'), limit: 'maxWork' },
    ]
    for (const item of cases) {
      const { scanner } = scannerFor(head, item.overrides)
      expect(() => scanner.write(item.bytes)).toThrow(item.limit)
      expectTerminal(scanner)
    }
  })

  it('refuses cancellation before construction with its original reason', () => {
    const controller = new AbortController()
    const reason = { type: 'cancelled' }
    controller.abort(reason)
    expect(failureOf(() => { new TentativeSessionLogScanner(header(), { limits, onEvent: () => {}, signal: controller.signal }) }))
      .toBe(reason)
  })

  it('fails terminally when the sink catches a reentrant write failure', () => {
    const scanner: TentativeSessionLogScanner = new TentativeSessionLogScanner(header(), { limits, onEvent: () => {
      expect(() => scanner.write(Buffer.alloc(0))).toThrow(/busy/)
    } })
    expect(() => scanner.write(line(smallEvents()[0]))).toThrow(/failed/)
    expectTerminal(scanner)
  })

  it('propagates non-Error callback failures without treating them as recoverable', () => {
    const reason = { type: 'sink-failure' }
    const scanner = new TentativeSessionLogScanner(header(), { limits, onEvent: () => { throw reason } })
    expect(failureOf(() => scanner.write(line(smallEvents()[0])))).toBe(reason)
    expectTerminal(scanner)
  })

  it('propagates callback failures and cancellation unchanged and terminates', () => {
    const head = header()
    const reason = new Error('consumer stopped')
    const scanner = new TentativeSessionLogScanner(head, { limits, onEvent: () => { throw reason } })
    expect(failureOf(() => scanner.write(line(smallEvents()[0])))).toBe(reason)
    expectTerminal(scanner)

    const controller = new AbortController()
    const cancelled = new Error('cancelled by caller')
    const onEvent = vi.fn(() => { controller.abort(cancelled) })
    const aborted = new TentativeSessionLogScanner(head, { limits, onEvent, signal: controller.signal })
    expect(failureOf(() => aborted.write(bodyOf(smallEvents())))).toBe(cancelled)
    expect(onEvent).toHaveBeenCalledTimes(1)
    expectTerminal(aborted)
  })
})
