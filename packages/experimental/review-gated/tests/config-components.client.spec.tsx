// @vitest-environment jsdom
/** RG settings controls exercise the draft controller through the rendered form. */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { RgConfig } from '../src/client/RgConfig.tsx'
import { en } from '../src/client/locales.ts'
import { catalog, fixture, settings, waitForState } from './fixture.client.ts'

afterEach(cleanup)

async function mount(options: Parameters<typeof fixture>[0] = {}) {
  const f = fixture({ ...options, subscribe: false })
  const props = { ...f.face, close: () => {}, t: makeTranslate(en), useRgConfig: bindSnapshotSelector(f.face.hooks.rgConfig) }
  const view = render(<RgConfig {...props} />)
  await act(async () => { await waitForState(f.face, state => state.catalogStatus !== 'loading') })
  return { ...f, ...view }
}

const mainSection = () => screen.getByRole('heading', { name: en.main }).closest('section')!
const edit = (name: string, value: string) => fireEvent.change(screen.getByLabelText(name), { target: { value } })

describe('RG settings form', () => {
  it('renders provider groups, explicit defaults, custom reviewer efforts, and one atomic save', async () => {
    const f = await mount()
    expect(screen.getByRole('heading', { name: en.roleModels })).toBeTruthy()
    expect(screen.getByText(en.poolHint)).toBeTruthy()
    const main = within(mainSection())
    expect(main.getByText('Alpha')).toBeTruthy()
    fireEvent.click(main.getByRole('checkbox', { name: 'Allow model alpha/fast' }))
    fireEvent.click(main.getByRole('radio', { name: 'Default model alpha/fast' }))
    fireEvent.click(screen.getByRole('radio', { name: en.custom }))
    const reviewer = within(screen.getAllByRole('heading', { name: en.reviewer })[1]!.closest('section')!)
    fireEvent.click(reviewer.getByRole('button', { name: 'Reasoning effort alpha/smart' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Low' }))
    edit(en.maxReviewAttempts, '4')
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    await act(async () => { await waitForState(f.face, state => !state.saving) })
    expect(f.mutate).toHaveBeenCalledOnce()
    expect(f.current().value?.settings).toMatchObject({ maxReviewAttempts: 4,
      main: { default: { provider: 'alpha', model: 'fast' } },
      reviewer: { mode: 'custom', pool: { candidates: [{ reasoningEffort: 'low' }, { model: 'fast' }] } } })
    expect(screen.getByText(en.saved)).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.save }).disabled).toBe(true)
  })

  it('disables save for missing defaults and invalid budgets and recovers on discard', async () => {
    const f = await mount()
    const main = within(mainSection())
    fireEvent.click(main.getByRole('checkbox', { name: 'Allow model alpha/fast' }))
    fireEvent.click(main.getByRole('checkbox', { name: 'Allow model alpha/smart' }))
    expect(main.getByText(en.defaultRequired)).toBeTruthy()
    edit(en.maxWorkerAttempts, '0')
    expect(screen.getByText(en.integerRequired)).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.save }).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: en.discard }))
    expect(screen.getByLabelText<HTMLInputElement>(en.maxWorkerAttempts).value).toBe('2')
    expect(f.mutate).not.toHaveBeenCalled()
  })

  it('keeps saved unavailable routes visible and does not allow adding them back', async () => {
    await mount({ readCatalog: async () => ({ ...catalog, groups: [] }) })
    const main = within(mainSection())
    expect(main.getByText(en.savedUnavailable)).toBeTruthy()
    const saved = main.getByRole<HTMLInputElement>('checkbox', { name: 'Allow model alpha/smart' })
    expect(saved.checked).toBe(true)
    fireEvent.click(saved)
    expect(saved.disabled).toBe(true)
    expect(main.getByText(en.poolRequired)).toBeTruthy()
  })

  it('reports a disappeared new candidate without dropping saved choices', async () => {
    const f = await mount()
    fireEvent.click(within(mainSection()).getByRole('checkbox', { name: 'Allow model alpha/fast' }))
    f.readCatalog.mockResolvedValueOnce({ ...catalog, groups: [] })
    await act(async () => { f.controller.refreshCatalog(); await waitForState(f.face, state => state.catalogStatus === 'ready') })
    expect(screen.getByText(en.candidateUnavailable)).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.save }).disabled).toBe(true)
  })

  it('offers a read-only explanation and disables every edit while retaining values', async () => {
    await mount({ writable: false })
    expect(screen.getByText(en.readOnly)).toBeTruthy()
    for (const input of screen.getAllByRole<HTMLInputElement>('checkbox')) expect(input.disabled).toBe(true)
    expect(screen.getByLabelText<HTMLInputElement>(en.maxReviewAttempts).disabled).toBe(true)
  })

  it('keeps the draft on a revision conflict until the user discards it', async () => {
    const f = await mount()
    edit(en.maxReviewAttempts, '3')
    act(() => { f.update({ ...f.current().value!.settings, maxReviewAttempts: 8 }) })
    expect(screen.getByRole('alert').textContent).toBe(en.conflict)
    expect(screen.getByLabelText<HTMLInputElement>(en.maxReviewAttempts).value).toBe('3')
    expect(screen.getByLabelText<HTMLInputElement>(en.maxReviewAttempts).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: en.discard }))
    expect(screen.getByLabelText<HTMLInputElement>(en.maxReviewAttempts).value).toBe('8')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('retains a model selection on a rejected revision and discards it before retry', async () => {
    const f = await mount()
    const main = within(mainSection())
    fireEvent.click(main.getByRole('checkbox', { name: 'Allow model alpha/fast' }))
    f.mutate.mockImplementationOnce(async () => {
      f.update({ ...settings(), maxReviewAttempts: 8 }, 2)
      return false
    })
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    await act(async () => { await waitForState(f.face, state => !state.saving) })
    expect(f.mutate.mock.calls[0]?.[1]).toBe(1)
    expect(screen.getByText(en.conflict)).toBeTruthy()
    expect(main.getByRole<HTMLInputElement>('checkbox', { name: 'Allow model alpha/fast' }).checked).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.save }).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: en.discard }))
    expect(main.getByRole<HTMLInputElement>('checkbox', { name: 'Allow model alpha/fast' }).checked).toBe(false)
    expect(screen.getByLabelText<HTMLInputElement>(en.maxReviewAttempts).value).toBe('8')
  })

  it('reports uncertain writes beside the retained draft instead of confirming success', async () => {
    const f = await mount()
    f.mutate.mockRejectedValueOnce(new Error('lost response'))
    edit(en.maxWorkerAttempts, '3')
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    await act(async () => { await waitForState(f.face, state => !state.saving) })
    expect(screen.getByText(en.saveFailed)).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain(en.uncertain)
    expect(screen.queryByText(en.saved)).toBeNull()
    expect(screen.getByLabelText<HTMLInputElement>(en.maxWorkerAttempts).value).toBe('3')
  })

  it('offers retry after partial or failed catalog reads without hiding existing values', async () => {
    const f = await mount({ readCatalog: async () => ({ ...catalog, failures: [{ id: 'beta', name: 'Beta', message: 'failed' }] }) })
    expect(screen.getByText(en.catalogPartial)).toBeTruthy()
    f.readCatalog.mockRejectedValueOnce(new Error('offline'))
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    await act(async () => { await waitForState(f.face, state => state.catalogStatus === 'error') })
    expect(screen.getByText(en.catalogFailed)).toBeTruthy()
    expect(within(mainSection()).getByText('Smart')).toBeTruthy()
    f.readCatalog.mockResolvedValueOnce(catalog)
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    await act(async () => { await waitForState(f.face, state => state.catalogStatus === 'ready') })
    expect(screen.queryByText(en.catalogFailed)).toBeNull()
  })

  it('drops edits after reconnecting, hides withdrawn controls, and ignores a late save', async () => {
    const f = await mount()
    const pending = Promise.withResolvers<boolean>()
    onTestFinished(() => { pending.resolve(false) })
    f.mutate.mockReturnValueOnce(pending.promise)
    edit(en.maxReviewAttempts, '3')
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    await act(async () => { f.controller.resetConnection(); await waitForState(f.face, state => state.catalogStatus === 'ready') })
    expect(screen.getByLabelText<HTMLInputElement>(en.maxReviewAttempts).value).toBe('2')
    expect(screen.getByText(en.uncertain, { exact: false })).toBeTruthy()
    await act(async () => { pending.resolve(true); await pending.promise })
    expect(screen.queryByText(en.saved)).toBeNull()
    act(() => { f.publish({ status: 'unavailable' }) })
    expect(screen.getByText(en.unavailable)).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain(en.uncertain)
    expect(screen.queryByRole('button', { name: en.acknowledgeUncertain })).toBeNull()
    expect(screen.queryByRole('checkbox')).toBeNull()
    act(() => { f.publish({ status: 'ready', value: { settings: { ...settings(), maxReviewAttempts: 3 } }, writable: true, revision: 2 }) })
    expect(screen.getByLabelText<HTMLInputElement>(en.maxReviewAttempts).value).toBe('3')
    fireEvent.click(screen.getByRole('button', { name: en.acknowledgeUncertain }))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('restores an unsaved draft after the settings section unmounts', async () => {
    const f = await mount()
    edit(en.maxReviewAttempts, '7')
    f.unmount()
    expect(f.read().dirty).toBe(true)
    expect(f.mutate).not.toHaveBeenCalled()
    render(<RgConfig {...f.face} close={() => {}} t={makeTranslate(en)} useRgConfig={bindSnapshotSelector(f.face.hooks.rgConfig)} />)
    expect(screen.getByLabelText<HTMLInputElement>(en.maxReviewAttempts).value).toBe('7')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.save }).disabled).toBe(false)
  })

  it('keeps a pending save alive when the section unmounts', async () => {
    const f = await mount()
    const pending = Promise.withResolvers<boolean>()
    onTestFinished(() => { pending.resolve(false) })
    f.mutate.mockReturnValueOnce(pending.promise)
    edit(en.maxReviewAttempts, '7')
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    f.unmount()
    expect(f.read().saving).toBe(true)
    act(() => { f.update({ ...settings(), maxReviewAttempts: 7 }) })
    await act(async () => { pending.resolve(true); await pending.promise })
    expect(f.read()).toMatchObject({ saving: false, dirty: false, failed: false })
    render(<RgConfig {...f.face} close={() => {}} t={makeTranslate(en)} useRgConfig={bindSnapshotSelector(f.face.hooks.rgConfig)} />)
    expect(screen.getByLabelText<HTMLInputElement>(en.maxReviewAttempts).value).toBe('7')
    expect(screen.getByText(en.saved)).toBeTruthy()
  })

  it('reports a conflict that occurs while the section is unmounted', async () => {
    const f = await mount()
    edit(en.maxReviewAttempts, '7')
    f.unmount()
    act(() => { f.update({ ...settings(), maxReviewAttempts: 8 }) })
    render(<RgConfig {...f.face} close={() => {}} t={makeTranslate(en)} useRgConfig={bindSnapshotSelector(f.face.hooks.rgConfig)} />)
    expect(screen.getByRole('alert').textContent).toBe(en.conflict)
    expect(screen.getByLabelText<HTMLInputElement>(en.maxReviewAttempts).value).toBe('7')
    expect(f.mutate).not.toHaveBeenCalled()
  })

  it('explains an unconfigured empty directory and hides controls while the Host reconnects', async () => {
    const f = await mount({ value: { ...settings(), configured: false,
      main: { candidates: [], default: null }, worker: { candidates: [], default: null } },
    readCatalog: async () => ({ ...catalog, groups: [] }) })
    expect(screen.getByText(en.notConfigured)).toBeTruthy()
    expect(screen.getByText(en.catalogEmpty)).toBeTruthy()
    act(() => { f.publish({ status: 'loading', value: undefined, writable: false, revision: undefined }) })
    expect(screen.getByText(en.unavailable)).toBeTruthy()
    expect(f.read().settings).toBeNull()
    expect(screen.queryByText(en.notConfigured)).toBeNull()
  })

  it('closes the effort menu on Escape, accepts provider defaults, and restores reviewer inheritance', async () => {
    const f = await mount()
    const main = within(mainSection())
    const effort = main.getByRole('button', { name: 'Reasoning effort alpha/smart' })
    fireEvent.click(effort)
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.click(effort)
    fireEvent.click(screen.getByRole('menuitem', { name: en.providerDefault }))
    expect(f.read().settings?.main.candidates[0]?.reasoningEffort).toBeUndefined()
    fireEvent.click(screen.getByRole('radio', { name: en.custom }))
    fireEvent.click(screen.getByRole('radio', { name: en.inherit }))
    expect(f.read().settings?.reviewer.mode).toBe('inherit-main')
  })

  it('dismisses a successful save after the shared toast lifecycle completes', async () => {
    vi.useFakeTimers()
    onTestFinished(() => { vi.useRealTimers() })
    const f = await mount()
    edit(en.maxReviewAttempts, '4')
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    await act(async () => { await waitForState(f.face, state => !state.saving) })
    expect(screen.getByText(en.saved)).toBeTruthy()
    await act(async () => { await vi.runOnlyPendingTimersAsync() })
    expect(screen.queryByText(en.saved)).toBeNull()
    expect(f.read().savedNotice).toBeNull()
  })
})
