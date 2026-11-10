/** Regression barriers for the UI projection while confirmed events are flushing. */
import { describe, expect, it } from 'vitest'
import { gitHandoff, gitRuntimeFixture } from './fixtures/git-runtime.ts'

describe('RG UI save barriers', { timeout: 120_000 }, () => {
  it('publishes unknown before exposing a failed confirmation', async () => {
    const f = await gitRuntimeFixture({ backend: false, noGit: true })
    const { agent } = await f.task()
    const abort = new AbortController()
    const stream = f.runtime.watchView({ sessionId: agent.id }, abort.signal)[Symbol.asyncIterator]()
    await stream.next()
    const failed = f.gate()
    let intercepted = false
    const off = f.ctx.on('session/flush', (session) => {
      if (session === agent.session && !intercepted && session.snapshotEvents().some(event => event.type === 'review-gated/result-confirmed')) {
        intercepted = true
        throw new Error('controlled confirmation failure')
      }
    })
    const offState = f.ctx.on('session/event', (session, event) => {
      if (session === agent.session && event.type === 'review-gated/state'
        && event.data.state?.diagnostic?.startsWith('RG_RESULT_SAVE_FAILED')) failed.resolve(undefined)
    })
    try {
      await f.runtime.startRole(agent, 'reviewer', gitHandoff, undefined, new AbortController().signal)
      await failed.promise
      expect(f.runtime.statusOf(agent.session)).toBe('unknown')
      let frame = await stream.next()
      while (!frame.done && frame.value.status !== 'unknown') frame = await stream.next()
      expect(frame.done).toBe(false)
      if (frame.done) throw new Error('Missing unknown view')
      expect(frame.value.state).toBeNull()
    } finally { off(); offState(); abort.abort(); await stream.return?.() }
  })

  it('does not expose task readiness while its confirmed append is flushing', async () => {
    const f = await gitRuntimeFixture({ backend: false, noGit: true })
    const { agent } = await f.task()
    const controller = new AbortController()
    const stream = f.runtime.watchView({ sessionId: agent.session.id }, controller.signal)[Symbol.asyncIterator]()
    await stream.next()
    const entered = f.gate()
    const release = f.gate()
    let intercepted = false
    const before = agent.session.snapshotEvents().filter(event => event.type === 'agent/admission/confirmed').length
    const off = f.ctx.on('session/flush', async (session) => {
      if (session !== agent.session || intercepted || session.snapshotEvents().filter(event => event.type === 'agent/admission/confirmed').length <= before) return
      intercepted = true
      entered.resolve(undefined)
      await release.promise
    })
    const pending = f.track(f.runtime.newTask(agent, 'A new task'))
    try {
      await entered.promise
      await f.ctx.sessionPersistence.flush()
      const stored = await f.ctx.sessionPersistence.open(agent.id, 'read')
      try { expect((await stored.read()).events.filter(event => event.type === 'agent/admission/confirmed').length).toBeGreaterThan(before) }
      finally { await stored.close() }
      const state = f.ctx.sessionProjections.snapshot(agent.session).values.reviewGated
      if (state == null) throw new Error('Missing RG projection')
      let frame = await stream.next()
      while (!frame.done && !(frame.value.status === 'saving' && frame.value.state?.task?.objective === 'A new task')) frame = await stream.next()
      expect(frame.done).toBe(false)
      if (frame.done || frame.value.state === null) throw new Error('Missing saving view')
      expect(frame.value.status).toBe('saving')
    } finally { controller.abort(); await stream.return?.(); off(); release.resolve(undefined); await pending }
  })

  it('does not expose a reviewer pass while its confirmed append is flushing', async () => {
    const f = await gitRuntimeFixture({ backend: false, noGit: true })
    const { agent } = await f.task()
    const controller = new AbortController()
    const stream = f.runtime.watchView({ sessionId: agent.session.id }, controller.signal)[Symbol.asyncIterator]()
    await stream.next()
    const entered = f.gate()
    const release = f.gate()
    let intercepted = false
    const off = f.ctx.on('session/flush', async (session) => {
      if (session !== agent.session || intercepted || !session.snapshotEvents().some(event => event.type === 'review-gated/result-confirmed')) return
      intercepted = true
      entered.resolve(undefined)
      await release.promise
    })
    try {
      const run = await f.runtime.startRole(agent, 'reviewer', gitHandoff, undefined, new AbortController().signal)
      await entered.promise
      const completion = f.runtime['runs'].get(run.subagentId)?.completion
      await f.ctx.sessionPersistence.flush()
      const stored = await f.ctx.sessionPersistence.open(agent.id, 'read')
      try { expect((await stored.read()).events.some(event => event.type === 'review-gated/result-confirmed')).toBe(true) }
      finally { await stored.close() }
      const state = f.ctx.sessionProjections.snapshot(agent.session).values.reviewGated
      if (state == null) throw new Error('Missing RG projection')
      let frame = await stream.next()
      while (!frame.done && !(frame.value.status === 'saving' && frame.value.state?.task?.reviewStatus === 'reported-pass')) frame = await stream.next()
      expect(frame.done).toBe(false)
      if (frame.done || frame.value.state === null) throw new Error('Missing saving view')
      expect(frame.value.status).toBe('saving')
      expect(frame.value.state.task?.reviewStatus).toBe('reported-pass')
      release.resolve(undefined)
      await completion
    } finally { controller.abort(); await stream.return?.(); off(); release.resolve(undefined) }
  })
})
