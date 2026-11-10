// @vitest-environment jsdom
/** Stream faults and fail-closed frames rendered through the real RG dock registration. */
import { act, cleanup } from '@testing-library/react'
import { RemoteStream, type RemoteStreamOptions } from '@deepseek-ai/dsh-api-gateway/client'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { SlotTestRuntime, sessionSnapshot } from '@deepseek-ai/dsh-client-test-runtime'
import type { OwnerOf } from '@deepseek-ai/dsh-client-ui-slots'
import { mountRgUi } from '../src/client/mount.ts'
import { en } from '../src/client/locales.ts'
import { fixture } from './fixture.client.ts'
import { gitState, rgState } from './task-fixture.client.ts'
import type { RgView } from '../src/types.ts'

const CONFIG = 'settings.section'
const DOCK = 'conversation.input.dock'
const plugin = { inject: ['remote', 'slots', 'locale', 'configForms', 'remote.session', 'remote.reviewGated'], apply: mountRgUi }

/** One open carrier generation a test pushes frames into or fails. */
class Carrier {
  private readonly queue: RgView[] = []
  private wake: (() => void) | undefined
  private failure: Error | undefined

  push(value: RgView): void {
    this.queue.push(value)
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }

  fail(error: Error): void {
    this.failure = error
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<{ value: RgView; accept(): void }> {
    for (;;) {
      const value = this.queue.shift()
      if (value !== undefined) {
        yield { value, accept: () => {} }
        continue
      }
      if (this.failure !== undefined) {
        const error = this.failure
        this.failure = undefined
        throw error
      }
      await new Promise<void>((resolve) => { this.wake = resolve })
    }
  }

  dispose = async (): Promise<void> => {}
}

async function settle(): Promise<void> {
  for (let index = 0; index < 4; index++) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
  }
}

async function boot(open: (carrier: Carrier) => AsyncIterable<{ value: RgView; accept(): void }> & { dispose?(): Promise<void> }) {
  const rt = await SlotTestRuntime.create()
  onTestFinished(() => rt.dispose())
  const locale = new LocaleRuntime(rt.ctx)
  rt.ctx.provide('locale', locale)
  rt.slots.installLocale(locale)
  await act(async () => { locale.setLocale('en') })
  const f = fixture({ subscribe: false })
  rt.ctx.provide('configForms', { get: () => f.scope, registerDecoder: () => () => {} } as never)
  const carriers: Carrier[] = []
  const optionSets: RemoteStreamOptions<RgView>[] = []
  const opened = vi.fn()
  Object.assign(rt.remote, {
    $stream: (options: RemoteStreamOptions<RgView>) => {
      optionSets.push(options)
      const carrier = new Carrier()
      carriers.push(carrier)
      opened()
      return open(carrier)
    },
  })
  rt.remote.provideNamespaces({
    session: { modelCatalog: async () => ({ ok: true as const, value: emptyCatalog }) },
    reviewGated: { newTask: async () => { throw new Error('unused') }, recheck: async () => { throw new Error('unused') },
      authorizeLocalGit: async () => { throw new Error('unused') }, leaveLocalGit: async () => { throw new Error('unused') },
      watchView: async function* () { } },
  })
  await rt.declare({ [CONFIG]: { kind: 'list', scope: 'root' }, [DOCK]: { kind: 'list', scope: 'session' } })
  await rt.mount(plugin)
  const id = await rt.sessions.add({ id: 'rg-stream' })
  await rt.sessions.setProjection(id, 'reviewGated', rgState())
  const session = rt.sessions.retain(id)
  onTestFinished(async () => { await rt.dispose(); session.release() })
  const owner: OwnerOf<typeof DOCK> = { session: sessionSnapshot(id),
    input: { draft: '', draftRev: 0, attachmentIds: [], phase: 'plain', occurrences: [], queue: [] } }
  const view = rt.renderSlot(DOCK, owner, { session })
  await settle()
  const generation = (): Carrier => {
    const current = carriers.at(-1)
    if (current === undefined) throw new Error('Expected an open carrier generation')
    return current
  }
  return { rt, id, session, owner, view, generation, opened, optionSets }
}

const ready: RgView = { status: 'ready', state: rgState(), git: null, claim: null }
const emptyCatalog = { default: null, routableProviders: [], failures: [], groups: [] }

afterEach(cleanup)

describe('RG dock carrier faults', () => {
  it('keeps the unknown frame when the carrier cannot be opened at all', async () => {
    const h = await boot(() => { throw new Error('transport unavailable') })
    expect(h.opened).toHaveBeenCalledOnce()
    expect(h.view.view.getByRole('status').textContent).toBe(en.statusUnknown)
  })

  it('ignores a frame that arrives after its generation was aborted', async () => {
    const h = await boot(carrier => carrier)
    const aborted = h.generation()
    await act(async () => { h.rt.ctx.emit('connection/reset') })
    await settle()
    aborted.push(ready)
    await settle()
    expect(h.view.view.getByRole('status').textContent).toBe(en.statusUnknown)
    h.generation().push(ready)
    await settle()
    expect(h.view.view.getByText('Repair the requested output', { selector: 'summary span' })).toBeTruthy()
  })

  it('clears a rendered frame when the generation throws', async () => {
    const h = await boot(carrier => carrier)
    h.generation().push(ready)
    await settle()
    expect(h.view.view.getByText('Repair the requested output', { selector: 'summary span' })).toBeTruthy()
    h.generation().fail(new Error('carrier lost'))
    await settle()
    expect(h.view.view.getByRole('status').textContent).toBe(en.statusUnknown)
  })

  it('logs a carrier disposal failure and still withdraws the frame', async () => {
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {})
    onTestFinished(() => { reported.mockRestore() })
    const h = await boot(carrier => ({
      async *[Symbol.asyncIterator]() { yield* carrier[Symbol.asyncIterator]() },
      dispose: () => Promise.reject(new Error('socket already gone')),
    }))
    h.generation().push(ready)
    await settle()
    expect(h.view.view.getByText('Repair the requested output', { selector: 'summary span' })).toBeTruthy()
    await act(async () => { h.rt.ctx.emit('connection/reset') })
    await settle()
    await settle()
    expect(reported.mock.calls.some(call => String(call[0]).includes('[review-gated] view stream disposal failed'))).toBe(true)
  })

  it('reports a saving host and a pending or rejected claim without task facts', async () => {
    const h = await boot(carrier => carrier)
    h.generation().push({ status: 'saving', state: null, git: null,
      claim: { phase: 'unsettled', text: 'pending input', truncated: false, otherContent: false } })
    await settle()
    expect(h.view.view.getByRole('status').textContent).toContain(en.saving)
    expect(h.view.view.getByRole('status').textContent).toContain(en.statusProcessingHint)
    expect(h.view.view.getByText(en.claimPending)).toBeTruthy()
    expect(h.view.view.getByText(en.claimLogHint)).toBeTruthy()
    expect(h.view.view.getByText('pending input')).toBeTruthy()
    expect(h.view.view.queryByText(en.reportedPass)).toBeNull()
    h.generation().push({ status: 'unknown', state: null, git: null,
      claim: { phase: 'rejected', text: 'rejected input', truncated: true, otherContent: true } })
    await settle()
    expect(h.view.view.getByRole('status').textContent).toBe(en.statusUnknown)
    expect(h.view.view.getByText(en.claimRejected)).toBeTruthy()
    expect(h.view.view.getByText(en.claimNotEnteredHint)).toBeTruthy()
    expect(h.view.view.getByText(en.claimTruncated)).toBeTruthy()
  })

  it('matches a retained Git grant against the task identity of a role Session', async () => {
    const h = await boot(carrier => carrier)
    // A role-scoped Session has no task record of its own, so the state-level taskId identifies it.
    const state = rgState()
    h.generation().push({ status: 'ready', git: gitState(), claim: null,
      state: { ...state, role: 'reviewer', task: null, taskId: gitState().taskId } })
    await settle()
    expect(h.view.view.getByRole('region', { name: en.details })).toBeTruthy()
    expect(h.view.view.getByText(en.gitAuthorized)).toBeTruthy()
    expect(h.view.view.getByText('/work')).toBeTruthy()
    h.generation().push({ status: 'ready', claim: null,
      state: { ...state, role: 'reviewer', task: null, taskId: 'another-task' as never },
      git: gitState() })
    await settle()
    expect(h.view.view.queryByText(en.gitAuthorized)).toBeNull()
    // A task record of its own supplies the identity instead of the state-level taskId.
    h.generation().push({ status: 'ready', claim: null, state, git: { ...gitState(), taskId: state.task!.id } })
    await settle()
    expect(h.view.view.getByText(en.gitAuthorized)).toBeTruthy()
    expect(h.view.view.getByText('/work')).toBeTruthy()
  })
})

describe('RG dock stream terminal classification', () => {
  it('classifies a generation that ends without a terminal frame as a retryable carrier loss', async () => {
    const h = await boot(carrier => carrier)
    const options = h.optionSets[0]
    if (options === undefined) throw new Error('Expected the registered stream options')
    const carrierFailed = vi.fn()
    // The registration's own end classifier runs inside the real supervisor: every generation ends
    // without a terminal frame, so the first loss is retried and the second one fails terminally.
    const connection: Pick<ConnectionHandle, 'generation'> = {
      generation: { getSnapshot: () => ({ id: 1, host: { home: '/home/rg' } }), subscribe: () => () => {} },
    }
    const stream = new RemoteStream(connection, { ...options, carrierFailed })
    const outcome = stream[Symbol.asyncIterator]().next().then(() => null, (error: unknown) => error)
    expect(await outcome).toMatchObject({ code: 'gateway/internal', message: 'RG view stream ended' })
    // The first loss is retried against the live generation source; the second one is terminal.
    expect(carrierFailed).toHaveBeenCalledTimes(2)
    expect(carrierFailed.mock.calls.every(([error]) => String(error).includes('RG view stream ended'))).toBe(true)
    await stream.dispose()
  })
})
