// @vitest-environment jsdom
/** Task facts and explicit controls remain independent of model-written prose. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { RgStatus } from '../src/client/RgDock.tsx'
import { en, zh } from '../src/client/locales.ts'
import { candidateGitState, freshRgState, gitState, rgState, reviewRun } from './task-fixture.client.ts'

// jsdom does not implement scrolling; browser layout is covered separately.
const originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')
beforeAll(() => { Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: () => {} }) })
afterAll(() => {
  if (originalScrollIntoView === undefined) Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
  else Object.defineProperty(Element.prototype, 'scrollIntoView', originalScrollIntoView)
})

afterEach(cleanup)

function mount(overrides: Partial<ComponentProps<typeof RgStatus>> = {}) {
  const newTask = vi.fn(async (_objective: string, _signal: AbortSignal) => {})
  const recheck = vi.fn(async (_signal: AbortSignal) => {})
  const authorizeLocalGit = vi.fn(async (_scope: readonly string[], _signal: AbortSignal) => {})
  const leaveLocalGit = vi.fn(async (_signal: AbortSignal) => {})
  const props: ComponentProps<typeof RgStatus> = { state: rgState(), trust: 'ready', git: null, busy: false,
    canNewTask: true, canRecheck: true, canAuthorizeLocalGit: true, canLeaveLocalGit: true,
    model: { lastUsed: { provider: 'alpha', model: 'last-actual' }, next: { provider: 'beta', model: 'next-choice' } },
    roleModel: undefined, newTask, recheck, authorizeLocalGit, leaveLocalGit, t: makeTranslate(en), ...overrides }
  const view = render(<RgStatus {...props} />)
  fireEvent.click(view.container.querySelector('summary')!)
  return { props, newTask, recheck, authorizeLocalGit, leaveLocalGit, ...view }
}

describe('RG task status', () => {
  it('withdraws controls, reports uncertainty, and discards drafts when trust changes', () => {
    const f = mount()
    fireEvent.click(screen.getByRole('button', { name: en.newTask }))
    fireEvent.change(screen.getByLabelText(en.newTaskObjective), { target: { value: 'unconfirmed draft' } })
    f.rerender(<RgStatus {...f.props} trust="saving" />)
    expect(screen.getByRole('status').textContent).toContain(en.saving)
    expect(screen.getByRole('status').textContent).toContain(en.statusProcessingHint)
    expect(screen.queryByText(en.reportedPass)).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
    f.rerender(<RgStatus {...f.props} trust="unknown" />)
    expect(screen.getByRole('status').textContent).toBe(en.statusUnknown)
    expect(f.newTask).not.toHaveBeenCalled()
    f.rerender(<RgStatus {...f.props} trust="ready" />)
    expect(screen.queryByLabelText(en.newTaskObjective)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.newTask }))
    expect(screen.getByLabelText<HTMLInputElement>(en.newTaskObjective).value).toBe('')
  })

  it('reveals newly opened task and Git forms without focusing their inputs', () => {
    const original = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')
    const scroll = vi.fn()
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: scroll })
    onTestFinished(() => {
      if (original === undefined) Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
      else Object.defineProperty(Element.prototype, 'scrollIntoView', original)
    })
    mount({ state: freshRgState() })
    fireEvent.click(screen.getByRole('button', { name: en.newTask }))
    expect(scroll).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' })
    expect(document.activeElement).not.toBe(screen.getByLabelText(en.newTaskObjective))
    fireEvent.click(screen.getByRole('button', { name: en.cancel }))
    scroll.mockClear()
    fireEvent.click(screen.getByRole('button', { name: en.localGit }))
    expect(scroll).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' })
    expect(document.activeElement).not.toBe(screen.getByLabelText(en.gitScope))
  })

  it('retains the complete task objective in expanded details', () => {
    const state = rgState()
    const objective = 'Long objective '.repeat(100).trim()
    mount({ state: { ...state, task: { ...state.task!, objective } } })
    expect(screen.getByText(objective, { selector: 'summary span' })).toBeTruthy()
    expect(screen.getByText(objective, { selector: 'dd' })).toBeTruthy()
  })

  it('keeps expanded details in a keyboard-accessible scroll region', () => {
    mount()
    const details = screen.getByRole('region', { name: en.details })
    expect(details.getAttribute('tabindex')).toBe('0')
    expect(details.contains(screen.getByText('Inspected the requested change'))).toBe(true)
  })

  it('distinguishes reported review, revision, budgets, policy, and actual versus next model', () => {
    mount()
    expect(screen.getByText('Repair the requested output', { selector: 'summary span' })).toBeTruthy()
    for (const text of [en.reportedPass, 'frozen-policy', 'alpha/last-actual', 'beta/next-choice',
      'src/first.ts', 'unit suite passed', 'cross-platform behavior', en.reviewNote]) {
      expect(screen.getByText(text)).toBeTruthy()
    }
    expect(screen.getByText(new RegExp('src/first.ts:4')).textContent).toContain('Incorrect output')
    expect(screen.getByText(new RegExp('Worker attempts 1/2'))).toBeTruthy()
    expect(screen.getByText(new RegExp('Review attempts 2/2'))).toBeTruthy()
  })

  it('does not display a pass without workspace scope or a retained Git delivery', () => {
    const state = rgState()
    const task = state.task!
    const lostEvidence = { ...state, task: { ...task, lastReview: { ...reviewRun(), scope: null } } }
    const f = mount({ state: lostEvidence })
    expect(screen.queryByText(en.reportedPass)).toBeNull()
    expect(screen.getByText(en.stale)).toBeTruthy()
    const candidate = candidateGitState()
    f.rerender(<RgStatus {...f.props} git={candidate} />)
    expect(screen.queryByText(en.reportedPass)).toBeNull()
    if (candidate.candidate === null || candidate.workspace === null) throw new Error('Candidate fixture lacks a checkout.')
    f.rerender(<RgStatus {...f.props} git={{ ...candidate, binding: { role: 'reviewer', runId: reviewRun().id,
      candidateId: candidate.candidate.id, checkoutName: 'review', checkout: candidate.workspace } }} />)
    expect(screen.getByText(en.reportedPass)).toBeTruthy()
  })

  it('identifies the admitted active model separately from the child actual request', () => {
    const state = rgState()
    mount({ state: { ...state, task: { ...state.task!, active: { ...reviewRun(), status: 'running' } } },
      roleModel: { lastUsed: { provider: 'child', model: 'actual' }, next: null } })
    expect(screen.getByText('child/actual')).toBeTruthy()
    expect(screen.getByText('alpha/smart · high')).toBeTruthy()
    expect(screen.queryByText('alpha/last-actual')).toBeNull()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.newTask }).disabled).toBe(true)
  })

  it('shows missing policy and read-only controls rather than admitting a mutation', () => {
    const state = rgState()
    const f = mount({ state: { ...state, policy: null } })
    expect(screen.getByText(en.policyMissing)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.newTask }))
    expect(screen.queryByLabelText(en.newTaskObjective)).toBeNull()
    expect(f.newTask).not.toHaveBeenCalled()
    f.rerender(<RgStatus {...f.props} canNewTask={false} canRecheck={false} />)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.newTask }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.recheck }).disabled).toBe(true)
  })

  it('does not offer parent task actions in worker and reviewer sessions', () => {
    const state = rgState()
    mount({ state: { ...state, role: 'worker', task: null } })
    expect(screen.getByText(en.worker, { selector: 'dd' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: en.newTask })).toBeNull()
    expect(screen.queryByRole('button', { name: en.recheck })).toBeNull()
  })

  it('submits a trimmed explicit objective once and waits for the authoritative projection', async () => {
    const f = mount()
    const pending = Promise.withResolvers<undefined>()
    onTestFinished(() => { pending.resolve(undefined) })
    f.newTask.mockReturnValueOnce(pending.promise)
    fireEvent.click(screen.getByRole('button', { name: en.newTask }))
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.confirmNewTask }).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(en.newTaskObjective), { target: { value: '  New objective  ' } })
    fireEvent.click(screen.getByRole('button', { name: en.confirmNewTask }))
    fireEvent.click(screen.getByRole('button', { name: en.confirmNewTask }))
    expect(f.newTask).toHaveBeenCalledOnce()
    expect(f.newTask.mock.calls[0]?.[0]).toBe('New objective')
    expect(screen.getByText('Repair the requested output', { selector: 'summary span' })).toBeTruthy()
    await act(async () => { pending.resolve(undefined); await pending.promise })
    expect(screen.queryByLabelText(en.newTaskObjective)).toBeNull()
    expect(screen.getByText('Repair the requested output', { selector: 'summary span' })).toBeTruthy()
  })

  it('retains the typed objective and reports uncertainty after a failed task action', async () => {
    const f = mount()
    f.newTask.mockRejectedValueOnce(new Error('lost response'))
    fireEvent.click(screen.getByRole('button', { name: en.newTask }))
    fireEvent.change(screen.getByLabelText(en.newTaskObjective), { target: { value: 'Keep this draft' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.confirmNewTask })) })
    expect(screen.getByRole('alert').textContent).toBe(en.actionFailed)
    expect(screen.getByLabelText<HTMLInputElement>(en.newTaskObjective).value).toBe('Keep this draft')
  })

  it('passes cancellation to recheck and suppresses a late response after unmount', async () => {
    const f = mount()
    const pending = Promise.withResolvers<undefined>()
    onTestFinished(() => { pending.resolve(undefined) })
    f.recheck.mockReturnValueOnce(pending.promise)
    fireEvent.click(screen.getByRole('button', { name: en.recheck }))
    expect(f.recheck).toHaveBeenCalledOnce()
    const signal = f.recheck.mock.calls[0]![0]
    expect(signal.aborted).toBe(false)
    f.unmount()
    expect(signal.aborted).toBe(true)
    await act(async () => { pending.reject(new Error('late response')); await expect(pending.promise).rejects.toThrow('late response') })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('localizes unconfirmed task and role saves with recovery guidance', () => {
    const state = rgState()
    const taskDiagnostic = 'RG_TASK_SAVE_UNCERTAIN: the task may not be saved'
    const f = mount({ state: { ...state, diagnostic: taskDiagnostic }, t: makeTranslate(zh) })
    expect(screen.getByText('新任务或其消息可能未保存。请检查会话和工作区，然后新建 RG 会话再继续。')).toBeTruthy()
    expect(screen.queryByText(taskDiagnostic)).toBeNull()
    f.rerender(<RgStatus {...f.props} state={{ ...state, diagnostic: 'RG_RESULT_SAVE_FAILED: saving failed' }} />)
    expect(screen.getByText('角色结果未能可靠保存。请检查会话和工作区，然后新建 RG 会话再继续。')).toBeTruthy()
  })

  it('renders worker evidence and independent persistence and run diagnostics', () => {
    const state = rgState()
    const review = reviewRun()
    const worker = { ...review, role: 'worker' as const, diagnostic: 'Worker validation is incomplete', scope: null,
      report: { kind: 'worker' as const, outcome: 'partial' as const, summary: 'Applied a bounded change', changes: ['Updated the parser'],
        validation: ['Ran the targeted test'], unverified: ['Full integration remains unverified'] } }
    mount({ model: undefined, state: { ...state, diagnostic: 'The persisted result cannot be trusted',
      task: { ...state.task!, active: null, reviewStatus: 'inconclusive', lastWorker: worker,
        lastReview: { ...review, report: null, diagnostic: 'Review could not complete' } } } })
    for (const text of ['The persisted result cannot be trusted', 'Worker validation is incomplete', 'Review could not complete', en.notRequested]) expect(screen.getByText(text)).toBeTruthy()
    expect(screen.queryByText('Applied a bounded change')).toBeNull()
    expect(screen.queryByText(en.report)).toBeNull()
    expect(screen.queryByText(en.reviewNote)).toBeNull()
  })

  it('shows the newest worker report after rework and its outcome and changes', () => {
    const state = rgState()
    const review = reviewRun()
    const worker = { ...review, role: 'worker' as const, workRevision: 4, scope: null,
      report: { kind: 'worker' as const, outcome: 'partial' as const, summary: 'Repaired output', changes: ['Updated parser'],
        validation: ['Focused tests'], unverified: ['Integration'] } }
    mount({ state: { ...state, task: { ...state.task!, workRevision: 4, lastWorker: worker, reviewStatus: 'stale' } } })
    for (const text of ['Repaired output', 'Updated parser', 'Focused tests', 'Integration', 'Partial']) expect(screen.getByText(text)).toBeTruthy()
    expect(screen.queryByText('Inspected the requested change')).toBeNull()
  })

  it.each(['completed', 'partial', 'blocked'] as const)('localizes the worker %s outcome', (outcome) => {
    const state = rgState()
    const worker = { ...reviewRun(), role: 'worker' as const, workRevision: 4, scope: null,
      report: { kind: 'worker' as const, outcome, summary: 'Worker result', changes: [], validation: [], unverified: [] } }
    mount({ state: { ...state, task: { ...state.task!, workRevision: 4, lastWorker: worker } }, t: makeTranslate(zh) })
    expect(screen.getByText(zh.outcome)).toBeTruthy()
    expect(screen.getByText(zh[outcome])).toBeTruthy()
    expect(screen.getByText(zh.changes)).toBeTruthy()
  })

  it('does not resurrect a task editor after switching tasks away and back', () => {
    const state = rgState()
    const f = mount()
    fireEvent.click(screen.getByRole('button', { name: en.newTask }))
    fireEvent.change(screen.getByLabelText(en.newTaskObjective), { target: { value: 'Old draft' } })
    f.rerender(<RgStatus {...f.props} state={{ ...state, task: { ...state.task!, id: 'task-2' as NonNullable<typeof state.task>['id'] } }} />)
    expect(screen.queryByLabelText(en.newTaskObjective)).toBeNull()
    f.rerender(<RgStatus {...f.props} />)
    expect(screen.queryByLabelText(en.newTaskObjective)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.newTask }))
    expect(screen.getByLabelText<HTMLInputElement>(en.newTaskObjective).value).toBe('')
  })

  it('does not present a previous review when the latest worker attempt has no report', () => {
    const state = rgState()
    const worker = { ...reviewRun(), role: 'worker' as const, workRevision: 4, scope: null, report: null }
    mount({ state: { ...state, task: { ...state.task!, workRevision: 4, lastWorker: worker } } })
    expect(screen.queryByText(en.report)).toBeNull()
    expect(screen.queryByText('Inspected the requested change')).toBeNull()
  })

  it.each(['not-reviewed', 'reviewing', 'changes-requested', 'inconclusive', 'stale'] as const)(
    'does not offer an ineffective recheck for %s', (reviewStatus) => {
      const state = rgState()
      mount({ state: { ...state, task: { ...state.task!, reviewStatus } } })
      expect(screen.queryByRole('button', { name: en.recheck })).toBeNull()
    })

  it('cancels a draft and rejects an empty or newly unauthorized implicit submission', () => {
    const f = mount()
    fireEvent.click(screen.getByRole('button', { name: en.newTask }))
    const input = screen.getByLabelText(en.newTaskObjective)
    const form = input.closest('form')!
    fireEvent.submit(form)
    expect(f.newTask).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: 'Do not submit after access changes' } })
    f.rerender(<RgStatus {...f.props} canNewTask={false} />)
    fireEvent.submit(form)
    expect(f.newTask).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: en.cancel }))
    expect(screen.queryByLabelText(en.newTaskObjective)).toBeNull()
  })

  it('admits only one recheck when two gestures arrive before React commits pending state', async () => {
    const f = mount()
    const pending = Promise.withResolvers<undefined>()
    onTestFinished(() => { pending.resolve(undefined) })
    f.recheck.mockReturnValueOnce(pending.promise)
    const button = screen.getByRole('button', { name: en.recheck })
    act(() => { fireEvent.click(button); fireEvent.click(button) })
    expect(f.recheck).toHaveBeenCalledOnce()
    await act(async () => { pending.resolve(undefined); await pending.promise })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.recheck }).disabled).toBe(false)
  })

  it('ignores a successful action response that arrives after its view unmounts', async () => {
    const f = mount()
    const pending = Promise.withResolvers<undefined>()
    onTestFinished(() => { pending.resolve(undefined) })
    f.recheck.mockReturnValueOnce(pending.promise)
    fireEvent.click(screen.getByRole('button', { name: en.recheck }))
    const signal = f.recheck.mock.calls[0]![0]
    f.unmount()
    expect(signal.aborted).toBe(true)
    await act(async () => { pending.resolve(undefined); await pending.promise })
    expect(screen.queryByRole('alert')).toBeNull()
  })
})


describe('explicit local Git delivery', () => {
  it('starts with an empty scope and sends only an explicit human confirmation once', async () => {
    const f = mount({ state: freshRgState() })
    const pending = Promise.withResolvers<undefined>()
    onTestFinished(() => { pending.resolve(undefined) })
    f.authorizeLocalGit.mockReturnValueOnce(pending.promise)
    expect(screen.queryByLabelText(en.gitScope)).toBeNull()
    expect(f.authorizeLocalGit).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: en.localGit }))
    const input = screen.getByLabelText<HTMLTextAreaElement>(en.gitScope)
    expect(input.value).toBe('')
    for (const hint of [en.gitScopeHint, en.gitDeliveryHint, en.gitTrustHint]) expect(screen.getByText(hint)).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.authorizeLocalGit }).disabled).toBe(true)
    fireEvent.submit(input.closest('form')!)
    expect(f.authorizeLocalGit).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: ' src/\n  \n docs/file.md \n' } })
    const submit = screen.getByRole('button', { name: en.authorizeLocalGit })
    act(() => { fireEvent.click(submit); fireEvent.click(submit) })
    expect(f.authorizeLocalGit).toHaveBeenCalledOnce()
    expect(f.authorizeLocalGit.mock.calls[0]?.[0]).toEqual(['src/', 'docs/file.md'])
    expect(f.authorizeLocalGit.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal)
    expect(screen.queryByText(en.gitAuthorized)).toBeNull()
    await act(async () => { pending.resolve(undefined); await pending.promise })
    expect(screen.queryByLabelText(en.gitScope)).toBeNull()
    expect(screen.queryByText(en.gitAuthorized)).toBeNull()
  })

  it('retains the scope draft on refusal and stops newly unauthorized form submission', async () => {
    const f = mount({ state: freshRgState() })
    f.authorizeLocalGit.mockRejectedValueOnce(new Error('authorization response lost'))
    fireEvent.click(screen.getByRole('button', { name: en.localGit }))
    const input = screen.getByLabelText<HTMLTextAreaElement>(en.gitScope)
    fireEvent.change(input, { target: { value: '.' } })
    await act(async () => { fireEvent.submit(input.closest('form')!) })
    expect(screen.getByRole('alert').textContent).toBe(en.actionFailed)
    expect(input.value).toBe('.')
    f.rerender(<RgStatus {...f.props} canAuthorizeLocalGit={false} />)
    fireEvent.submit(input.closest('form')!)
    expect(f.authorizeLocalGit).toHaveBeenCalledOnce()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.authorizeLocalGit }).disabled).toBe(true)
  })

  it('clears a cancelled scope and keeps task and authorization editors mutually exclusive', () => {
    mount({ state: freshRgState() })
    fireEvent.click(screen.getByRole('button', { name: en.localGit }))
    fireEvent.change(screen.getByLabelText(en.gitScope), { target: { value: 'src/' } })
    fireEvent.click(screen.getByRole('button', { name: en.cancel }))
    fireEvent.click(screen.getByRole('button', { name: en.localGit }))
    expect(screen.getByLabelText<HTMLTextAreaElement>(en.gitScope).value).toBe('')
    fireEvent.click(screen.getByRole('button', { name: en.localGit }))
    expect(screen.queryByLabelText(en.gitScope)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.newTask }))
    expect(screen.getByLabelText(en.newTaskObjective)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.localGit }))
    expect(screen.queryByLabelText(en.newTaskObjective)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.newTask }))
    expect(screen.queryByLabelText(en.gitScope)).toBeNull()
  })

  it.each(['busy', 'active', 'policy', 'access'] as const)('blocks authorization while %s prevents admission', (kind) => {
    const state = freshRgState()
    const f = mount({ state: kind === 'policy' ? { ...state, policy: null }
      : kind === 'active' ? { ...state, task: { ...state.task!, active: reviewRun() } } : state,
    busy: kind === 'busy', canAuthorizeLocalGit: kind !== 'access' })
    const button = screen.getByRole<HTMLButtonElement>('button', { name: en.localGit })
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(screen.queryByLabelText(en.gitScope)).toBeNull()
    expect(f.authorizeLocalGit).not.toHaveBeenCalled()
  })

  it.each(['worker-budget', 'review-budget', 'no-task', 'worker', 'reviewer', 'authorized'] as const)(
    'does not offer fresh authorization for %s', (kind) => {
      const state = freshRgState()
      mount({ state: kind === 'no-task' ? { ...state, task: null }
        : kind === 'worker' || kind === 'reviewer' ? { ...state, role: kind }
          : { ...state, task: { ...state.task!, workerAttempts: kind === 'worker-budget' ? 1 : 0,
            reviewAttempts: kind === 'review-budget' ? 1 : 0 } }, git: kind === 'authorized' ? gitState() : null })
      expect(screen.queryByRole('button', { name: en.localGit })).toBeNull()
    })

  it('renders committed candidate facts and worker validation claims separately from review status', () => {
    const git = candidateGitState()
    const f = mount({ git })
    for (const text of [en.gitCandidateReady, '/work', 'main', '/work/.agents/worktrees/task', 'task', 'candidate-1',
      'c'.repeat(40), 'd'.repeat(40), 'Worker reports focused tests passed', en.gitValidation, en.reportedPass]) {
      expect(screen.getByText(text)).toBeTruthy()
    }
    f.rerender(<RgStatus {...f.props} git={{ ...git, status: 'unknown', diagnostic: 'Inspect retained task checkout before retrying',
      source: { ...git.source, branch: null }, workspace: { ...git.workspace!, branch: null } }} />)
    expect(screen.getAllByText(en.gitDetached)).toHaveLength(2)
    expect(screen.getByText(en.gitUnknown)).toBeTruthy()
    expect(screen.getByRole('status').textContent).toBe('Inspect retained task checkout before retrying')
    expect(screen.getByText('candidate-1')).toBeTruthy()
    expect(screen.getByText(en.reportedPass)).toBeTruthy()
  })

  it('keeps a committed authorization visible when its response fails', async () => {
    const f = mount({ state: freshRgState() })
    const pending = Promise.withResolvers<undefined>()
    onTestFinished(() => { pending.resolve(undefined) })
    f.authorizeLocalGit.mockReturnValueOnce(pending.promise)
    fireEvent.click(screen.getByRole('button', { name: en.localGit }))
    fireEvent.change(screen.getByLabelText(en.gitScope), { target: { value: 'src/' } })
    fireEvent.click(screen.getByRole('button', { name: en.authorizeLocalGit }))
    f.rerender(<RgStatus {...f.props} git={gitState()} />)
    await act(async () => { pending.reject(new Error('committed but response lost')); await expect(pending.promise).rejects.toThrow('response lost') })
    expect(screen.getByText(en.gitAuthorized)).toBeTruthy()
    expect(screen.getByText('/work')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toBe(en.actionFailed)
  })
})


describe('acknowledging retained local delivery', () => {
  it.each(['failed', 'interrupted', 'unknown'] as const)('requires an explicit acknowledgement to leave %s artifacts intact', async (status) => {
    const f = mount({ git: { ...candidateGitState(), status } })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.newTask }).disabled).toBe(true)
    const pending = Promise.withResolvers<undefined>()
    onTestFinished(() => { pending.resolve(undefined) })
    f.leaveLocalGit.mockReturnValueOnce(pending.promise)
    fireEvent.click(screen.getByRole('button', { name: en.leaveLocalGit }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByText(en.leaveGitHint)).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.confirmLeaveLocalGit }).disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: en.leaveGitAcknowledgement }))
    fireEvent.click(screen.getByRole('button', { name: en.confirmLeaveLocalGit }))
    expect(f.leaveLocalGit).toHaveBeenCalledOnce()
    expect(f.leaveLocalGit.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByText('candidate-1')).toBeTruthy()
    expect(screen.getByText(en.reportedPass)).toBeTruthy()
    expect(screen.getByText(new RegExp('Worker attempts 1/2'))).toBeTruthy()
    await act(async () => { pending.resolve(undefined); await pending.promise })
    expect(screen.getByText('candidate-1')).toBeTruthy()
  })

  it('resets acknowledgement on cancel and keeps access and running-state restrictions', () => {
    const f = mount({ git: gitState() })
    fireEvent.click(screen.getByRole('button', { name: en.leaveLocalGit }))
    fireEvent.click(screen.getByRole('checkbox', { name: en.leaveGitAcknowledgement }))
    fireEvent.click(screen.getByRole('button', { name: en.cancel }))
    expect(f.leaveLocalGit).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: en.leaveLocalGit }))
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: en.leaveGitAcknowledgement }).checked).toBe(false)
    fireEvent.click(screen.getByRole('checkbox', { name: en.leaveGitAcknowledgement }))
    f.rerender(<RgStatus {...f.props} canLeaveLocalGit={false} />)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.confirmLeaveLocalGit }).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: en.close }))
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.leaveLocalGit }).disabled).toBe(true)
    f.rerender(<RgStatus {...f.props} busy />)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.leaveLocalGit }).disabled).toBe(true)
    f.rerender(<RgStatus {...f.props} state={{ ...f.props.state, role: 'reviewer' }} />)
    expect(screen.queryByRole('button', { name: en.leaveLocalGit })).toBeNull()
  })

  it('allows an idle owner to withdraw the grant even when the model policy is unavailable', async () => {
    const f = mount({ git: gitState(), state: { ...rgState(), policy: null } })
    fireEvent.click(screen.getByRole('button', { name: en.leaveLocalGit }))
    fireEvent.click(screen.getByRole('checkbox', { name: en.leaveGitAcknowledgement }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.confirmLeaveLocalGit })) })
    expect(f.leaveLocalGit).toHaveBeenCalledOnce()
    expect(screen.getByText(en.gitAuthorized)).toBeTruthy()
    expect(screen.getByText(en.policyMissing)).toBeTruthy()
  })
})
