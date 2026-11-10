/** Gateway authorization for RG view snapshots with retained claim input. */
import { describe, expect, it } from 'vitest'
import TypertRegistry from '../../../typert/registry/src/index.ts'
import RemoteAccess from '../../../api/remote-access/src/index.ts'
import Gateway from '../../../api/gateway/src/index.ts'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { PeerId, PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import { gitRuntimeFixture } from './fixtures/git-runtime.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    /** Guest used only for the RG Session authorization regression. */
    'rg-view-guest': { readonly kind: 'rg-view-guest' }
  }
}

describe('RG view Gateway access', () => {
  it('bounds multilingual recovery previews while retaining full Session input', async () => {
    const f = await gitRuntimeFixture({ backend: false, noGit: true })
    const { agent } = await f.task()
    const entered = f.gate()
    const release = f.gate()
    f.adapter.beforeMain = async () => { entered.resolve(undefined); await release.promise }
    const input = '首行\nsecond line\n' + '长文本NoSpaces'.repeat(1000)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: input }], source: { kind: 'user' } }))
    await entered.promise
    const abort = new AbortController()
    const stream = f.runtime.watchView({ sessionId: agent.id }, abort.signal)[Symbol.asyncIterator]()
    try {
      const frame = await stream.next()
      if (frame.done || frame.value.claim === null) throw new Error('Missing claim recovery')
      expect(frame.value.claim.text).toBe(input.slice(0, 8192))
      expect(frame.value.claim.truncated).toBe(true)
      expect(Buffer.byteLength(JSON.stringify(frame.value.claim))).toBeLessThanOrEqual(51_200)
      expect(agent.claimRecovery?.inputs[0]?.message).toMatchObject({ content: [{ text: input }] })
    } finally { abort.abort(); await stream.return?.(); release.resolve(undefined); await agent.whenIdle() }
  })

  it('returns claim input only for an authorized Session', async () => {
    const f = await gitRuntimeFixture({ backend: false, noGit: true })
    const { agent } = await f.task()
    await f.ctx.plugin(TypertRegistry)
    await f.ctx.plugin(RemoteAccess)
    await f.ctx.plugin(Gateway)
    f.ctx.typert.resources.register('session', { field: 'sessionId' })
    f.ctx.remoteAccess.registerPolicy('rg-view-guest', { bindings: () => [{
      role: { name: 'test:rg-view', resource: 'session', actions: ['reviewGated/watchView'] },
      resource: { kind: 'session', id: agent.id },
    }] })
    const entered = f.gate()
    const release = f.gate()
    f.adapter.beforeMain = async () => { entered.resolve(undefined); await release.promise }
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'private recovery text' }], source: { kind: 'user' } }))
    await entered.promise
    const abort = new AbortController()
    const peer: PeerScope = { id: 'rg-view-guest' as PeerId, ctx: f.ctx, principal: { kind: 'rg-view-guest' },
      interactions: 'answer', signal: abort.signal, dispose: async () => {} }
    try {
      const open = (sessionId: SessionId) => f.ctx.typertGateway.stream({ peer, namespace: 'reviewGated',
        method: 'watchView', args: { request: { sessionId } }, signal: abort.signal })
      const stream = (await open(agent.id))[Symbol.asyncIterator]()
      try {
        const frame = await stream.next()
        expect(JSON.stringify(frame.value)).toContain('private recovery text')
      } finally { await stream.return?.() }
      await expect(open(SessionId('rg-private-other'))).rejects.toMatchObject({ code: 'remote-access/denied' })
    } finally { abort.abort(); release.resolve(undefined); await agent.whenIdle() }
  })
})
