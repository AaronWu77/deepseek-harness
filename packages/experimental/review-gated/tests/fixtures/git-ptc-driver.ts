/** Hold headless's first idle checkpoint while the owner authorizes and observes delivery. */
import type { Context } from '@deepseek-ai/cordis'
import { Peer } from '@deepseek-ai/dsh-client-connection'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-api-gateway'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '../../src/runtime.ts'

export const name = 'git-ptc-driver'
export const inject = ['agents', 'reviewGated', 'typertGateway', 'subagents']

class Driver {
  constructor(private readonly ctx: Context) {}

  install(): void {
    const off = this.ctx.on('session/flush', async (session) => {
      const agent = this.ctx.agents.get(session.id)
      if (agent === undefined || session.header.parentSession !== undefined || agent.status !== 'idle'
        || this.ctx.reviewGated.read(session)?.task == null) return
      off()
      const peer = new Peer(this.ctx.root, { principal: { kind: 'owner' } })
      let stopNotice: (() => void) | undefined
      try {
        await this.ctx.typertGateway.invoke({ peer, namespace: 'reviewGated', method: 'authorizeLocalGit',
          args: { agentId: agent.id, scope: ['tracked.txt'] } })
        const notice = new Promise<void>((resolve) => {
          stopNotice = this.ctx.on('agent/inbox/claimed', ({ agent: subject, message }) => {
            if (subject === agent && message.source.kind === 'review-gated'
              && this.ctx.reviewGated.read(session)?.task?.lastReview != null) resolve()
          })
        })
        agent.followup(createUserMessage({ content: [{ type: 'text', text: 'START_GIT' }], source: { kind: 'user' } }))
        await notice
        while (true) {
          await agent.whenIdle()
          const seq = session.seq
          if (!await this.ctx.subagents.waitForChildren(agent) && agent.status === 'idle' && session.seq === seq) break
        }
        process.stdout.write(JSON.stringify({ type: 'git_ptc_state', state: this.ctx.reviewGated.read(session),
          git: this.ctx.reviewGated.readGit(session) }) + '\n')
      } finally {
        stopNotice?.()
        await peer.dispose()
      }
    })
  }
}

export function apply(ctx: Context): void { new Driver(ctx).install() }
