/** Fresh recording does not weaken released fixture inventory validation. */
import { describe, expect, it } from 'vitest'
import { sessionFixtureNamesForRecording } from '../src/session-files.ts'

describe('first recording inventory', () => {
  it('accepts no canonical Sessions only while recording', () => {
    expect(sessionFixtureNamesForRecording(['snapshot.yml', 'scripted-llm.ts'], 'record')).toEqual([])
    for (const mode of ['replay', 'refresh'] as const) {
      expect(() => sessionFixtureNamesForRecording(['snapshot.yml'], mode)).toThrow('missing parent session fixture')
    }
  })

  it.each(['record', 'replay', 'refresh'] as const)('keeps invalid inventory refusal in %s', (mode) => {
    expect(() => sessionFixtureNamesForRecording(['session.v0.jsonl'], mode)).toThrow('invalid session fixture name')
    expect(() => sessionFixtureNamesForRecording(['session.1.v4.jsonl'], mode)).toThrow('missing parent session fixture')
    expect(() => sessionFixtureNamesForRecording(['session.v4.jsonl', 'session.2.v4.jsonl'], mode))
      .toThrow('session fixture roles must be contiguous')
  })

  it('selects existing highest generations without discarding child roles', () => {
    expect(sessionFixtureNamesForRecording([
      'session.v3.jsonl', 'session.v4.jsonl', 'session.1.v3.jsonl', 'session.1.v4.jsonl',
    ], 'record')).toEqual(['session.v4.jsonl', 'session.1.v4.jsonl'])
  })
})
