/** Direct human task claims honor the frozen handoff limit. */
import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import SessionReferenceResolver, { formatSessionReferenceMention } from '@deepseek-ai/dsh-session-reference'
import { gitRuntimeFixture, gitSettings } from './fixtures/git-runtime.ts'

class TestQuery extends SessionQueryEngine {
  override searchSessions(): Promise<never> { return Promise.reject(new Error('Search is not used here')) }
  override searchEvents(): Promise<never> { return Promise.reject(new Error('Search is not used here')) }
}

describe('RG direct task input length', () => {
  it('retains an oversized first claim for inspection without replaying it', async () => {
    const limit = 300
    const f = await gitRuntimeFixture({ backend: false, noGit: true, settings: { ...gitSettings(), maxHandoffChars: limit } })
    const handle = await f.create()
    const { agent } = handle
    const text = 'x'.repeat(limit + 1)
    const input = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
    expect(f.runtime.read(agent.session)?.policy?.maxHandoffChars).toBe(limit)
    agent.followup(input)
    await agent.whenIdle()
    expect.soft(f.adapter.calls).toHaveLength(0)
    expect.soft(f.adapter.calls.some(call => call.messages.some(message => message.role === 'user'
      && message.content.some(block => block.type === 'text' && block.text === text)))).toBe(false)
    expect(f.runtime.read(agent.session)?.task).toBeNull()
    expect(agent.claimProtectionStatus).toBe('unknown')
    expect.soft(f.runtime.claimOf(agent.session)).toMatchObject({ phase: 'unsettled', inputs: [{ message: { id: input.id, content: input.content } }] })
    const id = agent.id
    await handle.dispose()
    const stored = await f.ctx.sessionPersistence.open(id, 'read')
    try {
      const events = (await stored.read()).events
      const intent = events.find(event => event.type === 'agent/claim/intent')
      expect(intent?.data).toMatchObject({ inputs: [{ message: { id: input.id, content: [{ type: 'text', text }] } }] })
      expect.soft(events.some(event => event.type === 'agent/claim/settled' && event.data.outcome === 'entered')).toBe(false)
      expect.soft(events.some(event => event.type === 'assistant/message')).toBe(false)
    } finally { await stored.close() }
    const resumed = await f.ctx.agents.resume({ resumeSessionId: id,
      setup: async (child) => { await f.ctx.agentPresets.mount(child, 'rg') } })
    try {
      await resumed.agent.whenIdle()
      expect.soft(f.adapter.calls).toHaveLength(0)
      expect(f.runtime.read(resumed.agent.session)?.task).toBeNull()
      expect.soft(f.runtime.claimOf(resumed.agent.session)).toMatchObject({ inputs: [{ message: { id: input.id } }] })
    } finally { await resumed.dispose() }
  })

  it('does not create a task from a later input after an oversized first input in one claim', async () => {
    const limit = 300
    const f = await gitRuntimeFixture({ backend: false, noGit: true, settings: { ...gitSettings(), maxHandoffChars: limit } })
    const handle = await f.create()
    const { agent } = handle
    const first = createUserMessage({ content: [{ type: 'text', text: 'x'.repeat(limit + 1) }], source: { kind: 'user' } })
    const second = createUserMessage({ content: [{ type: 'text', text: 'A later valid input' }], source: { kind: 'user' } })
    agent.inject(first)
    agent.followup(second)
    await agent.whenIdle()
    const events = agent.session.snapshotEvents()
    const intent = events.find(event => event.type === 'agent/claim/intent')
    expect(intent?.data).toMatchObject({ inputs: [{ message: { id: first.id } }, { message: { id: second.id } }] })
    expect.soft(f.runtime.read(agent.session)?.task).toBeNull()
    expect.soft(f.adapter.calls).toHaveLength(0)
    expect(agent.claimProtectionStatus).toBe('unknown')
    expect.soft(f.runtime.claimOf(agent.session)).toMatchObject({ phase: 'unsettled', inputs: [
      { message: { id: first.id, content: first.content } }, { message: { id: second.id, content: second.content } },
    ] })
    expect.soft(events.some(event => event.type === 'agent/claim/settled' && event.data.outcome === 'entered')).toBe(false)
    const id = agent.id
    await handle.dispose()
    const resumed = await f.ctx.agents.resume({ resumeSessionId: id,
      setup: async (child) => { await f.ctx.agentPresets.mount(child, 'rg') } })
    try {
      await resumed.agent.whenIdle()
      expect.soft(f.adapter.calls).toHaveLength(0)
      expect.soft(f.runtime.read(resumed.agent.session)?.task).toBeNull()
      expect(f.runtime.statusOf(resumed.agent.session)).toBe('unknown')
      expect.soft(f.runtime.claimOf(resumed.agent.session)).toMatchObject({ phase: 'unsettled', inputs: [
        { message: { id: first.id, content: first.content } }, { message: { id: second.id, content: second.content } },
      ] })
    } finally { await resumed.dispose() }
  })

  it('creates only the first valid task when a later input in the same claim is oversized', async () => {
    const limit = 300
    const f = await gitRuntimeFixture({ backend: false, noGit: true, settings: { ...gitSettings(), maxHandoffChars: limit } })
    const { agent } = await f.create()
    const first = createUserMessage({ content: [{ type: 'text', text: 'First task' }], source: { kind: 'user' } })
    const second = createUserMessage({ content: [{ type: 'text', text: 'x'.repeat(limit + 1) }], source: { kind: 'user' } })
    agent.inject(first)
    agent.followup(second)
    await agent.whenIdle()
    const intent = agent.session.snapshotEvents().find(event => event.type === 'agent/claim/intent')
    expect(intent?.data).toMatchObject({ inputs: [{ message: { id: first.id } }, { message: { id: second.id } }] })
    expect(f.runtime.read(agent.session)?.task).toMatchObject({ originMessageId: first.id, objective: 'First task' })
    expect(f.adapter.calls).toHaveLength(1)
  })

  it('retains the original task across a real session-reference rewrite and cold resume', async () => {
    const f = await gitRuntimeFixture({ backend: false, noGit: true })
    const source = await f.create()
    source.agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Referenced evidence' }],
      source: { kind: 'user' } }), { surfaceOp: 'append' })
    const sourceId = source.agent.id
    await source.dispose()
    await f.ctx.plugin(TestQuery)
    await f.ctx.plugin(SessionReferenceResolver, { maxReferenceBytes: 4096 })
    const handle = await f.create()
    const { agent } = handle
    const original = 'Review ' + formatSessionReferenceMention({ sessionId: sourceId, label: 'source' })
    const input = createUserMessage({ content: [{ type: 'text', text: original }], source: { kind: 'user' } })
    agent.followup(input)
    await agent.whenIdle()
    const task = f.runtime.read(agent.session)?.task
    expect(task).toMatchObject({ originMessageId: input.id, objective: original })
    expect(f.adapter.calls).toHaveLength(1)
    const request = f.adapter.calls[0]
    expect(request?.messages.some(message => message.role === 'user' && message.id === input.id
      && message.content.some(block => block.type === 'text' && block.text === 'Review @source'))).toBe(true)
    expect(request?.messages.some(message => message.role === 'user' && message.source?.kind === 'session-reference'
      && message.content.some(block => block.type === 'text' && block.text.includes('Referenced evidence')))).toBe(true)
    const id = agent.id
    await handle.dispose()
    const abort = new AbortController()
    const stream = f.runtime.watchView({ sessionId: id }, abort.signal)[Symbol.asyncIterator]()
    try { expect((await stream.next()).value).toMatchObject({ status: 'ready', state: { task: { id: task?.id, objective: original } } }) }
    finally { abort.abort(); await stream.return?.() }
    const resumed = await f.ctx.agents.resume({ resumeSessionId: id,
      setup: async (child) => { await f.ctx.agentPresets.mount(child, 'rg') } })
    try {
      await resumed.agent.whenIdle()
      expect(f.runtime.statusOf(resumed.agent.session)).toBe('ready')
      expect(f.runtime.read(resumed.agent.session)?.task).toMatchObject({ id: task?.id, objective: original })
      expect(f.adapter.calls).toHaveLength(1)
    } finally { await resumed.dispose() }
  })

  it.each([true, false] as const)('preserves the original task after same-ID rewrite with prepend=%s', async (prepend) => {
    const f = await gitRuntimeFixture({ backend: false, noGit: true })
    const handle = await f.create()
    const { agent } = handle
    const input = createUserMessage({ content: [{ type: 'text', text: 'Original direct task' }], source: { kind: 'user' } })
    let entered = false
    const off = agent.ctx.on('agent/pre-step', async (_event, next) => {
      const decision = await next()
      entered = true
      if (decision.kind === 'reject') return decision
      return { ...decision, messages: decision.messages.map(message => message.id === input.id
        ? { ...message, content: [{ type: 'text' as const, text: 'Expanded session reference' }] } : message) }
    }, { prepend })
    try {
      agent.followup(input)
      await agent.whenIdle()
      expect(entered).toBe(true)
      expect(f.runtime.read(agent.session)?.task).toMatchObject({ originMessageId: input.id, objective: 'Original direct task' })
      expect(f.adapter.calls).toHaveLength(1)
      expect(f.adapter.calls[0]?.messages.some(message => message.role === 'user' && message.id === input.id
        && message.content.some(block => block.type === 'text' && block.text === 'Expanded session reference'))).toBe(true)
      expect(f.runtime.statusOf(agent.session)).toBe('ready')
      const id = agent.id
      const taskId = f.runtime.read(agent.session)?.task?.id
      expect(taskId).toBeDefined()
      off()
      await handle.dispose()
      await f.ctx.plugin(TestQuery)
      const abort = new AbortController()
      const stream = f.runtime.watchView({ sessionId: id }, abort.signal)[Symbol.asyncIterator]()
      try {
        expect((await stream.next()).value).toMatchObject({ status: 'ready', state: { task: { id: taskId, objective: 'Original direct task' } } })
      } finally { abort.abort(); await stream.return?.() }
      const resumed = await f.ctx.agents.resume({ resumeSessionId: id,
        setup: async (child) => { await f.ctx.agentPresets.mount(child, 'rg') } })
      try {
        await resumed.agent.whenIdle()
        expect(f.runtime.statusOf(resumed.agent.session)).toBe('ready')
        expect(f.runtime.read(resumed.agent.session)?.task).toMatchObject({ originMessageId: input.id, objective: 'Original direct task' })
        expect(f.adapter.calls).toHaveLength(1)
      } finally { await resumed.dispose() }
    } finally { off() }
  })

  it.each([true, false] as const)('leaves no task after pre-step reject, empty, or throw with prepend=%s', async (prepend) => {
    for (const disposition of ['reject', 'empty', 'throw'] as const) {
      const f = await gitRuntimeFixture({ backend: false, noGit: true })
      const { agent } = await f.create()
      let entered = false
      const off = agent.ctx.on('agent/pre-step', async (_event, next) => {
        const decision = await next()
        entered = true
        expect(f.runtime.read(agent.session)?.task).toBeNull()
        if (disposition === 'throw') throw new Error('controlled downstream failure')
        if (disposition === 'reject') return { kind: 'reject' as const }
        return decision.kind === 'reject' ? decision : { ...decision, messages: [] }
      }, { prepend })
      try {
        agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Original direct task' }], source: { kind: 'user' } }))
        await agent.whenIdle()
        expect(entered).toBe(true)
        expect(f.runtime.read(agent.session)?.task).toBeNull()
        expect(f.adapter.calls).toHaveLength(0)
        expect(agent.session.snapshotEvents().some(event => event.type === 'review-gated/direct-task-prepared')).toBe(false)
      } finally { off() }
    }
  })

  it.each([true, false] as const)('leaves no task after cancellation during pre-step with prepend=%s', async (prepend) => {
    const f = await gitRuntimeFixture({ backend: false, noGit: true })
    const { agent } = await f.create()
    const entered = f.gate()
    const release = f.gate()
    const off = agent.ctx.on('agent/pre-step', async (_event, next) => {
      const decision = await next()
      entered.resolve(undefined)
      await release.promise
      return decision
    }, { prepend })
    try {
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Cancelled direct task' }], source: { kind: 'user' } }))
      await entered.promise
      expect(f.runtime.read(agent.session)?.task).toBeNull()
      agent.cancel({ kind: 'parent' })
      release.resolve(undefined)
      await agent.whenIdle()
      expect(f.runtime.read(agent.session)?.task).toBeNull()
      expect(f.adapter.calls).toHaveLength(0)
      expect(agent.session.snapshotEvents().some(event => event.type === 'review-gated/direct-task-prepared')).toBe(false)
    } finally { release.resolve(undefined); off() }
  })

  it('keeps the claim unknown when its task checkpoint acknowledgment fails', async () => {
    const f = await gitRuntimeFixture({ backend: false, noGit: true })
    const handle = await f.create()
    const { agent } = handle
    const input = createUserMessage({ content: [{ type: 'text', text: 'Save this task' }], source: { kind: 'user' } })
    const original = f.ctx.sessions.flush.bind(f.ctx.sessions)
    let failed = false
    const flush = vi.spyOn(f.ctx.sessions, 'flush').mockImplementation(async (session) => {
      const result = await original(session)
      if (session === agent.session && !failed && f.runtime.read(session)?.task?.originMessageId === input.id) {
        failed = true
        throw new Error('controlled lost checkpoint acknowledgment')
      }
      return result
    })
    try {
      agent.followup(input)
      await agent.whenIdle()
      expect(failed).toBe(true)
      expect(f.adapter.calls).toHaveLength(0)
      expect(agent.claimProtectionStatus).toBe('unknown')
      expect(f.runtime.claimOf(agent.session)).toMatchObject({ inputs: [{ message: { id: input.id, content: input.content } }] })
      expect(agent.session.snapshotEvents().some(event => event.type === 'agent/claim/settled' && event.data.outcome === 'rejected')).toBe(false)
      const id = agent.id
      flush.mockRestore()
      await handle.dispose()
      const resumed = await f.ctx.agents.resume({ resumeSessionId: id,
        setup: async (child) => { await f.ctx.agentPresets.mount(child, 'rg') } })
      try {
        await resumed.agent.whenIdle()
        expect(f.adapter.calls).toHaveLength(0)
        expect(f.runtime.statusOf(resumed.agent.session)).toBe('unknown')
        expect(f.runtime.claimOf(resumed.agent.session)).toMatchObject({ inputs: [{ message: { id: input.id, content: input.content } }] })
      } finally { await resumed.dispose() }
    } finally { flush.mockRestore() }
  })

  it('keeps a prior task when a human adds a clarification', async () => {
    const f = await gitRuntimeFixture({ backend: false, noGit: true })
    const { agent } = await f.task()
    const prior = f.runtime.read(agent.session)?.task
    if (prior == null) throw new Error('Expected first task')
    const calls = f.adapter.calls.length
    const input = createUserMessage({ content: [{ type: 'text', text: 'An additional clarification' }], source: { kind: 'user' } })
    agent.followup(input)
    await agent.whenIdle()
    expect(f.runtime.read(agent.session)?.task).toEqual(prior)
    expect(f.adapter.calls).toHaveLength(calls + 1)
    expect(f.adapter.calls.at(-1)?.messages.some(message => message.role === 'user' && message.id === input.id)).toBe(true)
  })

  it('allows an empty-text first input without creating a task', async () => {
    const f = await gitRuntimeFixture({ backend: false, noGit: true })
    const { agent } = await f.create()
    const input = createUserMessage({ content: [{ type: 'text', text: '  ' }], source: { kind: 'user' } })
    agent.followup(input)
    await agent.whenIdle()
    expect(f.runtime.read(agent.session)?.task).toBeNull()
    expect(f.adapter.calls).toHaveLength(1)
  })

  it('allows an image-only first input without creating a task', async () => {
    const f = await gitRuntimeFixture({ backend: false, noGit: true })
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aQAAAABJRU5ErkJggg==', 'base64')
    await writeFile(join(f.root, 'image.png'), bytes)
    const attachment = { attachmentId: AttachmentId('sha256:' + createHash('sha256').update(bytes).digest('hex')),
      mediaType: 'image/png' as const, bytes: bytes.length, width: 1, height: 1, name: 'image.png' }
    const { agent } = await f.create()
    agent.followup(createUserMessage({ content: [{ type: 'image', attachment }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(f.runtime.read(agent.session)?.task).toBeNull()
    expect(f.adapter.calls).toHaveLength(1)
  })

  it('preserves explicit exclusive newTask first-claim admission', async () => {
    const f = await gitRuntimeFixture({ backend: false, noGit: true })
    const { agent } = await f.create()
    const task = await f.runtime.newTask(agent, 'Explicit human task')
    await agent.whenIdle()
    expect(f.runtime.read(agent.session)?.task).toEqual(task)
    expect(f.adapter.calls).toHaveLength(1)
    expect(agent.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.id === task.originMessageId)).toBe(true)
  })

  it('admits a direct first input at the exact frozen limit', async () => {
    const limit = 300
    const f = await gitRuntimeFixture({ backend: false, noGit: true, settings: { ...gitSettings(), maxHandoffChars: limit } })
    const { agent } = await f.create()
    const text = 'x'.repeat(limit)
    const input = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
    agent.followup(input)
    await agent.whenIdle()
    expect(f.runtime.read(agent.session)?.task).toMatchObject({ originMessageId: input.id, objective: text })
    expect(f.adapter.calls).toHaveLength(1)
    expect(agent.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.id === input.id)).toBe(true)
  })
})
