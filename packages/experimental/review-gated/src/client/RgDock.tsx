/** Compact RG task facts derived from durable projections, never from model prose. */
import { useEffect, useRef, useState } from 'react'
import { RiskConfirmation } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ModelSelectionProjection } from '@deepseek-ai/dsh-agent/types'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { RgGitState } from '../git-types.ts'
import type { RgModel, RgSessionState } from '../types.ts'
import type { RgLocaleKey } from './locales.ts'
import type { RgView } from './view.ts'
import type {} from './index.ts'
import css from './rg.module.css'

/** Session-addressed actions; newTask and leaveLocalGit cannot cancel a Host mutation already dispatched. */
export interface RgDockFace {
  readonly hooks: { readonly rgConnection: HostObservable<number> }
  readonly watchView: (carrierFailed: () => void) =>
    AsyncIterable<{ readonly value: RgView; accept(): void }> & { dispose(): Promise<void> }
  readonly newTask: (objective: string, signal: AbortSignal) => Promise<void>
  readonly recheck: (signal: AbortSignal) => Promise<void>
  readonly authorizeLocalGit: (scope: readonly string[], signal: AbortSignal) => Promise<void>
  readonly leaveLocalGit: (signal: AbortSignal) => Promise<void>
}
/** Framework-provided session projections and localized task controls. */
export type RgDockProps = PropsRuntime<'conversation.input.dock'> & PropsLocale<'review-gated'> & InjectFace<RgDockFace>
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
  /** Host-confirmed lifecycle state; absent evidence is never treated as ready. */
  trust?: 'ready' | 'saving' | 'unknown'
}
const REVIEW_LABELS = { 'not-reviewed': 'notReviewed', reviewing: 'reviewing', 'reported-pass': 'reportedPass',
  'changes-requested': 'changesRequested', inconclusive: 'inconclusive', stale: 'stale' } as const satisfies Record<string, RgLocaleKey>

const GIT_LABELS = { authorized: 'gitAuthorized', preparing: 'gitPreparing', working: 'gitWorking', finalizing: 'gitFinalizing',
  candidate: 'gitCandidateReady', reviewing: 'reviewing', interrupted: 'interrupted', unknown: 'gitUnknown', failed: 'failed',
} as const satisfies Record<RgGitState['status'], RgLocaleKey>

function modelLabel(model: RgModel): string {
  return model.provider + '/' + model.model + (model.reasoningEffort === undefined ? '' : ' · ' + model.reasoningEffort)
}

/**
 * Render the current task and independently identified review result.
 * @param props - projection facts, access decisions, and Session-addressed Host callbacks.
 * @returns an expandable summary with explicit report scope and uncertainty.
 */
export function RgStatus(props: StatusProps) {
  if (props.trust !== 'ready') return <div className={css.dock} role="status" data-rg-status>
    {props.t(props.trust === 'saving' ? 'saving' : 'statusUnknown')}
    {props.trust === 'saving' ? <span> {props.t('statusProcessingHint')}</span> : null}
  </div>
  return <RgReadyStatus {...props} />
}

function RgReadyStatus({ state, git, model, roleModel, busy, canNewTask, canRecheck, canAuthorizeLocalGit,
  canLeaveLocalGit, newTask, recheck, authorizeLocalGit, leaveLocalGit, t }: StatusProps) {
  const [editing, setEditing] = useState(false)
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
  const gitEvidence = git?.status === 'candidate' && git.candidate !== null && git.binding?.role === 'reviewer'
    && git.binding.runId === review?.id && git.binding.candidateId === git.candidate.id && git.binding.checkout !== null
  const reviewStatus = task?.reviewStatus === 'reported-pass' && review?.scope == null && !gitEvidence ? 'stale' : task?.reviewStatus
  const status = active === null || active === undefined
    ? reviewStatus === undefined ? null : REVIEW_LABELS[reviewStatus]
    : active.status
  return <details className={css.dock} data-rg-status>
    <summary className={css.summary}>
      <span className={css.status}>{t('title')}</span>
      <span className={css.summaryTitle}>{task?.objective ?? (state.role === 'main' ? t('noTask') : t(state.role))}</span>
      {status === null ? null : <span>{t(status)}</span>}
      {task === null || policy === null ? null : <span>{t('workerBudget')} {task.workerAttempts}/{policy.maxWorkerAttempts} · {t('reviewBudget')} {task.reviewAttempts}/{policy.maxReviewAttempts}</span>}
    </summary>
    <div className={css.dockBody} role="region" aria-label={t('details')} tabIndex={0}>
      {policy === null ? <p className={css.error} role="status">{t('policyMissing')}</p> : null}
      <dl className={css.facts}>
        <div className={css.fact}><dt>{t('role')}</dt><dd>{t(state.role)}</dd></div>
        {task === null ? null : <div className={css.fact}><dt>{t('taskObjective')}</dt><dd>{task.objective}</dd></div>}
        {policy === null ? null : <div className={css.fact}><dt>{t('configuration')}</dt><dd>{policy.configurationHash}</dd></div>}
        {task === null ? null : <div className={css.fact}><dt>{t('workRevision')}</dt><dd>{task.workRevision}</dd></div>}
        <div className={css.fact}><dt>{t('actualModel')}</dt><dd>{latestModel?.lastUsed == null ? t('notRequested') : modelLabel(latestModel.lastUsed)}</dd></div>
        {latestModel?.next == null ? null : <div className={css.fact}><dt>{t('nextModel')}</dt><dd>{modelLabel(latestModel.next)}</dd></div>}
        {active === null || active === undefined ? null : <div className={css.fact}><dt>{t('activeModel')}</dt><dd>{modelLabel(active.selection)}</dd></div>}
      </dl>
      {stateDiagnostic === null ? null : <p className={css.error} role="status">{stateDiagnostic}</p>}
      {task?.lastWorker?.diagnostic == null ? null : <p className={css.error}>{task.lastWorker.diagnostic}</p>}
      {task?.lastReview?.diagnostic == null ? null : <p className={css.error}>{task.lastReview.diagnostic}</p>}
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
          <div className={css.actions}><button type="button" className={css.textButton} disabled={operationBlocked || !canLeaveLocalGit}
            onClick={() => { setLeaving(true) }}>{t('leaveLocalGit')}</button></div>
          <RiskConfirmation open={leaving} title={t('leaveLocalGit')} description={t('leaveGitHint')}
            acknowledgeLabel={t('leaveGitAcknowledgement')} acknowledged={leaveAcknowledged}
            onAcknowledgedChange={setLeaveAcknowledged} confirmLabel={t('confirmLeaveLocalGit')}
            cancelLabel={t('cancel')} closeLabel={t('close')} disabled={operationBlocked || !canLeaveLocalGit}
            onCancel={() => { setLeaving(false); setLeaveAcknowledged(false) }}
            onConfirm={() => { setLeaving(false); setLeaveAcknowledged(false); void run(leaveLocalGit, operationBlocked) }} />
        </> : null}
      </section>}
      {gitEligible ? <section className={css.section}>
        <div className={css.actions}><button type="button" className={css.textButton}
          disabled={actionBlocked || !canAuthorizeLocalGit} aria-expanded={authorizing}
          onClick={() => { setAuthorizing(authorizationTask !== taskId || !authorizing); setAuthorizationTask(taskId); setScopeDraft(''); setEditing(false) }}>{t('localGit')}</button></div>
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
            <button type="submit" className={css.textButton} disabled={actionBlocked || !canAuthorizeLocalGit || requestedScope.length === 0}>{t('authorizeLocalGit')}</button>
            <button type="button" className={css.textButton} disabled={pending} onClick={() => { setAuthorizing(false); setScopeDraft('') }}>{t('cancel')}</button>
          </div>
        </form> : null}
      </section> : null}
      {state.role === 'main' ? <div className={css.actions}>
        <button type="button" className={css.textButton} disabled={taskBlocked || !canNewTask}
          onClick={() => { setEditing(editorTask !== taskId || !editing); setEditorTask(taskId); setObjective(''); setAuthorizing(false) }}>{t('newTask')}</button>
        {reviewStatus !== 'reported-pass' || task?.lastReview == null ? null : <button type="button" className={css.textButton} disabled={actionBlocked || !canRecheck}
          onClick={() => { void run(recheck, actionBlocked) }}>{t('recheck')}</button>}
      </div> : null}
      {editing && editorTask === taskId && state.role === 'main' ? <form ref={taskForm} className={css.taskForm} onSubmit={(event) => {
        event.preventDefault()
        const trimmed = objective.trim()
        if (trimmed !== '' && canNewTask) void run(signal => newTask(trimmed, signal), taskBlocked)
      }}>
        <label>{t('newTaskObjective')}<input className={css.taskInput} value={objective} disabled={pending}
          onChange={(event) => { setObjective(event.target.value) }} /></label>
        <p className={css.notice}>{t('newTaskHint')}</p>
        <div className={css.actions}><button type="submit" className={css.textButton} disabled={taskBlocked || !canNewTask || objective.trim() === ''}>{t('confirmNewTask')}</button>
          <button type="button" className={css.textButton} disabled={pending} onClick={() => { setEditing(false) }}>{t('cancel')}</button></div>
      </form> : null}
      {failed ? <p className={css.error} role="alert">{t('actionFailed')}</p> : null}
    </div>
  </details>
}

/**
 * Bind the ordered RG view stream and existing model projections for one Session.
 * @param props - framework-provided Session hooks, connection identity, and task actions.
 * @returns nothing for non-RG Sessions, otherwise the current task's compact strip.
 */
export function RgDock(props: RgDockProps) {
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
  const roleModel = props.useSessions(snapshot => childId === undefined
    ? undefined : snapshot.projectionsBySession[childId]?.values.modelSelection)
  if (view?.status === 'ready' && state === null) return null
  if (rgHint === null && (view === undefined || view.status === 'unknown' && view.state === null && view.claim === null)) return null
  const claim = view?.claim == null ? null : <details className={css.dock}>
    <summary>{props.t(view.claim.phase === 'rejected' ? 'claimRejected' : view.claim.phase === 'empty' ? 'claimEmpty' : 'claimPending')}</summary>
    <div className={css.dockBody} tabIndex={0}>
      <p className={css.notice}>{props.t(view.claim.phase === 'rejected' || view.claim.phase === 'empty' ? 'claimNotEnteredHint' : 'claimLogHint')}</p>
      <pre className={css.report}>{view.claim.text}</pre>
      {view.claim.truncated ? <p className={css.notice}>{props.t('claimTruncated')}</p> : null}
    </div>
  </details>
  if (state == null) return <><div className={css.dock} role="status" data-rg-status>{props.t(view?.status === 'saving' ? 'saving' : 'statusUnknown')}
    {view?.status === 'saving' ? <span> {props.t('statusProcessingHint')}</span> : null}</div>{claim}</>
  return <><RgStatus key={JSON.stringify([props.sessionId, generation])}
    trust={view?.status ?? 'unknown'} state={state} git={gitState?.taskId === (state.task?.id ?? state.taskId) ? gitState : null}
    model={model} roleModel={roleModel} canNewTask={canNewTask} canRecheck={canRecheck}
    canAuthorizeLocalGit={canAuthorizeLocalGit} canLeaveLocalGit={canLeaveLocalGit}
    busy={props.session.running} t={props.t} newTask={props.newTask} recheck={props.recheck}
    authorizeLocalGit={props.authorizeLocalGit} leaveLocalGit={props.leaveLocalGit} />{claim}</>
}
