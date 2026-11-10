/** Runtime view and claim recovery edges on real RG Sessions. */
import { describe, expect, it, vi } from 'vitest'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { gitRuntimeFixture } from './fixtures/git-runtime.ts'

const claimId = SessionSeq(1)

describe('RG runtime view and claim recovery edges', () => {
  it('bounds hostile JSON claim fragments without losing valid text order', async () => {
    const f = await gitRuntimeFixture({ backend: false, noGit: true })
    const { agent } = await f.task()
    const target = 'next-turn' as const
    const claim = { intentSeq: claimId, target, turn: 1, step: 1, inputs: [
      { target, message: null }, { target, message: false }, { target, message: [] }, { target, message: {} },
      { target, message: { content: [null, false, [], {}, { type: 'text', text: 'first' }, { type: 'text', text: 'second' }] } },
    ] }
    const result = f.runtime.claimReport(agent.session, 'unknown', claim)
    expect(result).toMatchObject({ claim: { inputCount: 5, otherContent: true, textPreview: 'first\nsecond' }, rawPayloadTruncated: true })
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(16384)
  })

  it('limits both message and block scans when claim input is unusually large', async () => {
    const f = await gitRuntimeFixture({ backend: false, noGit: true })
    const { agent } = await f.task()
    const target = 'next-turn' as const
    const base = { intentSeq: claimId, target, turn: 1, step: 1 }
    const messages = Array.from({ length: 8193 }, () => ({ target, message: null }))
    const many = f.runtime.claimReport(agent.session, 'unknown', { ...base, inputs: messages })
    expect(many.claim).toMatchObject({ inputCount: 8193, otherContent: true, textPreview: '' })
    const blocks = Array.from({ length: 8193 }, () => null)
    const fragmented = f.runtime.claimReport(agent.session, 'unknown', { ...base, inputs: [{ target, message: { content: blocks } }] })
    expect(fragmented.claim).toMatchObject({ inputCount: 1, otherContent: true, textPreview: '' })
    const full = f.runtime.claimReport(agent.session, 'unknown', { ...base,
      inputs: [{ target, message: { content: [{ type: 'text', text: 'x'.repeat(8192) }, { type: 'text', text: 'more' }] } }] })
    expect(full.claim?.textPreview).toHaveLength(8192)
    expect(full.claim?.otherContent).toBe(true)
    expect(f.runtime.claimReport(agent.session, 'saving', null)).toMatchObject({ claimStatus: 'saving', claim: null })
  })

  it.each(['enableClaimProtection', 'claimProtectionStatus', 'claimRecovery', 'exclusiveAdmission'] as const)(
    'fails closed if the live Agent lacks %s', async (capability) => {
      const f = await gitRuntimeFixture({ backend: false, noGit: true })
      const { agent } = await f.task()
      const before = Object.getOwnPropertyDescriptor(agent, capability)
      Object.defineProperty(agent, capability, { configurable: true, value: undefined })
      try {
        expect(f.runtime.statusOf(agent.session)).toBe('unknown')
        const state = f.runtime.read(agent.session)
        const selection = state?.policy?.main.default
        if (selection == null) throw new Error('Expected configured main model')
        expect(() => { f.runtime.assertRequest(agent, selection) }).toThrow(/Protected input claims/)
        const abort = new AbortController()
        const stream = f.runtime.watchView({ sessionId: agent.id }, abort.signal)[Symbol.asyncIterator]()
        try { expect((await stream.next()).value).toMatchObject({ status: 'unknown', state: null }) }
        finally { abort.abort(); await stream.return?.() }
      } finally {
        if (before === undefined) Reflect.deleteProperty(agent, capability)
        else Object.defineProperty(agent, capability, before)
      }
    },
  )

  it('clears a view if a projection snapshot listener fails', async () => {
    const f = await gitRuntimeFixture({ backend: false, noGit: true })
    const { agent } = await f.task()
    const state = f.runtime.read(agent.session)
    if (state?.task == null) throw new Error('Expected a task')
    const abort = new AbortController()
    const stream = f.runtime.watchView({ sessionId: agent.id }, abort.signal)[Symbol.asyncIterator]()
    try {
      expect((await stream.next()).value).toMatchObject({ status: 'ready' })
      const snapshot = vi.spyOn(f.ctx.sessionProjections, 'snapshot').mockImplementationOnce(() => { throw new Error('snapshot failed') })
      try {
        agent.session.append('review-gated/state', { version: 1, state: { ...state, task: { ...state.task, objective: 'changed' } } })
        expect((await stream.next()).value).toMatchObject({ status: 'unknown', state: null })
      } finally { snapshot.mockRestore() }
    } finally { abort.abort(); await stream.return?.() }
  })

  it('withdraws a live view when its exact Agent is disposed', async () => {
    const f = await gitRuntimeFixture({ backend: false, noGit: true })
    const handle = await f.task()
    const session = handle.agent.session
    const abort = new AbortController()
    const stream = f.runtime.watchView({ sessionId: session.id }, abort.signal)[Symbol.asyncIterator]()
    try {
      expect((await stream.next()).value).toMatchObject({ status: 'ready' })
      await handle.dispose()
      expect(f.runtime.statusOf(session)).toBe('unknown')
      expect((await stream.next()).value).toMatchObject({ status: 'unknown', state: null })
    } finally { abort.abort(); await stream.return?.() }
  })

  it('cleans up a cancelled view before opening its snapshot', async () => {
    const f = await gitRuntimeFixture({ backend: false, noGit: true })
    const { agent } = await f.task()
    const abort = new AbortController()
    abort.abort(new Error('caller cancelled'))
    const stream = f.runtime.watchView({ sessionId: agent.id }, abort.signal)[Symbol.asyncIterator]()
    await expect(stream.next()).rejects.toThrow('caller cancelled')
    expect(f.runtime['viewListeners'].has(agent.id)).toBe(false)
  })
})
