import { describe, expect, it } from 'vitest'
import { Session, SessionId, SessionLogOffset, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import type { SessionFormatArtifact, SessionFormatEvent, SessionFormatJsonValue } from '@deepseek-ai/dsh-session-format'
import { assertReleasedV4Relationships } from '../src/index.ts'
import { assertV4LifecycleRelationships } from '../src/relationships.ts'

type Row = { type: string; data: Record<string, unknown>; surfaceOp?: unknown; sourceEventSeqs?: number[]; ignorable?: true }
const row = (type: string, data: Record<string, unknown>): Row => ({ type, data })
const user = (kind = 'user') => ({ id: 'input', role: 'user', source: { kind }, content: [{ type: 'text', text: 'input' }] })
const input = (kind = 'user'): Row => ({ ...row('user/message', user(kind)), surfaceOp: 'append' })
const step = { turn: 1, step: 1 }
const call = { type: 'tool-call', id: 'call', name: 'read', arguments: '{}' }
const assistant = (content: unknown[] = [call]): Row => ({
  ...row('assistant/message', { ...step, stream: [], message: { id: 'assistant', role: 'assistant', source: { kind: 'model', provider: 'mock', model: 'mock' }, content } }),
  surfaceOp: 'append',
})
const result = (id = 'call', extra: Record<string, unknown> = {}): Row => ({
  ...row('tool/result', { ...step, message: { id: 'result', role: 'tool', source: { kind: 'tool', callId: id }, toolCallId: id, content: [{ type: 'text', text: 'done' }], ...extra } }),
  surfaceOp: 'append',
})
const begin = () => [row('turn/start', { turn: 1 }), row('step/start', step)]
const end = () => [row('step/end', step), row('turn/end', { turn: 1, reason: { kind: 'completed' } })]
const toolCall = () => row('tool/call', { ...step, callId: 'call', name: 'read', arguments: '{}' })
const request = () => row('request/header', { reason: 'initial', header: { config: { provider: 'mock', model: 'mock' } } })

/** Exercise physical JSON, catalog relationship admission, Session adoption, and derivation together. */
function reopen(rows: readonly Row[], inherited = 0, seeded = false) {
  const restore = sessionFormatCatalog.createRestore({ type: 'session', version: 4, id: 'native-relations', createdAt: 1, delegationDepth: 0, isSeeded: seeded, ...(seeded ? { parentSession: 'parent' } : {}) }, { recovery: 'strict', validation: 'current' })
  for (const [seq, candidate] of rows.entries()) {
    const event = { ...candidate, seq, time: seq + 1 } as unknown as SessionFormatEvent
    restore.decodeRow(JSON.parse(JSON.stringify(sessionFormatCatalog.encodeCurrentEvent(event))))
  }
  const artifact = restore.finish()
  expect(artifact.inheritedEventCount).toBe(inherited)
  const session = Session.fromRestore(SessionId(artifact.header.id), artifact.events as SessionEvent[], artifact.header as unknown as SessionHeader, SessionLogOffset(inherited), 'detached')
  return { artifact, messages: session.deriveMessages() }
}

const compact = (): Row[] => [
  row('turn/start', { turn: 1 }), input(),
  row('compaction/start', { compactionId: 'c', turn: 1, sourceCommandId: 'cmd' }),
  row('compaction/summary', { compactionId: 'c', sourceCommandId: 'cmd', summary: [{ type: 'text', text: 'summary' }], shadowedRange: { start: 1, end: 1 }, shadowedSeqs: [1], shadowedTokenCount: 1, provider: 'mock', model: 'mock' }),
  { ...input('compact-checkpoint'), data: {
    ...user('compact-checkpoint'), id: 'checkpoint', source: { kind: 'compact-checkpoint', compactionId: 'c', sourceCommandId: 'cmd' },
  }, surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 }, sourceEventSeqs: [1, 2, 3] },
  row('compaction/end', { compactionId: 'c', sourceCommandId: 'cmd', turn: 1 }),
  row('turn/end', { turn: 1, reason: { kind: 'completed' } }),
]
const change = (rows: Row[], index: number, data: Record<string, unknown>): Row[] =>
  rows.map((candidate, i) => i === index ? { ...candidate, data: { ...candidate.data, ...data } } : candidate)
const retry = (changes: Record<string, unknown> = {}) => row('llm/retry', { ...step, retryId: 'retry', retry: 1, provider: 'mock', policyKey: 'policy', ...changes })
const retryStart = (changes: Record<string, unknown> = {}) => row('llm/retry-started', { ...step, retryId: 'retry', retry: 1, ...changes })
const dispatch = (type: 'start' | 'end', changes: Record<string, unknown> = {}) => row(type === 'start' ? 'tool/ptc-dispatch-start' : 'tool/ptc-dispatch', { rootCallId: 'root', parentCallId: 'root', subCallId: 'child', name: 'read', arguments: { a: 1, b: 2 }, ...changes })

describe('mandatory V4 lifecycle restoration', () => {
  it('retains valid ordinary tool exchanges and open interrupted tails', () => {
    const rows = [...begin(), input(), request(), assistant(), toolCall(), result(), ...end()]
    expect(reopen(rows).messages.map(message => message.role)).toEqual(['user', 'assistant', 'tool'])
    for (let length = 0; length < rows.length; length += 1) expect(() => reopen(rows.slice(0, length))).not.toThrow()
  })

  it.each([
    ['turn order', [row('turn/start', { turn: 2 })]],
    ['duplicate turn', [row('turn/start', { turn: 1 }), row('turn/start', { turn: 1 })]],
    ['unopened turn end', [row('turn/end', { turn: 1 })]],
    ['open step at turn end', [...begin(), row('turn/end', { turn: 1 })]],
    ['unopened step', [row('step/start', step)]],
    ['step sequence', [row('turn/start', { turn: 1 }), row('step/start', { turn: 1, step: 2 })]],
    ['mismatched step end', [...begin(), row('step/end', { turn: 2, step: 1 })]],
    ['assistant outside step', [assistant([])]],
    ['assistant attempt outside step', [row('assistant/attempt', { ...step, stream: [] })]],
    ['tool without advertisement', [...begin(), toolCall()]],
    ['result without advertisement', [...begin(), result()]],
    ['repeated advertisement', [...begin(), assistant([call, call])]],
    ['changed tool name', [...begin(), assistant(), row('tool/call', { ...step, callId: 'call', name: 'other', arguments: '{}' })]],
    ['changed tool arguments', [...begin(), assistant(), row('tool/call', { ...step, callId: 'call', name: 'read', arguments: '[]' })]],
    ['repeated start', [...begin(), assistant(), toolCall(), toolCall()]],
    ['unstarted success', [...begin(), assistant(), result()]],
    ['repeated result', [...begin(), assistant(), toolCall(), result(), result()]],
    ['unresolved advertised call', [...begin(), assistant(), ...end()]],
    ['unresolved started call', [...begin(), assistant(), toolCall(), ...end()]],
    ['header outside turn', [request()]],
    ['context outside turn', [row('request/context', { provider: 'mock', model: 'mock' })]],
  ] satisfies Array<[string, Row[]]>)('rejects %s', (_name, rows) => {
    expect(() => reopen(rows)).toThrow()
  })

  it('accepts exact not-started repairs with preserved historical identity suffixes', () => {
    const repaired = result('call', { id: 'interrupted-tool-result-call-200', isError: true, content: [{ type: 'text', text: 'The tool call was interrupted before the Harness recorded it as started. Retry it if it is still needed.' }] })
    repaired.data['error'] = { name: 'ToolNotStartedError', code: 'TOOL_NOT_STARTED' }
    expect(() => reopen([...begin(), assistant(), repaired, ...end()])).not.toThrow()
    for (const extra of [{ id: 'made-up' }, { id: 'interrupted-tool-result-call-01' }, { id: 'interrupted-tool-result-call-9007199254740992' }, { content: [] }, { content: [{ type: 'text', text: 'invented repair' }] }]) {
      const invalid = { ...repaired, data: { ...repaired.data, message: { ...(repaired.data['message'] as Record<string, unknown>), ...extra } } }
      expect(() => reopen([...begin(), assistant(), invalid])).toThrow()
    }
    expect(() => reopen([...begin(), assistant(), { ...repaired, sourceEventSeqs: [2] }])).toThrow()
    expect(() => reopen([...begin(), assistant(), { ...repaired, data: { ...repaired.data, error: { name: 'OtherError', code: 'TOOL_NOT_STARTED' } } }])).toThrow()
  })

  it('preserves ignorable payloads and unknown attribution metadata', () => {
    const message = { ...user('external'), source: JSON.parse('{"kind":"external","__proto__":{"x":1},"meta":{"a":2}}') as unknown }
    const opaque: Row = { type: 'external/event', data: { arbitrary: true }, ignorable: true }
    const rows = [opaque, { ...input(), data: message }]
    const restored = reopen(rows)
    expect(restored.artifact.events[0]?.data).toEqual(opaque.data)
    expect(restored.messages[0]?.source).toEqual(message.source)
  })
})

describe('mandatory V4 compaction restoration', () => {
  it('retains matching checkpoint sources and inherited unfinished compactions', () => {
    expect(reopen(compact()).messages[0]?.source).toEqual({ kind: 'compact-checkpoint', compactionId: 'c', sourceCommandId: 'cmd' })
    const inherited = [row('compaction/start', { compactionId: 'old', turn: null }), ...begin(), ...end(), row('session/end-seed', { inherited: true })]
    expect(() => reopen(inherited, 5, true)).not.toThrow()
    expect(() => reopen([row('compaction/start', { compactionId: 'c', turn: null }), row('compaction/end', { compactionId: 'c', turn: null, error: 'cancelled' })])).not.toThrow()
    expect(() => reopen(compact().slice(0, 5))).not.toThrow()
  })

  it.each([
    ['checkpoint identity', change(compact(), 4, { source: { kind: 'compact-checkpoint', compactionId: 'WRONG', sourceCommandId: 'cmd' } })],
    ['checkpoint command', change(compact(), 4, { source: { kind: 'compact-checkpoint', compactionId: 'c', sourceCommandId: 'WRONG' } })],
    ['summary identity', change(compact(), 3, { compactionId: 'WRONG' })],
    ['end identity', change(compact(), 5, { compactionId: 'WRONG' })],
    ['end turn', change(compact(), 5, { turn: null })],
    ['start turn', change(compact(), 2, { turn: null })],
    ['wrong span', change(compact(), 3, { shadowedSeqs: [] })],
    ['missing span', change(compact(), 3, { shadowedRange: { start: 0, end: 0 }, shadowedSeqs: [0] })],
    ['overlap', [...compact().slice(0, 3), row('compaction/start', { compactionId: 'second', turn: 1 })]],
    ['repeated summary', [...compact().slice(0, 4), compact()[3]!]],
    ['success without summary', [...compact().slice(0, 3), compact()[5]!]],
    ['turn closes transaction', [...compact().slice(0, 3), compact()[6]!]],
    ['unowned end', [row('compaction/end', { compactionId: 'c', turn: null })]],
  ] satisfies Array<[string, Row[]]>)('rejects %s', (_name, rows) => {
    expect(() => reopen(rows)).toThrow()
  })
})

describe('mandatory V4 dependent event restoration', () => {
  it('accepts PTC nesting and settlements with equal argument objects', () => {
    expect(() => reopen([...begin(), dispatch('start'), dispatch('start', { subCallId: 'grandchild', parentCallId: 'child' }), dispatch('end', { subCallId: 'grandchild', parentCallId: 'child' }), dispatch('end', { arguments: { b: 2, a: 1 } }), ...end()])).not.toThrow()
  })

  it.each([
    ['outside turn', [dispatch('start')]],
    ['without start', [...begin(), dispatch('end')]],
    ['duplicate start', [...begin(), dispatch('start'), dispatch('start')]],
    ['duplicate settlement', [...begin(), dispatch('start'), dispatch('end'), dispatch('end')]],
    ['unknown parent', [...begin(), dispatch('start', { parentCallId: 'unknown' })]],
    ['root changes', [...begin(), dispatch('start'), dispatch('end', { rootCallId: 'different' })]],
    ['arguments change', [...begin(), dispatch('start'), dispatch('end', { arguments: {} })]],
    ['name changes', [...begin(), dispatch('start'), dispatch('end', { name: 'different' })]],
  ] satisfies Array<[string, Row[]]>)('rejects PTC %s', (_name, rows) => { expect(() => reopen(rows)).toThrow() })

  it('accepts retry chains, including retries scheduled after the step ends', () => {
    expect(() => reopen([...begin(), request(), retry(), retryStart(), retry({ retry: 2 }), retryStart({ retry: 2 }), row('step/end', step), retry({ retry: 3 }), row('turn/end', { turn: 1, reason: { kind: 'completed' } })])).not.toThrow()
  })

  it.each([
    ['outside turn', [retry()]],
    ['wrong step', [...begin(), request(), retry({ step: 2 })]],
    ['wrong provider', [...begin(), request(), retry({ provider: 'other' })]],
    ['skip attempt', [...begin(), request(), retry({ retry: 2 })]],
    ['changed identity', [...begin(), request(), retry(), retry({ retry: 2, retryId: 'other' })]],
    ['reused identity', [...begin(), request(), retry(), retry({ policyKey: 'other' })]],
    ['unpaired start', [retryStart()]],
    ['changed start coordinates', [...begin(), request(), retry(), retryStart({ step: 2 })]],
    ['duplicate start', [...begin(), request(), retry(), retryStart(), retryStart()]],
  ] satisfies Array<[string, Row[]]>)('rejects retry %s', (_name, rows) => { expect(() => reopen(rows)).toThrow() })

  it('requires command completion to cite its run and an earlier non-command success event', () => {
    const run = row('command/run', { commandId: 'cmd', name: 'test', source: { kind: 'user' } })
    const done = row('command/done', { commandId: 'cmd', kind: 'success', sourceEventSeq: 1 })
    expect(() => reopen([run, input(), done, row('command/done', { commandId: 'cmd', kind: 'error' })])).not.toThrow()
    for (const rows of [[done], [run, run], [run, done], [run, input(), { ...done, data: { ...done.data, kind: 'error' } }], [run, input(), { ...done, data: { ...done.data, sourceEventSeq: 10 } }]]) {
      expect(() => reopen(rows)).toThrow()
    }
  })

  it('requires titles and durable title requests to cite earlier human messages', () => {
    const title = row('session/title', { title: 'Example', source: { kind: 'generated' }, messageSeqs: [0] })
    const requestTitle = row('session/title-llm-request', { messageSeqs: [0], messages: [{ ...user('dsh-session-title-llm'), content: [{ type: 'text', text: 'historical frame with original coordinates' }] }] })
    expect(() => reopen([input(), title, requestTitle, row('session/title', { title: 'Manual', source: { kind: 'user' }, messageSeqs: [] })])).not.toThrow()
    for (const rows of [[input('external'), title], [input(), { ...title, data: { ...title.data, source: { kind: 'user' } } }], [input(), { ...title, data: { ...title.data, messageSeqs: [0, 0] } }], [input(), { ...title, data: { ...title.data, messageSeqs: [1] } }], [input(), { ...requestTitle, data: { ...requestTitle.data, messages: [user()] } }], [input(), { ...requestTitle, data: { ...requestTitle.data, messageSeqs: [] } }]]) {
      expect(() => reopen(rows)).toThrow()
    }
  })
})


describe('V4 protected system surface and malformed relationship inputs', () => {
  const system = (): Row => ({ ...row('system/message', { ...step, message: { id: 'system', role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'system' }] } }), surfaceOp: 'append' })
  it('keeps the first system head protected across exact replacements', () => {
    const replacement = { ...system(), surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 }, sourceEventSeqs: [2] }
    expect(() => reopen([...begin(), system(), input(), replacement, system(), ...end()])).not.toThrow()
    const prune = row('compaction/prune', { shadowedRange: { start: 3, end: 3 }, shadowedSeqs: [3], shadowedTokenCount: 1 })
    expect(() => reopen([...begin(), system(), input(), prune, ...end()])).not.toThrow()
    for (const rows of [
      [...begin(), input(), system()],
      [...begin(), input(), { ...replacement, sourceEventSeqs: [2] }],
      [...begin(), system(), { ...input(), surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 }, sourceEventSeqs: [2] }],
      [...begin(), system(), input(), { ...replacement, surfaceOp: { op: 'replace', startSeq: 2, endSeq: 3 }, sourceEventSeqs: [2, 3] }],
      [...begin(), system(), input(), { ...replacement, surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 } }],
      [...begin(), system(), input(), { ...replacement, surfaceOp: { op: 'replace', startSeq: 3, endSeq: 2 } }],
      [...begin(), system(), input(), { ...replacement, sourceEventSeqs: [0] }],
      [...begin(), system(), row('compaction/prune', { shadowedRange: { start: 2, end: 2 }, shadowedSeqs: [2] })],
    ]) expect(() => reopen(rows)).toThrow()
  })

  it('rejects malformed relationship values and mismatched inherited transaction ownership', () => {
    expect(() => reopen([row('command/run', { commandId: '' })])).toThrow()
    expect(() => reopen([row('session/title', { messageSeqs: null })])).toThrow()
    const inherited = [
      row('compaction/start', { compactionId: 'old', turn: null }), row('turn/start', { turn: 1 }), input(),
      row('compaction/summary', { compactionId: 'old', shadowedRange: { start: 2, end: 2 }, shadowedSeqs: [2] }),
      row('turn/end', { turn: 1, reason: { kind: 'completed' } }), row('session/end-seed', { inherited: true }),
    ]
    expect(() => reopen(inherited, 5, true)).toThrow(/does not match the open turn/)
  })
})

type HistoryRow = {
  type: string
  data: SessionFormatJsonValue
  surfaceOp?: SessionFormatJsonValue
  sourceEventSeqs?: SessionFormatJsonValue
  ignorable?: true
}

function historyArtifact(rows: readonly HistoryRow[]): SessionFormatArtifact {
  return {
    header: { version: 4, id: 'history', createdAt: 1, delegationDepth: 0, isSeeded: false },
    inheritedEventCount: 0,
    events: rows.map((candidate, seq): SessionFormatEvent => ({ ...candidate, seq, time: seq + 1 })),
  }
}

function knownTypes(input: SessionFormatArtifact): Set<string> {
  return new Set(input.events.map(event => event.type))
}

function decision(run: () => void): string {
  try { run(); return 'accepted' } catch (error: unknown) {
    if (!(error instanceof Error)) throw error
    return `${error.name}: ${error.message}`
  }
}

describe('V4 historical relationship lookups', () => {
  it('reads earlier headers, title inputs, and command sources at their original indexes', () => {
    const input = historyArtifact([
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'step/start', data: { turn: 1, step: 1 } },
      { type: 'request/header', data: { header: {
        config: { provider: 'mock', model: 'mock' },
        tools: [{ name: 'read', description: 'Read', parameters: {} }],
      } } },
      { type: 'developer/message', surfaceOp: 'append', data: {
        turn: 1, step: 1, headerSeq: 2,
        message: { role: 'developer', content: [{ type: 'tool-addition', toolName: 'read' }] },
      } },
      { type: 'user/message', surfaceOp: 'append', data: { source: { kind: 'user' } } },
      { type: 'session/title', data: { source: { kind: 'generated' }, messageSeqs: [4] } },
      { type: 'command/run', data: { commandId: 'cmd' } },
      { type: 'command/done', data: { commandId: 'cmd', kind: 'success', sourceEventSeq: 4 } },
      { type: 'step/end', data: { turn: 1, step: 1 } },
      { type: 'turn/end', data: { turn: 1 } },
    ])
    const known = knownTypes(input)
    const before = JSON.stringify(input)
    const reads: number[] = []
    const events = new Proxy(input.events, { get(target, key, receiver) {
      if (typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key)) reads.push(Number(key))
      const value: unknown = Reflect.get(target, key, receiver)
      return value
    } })
    expect(() => { assertV4LifecycleRelationships({ ...input, events }, known) }).not.toThrow()
    expect(reads).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0, 1, 2, 3, 2, 4, 5, 4, 6, 7, 4, 8, 9])
    expect(JSON.stringify(input)).toBe(before)
  })

  it('retains the known-type checks for header, title, and opaque command references', () => {
    const header = historyArtifact([
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'step/start', data: { turn: 1, step: 1 } },
      { type: 'request/header', data: { header: { config: { provider: 'mock' }, tools: [] } } },
      { type: 'developer/message', surfaceOp: 'append', data: {
        turn: 1, step: 1, headerSeq: 2, message: { content: [] },
      } },
    ])
    const headerTypes = knownTypes(header)
    headerTypes.delete('request/header')
    expect(() => { assertV4LifecycleRelationships(header, headerTypes) }).toThrow('must reference a known request/header')
    headerTypes.add('request/header')
    expect(() => { assertV4LifecycleRelationships(header, headerTypes) }).not.toThrow()

    const title = historyArtifact([
      { type: 'user/message', surfaceOp: 'append', data: { source: { kind: 'user' } } },
      { type: 'session/title', data: { source: { kind: 'generated' }, messageSeqs: [0] } },
    ])
    const titleTypes = knownTypes(title)
    titleTypes.delete('user/message')
    expect(() => { assertV4LifecycleRelationships(title, titleTypes) }).toThrow('must cite distinct earlier human user/message events')
    titleTypes.add('user/message')
    expect(() => { assertV4LifecycleRelationships(title, titleTypes) }).not.toThrow()

    const command = historyArtifact([
      { type: 'command/run', data: { commandId: 'cmd' } },
      { type: 'plugin/unrecognized', ignorable: true, data: null },
      { type: 'command/done', data: { commandId: 'cmd', kind: 'success', sourceEventSeq: 1 } },
    ])
    const commandTypes = knownTypes(command)
    commandTypes.delete('plugin/unrecognized')
    expect(() => { assertV4LifecycleRelationships(command, commandTypes) }).not.toThrow()
    const invalid = historyArtifact([
      { type: 'command/run', data: { commandId: 'cmd' } },
      { type: 'command/done', data: { commandId: 'cmd', kind: 'success', sourceEventSeq: 0 } },
    ])
    expect(() => { assertV4LifecycleRelationships(invalid, knownTypes(invalid)) }).toThrow('command/done has invalid sourceEventSeq')
  })

  it('keeps whole-artifact field errors ahead of earlier lifecycle errors', () => {
    const input = historyArtifact([
      { type: 'turn/end', data: { turn: 1 } },
      { type: 'developer/message', surfaceOp: 'append', data: {
        turn: 1, step: 1, message: { role: 'user', content: [] },
      } },
    ])
    const known = knownTypes(input)
    expect(decision(() => { assertV4LifecycleRelationships(input, known) }))
      .toBe('SessionFormatError: turn/end does not match the open turn with no open step')
    expect(decision(() => { assertReleasedV4Relationships(input, known) }))
      .toBe('SessionFormatError: format v4 developer/message requires turn, step, and a developer message')
  })
})

describe('V4 array relationship decisions', () => {
  const turnStart: HistoryRow = { type: 'turn/start', data: { turn: 1 } }
  const stepStart: HistoryRow = { type: 'step/start', data: { turn: 1, step: 1 } }
  const header: HistoryRow = { type: 'request/header', data: { header: {
    config: { provider: 'mock' }, tools: [{ name: 'read', description: 'Read', parameters: {} }],
  } } }
  const developer = (headerSeq: number): HistoryRow => ({ type: 'developer/message', surfaceOp: 'append', data: {
    turn: 1, step: 1, headerSeq, message: { content: [{ type: 'tool-addition', toolName: 'read' }] },
  } })
  const userMessage = (kind: string): HistoryRow => ({ type: 'user/message', surfaceOp: 'append', data: { source: { kind } } })
  const title = (messageSeqs: number[]): HistoryRow => ({ type: 'session/title', data: {
    source: { kind: 'generated' }, messageSeqs,
  } })
  const run: HistoryRow = { type: 'command/run', data: { commandId: 'cmd' } }
  const done = (seq: number): HistoryRow => ({ type: 'command/done', data: { commandId: 'cmd', kind: 'success', sourceEventSeq: seq } })
  const start: HistoryRow = { type: 'compaction/start', data: { compactionId: 'old', turn: null } }
  const end: HistoryRow = { type: 'turn/end', data: { turn: 1 } }
  const marker: HistoryRow = { type: 'session/end-seed', data: {} }
  const cases: { label: string; rows: HistoryRow[]; omit?: string[]; expected: string }[] = [
    { label: 'empty history', rows: [], expected: 'accepted' },
    { label: 'header lookup', rows: [turnStart, stepStart, header, developer(2)], expected: 'accepted' },
    { label: 'wrong header event', rows: [turnStart, stepStart, userMessage('user'), developer(2)], expected: 'SessionFormatError: developer/message headerSeq must reference an earlier request/header' },
    { label: 'unknown header event', rows: [turnStart, stepStart, header, developer(2)], omit: ['request/header'], expected: 'SessionFormatError: developer/message headerSeq must reference a known request/header' },
    { label: 'non-earlier header', rows: [turnStart, stepStart, developer(2)], expected: 'SessionFormatError: developer/message headerSeq must name an earlier event' },
    { label: 'human title source', rows: [userMessage('user'), title([0])], expected: 'accepted' },
    { label: 'nonhuman title source', rows: [userMessage('external'), title([0])], expected: 'SessionFormatError: session/title messageSeqs must cite distinct earlier human user/message events' },
    { label: 'unknown title source', rows: [userMessage('user'), title([0])], omit: ['user/message'], expected: 'SessionFormatError: session/title messageSeqs must cite distinct earlier human user/message events' },
    { label: 'duplicate title source', rows: [userMessage('user'), title([0, 0])], expected: 'SessionFormatError: session/title messageSeqs must cite distinct earlier human user/message events' },
    { label: 'non-earlier title source', rows: [userMessage('user'), title([1])], expected: 'SessionFormatError: title messageSeqs must name an earlier event' },
    { label: 'opaque command source', rows: [run, { type: 'extension/unknown', data: null, ignorable: true }, done(1)], omit: ['extension/unknown'], expected: 'accepted' },
    { label: 'command source is a run', rows: [run, done(0)], expected: 'SessionFormatError: command/done has invalid sourceEventSeq' },
    { label: 'non-earlier command source', rows: [run, done(1)], expected: 'SessionFormatError: command sourceEventSeq must name an earlier event' },
    { label: 'future inherited marker', rows: [start, turnStart, end, marker], expected: 'accepted' },
    { label: 'unknown inherited marker', rows: [start, turnStart, end, marker], omit: ['session/end-seed'], expected: 'SessionFormatError: turn/start crosses an open compaction' },
    { label: 'future marker with invalid payload', rows: [start, turnStart, end, { type: 'session/end-seed', data: null }], expected: 'SessionFormatError: session/end-seed requires an object' },
  ]

  it.each(cases)('preserves $label', ({ rows, omit = [], expected }) => {
    const input = historyArtifact(rows)
    const known = knownTypes(input)
    for (const type of omit) known.delete(type)
    expect(decision(() => { assertV4LifecycleRelationships(input, known) })).toBe(expected)
  })
})

describe('V4 orphan compaction summary', () => {
  const start = (id: string): HistoryRow => ({ type: 'compaction/start', data: { compactionId: id, turn: null } })
  const turn = (number: number): HistoryRow[] => [
    { type: 'turn/start', data: { turn: number } },
    { type: 'turn/end', data: { turn: number } },
  ]
  const marker: HistoryRow = { type: 'session/end-seed', data: {} }

  it('keeps all orphan starts from multiple inherited boundaries', () => {
    const input = historyArtifact([start('old'), ...turn(1), marker, start('new'), ...turn(2), marker])
    expect(() => { assertV4LifecycleRelationships(input, knownTypes(input)) }).not.toThrow()
    const unknownMarker = knownTypes(input)
    unknownMarker.delete('session/end-seed')
    expect(() => { assertV4LifecycleRelationships(input, unknownMarker) }).toThrow('turn/start crosses an open compaction')
  })

  it('does not apply an earlier marker to a later open compaction', () => {
    const input = historyArtifact([start('old'), marker, start('new'), ...turn(1)])
    expect(() => { assertV4LifecycleRelationships(input, knownTypes(input)) }).toThrow('turn/start crosses an open compaction')
  })

  it('recognizes future markers before checking the marker payload', () => {
    const input = historyArtifact([start('old'), ...turn(1), { type: 'session/end-seed', data: null }])
    expect(() => { assertV4LifecycleRelationships(input, knownTypes(input)) }).toThrow('session/end-seed requires an object')
  })

  it('honors whether a compaction end is part of the installed vocabulary', () => {
    const input = historyArtifact([
      start('old'), { type: 'compaction/end', data: { compactionId: 'other', turn: null, error: 'cancelled' } },
      ...turn(1), marker,
    ])
    const known = knownTypes(input)
    expect(() => { assertV4LifecycleRelationships(input, known) }).toThrow('compaction/end has no matching compaction/start')
    known.delete('compaction/end')
    expect(() => { assertV4LifecycleRelationships(input, known) }).not.toThrow()
  })
})
