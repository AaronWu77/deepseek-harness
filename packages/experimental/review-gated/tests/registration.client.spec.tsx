// @vitest-environment jsdom
/** Production Slot registries bind RG locale, settings, Session projections, and actions. */
import { act, fireEvent, screen } from '@testing-library/react'
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-experimental-review-gated/remote'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply as applySettings, inject as settingsInject } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import Schema from '@deepseek-ai/schemastery'
import { settingsSchema } from '../src/settings-schema.ts'
import { RemoteError, SlotTestRuntime, sessionSnapshot } from '@deepseek-ai/dsh-client-test-runtime'
import { resolveSlotLabel, type OwnerOf } from '@deepseek-ai/dsh-client-ui-slots'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { mountRgUi } from '../src/client/mount.ts'
import { RemoteStream, RemoteStreamCarrierError } from '@deepseek-ai/dsh-api-gateway/client'
import type { RgView, RgSessionState, RgGitState } from '../src/types.ts'
import * as Client from '../src/client/index.ts'
import { en, zh } from '../src/client/locales.ts'
import { fixture, catalog, settings } from './fixture.client.ts'
import { candidateGitState, freshRgState, gitState, rgState } from './task-fixture.client.ts'

// jsdom does not implement scrolling; browser layout is covered separately.
const originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')
beforeAll(() => { Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: () => {} }) })
afterAll(() => {
  if (originalScrollIntoView === undefined) Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
  else Object.defineProperty(Element.prototype, 'scrollIntoView', originalScrollIntoView)
})

/** The face receives a test-owned descriptor; no generated Remote implementation is evaluated. */
vi.mock('@deepseek-ai/dsh-experimental-review-gated/remote', () => ({
  default: { package: '@deepseek-ai/dsh-experimental-review-gated', descriptors: [] },
}))

const ID = 'review-gated'
const CONFIG = 'settings.section'
const DOCK = 'conversation.input.dock'
const plugin = { inject: ['remote', 'slots', 'locale', 'configForms', 'remote.session', 'remote.reviewGated'], apply: mountRgUi }

class ViewHost {
  private readonly values = new Map<string, RgView>()
  private readonly listeners = new Map<string, Set<(view: RgView) => void>>()

  set(id: string, change: Partial<RgView>) {
    const view: RgView = { ...(this.values.get(id) ?? { status: 'ready', state: null, git: null, claim: null }), ...change }
    this.values.set(id, view)
    for (const listener of this.listeners.get(id) ?? []) listener(view)
  }

  async *watch(request: { readonly sessionId: string }, signal: AbortSignal): AsyncIterable<RgView> {
    const queue: RgView[] = []
    let wake: (() => void) | undefined
    const notify = () => { wake?.(); wake = undefined }
    const listener = (view: RgView) => { queue.push(view); notify() }
    const listeners = this.listeners.get(request.sessionId) ?? new Set()
    listeners.add(listener)
    this.listeners.set(request.sessionId, listeners)
    signal.addEventListener('abort', notify, { once: true })
    try {
      yield this.values.get(request.sessionId) ?? { status: 'unknown', state: null, git: null, claim: null }
      while (!signal.aborted) {
        const value = queue.shift()
        if (value !== undefined) yield value
        else await new Promise<void>((resolve) => { wake = resolve })
      }
    } finally {
      listeners.delete(listener)
      signal.removeEventListener('abort', notify)
    }
  }
}

async function boot(served = true) {
  const rt = await SlotTestRuntime.create()
  onTestFinished(() => rt.dispose())
  const locale = new LocaleRuntime(rt.ctx)
  rt.ctx.provide('locale', locale)
  rt.slots.installLocale(locale)
  await act(async () => { locale.setLocale('en') })
  const f = fixture({ subscribe: false })
  if (!served) f.publish({ status: 'unavailable', value: undefined, writable: false, revision: undefined })
  const get = vi.fn(() => f.scope)
  const unregisterDecoder = vi.fn()
  const registerDecoder = vi.fn((_namespace: string, _decoder: (value: unknown) => unknown) => unregisterDecoder)
  const forms = { get, registerDecoder }
  // The settings transport is scripted; Slot declaration, binding, rendering, and lifecycle are real.
  rt.ctx.provide('configForms', forms as never)
  const modelCatalog = vi.fn<Context['remote']['session']['modelCatalog']>(async () => ({ ok: true as const, value: catalog }))
  const newTask = vi.fn<Context['remote']['reviewGated']['newTask']>(async () => ({ ok: true as const, value: rgState().task! }))
  const recheck = vi.fn<Context['remote']['reviewGated']['recheck']>(async () => ({ ok: true as const, value: rgState() }))
  const authorizeLocalGit = vi.fn<Context['remote']['reviewGated']['authorizeLocalGit']>(async () => ({ ok: true as const, value: gitState() }))
  const leaveLocalGit = vi.fn<Context['remote']['reviewGated']['leaveLocalGit']>(async () => ({ ok: true as const, value: undefined }))
  const host = new ViewHost()
  let failCarrier = () => {}
  Object.assign(rt.remote, { $stream: (options: ConstructorParameters<typeof RemoteStream<RgView>>[1]) => {
    failCarrier = () => { options.carrierFailed?.(new RemoteStreamCarrierError('fixture carrier lost')) }
    return new RemoteStream({ generation: { getSnapshot: () => 1, subscribe: () => () => {} } } as never, options)
  } })
  rt.remote.provideNamespaces({ session: { modelCatalog },
    reviewGated: { newTask, recheck, authorizeLocalGit, leaveLocalGit, watchView: host.watch.bind(host) } })
  const setState = async (id: string, state: RgSessionState | null) => { await act(async () => { host.set(id, { state }) }) }
  const setGit = async (id: string, git: RgGitState | null) => { await act(async () => { host.set(id, { git }) }) }
  const declare = () => rt.declare({ [CONFIG]: { kind: 'list', scope: 'root' },
    'plugins.bundle.config': { kind: 'keyed', scope: 'root' }, [DOCK]: { kind: 'list', scope: 'session' } })
  return { rt, locale, f, modelCatalog, get, registerDecoder, unregisterDecoder,
    newTask, recheck, authorizeLocalGit, leaveLocalGit, declare, setState, setGit, host, failCarrier: () => { failCarrier() } }
}

async function dock(h: Awaited<ReturnType<typeof boot>>, idText = 'rg-main') {
  const id = await h.rt.sessions.add({ id: idText })
  await h.setState(id, rgState())
  const session = h.rt.sessions.retain(id)
  onTestFinished(async () => { await h.rt.dispose(); session.release() })
  const owner: OwnerOf<typeof DOCK> = { session: sessionSnapshot(id),
    input: { draft: '', draftRev: 0, attachmentIds: [], phase: 'plain', occurrences: [], queue: [] } }
  const view = h.rt.renderSlot(DOCK, owner, { session })
  await view.view.findByText('Repair the requested output', { selector: 'summary span' })
  fireEvent.click(view.container.querySelector('summary')!)
  return { id, session, owner, ...view }
}

describe('RG client registration', () => {
  it('hides ordinary Sessions while keeping an unknown RG Session fail-closed', async () => {
    const h = await boot()
    await h.declare()
    await h.rt.mount(plugin)
    const normalId = await h.rt.sessions.add({ id: 'ordinary' })
    await h.rt.sessions.setProjection(normalId, 'reviewGated', null)
    const normalSession = h.rt.sessions.retain(normalId)
    onTestFinished(async () => { await h.rt.dispose(); normalSession.release() })
    h.host.set(normalId, { status: 'unknown', state: null })
    const owner: OwnerOf<typeof DOCK> = { session: sessionSnapshot(normalId),
      input: { draft: '', draftRev: 0, attachmentIds: [], phase: 'plain', occurrences: [], queue: [] } }
    const normal = h.rt.renderSlot(DOCK, owner, { session: normalSession })
    expect(normal.view.queryByRole('status')).toBeNull()
    await act(async () => { h.host.set(normalId, { status: 'unknown', state: null }) })
    expect(normal.view.queryByRole('status')).toBeNull()

    const id = await h.rt.sessions.add({ id: 'rg-unknown' })
    await h.rt.sessions.setProjection(id, 'reviewGated', rgState())
    const session = h.rt.sessions.retain(id)
    onTestFinished(async () => { await h.rt.dispose(); session.release() })
    h.host.set(id, { status: 'unknown', state: null })
    normal.update({ ...owner, session: sessionSnapshot(id) }, { session })
    expect(normal.view.getByRole('status').textContent).toBe(en.statusUnknown)
    expect(normal.view.queryByRole('button')).toBeNull()
    await act(async () => { h.host.set(id, { status: 'ready', state: rgState() }) })
    expect(normal.view.getByText(en.reportedPass)).toBeTruthy()
  })

  it('withdraws controls on saving and carrier loss, then replaces them on reconnect', async () => {
    const h = await boot()
    await h.declare()
    await h.rt.mount(plugin)
    const d = await dock(h)
    const id = d.id
    await act(async () => { h.host.set(id, { claim: { phase: 'rejected', text: '<script>raw input</script>', truncated: true, otherContent: true } }) })
    expect(d.view.getByText(en.claimRejected)).toBeTruthy()
    expect(d.view.getByText(en.claimNotEnteredHint)).toBeTruthy()
    expect(d.view.getByText(en.claimTruncated)).toBeTruthy()
    expect(d.container.querySelector('script')).toBeNull()
    expect(d.container.querySelector('pre')?.textContent).toBe('<script>raw input</script>')
    expect(d.container.querySelector('pre')?.parentElement?.getAttribute('tabindex')).toBe('0')
    await act(async () => { h.host.set(id, { claim: { phase: 'empty', text: 'unchanged input', truncated: false, otherContent: false } }) })
    expect(d.view.getByText(en.claimEmpty)).toBeTruthy()
    await act(async () => { h.host.set(id, { claim: null }) })
    fireEvent.click(d.view.getByRole('button', { name: en.newTask }))
    await act(async () => { h.host.set(id, { status: 'saving' }) })
    expect(d.view.queryByText(en.reportedPass)).toBeNull()
    expect(d.view.queryByRole('button')).toBeNull()
    expect(h.newTask).not.toHaveBeenCalled()
    await act(async () => { h.host.set(id, { status: 'ready' }) })
    expect(d.view.getByText(en.reportedPass)).toBeTruthy()
    await act(async () => { h.failCarrier() })
    expect(d.view.queryByText(en.reportedPass)).toBeNull()
    expect(d.view.getByRole('status').textContent).toBe(en.statusUnknown)
    await act(async () => { h.host.set(id, { status: 'ready' }) })
    expect(d.view.getByText(en.reportedPass)).toBeTruthy()
  })

  it('retains the settings slot across unavailable and reconnect states, and withdraws with its owner', async () => {
    const h = await boot()
    const initial = h.f.current()
    const feature = await h.rt.mount(plugin)
    expect(h.get).not.toHaveBeenCalled()
    expect(h.rt.slots.entries(CONFIG)).toEqual([])
    expect(h.rt.slots.entries(DOCK)).toEqual([])
    await h.declare()
    expect(h.get).toHaveBeenCalledWith('rg-settings')
    expect(h.rt.slots.entries(DOCK)).toHaveLength(1)
    expect(h.rt.slots.entries(CONFIG)[0]).toMatchObject({ options: { id: ID, order: 11 }, locale: 'review-gated' })
    expect(h.rt.slots.entries('plugins.bundle.config')).toEqual([])
    const view = h.rt.renderSlot(CONFIG, { close: () => {} }, { only: ID })
    await view.view.findAllByText('Smart')
    act(() => { h.f.publish({ status: 'unavailable', value: undefined, writable: false, revision: undefined }) })
    expect(h.rt.slots.entries(CONFIG)).toHaveLength(1)
    expect(view.view.getByText(en.unavailable)).toBeTruthy()
    expect(view.view.queryByText(en.readOnly)).toBeNull()
    expect(view.view.queryByRole('checkbox')).toBeNull()
    await act(async () => { h.rt.ctx.emit('connection/reset'); h.f.publish({ ...initial, status: 'loading' }) })
    expect(view.view.getByText(en.unavailable)).toBeTruthy()
    act(() => { h.f.publish(initial) })
    expect(await view.view.findAllByText('Smart')).toBeTruthy()
    expect(h.rt.slots.entries(CONFIG)).toHaveLength(1)
    await feature.dispose()
    expect(h.rt.slots.entries(CONFIG)).toEqual([])
    expect(h.rt.slots.entries(DOCK)).toEqual([])
  })

  it('re-registers the settings slot after its declaration owner collapses', async () => {
    const h = await boot(false)
    await h.rt.mount(plugin)
    await h.declare()
    expect(h.rt.slots.entries(CONFIG)).toHaveLength(1)
    h.rt.root.release()
    expect(h.rt.slots.entries(CONFIG)).toEqual([])
    expect(h.rt.slots.entries(DOCK)).toEqual([])
    await h.declare()
    expect(h.rt.slots.entries(CONFIG)).toHaveLength(1)
    expect(h.rt.slots.entries(DOCK)).toHaveLength(1)
  })

  it('clears the settings draft when the section declaration is withdrawn and restored', async () => {
    const h = await boot()
    const baseline = h.f.listenerCount()
    await h.declare()
    await h.rt.mount(plugin)
    expect(h.f.listenerCount()).toBe(baseline + 1)
    const view = h.rt.renderSlot(CONFIG, { close: () => {} }, { only: ID })
    await view.view.findAllByText('Smart')
    fireEvent.change(view.view.getByLabelText(en.maxReviewAttempts), { target: { value: '7' } })
    act(() => { h.rt.root.release() })
    expect(h.rt.slots.entries(CONFIG)).toEqual([])
    expect(h.f.listenerCount()).toBe(baseline)
    await h.declare()
    expect(h.f.listenerCount()).toBe(baseline + 1)
    const restored = h.rt.renderSlot(CONFIG, { close: () => {} }, { only: ID })
    expect(restored.view.getByLabelText<HTMLInputElement>(en.maxReviewAttempts).value).toBe('2')
    await restored.view.findAllByText('Smart')
    const reads = h.modelCatalog.mock.calls.length
    await act(async () => { h.rt.remote.emit('llm/models-updated', []) })
    expect(h.modelCatalog).toHaveBeenCalledTimes(reads + 1)
    expect(h.f.mutate).not.toHaveBeenCalled()
  })

  it('does not apply a withdrawn save result to the restored section', async () => {
    const h = await boot()
    await h.declare()
    await h.rt.mount(plugin)
    const pending = Promise.withResolvers<boolean>()
    onTestFinished(() => { pending.resolve(false) })
    h.f.mutate.mockReturnValueOnce(pending.promise)
    const view = h.rt.renderSlot(CONFIG, { close: () => {} }, { only: ID })
    await view.view.findAllByText('Smart')
    fireEvent.change(view.view.getByLabelText(en.maxReviewAttempts), { target: { value: '7' } })
    fireEvent.click(view.view.getByRole('button', { name: en.save }))
    expect(h.f.mutate).toHaveBeenCalledOnce()
    act(() => { h.rt.root.release() })
    await h.declare()
    const restored = h.rt.renderSlot(CONFIG, { close: () => {} }, { only: ID })
    await restored.view.findAllByText('Smart')
    fireEvent.change(restored.view.getByLabelText(en.maxReviewAttempts), { target: { value: '8' } })
    await act(async () => { pending.reject(new Error('lost response')); await expect(pending.promise).rejects.toThrow('lost response') })
    expect(restored.view.getByLabelText<HTMLInputElement>(en.maxReviewAttempts).value).toBe('8')
    expect(restored.view.queryByText(en.saveFailed)).toBeNull()
    expect(restored.view.queryByText(en.uncertain)).toBeNull()
  })

  it('restores a section draft after navigation and clears it when the feature is disabled', async () => {
    const h = await boot()
    await h.declare()
    const feature = await h.rt.mount(plugin)
    const first = h.rt.renderSlot(CONFIG, { close: () => {} }, { only: ID })
    await first.view.findAllByText('Smart')
    fireEvent.change(first.view.getByLabelText(en.maxReviewAttempts), { target: { value: '7' } })
    first.update({ close: () => {} }, { only: 'another-section' })
    expect(first.view.queryByRole('heading', { name: en.roleModels })).toBeNull()
    first.update({ close: () => {} }, { only: ID })
    expect(first.view.getByLabelText<HTMLInputElement>(en.maxReviewAttempts).value).toBe('7')
    first.update({ close: () => {} }, { only: 'another-section' })
    await feature.dispose()
    expect(h.rt.slots.entries(CONFIG)).toEqual([])
    await h.rt.mount(plugin)
    const third = h.rt.renderSlot(CONFIG, { close: () => {} }, { only: ID })
    expect(third.view.getByLabelText<HTMLInputElement>(en.maxReviewAttempts).value).toBe('2')
    expect(h.f.mutate).not.toHaveBeenCalled()
  })

  it('drops a hidden draft if the Host stops serving the namespace', async () => {
    const h = await boot()
    const initial = h.f.current()
    await h.declare()
    await h.rt.mount(plugin)
    const view = h.rt.renderSlot(CONFIG, { close: () => {} }, { only: ID })
    await view.view.findAllByText('Smart')
    fireEvent.change(view.view.getByLabelText(en.maxReviewAttempts), { target: { value: '7' } })
    view.update({ close: () => {} }, { only: 'another-section' })
    act(() => { h.f.publish({ status: 'unavailable', value: undefined, writable: false, revision: undefined }) })
    act(() => { h.f.publish(initial) })
    view.update({ close: () => {} }, { only: ID })
    expect(view.view.getByLabelText<HTMLInputElement>(en.maxReviewAttempts).value).toBe('2')
    expect(h.f.mutate).not.toHaveBeenCalled()
  })

  it('registers a strict settings decoder for the lifetime of the RG client', async () => {
    const h = await boot()
    const feature = await h.rt.mount(plugin)
    expect(h.registerDecoder).toHaveBeenCalledOnce()
    const [namespace, decode] = h.registerDecoder.mock.calls[0]!
    expect(namespace).toBe('rg-settings')
    expect(decode({ settings: settings(), git: { timeoutMs: 123 } })).toEqual({ settings: settings() })
    expect(decode({ settings: { ...settings(), unexpected: true } })).toBeUndefined()
    expect(decode([])).toBeUndefined()
    await feature.dispose()
    expect(h.unregisterDecoder).toHaveBeenCalledOnce()
  })

  it('renders unavailable when the namespace is absent at initial activation', async () => {
    const h = await boot(false)
    await h.declare()
    await h.rt.mount(plugin)
    const view = h.rt.renderSlot(CONFIG, { close: () => {} }, { only: ID })
    expect(view.view.getByRole('heading', { name: en.roleModels })).toBeTruthy()
    expect(view.view.getByText(en.unavailable)).toBeTruthy()
    expect(view.view.queryByText(en.readOnly)).toBeNull()
  })

  it('renders the real settings section with framework hooks and reacts to locale changes', async () => {
    const h = await boot()
    await h.declare()
    await h.rt.mount(plugin)
    expect(h.modelCatalog).not.toHaveBeenCalled()
    expect(resolveSlotLabel(h.rt.slots.entries(CONFIG)[0]?.options.label)).toBe(en.modelsNav)
    const view = h.rt.renderSlot(CONFIG, { close: () => {} }, { only: ID })
    expect(await view.view.findAllByText('Smart')).toBeTruthy()
    expect(view.view.getByText(en.effectiveHint)).toBeTruthy()
    fireEvent.change(view.view.getByLabelText(en.maxReviewAttempts), { target: { value: '5' } })
    await act(async () => { fireEvent.click(view.view.getByRole('button', { name: en.save })) })
    expect(h.f.mutate).toHaveBeenCalledOnce()
    expect(h.f.mutate.mock.calls[0]?.[1]).toBe(1)
    expect(h.f.current().value?.settings.maxReviewAttempts).toBe(5)
    await act(async () => { h.locale.setLocale('zh') })
    expect(resolveSlotLabel(h.rt.slots.entries(CONFIG)[0]?.options.label)).toBe(zh.modelsNav)
    expect(view.view.getByRole('button', { name: zh.save })).toBeTruthy()
    expect(view.view.getByText(zh.effectiveHint)).toBeTruthy()
    expect(view.view.getByRole('heading', { name: zh.roleModels })).toBeTruthy()
    expect(view.view.getByText(zh.poolHint)).toBeTruthy()
  })

  it('renders and saves through real ConfigForms with the serialized Host transform schema', async () => {
    const rt = await SlotTestRuntime.create()
    onTestFinished(() => rt.dispose())
    const locale = new LocaleRuntime(rt.ctx)
    rt.ctx.provide('locale', locale)
    rt.slots.installLocale(locale)
    await act(async () => { locale.setLocale('en') })
    let hostSettings = settings()
    let revision = 1
    const schema = JSON.parse(JSON.stringify(Schema.object({
      settings: Schema.transform(Schema.any(), value => settingsSchema.parse(value)), git: Schema.any(),
    }).toJSON())) as SettingsNamespaceView['schema']
    const view = (): SettingsNamespaceView => ({ ns: 'rg-settings', schema,
      value: JSON.parse(JSON.stringify({ settings: hostSettings, git: { timeoutMs: 60000 } })) as SettingsNamespaceView['value'],
      autoGenerate: true, applies: 'live', secrets: [], revision })
    const describe = vi.fn<Context['remote']['settings']['describe']>(async () =>
      ({ ok: true, value: { writable: true, hasDocument: true, namespaces: [view()] } }))
    const mutate = vi.fn<Context['remote']['settings']['mutate']>(async (_ns, ops, expectedRevision) => {
      expect(expectedRevision).toBe(revision)
      expect(ops).toHaveLength(1)
      const op = ops[0]!
      expect(op.op).toBe('set')
      if (op.op !== 'set') throw new Error('expected set')
      hostSettings = settingsSchema.parse(op.value)
      revision += 1
      return { ok: true, value: view() }
    })
    rt.remote.provideNamespaces({ settings: { describe, mutate }, session: { modelCatalog: async () => ({ ok: true, value: catalog }) },
      reviewGated: {} })
    await rt.mount({ inject: settingsInject, apply: applySettings })
    await rt.ctx.configForms.describe().ensure()
    const scope = rt.ctx.configForms.get('rg-settings')
    expect(scope.getSnapshot().status).toBe('loading')
    await rt.declare({ [CONFIG]: { kind: 'list', scope: 'root' }, [DOCK]: { kind: 'list', scope: 'session' } })
    const feature = await rt.mount(plugin)
    expect(scope.getSnapshot().status).toBe('ready')
    const rendered = rt.renderSlot(CONFIG, { close: () => {} }, { only: ID })
    expect(await rendered.view.findAllByText('Smart')).toBeTruthy()
    fireEvent.change(rendered.view.getByLabelText(en.maxReviewAttempts), { target: { value: '5' } })
    await act(async () => { fireEvent.click(rendered.view.getByRole('button', { name: en.save })) })
    expect(mutate).toHaveBeenCalledOnce()
    expect(hostSettings.maxReviewAttempts).toBe(5)
    await feature.dispose()
    expect(rt.slots.entries(CONFIG)).toEqual([])
  })

  it('does not render RG status for unrelated Sessions and follows the durable projection', async () => {
    const h = await boot()
    await h.declare()
    await h.rt.mount(plugin)
    const d = await dock(h)
    await h.setState(d.id, null)
    expect(d.view.queryByText('RG')).toBeNull()
    await h.setState(d.id, { ...rgState(), task: null })
    expect(d.view.getByText(en.noTask)).toBeTruthy()
  })

  it('addresses each injected callback to its rendered Session and never edits the projection optimistically', async () => {
    const h = await boot()
    await h.declare()
    await h.rt.mount(plugin)
    const d = await dock(h, 'first-session')
    fireEvent.click(d.view.getByRole('button', { name: en.newTask }))
    fireEvent.change(d.view.getByLabelText(en.newTaskObjective), { target: { value: '  next objective  ' } })
    await act(async () => { fireEvent.click(d.view.getByRole('button', { name: en.confirmNewTask })) })
    expect(h.newTask).toHaveBeenCalledWith(d.id, 'next objective')
    expect(d.view.getByText('Repair the requested output', { selector: 'summary span' })).toBeTruthy()
    await act(async () => { fireEvent.click(d.view.getByRole('button', { name: en.recheck })) })
    expect(h.recheck).toHaveBeenCalledWith(d.id, expect.any(AbortSignal))
  })

  it('keeps a pending new task failure visible after the Host publishes its task first', async () => {
    const h = await boot()
    await h.declare()
    await h.rt.mount(plugin)
    const d = await dock(h)
    const pending = Promise.withResolvers<Awaited<ReturnType<Context['remote']['reviewGated']['newTask']>>>()
    onTestFinished(() => { pending.resolve({ ok: true, value: rgState().task! }) })
    h.newTask.mockReturnValueOnce(pending.promise)
    fireEvent.click(d.view.getByRole('button', { name: en.newTask }))
    fireEvent.change(d.view.getByLabelText(en.newTaskObjective), { target: { value: 'New task' } })
    fireEvent.click(d.view.getByRole('button', { name: en.confirmNewTask }))
    const state = rgState()
    await h.setState(d.id, { ...state, task: { ...state.task!, id: 'task-2' as NonNullable<typeof state.task>['id'], objective: 'New task' } })
    expect(d.view.getByRole<HTMLButtonElement>('button', { name: en.newTask }).disabled).toBe(true)
    expect(d.view.queryByLabelText(en.newTaskObjective)).toBeNull()
    await act(async () => { pending.reject(new Error('lost response')); await expect(pending.promise).rejects.toThrow('lost response') })
    expect(d.view.getByRole('alert').textContent).toBe(en.actionFailed)
    expect(d.view.getByText('New task', { selector: 'summary span' })).toBeTruthy()
  })

  it('aborts pending rechecks on reconnect and ignores their late rejection in the new generation', async () => {
    const h = await boot()
    await h.declare()
    await h.rt.mount(plugin)
    const d = await dock(h)
    const pending = Promise.withResolvers<{ ok: true; value: ReturnType<typeof rgState> }>()
    onTestFinished(() => { pending.resolve({ ok: true, value: rgState() }) })
    h.recheck.mockReturnValueOnce(pending.promise)
    fireEvent.click(d.view.getByRole('button', { name: en.recheck }))
    const signal = h.recheck.mock.calls[0]![1]!
    expect(signal.aborted).toBe(false)
    await act(async () => { h.rt.ctx.emit('connection/reset') })
    expect(signal.aborted).toBe(true)
    fireEvent.click(d.container.querySelector('summary')!)
    expect(d.view.getByRole<HTMLButtonElement>('button', { name: en.recheck }).disabled).toBe(false)
    await act(async () => { pending.reject(new Error('old generation')); await expect(pending.promise).rejects.toThrow('old generation') })
    expect(d.view.queryByRole('alert')).toBeNull()
  })

  it('withdraws registrations, locale, Host subscriptions, and forwarded event handlers with its fiber', async () => {
    const h = await boot()
    await h.declare()
    const listeners = h.f.listenerCount()
    const feature = await h.rt.mount(plugin)
    const view = h.rt.renderSlot(CONFIG, { close: () => {} }, { only: ID })
    await view.view.findAllByText('Smart')
    const reads = h.modelCatalog.mock.calls.length
    await act(async () => { h.rt.remote.emit('llm/models-updated', []) })
    expect(h.modelCatalog).toHaveBeenCalledTimes(reads + 1)
    await feature.dispose()
    expect(h.f.listenerCount()).toBe(listeners)
    expect(h.rt.slots.entries(CONFIG)).toEqual([])
    expect(h.rt.slots.entries(DOCK)).toEqual([])
    expect(h.locale.bind('review-gated')('effectiveHint')).toBe('effectiveHint')
    await act(async () => { h.rt.remote.emit('llm/models-updated', []) })
    expect(h.modelCatalog).toHaveBeenCalledTimes(reads + 1)
  })

  it('reports Remote task and recheck refusals without changing retained task facts', async () => {
    const h = await boot()
    await h.declare()
    await h.rt.mount(plugin)
    const d = await dock(h)
    const refusal = new RemoteError('gateway/bad-request', 'request refused', {})
    h.newTask.mockResolvedValueOnce({ ok: false, error: refusal })
    fireEvent.click(d.view.getByRole('button', { name: en.newTask }))
    fireEvent.change(d.view.getByLabelText(en.newTaskObjective), { target: { value: 'Keep the objective' } })
    await act(async () => { fireEvent.click(d.view.getByRole('button', { name: en.confirmNewTask })) })
    expect(d.view.getByRole('alert').textContent).toBe(en.actionFailed)
    expect(d.view.getByLabelText<HTMLInputElement>(en.newTaskObjective).value).toBe('Keep the objective')
    h.recheck.mockResolvedValueOnce({ ok: false, error: refusal })
    await act(async () => { fireEvent.click(d.view.getByRole('button', { name: en.recheck })) })
    expect(d.view.getByRole('alert').textContent).toBe(en.actionFailed)
    expect(d.view.getByText('Repair the requested output', { selector: 'summary span' })).toBeTruthy()
  })

  it('reports a refused directory read while preserving the saved role models', async () => {
    const h = await boot()
    await h.declare()
    await h.rt.mount(plugin)
    h.modelCatalog.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/bad-request', 'directory refused', {}) })
    const view = h.rt.renderSlot(CONFIG, { close: () => {} }, { only: ID })
    expect(await view.view.findByText(en.catalogFailed)).toBeTruthy()
    expect(view.view.getAllByText(en.savedUnavailable)).toHaveLength(2)
    expect(view.view.getByLabelText<HTMLInputElement>(en.maxReviewAttempts).value).toBe('2')
  })

  it('mounts its generated contribution before UI and disposes UI before unmounting Remote methods', async () => {
    const h = await boot()
    await h.declare()
    const contribution: TypertRemoteContribution = { package: '@deepseek-ai/dsh-experimental-review-gated', descriptors: [] }
    const unmount = vi.fn(async () => {
      expect(h.rt.slots.entries(CONFIG)).toEqual([])
      expect(h.rt.slots.entries(DOCK)).toEqual([])
    })
    const mountRemote = vi.fn(async (_contribution: TypertRemoteContribution) => unmount)
    Object.assign(h.rt.remote, { $mount: mountRemote })
    const registration = Client
    const feature = await h.rt.mount(registration)
    expect(mountRemote).toHaveBeenCalledWith(contribution)
    expect(h.rt.slots.entries(CONFIG)).toHaveLength(1)
    await feature.dispose()
    expect(unmount).toHaveBeenCalledOnce()
  })

  it('rolls back a failed UI mount before releasing its Remote contribution', async () => {
    const h = await boot()
    await h.declare()
    const failure = new Error('locale service unavailable')
    vi.spyOn(h.locale, 'register').mockImplementationOnce(() => { throw failure })
    const unmount = vi.fn(async () => {
      expect(h.rt.slots.entries(CONFIG)).toEqual([])
      expect(h.rt.slots.entries(DOCK)).toEqual([])
    })
    Object.assign(h.rt.remote, { $mount: vi.fn(async () => unmount) })
    await expect(Client.apply(h.rt.ctx)).rejects.toBe(failure)
    expect(unmount).toHaveBeenCalledOnce()
  })

  it.each(['llm/adapters-updated', 'credentials/record-updated', 'credentials/reference-updated'] as const)(
    'refreshes visible model metadata after %s and stops listening after disposal', async (event) => {
      const h = await boot()
      await h.declare()
      const feature = await h.rt.mount(plugin)
      const view = h.rt.renderSlot(CONFIG, { close: () => {} }, { only: ID })
      await view.view.findAllByText('Smart')
      const reads = h.modelCatalog.mock.calls.length
      await act(async () => { h.rt.remote.emit(event, []) })
      expect(h.modelCatalog).toHaveBeenCalledTimes(reads + 1)
      await feature.dispose()
      await act(async () => { h.rt.remote.emit(event, []) })
      expect(h.modelCatalog).toHaveBeenCalledTimes(reads + 1)
    })

  it('follows the active child model projection instead of reusing the main model', async () => {
    const h = await boot()
    await h.declare()
    await h.rt.mount(plugin)
    const d = await dock(h)
    const childId = await h.rt.sessions.add({ id: 'child-1' })
    const child = h.rt.sessions.retain(childId)
    onTestFinished(async () => { await h.rt.dispose(); child.release() })
    const state = rgState()
    await h.setState(d.id, { ...state, task: { ...state.task!, active: { ...state.task!.lastReview!, status: 'running' } } })
    expect(d.view.getByText(en.notRequested)).toBeTruthy()
    await act(async () => {
      h.rt.sessions.list.update((draft) => {
        draft.projectionsBySession = { ...draft.projectionsBySession, [childId]: { state: 'ready', error: null,
          values: { modelSelection: { lastUsed: { provider: 'actual', model: 'child-route' }, next: null } } } }
      })
    })
    expect(d.view.getByText('actual/child-route')).toBeTruthy()
  })

  it('isolates a hot-reloaded form from its retired directory request and event listeners', async () => {
    const h = await boot()
    await h.declare()
    const old = Promise.withResolvers<Awaited<ReturnType<Context['remote']['session']['modelCatalog']>>>()
    onTestFinished(() => { old.resolve({ ok: true, value: catalog }) })
    h.modelCatalog.mockReturnValueOnce(old.promise)
    const first = await h.rt.mount(plugin)
    const view = h.rt.renderSlot(CONFIG, { close: () => {} }, { only: ID })
    expect(view.view.getByText(en.catalogLoading)).toBeTruthy()
    await first.dispose()
    const replacement = await h.rt.mount(plugin)
    await view.view.findAllByText('Smart')
    await act(async () => { old.resolve({ ok: true, value: { ...catalog, groups: [] } }); await old.promise })
    expect(view.view.getAllByText('Smart')).toHaveLength(2)
    const reads = h.modelCatalog.mock.calls.length
    await act(async () => { h.rt.remote.emit('llm/models-updated', []) })
    expect(h.modelCatalog).toHaveBeenCalledTimes(reads + 1)
    await replacement.dispose()
    expect(h.rt.slots.entries(CONFIG)).toEqual([])
    expect(h.rt.slots.entries(DOCK)).toEqual([])
    await act(async () => { h.rt.remote.emit('llm/models-updated', []) })
    expect(h.modelCatalog).toHaveBeenCalledTimes(reads + 1)
  })
})


describe('RG local Git delivery registration', () => {
  it('addresses authorization to the rendered Session and waits for Git projection publication', async () => {
    const h = await boot()
    await h.declare()
    await h.rt.mount(plugin)
    const d = await dock(h, 'git-owner')
    await h.setState(d.id, freshRgState())
    fireEvent.click(d.view.getByRole('button', { name: en.localGit }))
    const scope = d.view.getByLabelText<HTMLTextAreaElement>(en.gitScope)
    expect(scope.value).toBe('')
    expect(document.activeElement).not.toBe(scope)
    fireEvent.change(scope, { target: { value: ' src/\n README.md ' } })
    await act(async () => { fireEvent.click(d.view.getByRole('button', { name: en.authorizeLocalGit })) })
    expect(h.authorizeLocalGit).toHaveBeenCalledWith(d.id, ['src/', 'README.md'], expect.any(AbortSignal))
    expect(d.view.queryByText(en.gitAuthorized)).toBeNull()
    await h.setGit(d.id, gitState())
    expect(d.view.getByText(en.gitAuthorized)).toBeTruthy()
    expect(d.view.getByText('/work')).toBeTruthy()
    await act(async () => { h.locale.setLocale('zh') })
    expect(d.view.getByText(zh.gitAuthorized)).toBeTruthy()
    expect(d.view.getByText(zh.gitSource)).toBeTruthy()
  })

  it('reports a Remote authorization refusal and retains the human scope draft', async () => {
    const h = await boot()
    await h.declare()
    await h.rt.mount(plugin)
    const d = await dock(h)
    await h.setState(d.id, freshRgState())
    h.authorizeLocalGit.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/bad-request', 'authorization refused', {}) })
    fireEvent.click(d.view.getByRole('button', { name: en.localGit }))
    fireEvent.change(d.view.getByLabelText(en.gitScope), { target: { value: '.' } })
    await act(async () => { fireEvent.click(d.view.getByRole('button', { name: en.authorizeLocalGit })) })
    expect(d.view.getByRole('alert').textContent).toBe(en.actionFailed)
    expect(d.view.getByLabelText<HTMLTextAreaElement>(en.gitScope).value).toBe('.')
    expect(d.view.queryByText(en.gitAuthorized)).toBeNull()
  })

  it.each(['success', 'failure'] as const)('aborts reconnecting authorization and ignores its late %s', async (outcome) => {
    const h = await boot()
    await h.declare()
    await h.rt.mount(plugin)
    const d = await dock(h)
    await h.setState(d.id, freshRgState())
    const pending = Promise.withResolvers<Awaited<ReturnType<Context['remote']['reviewGated']['authorizeLocalGit']>>>()
    onTestFinished(() => { pending.resolve({ ok: true, value: gitState() }) })
    h.authorizeLocalGit.mockReturnValueOnce(pending.promise)
    fireEvent.click(d.view.getByRole('button', { name: en.localGit }))
    fireEvent.change(d.view.getByLabelText(en.gitScope), { target: { value: 'src/' } })
    fireEvent.click(d.view.getByRole('button', { name: en.authorizeLocalGit }))
    const signal = h.authorizeLocalGit.mock.calls[0]![2]!
    expect(signal.aborted).toBe(false)
    await act(async () => { h.rt.ctx.emit('connection/reset') })
    expect(signal.aborted).toBe(true)
    fireEvent.click(d.container.querySelector('summary')!)
    expect(d.view.queryByLabelText(en.gitScope)).toBeNull()
    fireEvent.click(d.view.getByRole('button', { name: en.localGit }))
    expect(d.view.getByLabelText<HTMLTextAreaElement>(en.gitScope).value).toBe('')
    await act(async () => {
      if (outcome === 'success') { pending.resolve({ ok: true, value: gitState() }); await pending.promise }
      else { pending.reject(new Error('old authorization generation')); await expect(pending.promise).rejects.toThrow('old authorization generation') }
    })
    expect(d.view.queryByRole('alert')).toBeNull()
    expect(d.view.queryByText(en.gitAuthorized)).toBeNull()
  })

  it('follows candidate projection changes without replacing the independent review result', async () => {
    const h = await boot()
    await h.declare()
    await h.rt.mount(plugin)
    const d = await dock(h)
    await h.setGit(d.id, candidateGitState())
    expect(d.view.getByText('candidate-1')).toBeTruthy()
    expect(d.view.getByText(en.reportedPass)).toBeTruthy()
    await act(async () => { fireEvent.click(d.view.getByRole('button', { name: en.recheck })) })
    expect(h.recheck).toHaveBeenCalledWith(d.id, expect.any(AbortSignal))
    expect(d.view.getByText('candidate-1')).toBeTruthy()
    await h.setState(d.id, { ...rgState(), task: null })
    expect(d.view.queryByText('candidate-1')).toBeNull()
    await h.setState(d.id, { ...rgState(), role: 'reviewer', task: null, taskId: gitState().taskId })
    expect(d.view.getByText('candidate-1')).toBeTruthy()
    expect(d.view.queryByRole('button', { name: en.localGit })).toBeNull()
  })
})


describe('RG retained Git grant exit', () => {
  it('leaves only after explicit acknowledgement and keeps candidate facts until the projection changes', async () => {
    const h = await boot()
    await h.declare()
    await h.rt.mount(plugin)
    const d = await dock(h)
    expect(d.view.queryByRole('button', { name: en.leaveLocalGit })).toBeNull()
    await h.setGit(d.id, candidateGitState())
    fireEvent.click(d.view.getByRole('button', { name: en.leaveLocalGit }))
    expect(h.leaveLocalGit).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('checkbox', { name: en.leaveGitAcknowledgement }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.confirmLeaveLocalGit })) })
    expect(h.leaveLocalGit).toHaveBeenCalledWith(d.id)
    expect(d.view.getByText('candidate-1')).toBeTruthy()
    expect(d.view.getByText(en.reportedPass)).toBeTruthy()
    await h.setGit(d.id, null)
    await h.setState(d.id, { ...rgState(), task: { ...rgState().task!, reviewStatus: 'stale' } })
    expect(d.view.queryByText('candidate-1')).toBeNull()
    expect(d.view.getByText(en.stale)).toBeTruthy()
  })

  it('retains a failed grant and candidate after a refused exit', async () => {
    const h = await boot()
    await h.declare()
    await h.rt.mount(plugin)
    const d = await dock(h)
    await h.setGit(d.id, { ...candidateGitState(), status: 'failed', diagnostic: 'Retained candidate needs inspection' })
    h.leaveLocalGit.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/bad-request', 'leave refused', {}) })
    fireEvent.click(d.view.getByRole('button', { name: en.leaveLocalGit }))
    fireEvent.click(screen.getByRole('checkbox', { name: en.leaveGitAcknowledgement }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.confirmLeaveLocalGit })) })
    expect(d.view.getByRole('alert').textContent).toBe(en.actionFailed)
    expect(d.view.getByText('candidate-1')).toBeTruthy()
    expect(d.view.getByText('Retained candidate needs inspection')).toBeTruthy()
  })

  it('clears the exit acknowledgement on reconnect without accepting a late response as a projection', async () => {
    const h = await boot()
    await h.declare()
    await h.rt.mount(plugin)
    const d = await dock(h)
    await h.setGit(d.id, { ...candidateGitState(), status: 'unknown' })
    const pending = Promise.withResolvers<Awaited<ReturnType<Context['remote']['reviewGated']['leaveLocalGit']>>>()
    onTestFinished(() => { pending.resolve({ ok: true, value: undefined }) })
    h.leaveLocalGit.mockReturnValueOnce(pending.promise)
    fireEvent.click(d.view.getByRole('button', { name: en.leaveLocalGit }))
    fireEvent.click(screen.getByRole('checkbox', { name: en.leaveGitAcknowledgement }))
    fireEvent.click(screen.getByRole('button', { name: en.confirmLeaveLocalGit }))
    await act(async () => { h.rt.ctx.emit('connection/reset') })
    fireEvent.click(d.container.querySelector('summary')!)
    fireEvent.click(d.view.getByRole('button', { name: en.leaveLocalGit }))
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: en.leaveGitAcknowledgement }).checked).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: en.close }))
    await act(async () => { pending.reject(new Error('old exit generation')); await expect(pending.promise).rejects.toThrow('old exit generation') })
    expect(d.view.queryByRole('alert')).toBeNull()
    expect(d.view.getByText('candidate-1')).toBeTruthy()
    expect(d.view.getByText(en.gitUnknown)).toBeTruthy()
  })
})
