import { describe, expect, it } from 'vitest'
import { firstHeadlessRecordingInput } from './headless-snapshot-recording.ts'

describe('first headless recording input', () => {
  it('preserves explicit task text and scripted model route without any fabricated Session', () => {
    expect(firstHeadlessRecordingInput({ input: { task: 'Run a fresh ordinary child and a roster teammate.' }, environment: {
      DSH_SNAPSHOT_PROVIDER: 'scripted', DSH_SNAPSHOT_MODEL: 'coexistence',
    } })).toEqual({ task: 'Run a fresh ordinary child and a roster teammate.', model: { provider: 'scripted', model: 'coexistence' } })
  })
  it.each([undefined, '', '   '])('refuses absent or blank first task %s', (task) => {
    expect(() => firstHeadlessRecordingInput({ ...(task === undefined ? {} : { input: { task } }), environment: {
      DSH_SNAPSHOT_PROVIDER: 'scripted', DSH_SNAPSHOT_MODEL: 'coexistence',
    } })).toThrow('input.task')
  })
  it.each([
    {}, { DSH_SNAPSHOT_PROVIDER: 'scripted' }, { DSH_SNAPSHOT_MODEL: 'coexistence' },
    { DSH_SNAPSHOT_PROVIDER: ' ', DSH_SNAPSHOT_MODEL: 'coexistence' },
    { DSH_SNAPSHOT_PROVIDER: 'scripted', DSH_SNAPSHOT_MODEL: ' ' },
  ])('refuses unspecified model route %j', (environment) => {
    expect(() => firstHeadlessRecordingInput({ input: { task: 'Record' }, environment })).toThrow('DSH_SNAPSHOT_PROVIDER and DSH_SNAPSHOT_MODEL')
  })
})
