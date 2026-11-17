import { describe, expect, it } from 'vitest'
import { ToolCallId , createMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { interruptedTurnClosers as repairInterruptedTurn, SessionSeq, TOOL_NOT_STARTED, TOOL_OUTCOME_UNKNOWN, ToolCallRecovery } from '../src/index.ts'
import { openTurnClosers as closeOpenTurn, type OpenTurnCloseCause } from '../src/repair.ts'
import type { SessionEvent as LogicalSessionEvent, SurfaceEvent } from '../src/index.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'test/repair-tail': { value: string }
  }
}

interface SessionEvent {
  type: string
  seq: number
  time: number
  data: unknown
  [key: string]: unknown
}

function interruptedTurnClosers(events: readonly SessionEvent[]): LogicalSessionEvent[] {
  for (const event of events) SessionSeq(event.seq)
  return repairInterruptedTurn(events as readonly LogicalSessionEvent[])
}

function openTurnClosers(events: readonly SessionEvent[], cause: OpenTurnCloseCause): LogicalSessionEvent[] {
  for (const event of events) SessionSeq(event.seq)
  return closeOpenTurn(events as unknown as readonly LogicalSessionEvent[], cause)
}

/**
 * Unit coverage for the crash-recovery closer synthesis. The persistence
 * contract exercises it end-to-end through the real JSONL provider; these tests pin the
 * pure function's branches directly — especially the synthetic error
 * `tool/result` for a tool call the crash left unanswered (without it a
 * resumed session replays a dangling assistant tool-call and the provider
 * rejects the transcript).
 */

const userTurnStart = (turn: number, seq: number): SessionEvent =>
  ({ type: 'turn/start', seq, time: seq, data: { turn } })

function liveToolRequests(): LogicalSessionEvent<'assistant/message'> {
  return {
    type: 'assistant/message', seq: SessionSeq(21), time: 110, surfaceOp: 'append',
    data: {
      turn: 3, step: 2, stream: [],
      message: createMessage({
        role: 'assistant', source: { kind: 'model', provider: 'mock', model: 'mock' },
        content: [
          { type: 'tool-call', id: ToolCallId('started'), name: 'bash', arguments: '{}' },
          { type: 'tool-call', id: ToolCallId('pending'), name: 'bash', arguments: '{}' },
        ],
      }),
    },
  }
}

describe('ToolCallRecovery', () => {
  it('observes a live step without earlier history and retains repairs until their commits arrive', () => {
    const recovery = new ToolCallRecovery()
    expect(recovery.results()).toEqual([])
    recovery.observe({ type: 'step/start', seq: SessionSeq(20), time: 100, data: { turn: 3, step: 2 } })
    recovery.observe(liveToolRequests())
    recovery.observe({
      type: 'tool/call', seq: SessionSeq(22), time: 120,
      data: { turn: 3, step: 2, callId: ToolCallId('started'), name: 'bash', arguments: '{}' },
    })

    const results = recovery.results()
    expect(results.map(event => ({
      seq: event.seq, time: event.time, turn: event.data.turn, step: event.data.step,
      callId: event.data.message.toolCallId, code: event.data.error?.code, sourceEventSeqs: event.sourceEventSeqs,
    }))).toEqual([
      { seq: 23, time: 120, turn: 3, step: 2, callId: 'started', code: TOOL_OUTCOME_UNKNOWN, sourceEventSeqs: [22] },
      { seq: 24, time: 120, turn: 3, step: 2, callId: 'pending', code: TOOL_NOT_STARTED, sourceEventSeqs: undefined },
    ])
    expect(recovery.results()).toEqual(results)
    for (const [index, event] of results.entries()) {
      recovery.observe(event)
      expect(recovery.results()).toEqual(results.slice(index + 1))
    }
  })

  it.each([
    { kind: 'replacement', turn: 3, step: 2 },
    { kind: 'other turn', turn: 2, step: 2 },
    { kind: 'other step', turn: 3, step: 1 },
  ])('does not acknowledge a pending call with $kind result reusing its id', ({ kind, turn, step }) => {
    const recovery = new ToolCallRecovery()
    recovery.observe(liveToolRequests())
    recovery.observe({
      type: 'tool/result', seq: SessionSeq(22), time: 120,
      surfaceOp: kind === 'replacement' ? { op: 'replace', startSeq: SessionSeq(10), endSeq: SessionSeq(10) } : 'append',
      ...kind === 'replacement' ? { sourceEventSeqs: [SessionSeq(10)] } : {},
      data: {
        turn, step,
        message: createToolResultMessage({ callId: ToolCallId('started'), content: [{ type: 'text', text: 'old result' }], isError: false }),
      },
    })

    expect(recovery.results().map(event => event.data.message.toolCallId)).toEqual([ToolCallId('started'), ToolCallId('pending')])
  })

})

const causes: OpenTurnCloseCause[] = [{ kind: 'interrupted' }, { kind: 'forked' }]

describe.each(causes)('openTurnClosers (cause %o)', (cause) => {
  it('returns nothing for a balanced log (ends on turn/end)', () => {
    const balanced: SessionEvent[] = [
      userTurnStart(1, 0),
      { type: 'turn/end', seq: 1, time: 1, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    expect(openTurnClosers(balanced, cause)).toEqual([])
  })

  it('returns nothing for an empty log', () => {
    expect(openTurnClosers([], cause)).toEqual([])
  })

  it('closes an open turn with no open step (turn/end with the cause reason only)', () => {
    const events: SessionEvent[] = [userTurnStart(1, 0)]
    const closers = openTurnClosers(events, cause)
    expect(closers.map(e => e.type)).toEqual(['turn/end'])
    const end = closers[0]!
    expect(end.seq).toBe(1)
    expect(end.type === 'turn/end' && end.data.reason).toEqual({ kind: cause.kind })
  })

  it('closes an open step before the turn (step/end then turn/end)', () => {
    const events: SessionEvent[] = [
      userTurnStart(1, 0),
      { type: 'step/start', seq: 1, time: 1, data: { turn: 1, step: 1 } },
    ]
    const closers = openTurnClosers(events, cause)
    expect(closers.map(e => e.type)).toEqual(['step/end', 'turn/end'])
    expect(closers.map(e => e.seq)).toEqual([2, 3])
  })

  it('marks an assistant tool request with no recorded call as not started', () => {
    const events: SessionEvent[] = [
      userTurnStart(2, 0),
      { type: 'step/start', seq: 1, time: 1, data: { turn: 2, step: 1 } },
      { type: 'assistant/message', seq: 2, time: 2, surfaceOp: 'append', data: {
        turn: 2, step: 1,
        message: createMessage({
          role: 'assistant',
          content: [
            { type: 'text', text: 'calling a tool' },
            { type: 'tool-call', id: ToolCallId('call-1'), name: 'bash', arguments: '{}' },
          ],
          source: {
            kind: 'model',
            ...{ provider: 'mock', model: 'mock' },
          },
        }),
      } },
    ]
    const closers = openTurnClosers(events, cause)
    // tool/result (for the orphaned call) → step/end → turn/end, contiguous seqs.
    expect(closers.map(e => e.type)).toEqual(['tool/result', 'step/end', 'turn/end'])
    expect(closers.map(e => e.seq)).toEqual([3, 4, 5])
    const result = closers[0]!
    expect(result.type === 'tool/result' && result.data).toMatchObject({
      turn: 2,
      step: 1,
      message: {
        id: `${cause.kind}-tool-result-call-1-3`,
        source: { callId: ToolCallId('call-1') },
        role: 'tool',
        toolCallId: ToolCallId('call-1'),
        isError: true,
      },
      error: { code: TOOL_NOT_STARTED },
    })
    expect(result.type === 'tool/result' && result.data.message.content).toEqual([{
      type: 'text', text: cause.kind === 'forked'
        ? 'The history inherited by this branch has no record of this tool call starting. The parent session may have executed it after the fork point. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.'
        : 'The tool call was interrupted before the Harness recorded it as started. Retry it if it is still needed.',
    }])
  })

  it('does NOT synthesize a result for a tool-call that already has one', () => {
    const events: SessionEvent[] = [
      userTurnStart(2, 0),
      { type: 'step/start', seq: 1, time: 1, data: { turn: 2, step: 1 } },
      { type: 'assistant/message', seq: 2, time: 2, surfaceOp: 'append', data: {
        turn: 2, step: 1,
        message: createMessage({
          role: 'assistant',
          content: [
            { type: 'tool-call', id: ToolCallId('call-1'), name: 'bash', arguments: '{}' },
          ],
          source: {
            kind: 'model',
            ...{ provider: 'mock', model: 'mock' },
          },
        }),
      } },
      { type: 'tool/result', seq: 3, time: 3, surfaceOp: 'append', data: {
        turn: 2, step: 1,
        message: createToolResultMessage({
          callId: ToolCallId('call-1'),
          content: [{ type: 'text', text: 'ok' }],
          isError: false,
        }),
      } },
    ]
    // The call is answered, so only the open step + turn need closing.
    const closers = openTurnClosers(events, cause)
    expect(closers.map(e => e.type)).toEqual(['step/end', 'turn/end'])
  })

  it('preserves an unanswered assistant call after the owning step already closed', () => {
    const events: SessionEvent[] = [
      userTurnStart(2, 0),
      { type: 'step/start', seq: 1, time: 1, data: { turn: 2, step: 1 } },
      { type: 'assistant/message', seq: 2, time: 2, surfaceOp: 'append', data: {
        turn: 2, step: 1,
        message: createMessage({
          role: 'assistant',
          content: [
            { type: 'tool-call', id: ToolCallId('call-1'), name: 'bash', arguments: '{}' },
          ],
          source: {
            kind: 'model',
            ...{ provider: 'mock', model: 'mock' },
          },
        }),
      } },
      { type: 'step/end', seq: 3, time: 3, data: { turn: 2, step: 1 } },
    ]

    const closers = openTurnClosers(events, cause)
    expect(closers).toEqual([{
      type: 'turn/end', seq: 4, time: 3, data: { turn: 2, reason: cause },
    }])
  })

  it('synthesizes results only for the still-open turn, not a committed earlier turn', () => {
    // Turn 1 completed with its own tool call+result (balanced). Turn 2 was cut
    // open with an unanswered call. Only turn 2's call must get a synthetic result.
    const events: SessionEvent[] = [
      userTurnStart(1, 0),
      { type: 'step/start', seq: 1, time: 1, data: { turn: 1, step: 1 } },
      { type: 'assistant/message', seq: 2, time: 2, surfaceOp: 'append', data: {
        turn: 1, step: 1,
        message: createMessage({
          role: 'assistant',
          content: [
            { type: 'tool-call', id: ToolCallId('old-call'), name: 'bash', arguments: '{}' },
          ],
          source: {
            kind: 'model',
            ...{ provider: 'mock', model: 'mock' },
          },
        }),
      } },
      { type: 'tool/result', seq: 3, time: 3, surfaceOp: 'append', data: {
        turn: 1, step: 1,
        message: createToolResultMessage({
          callId: ToolCallId('old-call'),
          content: [],
          isError: false,
        }),
      } },
      { type: 'step/end', seq: 4, time: 4, data: { turn: 1, step: 1 } },
      { type: 'turn/end', seq: 5, time: 5, data: { turn: 1, reason: { kind: 'completed' } } },
      userTurnStart(2, 6),
      { type: 'step/start', seq: 7, time: 7, data: { turn: 2, step: 1 } },
      { type: 'assistant/message', seq: 8, time: 8, surfaceOp: 'append', data: {
        turn: 2, step: 1,
        message: createMessage({
          role: 'assistant',
          content: [
            { type: 'tool-call', id: ToolCallId('new-call'), name: 'bash', arguments: '{}' },
          ],
          source: {
            kind: 'model',
            ...{ provider: 'mock', model: 'mock' },
          },
        }),
      } },
    ]
    const closers = openTurnClosers(events, cause)
    expect(closers.map(e => e.type)).toEqual(['tool/result', 'step/end', 'turn/end'])
    const result = closers[0]!
    expect(result.type === 'tool/result' && result.data.message.source.callId).toBe('new-call')
  })

  it('synthesizes a result for each of multiple unanswered calls, in log order', () => {
    const events: SessionEvent[] = [
      userTurnStart(1, 0),
      { type: 'step/start', seq: 1, time: 1, data: { turn: 1, step: 1 } },
      { type: 'assistant/message', seq: 2, time: 2, surfaceOp: 'append', data: {
        turn: 1, step: 1,
        message: createMessage({
          role: 'assistant',
          content: [
            { type: 'tool-call', id: ToolCallId('call-a'), name: 'bash', arguments: '{}' },
            { type: 'tool-call', id: ToolCallId('call-b'), name: 'bash', arguments: '{}' },
          ],
          source: {
            kind: 'model',
            ...{ provider: 'mock', model: 'mock' },
          },
        }),
      } },
      // call-a got answered before the cut; call-b did not.
      { type: 'tool/result', seq: 3, time: 3, surfaceOp: 'append', data: {
        turn: 1, step: 1,
        message: createToolResultMessage({
          callId: ToolCallId('call-a'),
          content: [],
          isError: false,
        }),
      } },
    ]
    const closers = openTurnClosers(events, cause)
    expect(closers.map(e => e.type)).toEqual(['tool/result', 'step/end', 'turn/end'])
    const result = closers[0]!
    expect(result.type === 'tool/result' && result.data.message.source.callId).toBe('call-b')
  })

  it('synthesized tool/result carries surfaceOp and sourceEventSeqs when tool/call was logged', () => {
    const events: SessionEvent[] = [
      userTurnStart(1, 0),
      { type: 'step/start', seq: 1, time: 1, data: { turn: 1, step: 1 } },
      { type: 'assistant/message', seq: 2, time: 2, surfaceOp: 'append', data: {
        turn: 1, step: 1,
        message: createMessage({
          role: 'assistant',
          content: [
            { type: 'tool-call', id: ToolCallId('call-1'), name: 'bash', arguments: '{}' },
          ],
          source: {
            kind: 'model',
            ...{ provider: 'mock', model: 'mock' },
          },
        }),
      } },
      { type: 'tool/call', seq: 3, time: 3, data: { turn: 1, step: 1, callId: ToolCallId('call-1'), name: 'bash', arguments: '{}' } },
    ]
    const closers = openTurnClosers(events, cause)
    expect(closers.map(e => e.type)).toEqual(['tool/result', 'step/end', 'turn/end'])
    const result = closers[0]!
    expect((result as SurfaceEvent).surfaceOp).toBe('append')
    expect((result as SurfaceEvent).sourceEventSeqs).toEqual([3])
    expect(result.type === 'tool/result' && result.data.error).toEqual({
      name: 'ToolOutcomeUnknownError', code: TOOL_OUTCOME_UNKNOWN,
    })
    if (result.type !== 'tool/result' || result.data.message.content[0]?.type !== 'text') {
      throw new Error('expected a text tool result')
    }
    expect(result.data.message.content[0].text).toContain('retry only if the operation is read-only or idempotent')
    expect(result.data.message.content[0].text).toContain('first verify external state or ask the user')
  })

  it('handles tool/call without a matching assistant/message entry gracefully', () => {
    // A raw tool/call with no assistant-registered pending call has nothing to
    // answer; repair still closes the step and turn without synthesizing a result.
    const events: SessionEvent[] = [
      userTurnStart(1, 0),
      { type: 'step/start', seq: 1, time: 1, data: { turn: 1, step: 1 } },
      { type: 'tool/call', seq: 2, time: 2, data: { turn: 1, step: 1, callId: ToolCallId('orphan'), name: 'bash', arguments: '{}' } },
    ]
    const closers = openTurnClosers(events, cause)
    // No pending calls → no synthetic tool/result, just step/end + turn/end.
    expect(closers.map(e => e.type)).toEqual(['step/end', 'turn/end'])
  })
})

describe('openTurnClosers model-visible wording', () => {
  /** An open turn with one unanswered call; `started` also logs its tool/call. */
  function openCall(started: boolean): SessionEvent[] {
    const events: SessionEvent[] = [
      userTurnStart(1, 0),
      { type: 'step/start', seq: 1, time: 1, data: { turn: 1, step: 1 } },
      { type: 'assistant/message', seq: 2, time: 2, data: {
        turn: 1, step: 1,
        message: createMessage({
          role: 'assistant',
          content: [
            { type: 'tool-call', id: ToolCallId('call-1'), name: 'bash', arguments: '{}' },
          ],
          source: {
            kind: 'model',
            ...{ provider: 'mock', model: 'mock' },
          },
        }),
      } },
    ]
    if (started) {
      events.push({ type: 'tool/call', seq: 3, time: 3, data: { turn: 1, step: 1, callId: ToolCallId('call-1'), name: 'bash', arguments: '{}' } })
    }
    return events
  }

  function resultText(closers: LogicalSessionEvent[]): string {
    const result = closers[0]
    if (result?.type !== 'tool/result' || result.data.message.content[0]?.type !== 'text') {
      throw new Error('expected a text tool result')
    }
    return result.data.message.content[0].text
  }

  // The exact wording is model-visible: pinned verbatim per cause and lifecycle.
  it.each([
    [
      { kind: 'interrupted' } satisfies OpenTurnCloseCause,
      false,
      'The tool call was interrupted before the Harness recorded it as started. Retry it if it is still needed.',
    ],
    [
      { kind: 'interrupted' } satisfies OpenTurnCloseCause,
      true,
      'The tool call was interrupted after it was recorded, but no result was durably recorded. Its outcome is unknown. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.',
    ],
    [
      { kind: 'forked' } satisfies OpenTurnCloseCause,
      false,
      'The history inherited by this branch has no record of this tool call starting. The parent session may have executed it after the fork point. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.',
    ],
    [
      { kind: 'forked' } satisfies OpenTurnCloseCause,
      true,
      'The history inherited by this branch records this tool call starting but does not include its result. The parent session may have completed it after the fork point. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.',
    ],
  ])('cause %o, started=%s pins its exact text', (cause, started, text) => {
    expect(resultText(openTurnClosers(openCall(started), cause))).toBe(text)
  })

  it('shares the error codes across causes: they state the same call lifecycle fact', () => {
    for (const cause of causes) {
      const notStarted = openTurnClosers(openCall(false), cause)[0]
      expect(notStarted?.type === 'tool/result' && notStarted.data.error).toEqual({
        name: 'ToolNotStartedError', code: TOOL_NOT_STARTED,
      })
      const started = openTurnClosers(openCall(true), cause)[0]
      expect(started?.type === 'tool/result' && started.data.error).toEqual({
        name: 'ToolOutcomeUnknownError', code: TOOL_OUTCOME_UNKNOWN,
      })
    }
  })

  it('interruptedTurnClosers is the public interrupted-cause entry (cause selection stays internal)', () => {
    const events = openCall(true)
    expect(interruptedTurnClosers(events)).toEqual(openTurnClosers(events, { kind: 'interrupted' }))
    const end = interruptedTurnClosers(events).at(-1)
    expect(end?.type === 'turn/end' && end.data.reason).toEqual({ kind: 'interrupted' })
  })
})

describe('incremental recovery equivalence', () => {
  function history(): LogicalSessionEvent[] {
    return [
      { type: 'turn/start', seq: SessionSeq(0), time: 10, data: { turn: 3 } },
      { type: 'step/start', seq: SessionSeq(1), time: 20, data: { turn: 3, step: 2 } },
      { ...liveToolRequests(), seq: SessionSeq(2), time: 30 },
      { type: 'tool/call', seq: SessionSeq(3), time: 35,
        data: { turn: 3, step: 2, callId: ToolCallId('started'), name: 'bash', arguments: '{}' } },
      { type: 'test/repair-tail', seq: SessionSeq(4), time: 40, data: { value: 'unrelated' } },
    ]
  }

  it.each(causes)('retains the exact recovery order, metadata and ownership for $kind', (cause) => {
    const events = history()
    const input = structuredClone(events)
    const first = closeOpenTurn(events, cause)
    const again = closeOpenTurn(events, cause)
    expect(first).toEqual(again)
    expect(first).not.toBe(again)
    expect(first[0]).not.toBe(again[0])
    expect(events).toEqual(input)
    expect(first.map(event => ({ type: event.type, seq: event.seq, time: event.time }))).toEqual([
      { type: 'tool/result', seq: 5, time: 40 },
      { type: 'tool/result', seq: 6, time: 40 },
      { type: 'step/end', seq: 7, time: 40 },
      { type: 'turn/end', seq: 8, time: 40 },
    ])
    const started = first[0]
    const pending = first[1]
    if (started?.type !== 'tool/result' || pending?.type !== 'tool/result') throw new Error('expected tool results')
    expect(started.data.message.id).toBe(cause.kind + '-tool-result-started-5')
    expect(started.data.message.source.callId).toBe('started')
    expect(started.data.error).toEqual({ name: 'ToolOutcomeUnknownError', code: TOOL_OUTCOME_UNKNOWN })
    expect(started.sourceEventSeqs).toEqual([3])
    expect(pending.data.message.id).toBe(cause.kind + '-tool-result-pending-6')
    expect(pending.data.error).toEqual({ name: 'ToolNotStartedError', code: TOOL_NOT_STARTED })
    expect(pending.sourceEventSeqs).toBeUndefined()
    expect(Object.isFrozen(started)).toBe(false)
    expect(Object.isFrozen(started.data)).toBe(false)
    expect(Object.isFrozen(started.data.message)).toBe(true)
    expect(Object.isFrozen(started.data.message.source)).toBe(true)
    expect(Object.isFrozen(started.data.message.content)).toBe(true)
    expect(Object.isFrozen(started.data.message.content[0])).toBe(true)
    expect(first[2]).toEqual({ type: 'step/end', seq: 7, time: 40, data: { turn: 3, step: 2 } })
    expect(first[3]).toEqual({ type: 'turn/end', seq: 8, time: 40, data: { turn: 3, reason: { kind: cause.kind } } })
    if (cause.kind === 'interrupted') expect(repairInterruptedTurn(events)).toEqual(first)
  })

  it('reads the array tail after iteration even for a balanced log', () => {
    const reason = new Error('tail lookup failed')
    const events: LogicalSessionEvent[] = []
    const observed = new Proxy(events, { get(target, key, receiver) {
      if (key === 'at') throw reason
      const value: unknown = Reflect.get(target, key, receiver)
      return value
    } })
    expect(() => { closeOpenTurn(observed, { kind: 'interrupted' }) }).toThrow(reason)
  })

  it('preserves the original event-read error before examining event type', () => {
    const seqFailure = new Error('sequence read failed')
    const typeFailure = new Error('type read failed')
    const event = new Proxy(history()[0]!, { get(target, key, receiver) {
      if (key === 'seq') throw seqFailure
      if (key === 'type') throw typeFailure
      const value: unknown = Reflect.get(target, key, receiver)
      return value
    } })
    expect(() => { closeOpenTurn([event], { kind: 'interrupted' }) }).toThrow(seqFailure)
  })

  it('uses the observed tail for tool results and the final array tail for lifecycle closers', () => {
    const source = history()
    const last = source.at(-1)
    if (last === undefined) throw new Error('expected an event')
    const events = new Proxy(source, { get(target, key, receiver) {
      if (key === Symbol.iterator) return function* () {
        yield* target
        last.seq = SessionSeq(100)
        last.time = 1234
      }
      const value: unknown = Reflect.get(target, key, receiver)
      return value
    } })
    const result = closeOpenTurn(events, { kind: 'interrupted' })
    expect(result.map(event => ({ type: event.type, seq: event.seq, time: event.time }))).toEqual([
      { type: 'tool/result', seq: 5, time: 40 },
      { type: 'tool/result', seq: 6, time: 40 },
      { type: 'step/end', seq: 103, time: 1234 },
      { type: 'turn/end', seq: 104, time: 1234 },
    ])
  })

  it('keeps a closed step closed when an unrelated event follows', () => {
    const events: LogicalSessionEvent[] = [
      { type: 'turn/start', seq: SessionSeq(0), time: 10, data: { turn: 3 } },
      { type: 'step/start', seq: SessionSeq(1), time: 20, data: { turn: 3, step: 2 } },
      { type: 'step/end', seq: SessionSeq(2), time: 30, data: { turn: 3, step: 2 } },
      { type: 'test/repair-tail', seq: SessionSeq(3), time: 40, data: { value: 'unrelated' } },
    ]
    expect(repairInterruptedTurn(events)).toEqual([
      { type: 'turn/end', seq: 4, time: 40, data: { turn: 3, reason: { kind: 'interrupted' } } },
    ])
  })
})
