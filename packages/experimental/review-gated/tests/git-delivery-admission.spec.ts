import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { LocalGitDelivery } from '../src/git-delivery.ts'
import { gitProjectionDefinition } from '../src/git-projection.ts'
import { git, gitRuntimeFixture } from './fixtures/git-runtime.ts'

/** Wait until the delivery owner published its optional Git backend.
 * @param delivery - owner whose backend arrives through its injected child context.
 */
async function waitForBackend(delivery: LocalGitDelivery): Promise<void> {
  for (;;) {
    const backend: unknown = Reflect.get(delivery, 'backend')
    if (backend !== undefined) return
    await Promise.resolve()
  }
}

describe('local Git owner admission', { timeout: 120_000 }, () => {
  it('refuses another operation for the same parent while authorization inspects the repository', async () => {
    const f = await gitRuntimeFixture()
    const { agent } = await f.task()
    const state = f.runtime.read(agent.session)
    if (state?.task == null || state.policy === null) throw new Error('Authorization requires a real task and policy.')
    const { task, policy } = state
    const index = await readFile(join(f.root, '.git', 'index'))
    const projection = await f.ctx.sessionProjections.register(gitProjectionDefinition)
    const context = f.entry.fiber?.ctx
    if (context === undefined) throw new Error('The runtime context must be active.')
    const delivery = new LocalGitDelivery(context, { gitCommand: 'git', timeoutMs: 60_000, graceMs: 1_000,
      maxOutputBytes: 1_000_000 }, projection, async () => {})
    await waitForBackend(delivery)
    const entered = f.gate()
    const release = f.gate()
    const spawn = f.ctx.subprocess.spawn.bind(f.ctx.subprocess)
    const observer = vi.spyOn(f.ctx.subprocess, 'spawn').mockImplementation((spec) => {
      const child = spawn(spec)
      return spec.argv.includes('symbolic-ref') ? { ...child, done: child.done.then(async (outcome) => {
        entered.resolve(undefined)
        await release.promise
        return outcome
      }), terminate: () =>{  child.terminate() }, waitForExit: () => child.waitForExit() } : child
    })
    try {
      const signal = new AbortController().signal
      const authorization = f.track(delivery.authorize(agent, task, policy, ['tracked.txt'], signal, () => {}))
      await Promise.race([entered.promise, authorization.then(() => { throw new Error('Authorization settled before inspection was paused.') })])
      const calls = observer.mock.calls.length
      expect(delivery.busy(agent)).toBe(true)
      expect(delivery.read(agent.session)).toBeNull()
      expect(() => delivery.authorize(agent, task, policy, ['tracked.txt'], signal, () => {}))
        .toThrow('Wait for the current local Git operation to settle.')
      expect(observer).toHaveBeenCalledTimes(calls)
      release.resolve(undefined)
      const grant = await authorization
      expect(delivery.busy(agent)).toBe(false)
      expect(delivery.read(agent.session)).toEqual(grant)
      expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(grant.source.headOid)
      expect(await readFile(join(f.root, '.git', 'index'))).toEqual(index)
      expect(await git(f.root, 'status', '--porcelain')).toBe('')
    } finally {
      release.resolve(undefined)
      observer.mockRestore()
      await delivery.close()
      await projection.dispose()
    }
  })
})
