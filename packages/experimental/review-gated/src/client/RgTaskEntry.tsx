/** Compact RG composer entry; recovery details remain in the task view. */
import { Button, IconBranchOutlineRegular, StateDot, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { RgGitState } from '../git-types.ts'
import type { RgTask } from '../types.ts'
import type { RgLocaleKey } from './locales.ts'
import type { RgView } from './view.ts'
import type {} from './index.ts'
import css from './rg.module.css'
import { reviewWorkflow } from '../review-workflow.ts'

interface EntryProps extends PropsLocale<'review-gated'> {
  readonly view: RgView | undefined
  readonly busy: boolean
  readonly git: RgGitState | null
  readonly reviewStatus: RgTask['reviewStatus'] | undefined
  readonly openSidebar: () => void
}

interface Feedback {
  readonly label: RgLocaleKey
  readonly state: StateDotState
  readonly warning: boolean
}

function feedback({ view, busy, git, reviewStatus }: EntryProps): Feedback | null {
  const warning = (label: RgLocaleKey): Feedback => ({ label, state: 'warning', warning: true })
  const ongoing = (label: RgLocaleKey): Feedback => ({ label, state: 'ongoing', warning: false })
  if (view === undefined || view.status === 'unknown') return warning('entryUnavailable')
  if (view.claim?.phase === 'rejected' || view.claim?.phase === 'empty') return warning('entryInputNotEntered')
  if (view.status === 'saving') return ongoing('entryProcessing')
  const state = view.state
  if (state === null) return warning('entryUnavailable')
  if (state.policy === null) return warning('entryNeedsConfiguration')
  if (state.diagnostic !== null || state.task?.lastWorker?.diagnostic != null || state.task?.lastReview?.diagnostic != null
    || git !== null && ['unknown', 'interrupted', 'failed'].includes(git.status)) return warning('entryOutcomeUncertain')
  if (!busy && view.claim !== null) return warning('entryInputUnconfirmed')
  const workflow = state.task === null ? null
    : reviewWorkflow({ ...state.task, reviewStatus: reviewStatus ?? state.task.reviewStatus }, state.policy)
  if (workflow?.needsHumanDecision) {
    return warning('entryReviewBudgetExhausted')
  }
  const active = state.task?.active
  if (active != null) {
    if (active.status === 'running') return ongoing(active.role === 'reviewer' ? 'reviewing' : 'entryWorking')
    if (active.status === 'failed' || active.status === 'cancelled' || active.status === 'interrupted') return warning(active.status)
    return ongoing(active.status === 'reserved' ? 'reserved' : 'entryConfirming')
  }
  if (reviewStatus === 'stale' || reviewStatus === 'changes-requested' || reviewStatus === 'inconclusive') {
    const labels = { stale: 'stale', 'changes-requested': 'changesRequested', inconclusive: 'inconclusive' } as const
    return warning(labels[reviewStatus])
  }
  return busy ? ongoing('entryProcessing') : null
}

/**
 * Render one explicit task button and at most one relevant status, without raw recovery records.
 * @param props - Confirmed RG view, parent activity, and session-addressed navigation.
 * @returns The compact composer row.
 */
export function RgTaskEntry(props: EntryProps) {
  const status = feedback(props)
  return <div className={css.taskEntry} data-rg-entry>
    <Button variant="outline" size="sm" className={css.taskButton} aria-label={props.t('openTaskView')}
      icon={<IconBranchOutlineRegular size={16} />} onClick={props.openSidebar}>{props.t('taskButton')}</Button>
    <span className={css.entryStatus} role="status" data-warning={status?.warning || undefined}>
      {status === null ? null : <><StateDot state={status.state} /><span>{props.t(status.label)}</span></>}
    </span>
  </div>
}
