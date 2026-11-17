/** Plugin record ownership, claim phases, and durable payload validation. */
import { MessageId } from '@deepseek-ai/dsh-llm'
import { pluginRecordOf, Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { foldGitState, gitProjectionDefinition } from '../src/git-projection.ts'
import { foldRgState, rgProjectionDefinition } from '../src/projection.ts'
import { claimRecordSchema, claimSettledRecordSchema, resultConfirmedRecordSchema } from '../src/records.ts'
import { appendRecord, durableEvents } from './records.ts'

const message = { id: MessageId('human-input'), role: 'user' as const, source: { kind: 'user' as const }, content: [{ type: 'text' as const, text: 'Keep this task' }] }

describe('RG plugin records', () => {
  it('writes explicit clears as ignorable records without interpreting them as core events', () => {
    const session = Session.create(SessionId('rg-record-clears'), [])
    for (const type of ['plugin:review-gated/state', 'plugin:review-gated/git-state'] as const) {
      const event = appendRecord(session, type, { version: 1, state: null })
      expect(event.ignorable).toBe(true)
      expect(pluginRecordOf(event)).toMatchObject({ type, seq: event.seq, data: { version: 1, state: null } })
    }
  })

  it('ignores other plugin owners without changing either projection', () => {
    const rg = rgProjectionDefinition.init()
    const git = gitProjectionDefinition.init()
    for (const type of ['plugin:another-owner/state', 'plugin:another-owner/git-state']) {
      for (const data of [{ version: 999 }, { version: 1, phase: 'confirmed', messageId: message.id }]) {
        const [event] = durableEvents([{ type, seq: 0, time: 1, ignorable: true, data }])
        if (event === undefined) throw new Error('Missing durable record')
        expect(foldRgState(rg, event)).toBe(rg)
        expect(foldGitState(git, event)).toBe(git)
      }
    }
  })

  it('requires original claim input and exactly the intent and settled phases', () => {
    const intent = { version: 1, phase: 'intent', target: 'next-turn', turn: 1, step: 2,
      inputs: [{ target: 'next-turn', message }] }
    const settled = { version: 1, phase: 'settled', intentSeq: SessionSeq(3), outcome: 'entered', messages: [message] }
    expect(claimRecordSchema.parse(intent)).toEqual(intent)
    expect(claimSettledRecordSchema.parse(settled)).toEqual(settled)
    for (const phase of ['opened', 'confirmed', 'uncertain']) {
      const payload = { version: 1, phase, messageId: message.id }
      expect(claimSettledRecordSchema.safeParse(payload).success).toBe(false)
      expect(claimRecordSchema.safeParse(payload).success).toBe(false)
    }
    expect(claimSettledRecordSchema.safeParse({ version: 1, phase: 'opened', messageId: message.id }).success).toBe(false)
    expect(claimRecordSchema.safeParse({ ...intent, inputs: [] }).success).toBe(false)
    expect(claimSettledRecordSchema.safeParse({ ...settled, intentSeq: -1 }).success).toBe(false)
  })

  it('rejects result confirmation payloads that duplicate candidate state', () => {
    const confirmation = { version: 1, taskId: 'task', runId: 'run', childId: 'child' }
    expect(resultConfirmedRecordSchema.parse(confirmation)).toEqual(confirmation)
    expect(resultConfirmedRecordSchema.safeParse({ ...confirmation, state: null }).success).toBe(false)
    expect(resultConfirmedRecordSchema.safeParse({ ...confirmation, version: 2 }).success).toBe(false)
  })
})
