/** Compact RG task facts derived from durable projections, never from model prose. */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Button, IconBranchOutlineRegular, IconChevronDownOutlineRegular, RiskConfirmation, SegmentedTabs, StateDot, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { ModelSelectionProjection } from '@deepseek-ai/dsh-agent/types'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { RgGitState } from '../git-types.ts'
import type { RgModel, RgRun, RgSessionState, RgTask } from '../types.ts'
import type { RgLocaleKey } from './locales.ts'
import type { RgView } from './view.ts'
import type {} from './index.ts'
import css from './rg.module.css'
import { RgTaskEntry } from './RgTaskEntry.tsx'
import { RgRecoveryNotice } from './RgRecoveryNotice.tsx'
import { reviewWorkflow } from '../review-workflow.ts'
import { resolveRoleLayout, type RgRoleLayout } from './role-layout.ts'

/** Session-addressed actions; newTask and leaveLocalGit cannot cancel a Host mutation already dispatched. */
export interface RgDockFace {
  readonly hooks: { readonly rgConnection: HostObservable<number>; readonly rgSidebarAvailable: HostObservable<boolean> }
  readonly openSidebar: () => void
  readonly watchView: (carrierFailed: () => void) =>
    AsyncIterable<{ readonly value: RgView; accept(): void }> & { dispose(): Promise<void> }
  readonly newTask: (objective: string, signal: AbortSignal) => Promise<void>
  readonly recheck: (signal: AbortSignal) => Promise<void>
  readonly authorizeLocalGit: (scope: readonly string[], signal: AbortSignal) => Promise<void>
  readonly leaveLocalGit: (signal: AbortSignal) => Promise<void>
}
/** Framework-provided session projections and localized task controls. */
export type RgDockProps = PropsRuntime<'conversation.input.dock'> & PropsLocale<'review-gated'> & InjectFace<RgDockFace>
/** Browser-local layout choice added only to the sidebar registration. */
export interface RgSidebarFace extends RgDockFace {
  readonly hooks: RgDockFace['hooks'] & { readonly rgRoleLayout: HostObservable<RgRoleLayout> }
  readonly setRoleLayout: (layout: RgRoleLayout) => void
}
type RgSidebarProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'review-gated'> & InjectFace<RgSidebarFace>
type StatusProps = PropsLocale<'review-gated'> & Pick<RgDockFace, 'newTask' | 'recheck' | 'authorizeLocalGit' | 'leaveLocalGit'> & {
  canNewTask: boolean
  canRecheck: boolean
  canAuthorizeLocalGit: boolean
  canLeaveLocalGit: boolean
  git: RgGitState | null
  state: RgSessionState
  model: ModelSelectionProjection | undefined
  roleModel: ModelSelectionProjection | undefined
  busy: boolean
  sidebar?: boolean
  roleLayout?: RgRoleLayout
  runModels?: Readonly<Record<string, ModelSelectionProjection | undefined>>
  /** Host-confirmed lifecycle state; absent evidence is never treated as ready. */
  trust?: 'ready' | 'saving' | 'unknown'
}
const REVIEW_LABELS = { 'not-reviewed': 'notReviewed', reviewing: 'reviewing', 'reported-pass': 'reportedPass',
  'changes-requested': 'changesRequested', inconclusive: 'inconclusive', stale: 'stale' } as const satisfies Record<string, RgLocaleKey>

const GIT_LABELS = { authorized: 'gitAuthorized', preparing: 'gitPreparing', working: 'gitWorking', finalizing: 'gitFinalizing',
  candidate: 'gitCandidateReady', reviewing: 'reviewing', interrupted: 'interrupted', unknown: 'gitUnknown', failed: 'failed',
} as const satisfies Record<RgGitState['status'], RgLocaleKey>

function effectiveReviewStatus(task: RgTask | null, git: RgGitState | null): RgTask['reviewStatus'] | undefined {
  const review = task?.lastReview
  const gitEvidence = git?.status === 'candidate' && git.candidate !== null && git.binding?.role === 'reviewer'
    && git.binding.runId === review?.id && git.binding.candidateId === git.candidate.id && git.binding.checkout !== null
  return task?.reviewStatus === 'reported-pass' && review?.scope == null && !gitEvidence ? 'stale' : task?.reviewStatus
}

const RUN_DOTS: Record<RgRun['status'], StateDotState> = {
  reserved: 'ongoing', running: 'ongoing', saving: 'ongoing', completed: 'done',
  failed: 'error', cancelled: 'warning', interrupted: 'warning',
}

function RgDetails({ label, children }: { label: string; children: ReactNode }) {
  const [expanded, setExpanded] = useState(false)
  const id = useId()
  return <div className={css.additionalDetails}>
    <Button variant="outline" size="sm" className={css.detailsButton} aria-expanded={expanded} aria-controls={id}
      icon={<IconChevronDownOutlineRegular size={16} className={css.detailsIcon} />}
      onClick={() => { setExpanded(value => !value) }}>{label}</Button>
    <div id={id} className={css.detailsPanel} hidden={!expanded} role="region" aria-label={label}>{children}</div>
  </div>
}

function modelLabel(model: RgModel): string {
  return model.provider + '/' + model.model + (model.reasoningEffort === undefined ? '' : ' · ' + model.reasoningEffort)
}

/**
 * Render the current task and independently identified review result.
 * @param props - projection facts, access decisions, and Session-addressed Host callbacks.
 * @returns The task view, or a compact notice while Host state is unconfirmed.
 */
export function RgStatus(props: StatusProps) {
  if (props.trust !== 'ready') return <RgRecoveryNotice status={props.trust ?? 'unknown'} claim={null} t={props.t} />
  return <RgReadyStatus {...props} />
}

function RgReadyStatus({ state, git, model, roleModel, busy, canNewTask, canRecheck, canAuthorizeLocalGit,
  canLeaveLocalGit, newTask, recheck, authorizeLocalGit, leaveLocalGit, sidebar, roleLayout = 'classic', runModels, t }: StatusProps) {
  const [editing, setEditing] = useState(false)
  const taskFormId = useId()
  const gitFormId = useId()
  const [editorTask, setEditorTask] = useState<string | null | undefined>(undefined)
  const [objective, setObjective] = useState('')
  const [authorizing, setAuthorizing] = useState(false)
  const [authorizationTask, setAuthorizationTask] = useState<string | null | undefined>(undefined)
  const [scopeDraft, setScopeDraft] = useState('')
  const [leaving, setLeaving] = useState(false)
  const [leaveAcknowledged, setLeaveAcknowledged] = useState(false)
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const operation = useRef<AbortController | null>(null)
  const taskForm = useRef<HTMLFormElement>(null)
  const authorizationForm = useRef<HTMLFormElement>(null)
  useEffect(() => () => { operation.current?.abort() }, [])
  const task = state.task
  const policy = state.policy
  const stateDiagnostic = state.diagnostic?.startsWith('RG_TASK_SAVE_UNCERTAIN:') ? t('taskSaveUncertain')
    : state.diagnostic?.startsWith('RG_RESULT_SAVE_FAILED:') ? t('resultSaveFailed') : state.diagnostic
  const active = task?.active
  const worker = task?.lastWorker
  const review = task?.lastReview
  const latest = review == null ? worker : worker == null || review.workRevision >= worker.workRevision ? review : worker
  const report = active == null ? latest?.report : null
  const taskId = task?.id ?? null
  useEffect(() => {
    const form = editing && editorTask === taskId ? taskForm.current
      : authorizing && authorizationTask === taskId ? authorizationForm.current : null
    form?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [editing, editorTask, authorizing, authorizationTask, taskId])
  const [formTask, setFormTask] = useState(taskId)
  if (formTask !== taskId) {
    setFormTask(taskId)
    setEditing(false)
    setObjective('')
    setAuthorizing(false)
    setScopeDraft('')
    setLeaving(false)
    setLeaveAcknowledged(false)
  }
  const latestModel = active === null || active === undefined ? model : roleModel
  const gitEligible = state.role === 'main' && task !== null && task.workerAttempts === 0 && task.reviewAttempts === 0 && git === null
  const requestedScope = scopeDraft.split('\n').map(path => path.trim()).filter(path => path !== '')
  const operationBlocked = busy || pending || active !== null && active !== undefined
  const actionBlocked = operationBlocked || policy === null
  const taskBlocked = actionBlocked || git !== null && ['unknown', 'interrupted', 'failed'].includes(git.status)
  const run = async (action: (signal: AbortSignal) => Promise<void>, blocked: boolean): Promise<void> => {
    if (operation.current !== null || blocked) return
    const controller = new AbortController()
    operation.current = controller
    setPending(true)
    setFailed(false)
    try {
      await action(controller.signal)
      if (!controller.signal.aborted) { setEditing(false); setObjective(''); setAuthorizing(false); setScopeDraft('') }
    } catch (_error) {
      // A failed response may follow a committed mutation; the projection remains authoritative.
      if (!controller.signal.aborted) setFailed(true)
    } finally {
      operation.current = null
      if (!controller.signal.aborted) setPending(false)
    }
  }
  const reviewStatus = effectiveReviewStatus(task, git)
  const status = active === null || active === undefined
    ? reviewStatus === undefined ? null : REVIEW_LABELS[reviewStatus]
    : active.status
  const runs = [active, worker, review].filter((run, index, all) => run != null && all.findIndex(item => item?.id === run.id) === index)
  const classic = roleLayout === 'classic'
  const mainCurrent = active == null
  const mainState = active != null || !busy ? 'idle' : 'ongoing'
  const mainModels = <>
    <p>{t('actualModel')}: {model?.lastUsed == null ? t('notRequested') : modelLabel(model.lastUsed)}</p>
    {model?.next == null ? null : <p>{t('nextModel')}: {modelLabel(model.next)}</p>}
  </>
  const mainRoleCard = { current: mainCurrent, element: <article key="main" className={css.runCard}
    data-rg-role={state.role} data-current={mainCurrent} data-run-state={mainState}>
    {roleLayout === 'focus' && mainCurrent ? <IconBranchOutlineRegular size={72} className={css.focusMark} /> : null}
    <h3 className={css.heading}>{t(state.role)}</h3>
    <p className={css.runStatus}><StateDot state={mainState} />
      {t(active != null ? 'mainWaiting' : busy ? 'running' : 'idle')}</p>
    {classic ? mainModels : <RgDetails label={t('modelDetails')}>{mainModels}</RgDetails>}
  </article> }
  const retainedRuns = classic ? runs : [...runs.filter(run => run?.role === 'worker'), ...runs.filter(run => run?.role === 'reviewer')]
  const roleCards = [mainRoleCard, ...retainedRuns.flatMap((run) => {
    if (run == null) return []
    const current = run.id === active?.id
    const requested = runModels?.[run.childId]?.lastUsed ?? (current ? roleModel?.lastUsed : undefined)
    const modelFacts = <>
      <p>{t('activeModel')}: {modelLabel(run.selection)}</p>
      {requested == null ? null : <p>{t('actualModel')}: {modelLabel(requested)}</p>}
    </>
    return [{ current, element: <article className={css.runCard} key={run.id} data-rg-role={run.role}
      data-rg-run={run.id} data-child="true" data-current={current} data-run-state={RUN_DOTS[run.status]}>
      {roleLayout === 'focus' && current ? <IconBranchOutlineRegular size={72} className={css.focusMark} /> : null}
      <h3 className={css.heading}>{t(run.role)}{classic || !current
        ? <> · {t(current ? 'activeRun' : run.role === 'worker' ? 'lastWorker' : 'lastReview')}</> : null}</h3>
      <p className={css.runStatus}><StateDot state={RUN_DOTS[run.status]} />{t(run.status)}</p>
      {classic ? modelFacts : null}
      <RgDetails label={t('runDetails')}>
        {classic ? null : modelFacts}
        <p>{t('runId')}: {run.id}</p><p>{t('workRevision')}: {run.workRevision}</p>
      </RgDetails>
    </article> }]
  })]
  const orderedRoleCards = roleLayout === 'focus'
    ? [...roleCards.filter(card => card.current), ...roleCards.filter(card => !card.current)] : roleCards
  const facts = <dl className={css.facts}>
    <div className={css.fact}><dt>{t('role')}</dt><dd>{t(state.role)}</dd></div>
    {task === null ? null : <div className={css.fact}><dt>{t('taskObjective')}</dt><dd>{task.objective}</dd></div>}
    {policy === null ? null : <div className={css.fact}><dt>{t('configuration')}</dt><dd>{policy.configurationHash}</dd></div>}
    {task === null ? null : <div className={css.fact}><dt>{t('workRevision')}</dt><dd>{task.workRevision}</dd></div>}
    <div className={css.fact}><dt>{t('actualModel')}</dt><dd>{latestModel?.lastUsed == null ? t('notRequested') : modelLabel(latestModel.lastUsed)}</dd></div>
    {latestModel?.next == null ? null : <div className={css.fact}><dt>{t('nextModel')}</dt><dd>{modelLabel(latestModel.next)}</dd></div>}
    {active === null || active === undefined ? null : <div className={css.fact}><dt>{t('activeModel')}</dt><dd>{modelLabel(active.selection)}</dd></div>}
  </dl>
  const workflow = task === null || policy === null ? null
    : reviewWorkflow({ ...task, reviewStatus: reviewStatus ?? task.reviewStatus }, policy)
  const heading = <>
    <span className={css.status}>{t('title')}</span>
    <span className={css.summaryTitle}>{task?.objective ?? (state.role === 'main' ? t('noTask') : t(state.role))}</span>
    {status === null ? null : <span>{t(status)}</span>}
    {task === null || policy === null ? null : <span>{t('workerBudget')} {task.workerAttempts}/{policy.maxWorkerAttempts} · {t('reviewBudget')} {task.reviewAttempts}/{policy.maxReviewAttempts}</span>}
  </>
  const body = <div className={sidebar ? css.sidebarBody : css.dockBody} role="region" aria-label={t('details')} tabIndex={0}>
    {sidebar ? <section className={css.runList} data-layout={roleLayout} aria-label={t('roles')}>
      {orderedRoleCards.map(card => card.element)}
      <p className={css.notice}>{t('recentRunsHint')}</p>
    </section> : null}
    {policy === null ? <p className={css.error} role="status">{t('policyMissing')}</p> : null}
    {sidebar ? <RgDetails label={t('taskDetails')}>{facts}</RgDetails> : facts}
    {stateDiagnostic === null ? null : <p className={css.error} role="status">{stateDiagnostic}</p>}
    {task?.lastWorker?.diagnostic == null ? null : <p className={css.error}>{task.lastWorker.diagnostic}</p>}
    {task?.lastReview?.diagnostic == null ? null : <p className={css.error}>{task.lastReview.diagnostic}</p>}
    {workflow?.needsHumanDecision ? <p className={css.notice} role="status">{t('reviewBudgetExhausted')}</p>
      : workflow?.nextReviewIsLast && task?.active == null && reviewStatus !== 'reported-pass'
        ? <p className={css.notice}>{t('lastReviewAttemptHint')}</p> : null}
    {workflow?.evidenceIncomplete ? <p className={css.notice}>{t('reviewEvidenceIncomplete')}</p> : null}
    {report == null ? null : <section className={css.section}>
      <h3 className={css.heading}>{t('report')}</h3><p className={css.report}>{report.summary}</p>
      {report.kind === 'reviewer' ? <>
        <p className={css.notice}>{t('reviewNote')}</p>
        <div className={css.fact}><span>{t('scope')}</span><span>{report.inspectedScope.join(', ')}</span></div>
        {report.findings.map((finding, index) => <p className={css.report} key={index}>
          {finding.location}<br />{finding.impact}<br />{finding.evidence}</p>)}
      </> : <>
        <div className={css.fact}><span>{t('outcome')}</span><span>{t(report.outcome)}</span></div>
        <h4 className={css.heading}>{t('changes')}</h4>
        <ul className={css.reportList}>{report.changes.map((item, index) => <li key={index}>{item}</li>)}</ul>
      </>}
      <h4 className={css.heading}>{t('validation')}</h4>
      <ul className={css.reportList}>{report.validation.map((item, index) => <li key={index}>{item}</li>)}</ul>
      <h4 className={css.heading}>{t('unverified')}</h4>
      <ul className={css.reportList}>{report.unverified.map((item, index) => <li key={index}>{item}</li>)}</ul>
    </section>}
    {git === null ? null : <section className={css.section} aria-label={t('localGit')}>
      <h3 className={css.heading}>{t('localGit')}</h3>
      <p className={css.notice}>{t(GIT_LABELS[git.status])}</p>
      <dl className={css.facts}>
        <div className={css.fact}><dt>{t('gitSource')}</dt><dd>{git.source.root}</dd></div>
        <div className={css.fact}><dt>{t('gitSourceBranch')}</dt><dd>{git.source.branch ?? t('gitDetached')}</dd></div>
        <div className={css.fact}><dt>{t('gitBase')}</dt><dd>{git.source.headOid}</dd></div>
        <div className={css.fact}><dt>{t('gitScope')}</dt><dd>{git.scope.join(', ')}</dd></div>
        {git.workspace === null ? <div className={css.fact}><dt>{t('gitReservedCheckout')}</dt><dd>{git.worktreeName}</dd></div> : <>
          <div className={css.fact}><dt>{t('gitWorkspace')}</dt><dd>{git.workspace.root}</dd></div>
          <div className={css.fact}><dt>{t('gitWorkspaceBranch')}</dt><dd>{git.workspace.branch ?? t('gitDetached')}</dd></div>
        </>}
      </dl>
      {git.diagnostic === null ? null : <p className={css.error} role="status">{git.diagnostic}</p>}
      {git.candidate === null ? null : <div className={css.gitCandidate}>
        <h4 className={css.heading}>{t('gitCandidate')}</h4>
        <dl className={css.facts}>
          <div className={css.fact}><dt>{t('gitCandidateId')}</dt><dd>{git.candidate.id}</dd></div>
          <div className={css.fact}><dt>{t('gitBase')}</dt><dd>{git.candidate.baseOid}</dd></div>
          <div className={css.fact}><dt>{t('gitHead')}</dt><dd>{git.candidate.headOid}</dd></div>
          <div className={css.fact}><dt>{t('gitTree')}</dt><dd>{git.candidate.treeOid}</dd></div>
          <div className={css.fact}><dt>{t('gitScope')}</dt><dd>{git.candidate.scope.join(', ')}</dd></div>
        </dl>
        <h4 className={css.heading}>{t('gitValidation')}</h4>
        <ul className={css.gitValidation}>{git.candidate.validation.map((claim, index) => <li key={index}>{claim}</li>)}</ul>
      </div>}
      {state.role === 'main' ? <>
        <div className={css.actions}><Button variant="outline" size="sm" className={css.actionButton} disabled={operationBlocked || !canLeaveLocalGit}
          onClick={() => { setLeaving(true) }}>{t('leaveLocalGit')}</Button></div>
        <RiskConfirmation open={leaving} title={t('leaveLocalGit')} description={t('leaveGitHint')}
          acknowledgeLabel={t('leaveGitAcknowledgement')} acknowledged={leaveAcknowledged}
          onAcknowledgedChange={setLeaveAcknowledged} confirmLabel={t('confirmLeaveLocalGit')}
          cancelLabel={t('cancel')} closeLabel={t('close')} disabled={operationBlocked || !canLeaveLocalGit}
          onCancel={() => { setLeaving(false); setLeaveAcknowledged(false) }}
          onConfirm={() => { setLeaving(false); setLeaveAcknowledged(false); void run(leaveLocalGit, operationBlocked) }} />
      </> : null}
    </section>}
    {gitEligible ? <section className={css.section}>
      <div className={css.actions}><Button variant="outline" size="sm" className={css.actionButton}
        disabled={actionBlocked || !canAuthorizeLocalGit}
        aria-expanded={authorizing && authorizationTask === taskId} aria-controls={gitFormId}
        onClick={() => { setAuthorizing(authorizationTask !== taskId || !authorizing); setAuthorizationTask(taskId); setScopeDraft(''); setEditing(false) }}>{t('localGit')}</Button></div>
      <div id={gitFormId} hidden={!authorizing || authorizationTask !== taskId}>
        {authorizing && authorizationTask === taskId ? <form ref={authorizationForm} className={css.taskForm} onSubmit={(event) => {
          event.preventDefault()
          if (requestedScope.length !== 0 && canAuthorizeLocalGit) {
            void run(signal => authorizeLocalGit(requestedScope, signal), actionBlocked)
          }
        }}>
          <label>{t('gitScope')}<textarea className={css.scopeInput} rows={3} value={scopeDraft} disabled={pending}
            onChange={(event) => { setScopeDraft(event.target.value) }} /></label>
          <p className={css.notice}>{t('gitScopeHint')}</p>
          <p className={css.notice}>{t('gitDeliveryHint')}</p>
          <p className={css.notice}>{t('gitTrustHint')}</p>
          <div className={css.actions}>
            <Button type="submit" variant="primary" size="sm" className={css.actionButton} disabled={actionBlocked || !canAuthorizeLocalGit || requestedScope.length === 0}>{t('authorizeLocalGit')}</Button>
            <Button variant="outline" size="sm" className={css.actionButton} disabled={pending} onClick={() => { setAuthorizing(false); setScopeDraft('') }}>{t('cancel')}</Button>
          </div>
        </form> : null}
      </div>
    </section> : null}
    {state.role === 'main' ? <div className={css.actions}>
      <Button variant="outline" size="sm" className={css.actionButton} disabled={taskBlocked || !canNewTask}
        aria-expanded={editing && editorTask === taskId} aria-controls={taskFormId}
        onClick={() => { setEditing(editorTask !== taskId || !editing); setEditorTask(taskId); setObjective(''); setAuthorizing(false) }}>{t('newTask')}</Button>
      {reviewStatus !== 'reported-pass' || task?.lastReview == null ? null : <Button variant="outline" size="sm" className={css.actionButton} disabled={actionBlocked || !canRecheck}
        onClick={() => { void run(recheck, actionBlocked) }}>{t('recheck')}</Button>}
    </div> : null}
    <div id={taskFormId} hidden={!editing || editorTask !== taskId || state.role !== 'main'}>
      {editing && editorTask === taskId && state.role === 'main' ? <form ref={taskForm} className={css.taskForm} onSubmit={(event) => {
        event.preventDefault()
        const trimmed = objective.trim()
        if (trimmed !== '' && canNewTask) void run(signal => newTask(trimmed, signal), taskBlocked)
      }}>
        <label>{t('newTaskObjective')}<input className={css.taskInput} value={objective} disabled={pending}
          onChange={(event) => { setObjective(event.target.value) }} /></label>
        <p className={css.notice}>{t('newTaskHint')}</p>
        <div className={css.actions}><Button type="submit" variant="primary" size="sm" className={css.actionButton} disabled={taskBlocked || !canNewTask || objective.trim() === ''}>{t('confirmNewTask')}</Button>
          <Button variant="outline" size="sm" className={css.actionButton} disabled={pending} onClick={() => { setEditing(false) }}>{t('cancel')}</Button></div>
      </form> : null}
    </div>
    {failed ? <p className={css.error} role="alert">{t('actionFailed')}</p> : null}
  </div>
  return sidebar ? <section className={css.dock} data-rg-status>
    <div className={css.summary}>{heading}</div>{body}
  </section> : <details className={css.dock} data-rg-status>
    <summary className={`${css.summary} ${css.summaryButton}`} role="button"><IconChevronDownOutlineRegular size={16} className={css.summaryIcon} />{heading}</summary>{body}
  </details>
}

/**
 * Bind the ordered RG view stream and existing model projections for one Session.
 * @param props - framework-provided Session hooks, connection identity, and task actions.
 * @returns nothing for non-RG Sessions, otherwise the current task's compact strip.
 */
export function RgDock(props: RgDockProps) { return <RgViewPanel {...props} sidebar={false} /> }

/** Render the same trusted view inside the registered sidebar tab. */
export function RgSidebar(props: RgSidebarProps) {
  const layout = props.useRgRoleLayout(resolveRoleLayout)
  const id = useId()
  return <div className={css.sidebar} data-rg-sidebar data-rg-layout={layout}>
    <SegmentedTabs<RgRoleLayout> value={layout} label={props.t('roleView')} className={css.layoutPicker} size="sm"
      items={[
        { value: 'classic', label: props.t('viewClassic'), id: id + '-classic', panelId: id + '-panel' },
        { value: 'flow', label: props.t('viewFlow'), id: id + '-flow', panelId: id + '-panel' },
        { value: 'focus', label: props.t('viewFocus'), id: id + '-focus', panelId: id + '-panel' },
        { value: 'trace', label: props.t('viewTrace'), id: id + '-trace', panelId: id + '-panel' },
      ]} onChange={props.setRoleLayout} />
    <div id={id + '-panel'} role="tabpanel" aria-labelledby={id + '-' + layout}>
      <RgViewPanel {...props} sidebar roleLayout={layout} />
    </div>
  </div>
}

/** Render the sidebar tab's existing product icon. */
export function RgSidebarTitle(props: PropsRuntime<'sidebar.right.pane.tab.title'>) {
  const tab = props.useTabInfo()
  return <><IconBranchOutlineRegular size={16} />{tab.tab.title}</>
}

function RgViewPanel(props: (RgDockProps | RgSidebarProps) & { sidebar: boolean; roleLayout?: RgRoleLayout }) {
  const available = props.useRgSidebarAvailable(value => value)
  const busy = props.useSession(value => value.running)
  const generation = props.useRgConnection(value => value)
  const canNewTask = props.useAccess('reviewGated/newTask')
  const canRecheck = props.useAccess('reviewGated/recheck')
  const canAuthorizeLocalGit = props.useAccess('reviewGated/authorizeLocalGit')
  const canLeaveLocalGit = props.useAccess('reviewGated/leaveLocalGit')
  const [received, setReceived] = useState<{ sessionId: typeof props.sessionId; generation: number; view: RgView }>()
  useEffect(() => {
    const lifetime = new AbortController()
    const clear = () => { if (!lifetime.signal.aborted) setReceived(undefined) }
    let stream: ReturnType<RgDockFace['watchView']>
    try { stream = props.watchView(clear) } catch (_error) { clear(); return () => { lifetime.abort() } }
    void (async () => {
      try {
        for await (const item of stream) {
          if (lifetime.signal.aborted) return
          setReceived({ sessionId: props.sessionId, generation, view: item.value })
          item.accept()
        }
      } catch (_error) {
        clear()
      } finally { clear() }
    })()
    return () => { lifetime.abort(); void stream.dispose().catch((error: unknown) => { console.error('[review-gated] view stream disposal failed', error) }) }
  }, [props.sessionId, generation, props.watchView])
  const view = received?.sessionId === props.sessionId && received.generation === generation ? received.view : undefined
  const state = view?.state
  const gitState = view?.git
  const rgHint = props.useProjection('reviewGated')
  const model = props.useProjection('modelSelection')
  const childId = state?.task?.active?.childId
  const workerId = state?.task?.lastWorker?.childId
  const reviewId = state?.task?.lastReview?.childId
  const roleModel = props.useSessions(snapshot => childId === undefined
    ? undefined : snapshot.projectionsBySession[childId]?.values.modelSelection)
  const workerModel = props.useSessions(snapshot => workerId === undefined
    ? undefined : snapshot.projectionsBySession[workerId]?.values.modelSelection)
  const reviewModel = props.useSessions(snapshot => reviewId === undefined
    ? undefined : snapshot.projectionsBySession[reviewId]?.values.modelSelection)
  const runModels: Record<string, ModelSelectionProjection | undefined> = {}
  if (childId !== undefined) runModels[childId] = roleModel
  if (workerId !== undefined) runModels[workerId] = workerModel
  if (reviewId !== undefined) runModels[reviewId] = reviewModel
  const currentGit = state != null && gitState?.taskId === (state.task?.id ?? state.taskId) ? gitState : null
  const reviewStatus = effectiveReviewStatus(state?.task ?? null, currentGit)
  if (view?.status === 'ready' && state === null && view.claim === null) return null
  if (rgHint === null && (view === undefined || view.status === 'unknown' && view.state === null && view.claim === null)) return null
  if (!props.sidebar && available) return <RgTaskEntry view={view} busy={busy} git={currentGit}
    reviewStatus={reviewStatus} openSidebar={props.openSidebar} t={props.t} />
  if (view?.status !== 'ready' || state == null || view.claim !== null) return <RgRecoveryNotice
    key={JSON.stringify([props.sessionId, generation])} status={view?.status ?? 'unknown'} claim={view?.claim ?? null} t={props.t} />
  return <RgStatus key={JSON.stringify([props.sessionId, generation])}
    trust="ready" state={state} git={currentGit}
    model={model} roleModel={roleModel} canNewTask={canNewTask} canRecheck={canRecheck}
    canAuthorizeLocalGit={canAuthorizeLocalGit} canLeaveLocalGit={canLeaveLocalGit}
    sidebar={props.sidebar} roleLayout={props.roleLayout ?? 'classic'} runModels={runModels} busy={busy} t={props.t} newTask={props.newTask} recheck={props.recheck}
    authorizeLocalGit={props.authorizeLocalGit} leaveLocalGit={props.leaveLocalGit} />
}
