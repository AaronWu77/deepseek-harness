/** Local Git save barriers publish saving until the exact operation settles. */
import { describe, expect, it, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { git, gitHandoff, gitRuntimeFixture } from './fixtures/git-runtime.ts'

const signal = () => new AbortController().signal

describe('RG Git view durability', { timeout: 120_000 }, () => {
  it('publishes claim unknown immediately even while Git inspection is in progress', async () => {
    const f = await gitRuntimeFixture()
    const { agent } = await f.task()
    const calls = f.adapter.calls.length
    const baseline = agent.session.snapshotEvents().filter(event => event.type === 'agent/claim/intent').length
    const entered = f.gate()
    const release = f.gate()
    const spawn = f.ctx.subprocess.spawn.bind(f.ctx.subprocess)
    const spy = vi.spyOn(f.ctx.subprocess, 'spawn').mockImplementation((spec) => {
      const child = spawn(spec)
      return spec.argv.includes('symbolic-ref') ? { ...child, done: child.done.then(async (outcome) => {
        entered.resolve(undefined)
        await release.promise
        return outcome
      }), terminate: () => { child.terminate() }, waitForExit: () => child.waitForExit() } : child
    })
    const off = f.ctx.on('session/flush', (session) => {
      if (session === agent.session && session.snapshotEvents().filter(event => event.type === 'agent/claim/intent').length > baseline) {
        throw new Error('claim intent save failed')
      }
    })
    const abort = new AbortController()
    const stream = f.runtime.watchView({ sessionId: agent.id }, abort.signal)[Symbol.asyncIterator]()
    await stream.next()
    const operation = f.track(f.runtime.authorizeLocalGit(agent, ['tracked.txt'], signal()))
    const failed = operation.then(() => null, (error: unknown) => error)
    try {
      await entered.promise
      const input = createUserMessage({ content: [{ type: 'text', text: 'Input during Git inspection' }], source: { kind: 'user' } })
      agent.followup(input)
      await agent.whenIdle()
      expect(agent.claimProtectionStatus).toBe('unknown')
      const events = agent.session.snapshotEvents()
      const intent = events.find(event => event.type === 'agent/claim/intent' && event.data.inputs.some(item => item.message.id === input.id))
      if (intent?.type !== 'agent/claim/intent') throw new Error('Expected the uncertain claim intent')
      expect(intent.data.inputs.map(item => item.message)).toContainEqual(input)
      expect(events.some(event => event.type === 'agent/claim/settled' && event.data.intentSeq === intent.seq)).toBe(false)
      expect(f.adapter.calls).toHaveLength(calls)
      expect((await stream.next()).value).toMatchObject({ status: 'unknown' })
      off()
      spy.mockRestore()
      release.resolve(undefined)
      expect(await failed).toBeInstanceOf(Error)
      expect(f.runtime.statusOf(agent.session)).toBe('unknown')
    } finally { off(); spy.mockRestore(); release.resolve(undefined); abort.abort(); await stream.return?.() }
  })

  it('publishes the final view after a Git-backed review recheck', async () => {
    const f = await gitRuntimeFixture()
    const { agent } = await f.task()
    await f.runtime.authorizeLocalGit(agent, ['tracked.txt'], signal())
    await f.role(agent, 'worker')
    await f.role(agent, 'reviewer')
    expect(f.runtime.read(agent.session)?.task?.reviewStatus).toBe('reported-pass')
    const abort = new AbortController()
    const stream = f.runtime.watchView({ sessionId: agent.id }, abort.signal)[Symbol.asyncIterator]()
    await stream.next()
    const entered = f.gate()
    const release = f.gate()
    const spawn = f.ctx.subprocess.spawn.bind(f.ctx.subprocess)
    const spy = vi.spyOn(f.ctx.subprocess, 'spawn').mockImplementation((spec) => {
      const child = spawn(spec)
      return spec.argv.includes('symbolic-ref') ? { ...child, done: child.done.then(async (outcome) => {
        entered.resolve(undefined)
        await release.promise
        return outcome
      }), terminate: () => { child.terminate() }, waitForExit: () => child.waitForExit() } : child
    })
    try {
      const recheck = f.track(f.runtime.recheck(agent, signal()))
      await entered.promise
      expect((await stream.next()).value).toMatchObject({ status: 'saving' })
      spy.mockRestore()
      release.resolve(undefined)
      await recheck
      expect((await stream.next()).value).toMatchObject({ status: 'ready' })
    } finally { spy.mockRestore(); release.resolve(undefined); abort.abort(); await stream.return?.() }
  })

  it('durably rejects busy inputs without losing them and accepts later input after authorization', async () => {
    const f = await gitRuntimeFixture()
    const { agent } = await f.task()
    const entered = f.gate()
    const release = f.gate()
    const spawn = f.ctx.subprocess.spawn.bind(f.ctx.subprocess)
    const spy = vi.spyOn(f.ctx.subprocess, 'spawn').mockImplementation((spec) => {
      const child = spawn(spec)
      return spec.argv.includes('symbolic-ref') ? { ...child, done: child.done.then(async (outcome) => {
        entered.resolve(undefined)
        await release.promise
        return outcome
      }), terminate: () => { child.terminate() }, waitForExit: () => child.waitForExit() } : child
    })
    const operation = f.track(f.runtime.authorizeLocalGit(agent, ['tracked.txt'], signal()))
    try {
      await entered.promise
      const calls = f.adapter.calls.length
      const inputs = ['first busy input', 'second busy input'].map(text =>
        createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
      for (const input of inputs) agent.followup(input)
      await agent.whenIdle()
      expect(f.adapter.calls).toHaveLength(calls)
      expect(agent.claimProtectionStatus).toBeNull()
      await f.ctx.sessionPersistence.flush()
      const stored = await f.ctx.sessionPersistence.open(agent.id, 'read')
      try {
        const events = (await stored.read()).events
        for (const input of inputs) {
          const claim = events.find(event => event.type === 'agent/claim/intent' && event.data.inputs.some(item => item.message.id === input.id))
          if (claim?.type === 'agent/claim/intent') {
            expect(claim.data.inputs.map(item => item.message)).toContainEqual(input)
            expect(events.some(event => event.type === 'agent/claim/settled' && event.data.intentSeq === claim.seq && event.data.outcome === 'rejected')).toBe(true)
          } else {
            expect(agent.inbox.nextTurn).toContainEqual(input)
            expect(events.some(event => event.type === 'agent/inbox/spliced' && event.data.inserted.some(item => JSON.stringify(item) === JSON.stringify(input)))).toBe(true)
          }
        }
      } finally { await stored.close() }
      release.resolve(undefined)
      await operation
      const after = createUserMessage({ content: [{ type: 'text', text: 'Continue after authorization' }], source: { kind: 'user' } })
      agent.followup(after)
      await agent.whenIdle()
      expect(f.adapter.calls.length).toBeGreaterThan(calls)
      expect(agent.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.id === after.id)).toBe(true)
    } finally { release.resolve(undefined); spy.mockRestore() }
  })

  it('does not publish authorization after the same task identity changes during its save', async () => {
    const f = await gitRuntimeFixture()
    const { agent } = await f.task()
    const before = await git(f.root, 'status', '--porcelain')
    const abort = new AbortController()
    const stream = f.runtime.watchView({ sessionId: agent.id }, abort.signal)[Symbol.asyncIterator]()
    await stream.next()
    const entered = f.gate()
    const release = f.gate()
    const off = f.ctx.on('session/flush', async (session) => {
      if (session !== agent.session || f.runtime.readGit(session)?.status !== 'authorized') return
      entered.resolve(undefined)
      await release.promise
    })
    try {
      const operation = f.track(f.runtime.authorizeLocalGit(agent, ['tracked.txt'], signal()))
      const outcome = operation.then(() => null, (error: unknown) => error)
      await entered.promise
      const state = f.runtime.read(agent.session)
      if (state?.task == null) throw new Error('Expected the authorized task')
      agent.session.append('review-gated/state', { version: 1, state: { ...state,
        task: { ...state.task, objective: 'Changed while saving' } } })
      expect((await stream.next()).value).toMatchObject({ status: 'saving' })
      off()
      release.resolve(undefined)
      expect(await outcome).toMatchObject({ code: 'review-gated/refused', details: { reason: 'RG_GIT_CHANGED' } })
      expect((await stream.next()).value).toMatchObject({ status: 'unknown' })
      expect(await git(f.root, 'status', '--porcelain')).toBe(before)
    } finally { off(); release.resolve(undefined); abort.abort(); await stream.return?.() }
  })

  it('hides authorization and departure until their real flushes settle', async () => {
    const f = await gitRuntimeFixture()
    const { agent } = await f.task()
    const before = await git(f.root, 'status', '--porcelain')
    const abort = new AbortController()
    const stream = f.runtime.watchView({ sessionId: agent.id }, abort.signal)[Symbol.asyncIterator]()
    await stream.next()
    const authorized = f.gate()
    const releaseAuthorization = f.gate()
    const offAuthorization = f.ctx.on('session/flush', async (session) => {
      if (session !== agent.session || f.runtime.readGit(session)?.status !== 'authorized') return
      authorized.resolve(undefined)
      await releaseAuthorization.promise
    })
    try {
      const operation = f.track(f.runtime.authorizeLocalGit(agent, ['tracked.txt'], signal()))
      await authorized.promise
      expect((await stream.next()).value).toMatchObject({ status: 'saving' })
      offAuthorization()
      releaseAuthorization.resolve(undefined)
      await operation
      expect((await stream.next()).value).toMatchObject({ status: 'ready', git: { status: 'authorized' } })
      const leaving = f.gate()
      const releaseLeave = f.gate()
      const offLeave = f.ctx.on('session/flush', async (session) => {
        if (session !== agent.session || f.runtime.readGit(session) !== null) return
        leaving.resolve(undefined)
        await releaseLeave.promise
      })
      try {
        const departure = f.track(f.runtime.leaveLocalGit(agent))
        await leaving.promise
        expect((await stream.next()).value).toMatchObject({ status: 'saving' })
        offLeave()
        releaseLeave.resolve(undefined)
        await departure
        expect((await stream.next()).value).toMatchObject({ status: 'ready', git: null })
      } finally { offLeave(); releaseLeave.resolve(undefined) }
      expect(await git(f.root, 'status', '--porcelain')).toBe(before)
    } finally { offAuthorization(); releaseAuthorization.resolve(undefined); abort.abort(); await stream.return?.() }
  })

  it('keeps a failed authorization as inspectable Git unknown without changing source', async () => {
    const f = await gitRuntimeFixture()
    const { agent } = await f.task()
    const before = await git(f.root, 'status', '--porcelain')
    const abort = new AbortController()
    const stream = f.runtime.watchView({ sessionId: agent.id }, abort.signal)[Symbol.asyncIterator]()
    await stream.next()
    let failed = false
    const off = f.ctx.on('session/flush', async (session) => {
      if (session !== agent.session || failed || f.runtime.readGit(session)?.status !== 'authorized') return
      failed = true
      await f.ctx.sessionPersistence.flush()
      throw new Error('authorized grant flush acknowledgement lost')
    })
    try {
      await expect(f.runtime.authorizeLocalGit(agent, ['tracked.txt'], signal())).rejects.toMatchObject({ code: 'review-gated/refused' })
      expect(failed).toBe(true)
      expect((await stream.next()).value).toMatchObject({ status: 'ready', git: { status: 'unknown' } })
      await expect(f.runtime.newTask(agent, 'Do not continue')).rejects.toMatchObject({ code: 'review-gated/refused' })
      await expect(f.runtime.startRole(agent, 'worker', gitHandoff, undefined, signal())).rejects.toMatchObject({ code: 'RG_GIT_UNKNOWN' })
      off()
      await f.runtime.leaveLocalGit(agent)
      expect((await stream.next()).value).toMatchObject({ status: 'ready', git: null })
      expect(await git(f.root, 'status', '--porcelain')).toBe(before)
    } finally { off(); abort.abort(); await stream.return?.() }
  })

  it('retains global unknown after a departure save failure without changing source', async () => {
    const f = await gitRuntimeFixture()
    const { agent } = await f.task()
    const before = await git(f.root, 'status', '--porcelain')
    await f.runtime.authorizeLocalGit(agent, ['tracked.txt'], signal())
    const abort = new AbortController()
    const stream = f.runtime.watchView({ sessionId: agent.id }, abort.signal)[Symbol.asyncIterator]()
    await stream.next()
    let failed = false
    const off = f.ctx.on('session/flush', async (session) => {
      if (session !== agent.session || failed || f.runtime.readGit(session) !== null) return
      failed = true
      await f.ctx.sessionPersistence.flush()
      throw new Error('departure acknowledgement lost')
    })
    try {
      await expect(f.runtime.leaveLocalGit(agent)).rejects.toThrow('departure acknowledgement lost')
      expect(failed).toBe(true)
      expect((await stream.next()).value).toMatchObject({ status: 'unknown' })
      await expect(f.runtime.newTask(agent, 'Do not continue')).rejects.toMatchObject({ code: 'review-gated/refused' })
      expect(await git(f.root, 'status', '--porcelain')).toBe(before)
    } finally { off(); abort.abort(); await stream.return?.() }
  })
})
