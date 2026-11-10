/** Stored review results remain untrusted until the terminal durability barrier succeeds. */
import { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { RgRunId } from '../src/types.ts'
import { foldRgState, rgProjectionDefinition } from '../src/projection.ts'
import { describe, expect, it } from 'vitest'
import { gitHandoff, gitRuntimeFixture } from './fixtures/git-runtime.ts'

describe('RG terminal durability', { timeout: 120_000 }, () => {
  it('does not recover a reviewer pass while its terminal flush is still pending', async () => {
    const f = await gitRuntimeFixture({ backend: false })
    const { agent } = await f.task()
    const entered = f.gate()
    const release = f.gate()
    let intercepted = false
    const off = f.ctx.on('session/flush', (session) => {
      if (session !== agent.session || intercepted) return
      const task = f.runtime.read(session)?.task
      if (task?.active?.status === 'saving') {
        intercepted = true
        entered.resolve(undefined)
        return release.promise
      }
    })
    let checkpoint: ReturnType<typeof f.ctx.sessionProjections.restore> | undefined
    let preparedCount = 0
    const notice = f.notice(agent)
    await f.runtime.startRole(agent, 'reviewer', gitHandoff, undefined, new AbortController().signal)
    await entered.promise
    try {
      await f.ctx.sessionPersistence.flush()
      const stored = await f.ctx.sessionPersistence.open(agent.id, 'read')
      try {
        const events = (await stored.read()).events
        expect(events.some(event => event.type === 'review-gated/result-prepared')).toBe(true)
        expect(events.some(event => event.type === 'review-gated/result-confirmed')).toBe(false)
        const recovered = f.ctx.sessionProjections.restore({}, events, SessionLogOffset(0), stored.header, stored.inheritedEventCount)
        expect(recovered.snapshot.values.reviewGated?.task?.reviewStatus).not.toBe('reported-pass')
        expect(recovered.snapshot.values.reviewGated?.task?.active).toMatchObject({ status: 'saving', report: null })
        checkpoint = recovered
        preparedCount = events.length
      } finally { await stored.close() }
    } finally { off(); release.resolve(undefined) }
    await notice
    await agent.whenIdle()
    await f.ctx.sessionPersistence.flush()
    const reopened = await f.ctx.sessionPersistence.open(agent.id, 'read')
    try {
      const events = (await reopened.read()).events
      const confirmed = events.find(event => event.type === 'review-gated/result-confirmed')
      expect(confirmed).toBeDefined()
      const full = f.ctx.sessionProjections.restore({}, events, SessionLogOffset(0), reopened.header, reopened.inheritedEventCount)
      expect(full.snapshot.values.reviewGated?.task?.reviewStatus).toBe('reported-pass')
      if (checkpoint === undefined || confirmed === undefined || confirmed.type !== 'review-gated/result-confirmed') {
        throw new Error('The result records are required')
      }
      const suffix = f.ctx.sessionProjections.restore(checkpoint.checkpoint, events.slice(preparedCount),
        SessionLogOffset(preparedCount), reopened.header, reopened.inheritedEventCount)
      expect(suffix.snapshot.values.reviewGated).toEqual(full.snapshot.values.reviewGated)
      const beforeConfirmation = events.slice(0, events.indexOf(confirmed)).reduce(foldRgState, rgProjectionDefinition.init())
      const mismatch = { ...confirmed, data: { ...confirmed.data, runId: brandString<RgRunId>('another-run') } }
      expect(foldRgState(beforeConfirmation, mismatch).failure).toContain('RG_STATE_INVALID')
      const replacement = events.find(event => event.type === 'review-gated/state' && event.data.state?.task === null)
      if (replacement === undefined) throw new Error('Missing earlier RG state')
      expect(foldRgState(foldRgState(beforeConfirmation, replacement), confirmed).failure).toContain('RG_STATE_INVALID')
      const committed = foldRgState(beforeConfirmation, confirmed)
      expect(foldRgState(committed, confirmed).failure).toContain('RG_STATE_INVALID')
      const fork = Session.create(SessionId('fork-during-preparation'), events.slice(0, events.indexOf(confirmed)))
      fork.append('review-gated/result-confirmed', confirmed.data)
      const forked = fork.snapshotEvents().reduce(foldRgState, rgProjectionDefinition.init())
      expect(forked.failure).toContain('RG_STATE_INVALID')
      expect(forked.value?.task?.reviewStatus).not.toBe('reported-pass')
    } finally { await reopened.close() }
  })

  it('leaves a failed preparation untrusted in the live and stored Session', async () => {
    const f = await gitRuntimeFixture({ backend: false })
    const { agent } = await f.task()
    const failed = f.gate()
    let injected = false
    const offFlush = f.ctx.on('session/flush', (session) => {
      if (session === agent.session && !injected && f.runtime.read(session)?.task?.active?.status === 'saving') {
        injected = true
        throw new Error('controlled preparation flush failure')
      }
    })
    const offState = f.ctx.on('session/event', (session, event) => {
      if (session === agent.session && event.type === 'review-gated/state' && event.data.state?.diagnostic?.startsWith('RG_RESULT_SAVE_FAILED')) failed.resolve(undefined)
    })
    try {
      await f.runtime.startRole(agent, 'reviewer', gitHandoff, undefined, new AbortController().signal)
      await failed.promise
      expect(f.runtime.read(agent.session)).toMatchObject({ task: { active: null, reviewStatus: 'inconclusive' } })
      expect(f.runtime.read(agent.session)?.diagnostic).toContain('RG_RESULT_SAVE_FAILED')
      await f.ctx.sessionPersistence.flush()
      const stored = await f.ctx.sessionPersistence.open(agent.id, 'read')
      try {
        const events = (await stored.read()).events
        expect(events.some(event => event.type === 'review-gated/result-prepared')).toBe(true)
        expect(events.some(event => event.type === 'review-gated/result-confirmed')).toBe(false)
        const view = f.ctx.sessionProjections.restore(
          {}, events, SessionLogOffset(0), stored.header, stored.inheritedEventCount).snapshot.values.reviewGated
        expect(view).toMatchObject({ task: { active: null, reviewStatus: 'inconclusive' } })
        expect(view?.diagnostic).toContain('RG_RESULT_SAVE_FAILED')
      } finally { await stored.close() }
    } finally { offFlush(); offState() }
  })

  it('does not expose a worker success from a prepared-only stored prefix', async () => {
    const f = await gitRuntimeFixture({ backend: false })
    const { agent } = await f.task()
    const entered = f.gate()
    const release = f.gate()
    let intercepted = false
    const off = f.ctx.on('session/flush', (session) => {
      if (session === agent.session && !intercepted && f.runtime.read(session)?.task?.active?.status === 'saving') {
        intercepted = true
        entered.resolve(undefined)
        return release.promise
      }
    })
    const notice = f.notice(agent)
    await f.runtime.startRole(agent, 'worker', gitHandoff, undefined, new AbortController().signal)
    await entered.promise
    try {
      await f.ctx.sessionPersistence.flush()
      const stored = await f.ctx.sessionPersistence.open(agent.id, 'read')
      try {
        const events = (await stored.read()).events
        expect(events.some(event => event.type === 'review-gated/result-prepared')).toBe(true)
        expect(events.some(event => event.type === 'review-gated/result-confirmed')).toBe(false)
        const view = f.ctx.sessionProjections.restore(
          {}, events, SessionLogOffset(0), stored.header, stored.inheritedEventCount).snapshot.values.reviewGated
        expect(view?.task?.lastWorker).toBeNull()
        expect(view?.task?.active).toMatchObject({ status: 'saving', report: null })
      } finally { await stored.close() }
    } finally { off(); release.resolve(undefined) }
    await notice
    await agent.whenIdle()
    await f.ctx.sessionPersistence.flush()
    const stored = await f.ctx.sessionPersistence.open(agent.id, 'read')
    try {
      const events = (await stored.read()).events
      const view = f.ctx.sessionProjections.restore(
        {}, events, SessionLogOffset(0), stored.header, stored.inheritedEventCount).snapshot.values.reviewGated
      expect(view?.task?.lastWorker).toMatchObject({ status: 'completed', report: { kind: 'worker', outcome: 'completed' } })
    } finally { await stored.close() }
  })

  it('refuses to confirm a prepared success after its parent is disposed', async () => {
    const f = await gitRuntimeFixture({ backend: false })
    const parent = await f.task()
    const { agent } = parent
    const entered = f.gate()
    const release = f.gate()
    let intercepted = false
    const off = f.ctx.on('session/flush', (session) => {
      if (session === agent.session && !intercepted && f.runtime.read(session)?.task?.active?.status === 'saving') {
        intercepted = true
        entered.resolve(undefined)
        return release.promise
      }
    })
    await f.runtime.startRole(agent, 'reviewer', gitHandoff, undefined, new AbortController().signal)
    await entered.promise
    const closing = Promise.withResolvers<undefined>()
    agent.ctx.effect(() => () => { closing.resolve(undefined) })
    const disposed = parent.dispose()
    await closing.promise
    off()
    release.resolve(undefined)
    await disposed
    const stored = await f.ctx.sessionPersistence.open(agent.id, 'read')
    try {
      const events = (await stored.read()).events
      expect(events.some(event => event.type === 'review-gated/result-prepared')).toBe(true)
      expect(events.some(event => event.type === 'review-gated/result-confirmed')).toBe(false)
      const view = f.ctx.sessionProjections.restore(
        {}, events, SessionLogOffset(0), stored.header, stored.inheritedEventCount).snapshot.values.reviewGated
      expect(view?.task?.reviewStatus).not.toBe('reported-pass')
    } finally { await stored.close() }
  })
})
