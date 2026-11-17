// @vitest-environment jsdom
/** The composer shows one task button and only actionable or current status. */
import type { ComponentProps } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RgTaskEntry } from '../src/client/RgTaskEntry.tsx'
import { en } from '../src/client/locales.ts'
import { gitState, rgState, reviewRun } from './task-fixture.client.ts'
import type { RgView } from '../src/types.ts'

afterEach(cleanup)
type Props = ComponentProps<typeof RgTaskEntry>
const copy: ReadonlyMap<string, string> = new Map(Object.entries(en))
const ready = (): RgView => ({ status: 'ready', state: rgState(), git: null, claim: null })
const claim = (phase: NonNullable<RgView['claim']>['phase']): NonNullable<RgView['claim']> =>
  ({ phase, text: 'raw input only for recovery', truncated: true, otherContent: true })

function mount(overrides: Partial<Props> = {}) {
  const openSidebar = vi.fn()
  render(<RgTaskEntry view={ready()} busy={false} git={null} reviewStatus="reported-pass"
    t={key => copy.get(key) ?? key} openSidebar={openSidebar} {...overrides} />)
  return openSidebar
}

describe('compact RG task entry', () => {
  it('uses a named button and omits completed task facts and raw recovery details', () => {
    const open = mount()
    const button = screen.getByRole('button', { name: en.openTaskView })
    expect(button.textContent).toBe(en.taskButton)
    fireEvent.click(button)
    expect(open).toHaveBeenCalledOnce()
    expect(screen.getByRole('status').textContent).toBe('')
    for (const text of [en.reportedPass, en.noTask, 'frozen-policy', en.workerBudget, en.claimPending]) {
      expect(screen.queryByText(text)).toBeNull()
    }
    expect(document.querySelector('details')).toBeNull()
  })

  it('does not add a no-task empty state above the composer', () => {
    const view = ready()
    mount({ view: { ...view, state: { ...view.state!, task: null } } })
    expect(screen.getByRole('status').textContent).toBe('')
    expect(screen.queryByText(en.noTask)).toBeNull()
  })

  it.each(['unsettled', 'entered'] as const)('collapses normal %s saving into one processing status', (phase) => {
    mount({ view: { ...ready(), status: 'saving', claim: claim(phase) }, busy: true })
    expect(screen.getByRole('status').textContent).toBe(en.entryProcessing)
    expect(screen.queryByText(en.saving)).toBeNull()
    expect(screen.queryByText(en.claimPending)).toBeNull()
    expect(screen.queryByText('raw input only for recovery')).toBeNull()
    expect(document.querySelector('details')).toBeNull()
  })

  it.each(['rejected', 'empty'] as const)('keeps a %s input failure visible without exposing recovery records', (phase) => {
    mount({ view: { ...ready(), status: 'saving', claim: claim(phase) }, busy: true })
    expect(screen.getByRole('status').textContent).toBe(en.entryInputNotEntered)
    expect(screen.getByRole('status').getAttribute('data-warning')).toBe('true')
    expect(screen.queryByText('raw input only for recovery')).toBeNull()
    expect(screen.getByRole('button', { name: en.openTaskView })).toBeTruthy()
  })

  it.each([undefined, { ...ready(), status: 'unknown' } as const])('keeps uncertain status visible and navigation available', (view) => {
    mount({ view })
    expect(screen.getByRole('status').textContent).toBe(en.entryUnavailable)
    expect(screen.getByRole('button', { name: en.openTaskView })).toBeTruthy()
  })

  it('does not show an inactive unresolved claim as ordinary processing', () => {
    mount({ view: { ...ready(), claim: claim('unsettled') } })
    expect(screen.getByRole('status').textContent).toBe(en.entryInputUnconfirmed)
  })

  it.each(['worker', 'reviewer'] as const)('names the active %s work without duplicating review feedback', (role) => {
    const view = ready()
    mount({ view: { ...view, state: { ...view.state!, task: { ...view.state!.task!, active: { ...reviewRun(), role, status: 'running' } } } },
      busy: true, reviewStatus: 'stale' })
    expect(screen.getByRole('status').textContent).toBe(role === 'worker' ? en.entryWorking : en.reviewing)
  })

  it.each(['reserved', 'saving', 'completed', 'failed', 'cancelled', 'interrupted'] as const)('renders active %s without raw details', (status) => {
    const view = ready()
    mount({ view: { ...view, state: { ...view.state!, task: { ...view.state!.task!, active: { ...reviewRun(), status } } } } })
    const label = status === 'reserved' ? en.reserved
      : status === 'saving' || status === 'completed' ? en.entryConfirming : en[status]
    expect(screen.getByRole('status').textContent).toBe(label)
  })

  it.each(['stale', 'changes-requested', 'inconclusive'] as const)('retains %s review feedback when no role is running', (reviewStatus) => {
    const view = ready()
    mount({ reviewStatus, view: { ...view, state: { ...view.state!, task: { ...view.state!.task!, reviewAttempts: 1 } } } })
    const labels = { stale: en.stale, 'changes-requested': en.changesRequested, inconclusive: en.inconclusive }
    expect(screen.getByRole('status').textContent).toBe(labels[reviewStatus])
  })

  it('prioritizes a human-decision warning when independent review is exhausted', () => {
    mount({ reviewStatus: 'inconclusive' })
    expect(screen.getByRole('status').textContent).toBe(en.entryReviewBudgetExhausted)
  })

  it('directs missing policy to setup instead of printing the complete policy diagnostic', () => {
    const view = ready()
    mount({ view: { ...view, state: { ...view.state!, policy: null } } })
    expect(screen.getByRole('status').textContent).toBe(en.entryNeedsConfiguration)
  })

  it.each(['parent', 'worker', 'reviewer', 'git'] as const)('keeps an uncertain %s outcome visible as one safe-next-step warning', (source) => {
    const view = ready()
    const state = view.state!
    const diagnostic = 'RG_RESULT_SAVE_FAILED: internal transport diagnostic'
    mount({ view: { ...view, state: { ...state, diagnostic: source === 'parent' ? diagnostic : null, task: { ...state.task!,
      lastWorker: source === 'worker' ? { ...reviewRun(), role: 'worker', diagnostic } : null,
      lastReview: source === 'reviewer' ? { ...reviewRun(), diagnostic } : state.task!.lastReview } } },
    git: source === 'git' ? { ...gitState(), status: 'unknown' } : null })
    expect(screen.getByRole('status').textContent).toBe(en.entryOutcomeUncertain)
    expect(screen.queryByText(diagnostic)).toBeNull()
  })
})
