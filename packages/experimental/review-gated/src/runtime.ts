/** RG policy and budget owner; the existing subagent manager owns child lifecycles. */
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { Context, FiberState, Service } from '@deepseek-ai/cordis'
import type { Disposable } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Agent, ClaimRecovery, ClaimWireState, InboxWireState, ModelSelection } from '@deepseek-ai/dsh-agent'
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { MessageId, UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import type { SubagentActivation, SubagentActivationSpec, SubagentResult } from '@deepseek-ai/dsh-subagent'
import { Remote, RemoteError, TypertRemoteService, principalOf } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-working-directory'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-tool-subagent/model-selection-settings'
import type {} from '@deepseek-ai/dsh-tool-executor-ptc/types'
import { Config, capturePolicy, resolveModel } from './config.ts'
import { RgError } from './errors.ts'
import { RG_TASK_ADMISSION_OWNER, rgProjectionDefinition, TASK_SAVE_UNCERTAIN } from './projection.ts'
import { gitProjectionDefinition, gitStateSchema } from './git-projection.ts'
import { sessionStateSchema } from './schemas.ts'
import type { RgClaimReport, RgReviewReport, RgView } from './types.ts'
import { LocalGitDelivery } from './git-delivery.ts'
import type { RgGitState } from './git-types.ts'
import type { RgProjectionState } from './projection.ts'
import { handoffSchema, reviewReportSchema, workerReportSchema } from './schemas.ts'
import { reviewerOutputSchema, workerOutputSchema } from './report-schema.ts'
import { boundCompletion } from './report-result.ts'
import { captureScope } from './scope.ts'
import { reserveRun, settleRun } from './task.ts'
import type { RgHandoff, RgModel, RgPolicy, RgReport, RgRole, RgRun, RgRunId, RgSessionState, RgTask, RgTaskId } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Frozen role authorization and bounded RG task operations. */
    reviewGated: ReviewGatedService
  }
}
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** A committed RG role result or scope-invalidation notice. */
    'review-gated': { kind: 'review-gated' }
  }
}

interface LiveRun {
  readonly parent: Agent
  readonly run: RgRun
  readonly taskId: RgTaskId
  child: Agent | undefined
  readonly control: AbortController
  readonly startup: Promise<void>
  parentCancelled: boolean
  settling: boolean
  activation: SubagentActivation | undefined
  completion: Promise<void> | undefined
  delivery: { readonly kind: 'workspace' } | { readonly kind: 'git'; readonly prepared: RgGitState } | null
}

/** Convert an RG candidate without carrying an effort from another role.
 * @param model - exact configured candidate.
 * @returns complete next-request selection.
 */
export function rgSelection(model: RgModel): ModelSelection {
  return { provider: model.provider, model: model.model,
    ...model.reasoningEffort === undefined ? {} : { reasoningEffort: brandString<ReasoningEffortId>(model.reasoningEffort) } }
}

/** Current review label used only while bounding a worker's complete parent notice. */
function currentReviewStatus(state: RgSessionState | null): RgTask['reviewStatus'] { return state?.task?.reviewStatus ?? 'not-reviewed' }

/** Verify a direct task against its original claim and the admitted message recorded by that claim. */
function directTaskRecorded(events: readonly SessionEvent[], creation: number, task: RgTask,
  prepared: Extract<SessionEvent, { type: 'review-gated/direct-task-prepared' }>): boolean {
  if (prepared.data.messageId !== task.originMessageId) return false
  const intentIndex = events.findIndex(event => event.type === 'agent/claim/intent' && event.seq === prepared.data.intentSeq)
  const intent = intentIndex < 0 || intentIndex >= creation ? undefined : events[intentIndex]
  if (intent?.type !== 'agent/claim/intent') return false
  let origin: UserMessage | undefined
  for (const input of intent.data.inputs) {
    const message = input.message
    if (message.source.kind !== 'user') continue
    const objective = message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n').trim()
    if (objective === '') continue
    if (message.id !== task.originMessageId || objective !== task.objective) return false
    origin = message
    break
  }
  if (origin === undefined) return false
  for (const event of events.slice(intentIndex + 1, creation)) {
    if (event.type === 'agent/claim/settled' && event.data.intentSeq === intent.seq) return false
  }
  let admitted: UserMessage | undefined
  let count = 0
  for (const event of events.slice(creation + 1)) {
    if (event.type === 'user/message' && event.data.id === task.originMessageId) {
      admitted = event.data
      count++
    }
    if (event.type !== 'agent/claim/settled' || event.data.intentSeq !== intent.seq) continue
    if (event.data.outcome !== 'entered' || count !== 1 || admitted?.source.kind !== 'user') return false
    const matches = event.data.messages.filter(message => message.id === task.originMessageId)
    return matches.length === 1 && matches[0]?.source.kind === 'user' && isDeepStrictEqual(matches[0], admitted)
  }
  return false
}

/** Verify that the current task's input was recorded after its most recent creation. */
function taskInputRecorded(events: readonly SessionEvent[], task: RgTask): boolean {
  let creation = -1
  for (const [index, event] of [...events.entries()].reverse()) {
    if (event.type !== 'review-gated/state' && event.type !== 'review-gated/task-prepared'
      && event.type !== 'review-gated/direct-task-prepared') continue
    const candidate = event.data.state?.task
    const sameTask = candidate?.id === task.id && candidate.originMessageId === task.originMessageId
      && candidate.objective === task.objective
    if (sameTask) {
      creation = index
      if (event.type === 'review-gated/task-prepared' || event.type === 'review-gated/direct-task-prepared') break
    } else if (creation !== -1) break
  }
  if (creation === -1) return false
  const event = events[creation]
  if (event?.type === 'review-gated/direct-task-prepared') return directTaskRecorded(events, creation, task, event)
  for (const entry of events.slice(creation + 1)) {
    if (entry.type === 'user/message' && entry.data.id === task.originMessageId && entry.data.source.kind === 'user'
      && entry.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n').trim() === task.objective) return true
  }
  return false
}

/** A recorded RG state that the projection no longer reports means the projection failed. */
function stateContradicted(events: readonly SessionEvent[], value: RgSessionState | null): boolean {
  for (const event of events.toReversed()) {
    if (event.type === 'review-gated/state') return (event.data.state !== null) !== (value !== null)
    if (event.type === 'review-gated/task-prepared' || event.type === 'review-gated/direct-task-prepared') {
      return value === null
    }
  }
  return false
}

/** A rejected or empty claim cannot establish the task whose origin it captured. */
function claimRejectedOrigin(claim: ClaimWireState | null | undefined, task: RgTask | null | undefined): boolean {
  if (task == null || (claim?.phase !== 'rejected' && claim?.phase !== 'empty')) return false
  return claim.inputs.some(({ message }) => message !== null && typeof message === 'object' && !Array.isArray(message)
    && message.id === task.originMessageId)
}

/** A missing, malformed, or still-pending origin cannot authorize a cold task view. */
function noPendingOrigin(inbox: InboxWireState | undefined, origin: MessageId): boolean {
  if (inbox === undefined) return false
  for (const target of ['next-turn', 'next-step'] as const) {
    for (const message of inbox[target]) {
      if (message === null || typeof message !== 'object' || Array.isArray(message) || typeof message.id !== 'string'
        || message.id === origin) return false
    }
  }
  return true
}

/** Settings, Session policy, durable reservations, and parent-visible formal results. */
export default class ReviewGatedService extends TypertRemoteService {
  static inject = ['agents', 'sessions', 'sessionProjections', 'subagents', 'agentPresets', 'llm', 'fs', 'workingDirectory']
  static Config = Config
  private projection!: ProjectionHandle<RgProjectionState>
  private agents!: Context['agents']
  private git!: LocalGitDelivery
  private readonly lifecycle = new AbortController()
  private readonly serviceIdentity = Symbol('review-gated-service')
  private readonly runs = new Map<SessionId, LiveRun>()
  private readonly parents = new Map<Agent, Disposable<void | Promise<void>>>()
  private readonly tasks = new Map<Agent, { stopped: boolean; deliveryId?: MessageId; readonly settled: Promise<void> }>()
  private readonly departures = new Map<Agent, Promise<void>>()
  private readonly uncertainViews = new WeakSet<Session>()
  private readonly retiredViewAgents = new WeakSet<Agent>()
  private readonly viewListeners = new Map<SessionId, Set<() => void>>()

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'reviewGated')
    ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  }

  protected async [Service.init](): Promise<void> {
    this.agents = this.ctx.agents
    this.projection = await this.ctx.sessionProjections.register<'reviewGated', RgProjectionState>(rgProjectionDefinition)
    const gitProjection = await this.ctx.sessionProjections.register(gitProjectionDefinition)
    this.git = new LocalGitDelivery(this.ctx, this.config.git, gitProjection, async () => {
      await this.drain([...this.runs.values()].filter(live => this.git.read(live.parent.session) !== null),
        new Error('Local Git services became unavailable; inspect retained worktrees.'))
    })
    const ctx = this.ctx
    ctx.on('agent/created', ({ agent }) => { this.initialize(agent); this.publishView(agent.session.id); return undefined })
    ctx.on('agent-preset/recomposed', ({ agent }) => { this.initialize(agent); this.publishView(agent.session.id) })
    ctx.on('agent/inbox/claimed', ({ agent, message }) => {
      const pending = this.tasks.get(agent)
      if (pending !== undefined && (message.id !== pending.deliveryId || message.source.kind !== 'user')) pending.stopped = true
    })
    ctx.on('agent/post-pre-step', async ({ agent, claimedMessages, admittedMessages, signal, modelSelection, addGuard }) => {
      await this.prepareModelEntry(agent, claimedMessages, admittedMessages, signal, modelSelection, addGuard)
    })
    ctx.on('tools/result', (exec, result) => {
      const agent = exec.agent
      if (agent === undefined || result.isError || !['write', 'edit', 'bash', 'pwsh'].includes(exec.name)) return undefined
      const state = this.read(agent.session)
      if (state?.role === 'main' && state.task?.reviewStatus === 'reported-pass') {
        this.commit(agent.session, { ...state, task: { ...state.task, workRevision: state.task.workRevision + 1, reviewStatus: 'stale' } })
      }
      return undefined
    })
    ctx.effect(() => ctx.sessionProjections.onEventChanged((session, changes) => {
      if (changes.some(change => change.key === 'reviewGated' || change.key === 'reviewGatedGit' || change.key === 'agentClaim')) this.publishView(session.id)
    }))
    ctx.on('agent/claim/status', ({ agent }) => { this.publishView(agent.session.id) }, { global: true })
    ctx.on('session/created', (session) => { this.publishView(session.id) }, { global: true })
    ctx.on('agent/disposed', ({ agent }) => { this.retiredViewAgents.add(agent); this.publishView(agent.session.id) }, { global: true })
    ctx.on('session/event', (session, event) => {
      const agent = ctx.agents.get(session.id)
      if (agent === undefined) return
      if (event.type === 'turn/end' && event.data.reason.kind === 'aborted') {
        const live = [...this.runs.values()].find(run => run.parent === agent)
        if (live !== undefined) { live.parentCancelled = true; live.control.abort(event.data.reason.reason) }
      }
      if (event.type === 'review-gated/state') {
        const live = [...this.runs.values()].find(run => run.parent === agent)
        if (live === undefined) return
        const task = event.data.state?.task
        const active = task?.active
        if (!live.settling && (event.data.state?.role !== 'main' || event.data.state.policy === null
          || task?.id !== live.taskId || active?.id !== live.run.id || active.childId !== live.run.childId)) {
          live.control.abort(new Error('The RG role reservation is no longer current.'))
        }
      }
    })
    ctx.on('agent/turn-stopping', async ({ agent, signal }) => {
      const live = [...this.runs.values()].find(run => run.parent === agent)
      if (live !== undefined && live.parent === agent) {
        const abort = () => { live.parentCancelled = true; live.control.abort(signal.reason) }
        signal.addEventListener('abort', abort, { once: true })
        try { if (signal.aborted) abort(); await live.startup; await live.completion } finally { signal.removeEventListener('abort', abort) }
        signal.throwIfAborted()
      }
      const before = this.read(agent.session)?.task?.reviewStatus
      await this.recheck(agent, signal)
      if (before === 'reported-pass' && this.read(agent.session)?.task?.reviewStatus === 'stale') {
        agent.steer(this.notice('The reviewed file scope changed. The previous reviewer pass is stale; report this or request a new review within the remaining budget.'))
      }
    })
    ctx.effect(() => ctx.subagents.guardStarts((spec) =>{  this.guardStart(spec) }))
    ctx.inject(['subagentModelSelection'], (child) => {
      child.effect(() => child.subagentModelSelection.registerSource({ name: 'review-gated', resolve: (agent) => {
        this.initialize(agent)
        const state = this.read(agent.session)
        if (state?.role !== 'main' || state.policy === null) return undefined
        const routes = [...state.policy.worker.candidates, ...state.policy.reviewer.candidates]
        return [...new Map(routes.map(route => [
          JSON.stringify([route.provider, route.model]), { provider: route.provider, model: route.model },
        ])).values()]
      } }))
    })
    ctx.effect(() => async () => {
      this.lifecycle.abort(new Error('RG was disabled; no further role work is authorized.'))
      for (const id of this.viewListeners.keys()) this.publishView(id)
      try { await this.drain([...this.runs.values()], this.lifecycle.signal.reason) } finally {
        await this.git.close()
        await Promise.all([...this.parents.values()].map(dispose => Promise.resolve().then(dispose)))
      }
    })
  }

  /** Bind a fresh RG composition or restore main policy; persisted children gain no new run authorization.
   * @param agent - live or initialization-window Agent.
   */
  initialize(agent: Agent): void {
    const preset = this.ctx.agentPresets.presetForSession(agent.session)
    const role: RgRole | undefined = preset === 'rg' ? 'main' : preset === 'rg-worker' ? 'worker' : preset === 'rg-reviewer' ? 'reviewer' : undefined
    if (role !== undefined) agent.enableClaimProtection?.()
    const recovered = this.projection.stateOf(agent.session)
    if (role === undefined) {
      if (recovered.value !== null && !recovered.hasRequested) {
        this.ctx.agents.clearModelPolicy(agent)
        if (recovered.value.priorModel !== null && recovered.value.priorModel !== undefined) {
          agent.model.select(rgSelection(recovered.value.priorModel))
        }
        this.commit(agent.session, null)
      }
      return
    }
    if (recovered.value !== null) {
      const state = recovered.value
      if (state.role === 'main' && !recovered.hasRequested && state.policy !== null && this.ctx.agents.modelPolicyFor(agent) === null) this.bindModel(agent, state.policy, state.role)
      if (state.task?.active !== null && state.task?.active !== undefined) {
        const run = state.task.active
        const live = this.runs.get(run.childId)
        if (live?.parent !== agent || live.run.id !== run.id || live.taskId !== state.task.id) {
          const task = settleRun(state.task, run.id, { status: 'interrupted', report: null, scope: run.scope, diagnostic: 'RG execution was interrupted. Inspect partial changes before starting another attempt.' }, false)
          this.commit(agent.session, { ...state, task })
        }
      }
      if (role === 'main') this.git.recover(agent, this.read(agent.session)?.task ?? null)
      return
    }
    if (recovered.hasRequested) {
      this.commit(agent.session, { policy: null, role, parentSessionId: null, taskId: null, runId: null, task: null,
        diagnostic: 'RG_LEGACY_SESSION: this older Session has no frozen model policy. Open a new RG Session after configuring the plugin.' })
      return
    }
    if (role === 'main') {
      let policy: RgPolicy
      try { policy = capturePolicy(this.config.settings.get()) } catch (error) {
        this.commit(agent.session, {
          policy: null, role, parentSessionId: null, taskId: null, runId: null, task: null,
          /* v8 ignore next -- settings parsing and hashing only throw Error instances; keep unknown-value formatting defensive. */
          diagnostic: error instanceof Error ? error.message : String(error),
        })
        return
      }
      const state: RgSessionState = {
        policy, role, priorModel: agent.model.current() ?? null, parentSessionId: null,
        taskId: null, runId: null, task: null, diagnostic: null,
      }
      this.commit(agent.session, state)
      this.bindModel(agent, policy, role)
      return
    }
    const parentId = agent.session.header.parentSession
    const parent = parentId === undefined ? undefined : this.ctx.sessions.get(parentId)
    const state = parent === undefined ? null : this.read(parent)
    const run = state?.task?.active
    const live = this.runs.get(agent.id)
    if (parent === undefined || state?.policy === null || state?.policy === undefined
      || run === null || run === undefined || run.childId !== agent.id || run.role !== role
      || live === undefined || live.parent.session !== parent || this.ctx.agents.get(parent.id) !== live.parent
      || live.taskId !== state.task?.id || live.run.id !== run.id || live.child !== undefined) {
      throw new RgError('RG_UNAUTHORIZED_START', 'RG roles must belong to an existing parent task reservation.')
    }
    const child: RgSessionState = {
      policy: state.policy, role, parentSessionId: parent.id, taskId: live.taskId, runId: run.id, task: null, diagnostic: null,
    }
    live.child = agent
    this.commit(agent.session, child)
    this.bindModel(agent, state.policy, role, live.run.selection)
  }

  /** Read the current projection without cold-log scans.
   * @param session - prepared Session.
   * @returns exact RG state, or null outside RG.
   */
  read(session: Session): RgSessionState | null {
    const state = this.projection.stateOf(session)
    if (state.failure !== null) throw new RgError('RG_NOT_READY', state.failure)
    const agent = this.agents.get(session.id)
    const admission = agent?.session === session ? agent.exclusiveAdmission : null
    if (state.value !== null && admission?.owner === RG_TASK_ADMISSION_OWNER && admission.state !== 'confirmed') {
      return { ...state.value, diagnostic: TASK_SAVE_UNCERTAIN }
    }
    return state.value
  }

  /** Read process-local save evidence for an exact live Session.
   * @param session - attached Session whose save lifecycle is being inspected.
   * @returns unknown for missing, replaced, or uncertain owners; saving until the owned operation settles.
   */
  statusOf(session: Session): 'ready' | 'saving' | 'unknown' {
    const agent = this.agents.get(session.id)
    if (this.lifecycle.signal.aborted || this.ctx.sessions.get(session.id) !== session || agent?.session !== session
      || agent.ctx.fiber.state !== FiberState.ACTIVE || this.retiredViewAgents.has(agent) || this.uncertainViews.has(session)) return 'unknown'
    if (agent.enableClaimProtection === undefined || agent.claimProtectionStatus === undefined || agent.claimRecovery === undefined
      || agent.exclusiveAdmission === undefined || agent.claimProtectionStatus === 'unknown'
      || (agent.claimProtectionStatus !== 'saving' && agent.claimRecovery !== null)) return 'unknown'
    let claim: ClaimWireState | null
    try { claim = this.consistentClaim(session) } catch { return 'unknown' }
    if (agent.claimProtectionStatus === 'saving' || this.tasks.has(agent) || this.departures.has(agent) || this.git.busy(agent)) return 'saving'
    if (agent.exclusiveAdmission?.owner === RG_TASK_ADMISSION_OWNER) return 'unknown'
    const state = this.projection.stateOf(session)
    if (state.failure !== null || state.value?.diagnostic != null || claimRejectedOrigin(claim, state.value?.task)
      || claim?.phase === 'unsettled' || claim?.phase === 'entered') return 'unknown'
    const active = state.value?.task?.active
    if ([...this.runs.values()].some(run => run.parent === agent
      && (active?.status === 'saving' || active == null))) return 'saving'
    return 'ready'
  }

  private consistentClaim(session: Session): ClaimWireState | null {
    const cut = this.ctx.sessionProjections.snapshot(session, ['reviewGated', 'agentClaim'])
    const state = this.projection.stateOf(session)
    if (cut.asOfSeq !== session.seq - 1 || cut.values.reviewGated === undefined || cut.values.agentClaim === undefined
      || state.failure !== null || JSON.stringify(cut.values.reviewGated) !== JSON.stringify(state.value)) {
      throw new RgError('RG_NOT_READY', 'The RG and input-claim projections are unavailable or inconsistent. Inspect the Session before continuing.')
    }
    return cut.values.agentClaim
  }

  /** Read the exact Session claim disposition without starting an Agent.
   * @param session - prepared Session.
   * @returns the claim view, or undefined when its projection is unavailable.
   */
  claimOf(session: Session): ClaimWireState | null | undefined {
    return this.ctx.sessionProjections.snapshot(session, ['agentClaim']).values.agentClaim
  }

  private claimView(claim: ClaimRecovery | null | undefined, phase: NonNullable<RgView['claim']>['phase']): RgView['claim'] {
    if (claim == null) return null
    let text = ''
    let truncated = false
    let otherContent = false
    let examined = 0
    inputs: for (const input of claim.inputs) {
      if (++examined > 8192) { truncated = true; otherContent = true; break }
      const message = input.message
      if (message === null || typeof message !== 'object' || Array.isArray(message) || !Array.isArray(message.content)) {
        otherContent = true
        continue
      }
      for (const part of message.content) {
        if (++examined > 8192) { truncated = true; otherContent = true; break inputs }
        if (part === null || typeof part !== 'object' || Array.isArray(part) || part.type !== 'text' || typeof part.text !== 'string') {
          otherContent = true
          continue
        }
        if (text !== '') {
          if (text.length < 8192) text += '\n'
          else truncated = true
        }
        const remaining = Math.max(0, 8192 - text.length)
        text += part.text.slice(0, remaining)
        if (part.text.length > remaining) { truncated = true; otherContent = true; break inputs }
      }
    }
    return { phase, text, truncated, otherContent }
  }

  /** Bound model-visible claim details including the complete JSON wrapper.
   * @param session - Session owning the input.
   * @param status - live claim durability state.
   * @param claim - JSON-safe claim retained by the Agent or its projection.
   * @returns a bounded summary; omitted raw fields and text are explicitly marked.
   * @throws RgError when the configured budget cannot hold the minimum summary.
   */
  claimReport(session: Session, status: 'saving' | 'unknown' | null, claim: ClaimRecovery | ClaimWireState | null): RgClaimReport {
    let limit = this.config.settings.get().maxReportChars
    try {
      const state = this.projection.stateOf(session)
      if (state.failure === null && state.value?.policy != null) limit = state.value.policy.maxReportChars
    } catch (error) {
      this.ctx.logger.warn('RG claim report budget uses current settings: %s', error)
    }
    const phase = claim !== null && 'phase' in claim ? claim.phase : 'unsettled'
    const preview = this.claimView(claim, phase)
    const summary = { claimStatus: status, sessionId: session.id.slice(0, 8192), sessionIdTruncated: session.id.length > 8192,
      rawPayloadTruncated: true as const,
      hint: 'Inspect the authorized Session view or log. Input may be unsaved; do not replay automatically.',
      claim: claim === null ? null : { intentSeq: claim.intentSeq, target: claim.target, turn: claim.turn,
        step: claim.step, phase, inputCount: claim.inputs.length, otherContent: preview?.otherContent ?? false, textPreview: '' } }
    if (JSON.stringify(summary).length > limit) {
      throw new RgError('RG_NOT_READY', 'The configured report limit cannot hold claim recovery details. Inspect the Session view or log.')
    }
    if (summary.claim !== null && preview !== null) {
      let low = 0
      let high = preview.text.length
      while (low < high) {
        const middle = Math.ceil((low + high) / 2)
        const candidate = { ...summary, claim: { ...summary.claim, textPreview: preview.text.slice(0, middle) } }
        if (JSON.stringify(candidate).length <= limit) low = middle
        else high = middle - 1
      }
      return { ...summary, claim: { ...summary.claim, textPreview: preview.text.slice(0, low) } }
    }
    return summary
  }

  private liveView(session: Session): RgView {
    const agent = this.agents.get(session.id)
    const projected = this.ctx.sessionProjections.snapshot(session, ['agentClaim']).values.agentClaim
    const recovery = agent?.session === session ? agent.claimRecovery : null
    const current = recovery != null && recovery.intentSeq !== projected?.intentSeq ? recovery : projected
    const phase = current === projected ? projected?.phase ?? 'unsettled' : 'unsettled'
    const status = projected === undefined ? 'unknown' : this.statusOf(session)
    const claim = this.claimView(current, phase)
    if (status === 'unknown') return { status, state: null, git: null, claim }
    return { status, state: this.projection.stateOf(session).value, git: this.git.read(session), claim }
  }

  private publishView(sessionId: SessionId): void {
    for (const listener of this.viewListeners.get(sessionId) ?? []) {
      try { listener() } catch (error) { this.ctx.logger.error('RG view listener failed: %s', error) }
    }
  }

  /** Follow complete RG snapshots without activating a historical Agent.
   * @param request - authorized Session identity.
   * @param signal - transport lifetime.
   * @returns ordered replacement snapshots; unknown disables dependent actions.
   */
  @Remote({ mode: 'stream', resources: { session: request => request.sessionId } })
  async *watchView(request: { readonly sessionId: SessionId }, signal: AbortSignal): AsyncIterable<RgView> {
    const id = request.sessionId
    const unknown: RgView = { status: 'unknown', state: null, git: null, claim: null }
    let pending: RgView | undefined
    const takePending = () => { const value = pending; pending = undefined; return value }
    let wake: (() => void) | undefined
    let opened = false
    let openingChanged = false
    const changedDuringOpening = () => openingChanged
    const notify = () => { wake?.(); wake = undefined }
    const capture = () => {
      if (!opened) { openingChanged = true; return }
      try {
        const live = this.ctx.sessions.get(id)
        pending = live === undefined ? unknown : this.liveView(live)
      } catch (error) {
        this.ctx.logger.error('RG view snapshot failed: %s', error)
        pending = unknown
      }
      notify()
    }
    const listeners = this.viewListeners.get(id) ?? new Set<() => void>()
    listeners.add(capture)
    this.viewListeners.set(id, listeners)
    const lifetime = AbortSignal.any([signal, this.lifecycle.signal])
    lifetime.addEventListener('abort', notify, { once: true })
    try {
      lifetime.throwIfAborted()
      let initial = unknown
      const query = this.ctx.get('sessionQuery')
      if (this.ctx.sessions.get(id) === undefined && query !== undefined) {
        using observation = await query.observeSession(id, { signal: lifetime, projectionMode: 'all' })
        const values = observation.projections?.values
        const state = sessionStateSchema.nullable().safeParse(values?.reviewGated)
        const git = gitStateSchema.nullable().safeParse(values?.reviewGatedGit)
        if (observation.header.id === id && observation.header.cwd !== undefined
          && state.success && git.success && values?.agentClaim !== undefined
          && !stateContradicted(observation.events, state.data)) initial = {
          status: state.data?.diagnostic == null && state.data?.task?.active?.status !== 'saving'
            && (state.data?.task == null || (noPendingOrigin(values.inbox, state.data.task.originMessageId)
              && !claimRejectedOrigin(values.agentClaim, state.data.task) && taskInputRecorded(observation.events, state.data.task)))
            && (values.agentClaim === null || values.agentClaim.phase === 'rejected' || values.agentClaim.phase === 'empty') ? 'ready' : 'unknown',
          state: state.data, git: git.data, claim: this.claimView(values.agentClaim, values.agentClaim?.phase ?? 'unsettled'),
        }
      }
      lifetime.throwIfAborted()
      const live = this.ctx.sessions.get(id)
      if (live !== undefined) initial = this.liveView(live)
      else if (changedDuringOpening()) initial = unknown
      opened = true
      yield initial
      for (;;) {
        if (lifetime.aborted) return
        const item = takePending()
        if (item !== undefined) { yield item; continue }
        await new Promise<void>((resolve) => { wake = resolve })
      }
    } finally {
      listeners.delete(capture)
      if (listeners.size === 0) this.viewListeners.delete(id)
      lifetime.removeEventListener('abort', notify)
    }
  }

  private async prepareModelEntry(agent: Agent, claimed: readonly UserMessage[], admitted: readonly UserMessage[],
    signal: AbortSignal, selection: Readonly<ModelSelection>, addGuard: (guard: () => undefined) => void): Promise<void> {
    const session = agent.session
    let projected = this.projection.stateOf(session)
    if (projected.failure !== null) throw new RgError('RG_NOT_READY', projected.failure)
    if (projected.value === null) return
    if (this.ctx.get('reviewGated')?.serviceIdentity !== this.serviceIdentity) throw new RgError('RG_NOT_READY', 'The RG service is unavailable. Inspect the Session before continuing.')
    this.assertRequest(agent, selection, { signal, messages: claimed })
    const direct = projected.directClaim
    let directIntent: number | undefined
    if (projected.value.role === 'main' && projected.value.task === null && direct?.phase === 'intent') {
      if (direct.objective === null) {
        throw new RgError('RG_NOT_READY', `The direct task exceeds its frozen limit of ${direct.limit} characters. Inspect the input and open a new RG Session with a shorter task.`)
      }
      if (admitted.length === 0) return
      const originals = claimed.filter(message => message.id === direct.messageId)
      const accepted = admitted.filter(message => message.id === direct.messageId)
      if (agent.claimProtectionStatus !== 'saving' || agent.claimRecovery?.intentSeq !== direct.intentSeq
        || originals.length !== 1 || originals[0]?.source.kind !== 'user'
        || accepted.length !== 1 || accepted[0]?.source.kind !== 'user') {
        throw new RgError('RG_NOT_READY', 'The original task input could not be matched to the admitted message. Inspect the Session before continuing.')
      }
      this.git.assertSettled(agent)
      const task: RgTask = { id: brandString<RgTaskId>(`rg-task-${randomUUID()}`), originMessageId: direct.messageId,
        objective: direct.objective, workRevision: 0, workerAttempts: 0, reviewAttempts: 0,
        active: null, lastWorker: null, lastReview: null, reviewStatus: 'not-reviewed' }
      this.git.clear(session)
      session.append('review-gated/direct-task-prepared', { version: 1, intentSeq: direct.intentSeq, messageId: direct.messageId,
        state: { ...projected.value, task, diagnostic: TASK_SAVE_UNCERTAIN } })
      projected = this.projection.stateOf(session)
      if (projected.failure !== null || projected.directClaim?.phase !== 'prepared'
        || projected.directClaim.intentSeq !== direct.intentSeq || projected.value?.task?.id !== task.id) {
        throw new RgError('RG_NOT_READY', `${TASK_SAVE_UNCERTAIN} The prepared task projection did not match the active claim.`)
      }
      const prepared = JSON.stringify(projected.value)
      await this.flushRequired(session)
      signal.throwIfAborted()
      if (this.ctx.get('reviewGated')?.serviceIdentity !== this.serviceIdentity || this.ctx.sessions.get(agent.id) !== session
        || this.ctx.agents.get(agent.id) !== agent || agent.ctx.fiber.state !== FiberState.ACTIVE
        || JSON.stringify(this.projection.stateOf(session).value) !== prepared) {
        throw new RgError('RG_NOT_READY', `${TASK_SAVE_UNCERTAIN} The task owner or saved state changed during the checkpoint.`)
      }
      directIntent = direct.intentSeq
    }
    const expected = { ...projected.value, ...directIntent === undefined ? {} : { diagnostic: null } }
    const expectedJson = JSON.stringify(expected)
    addGuard(() => {
      signal.throwIfAborted()
      if (this.lifecycle.signal.aborted || this.ctx.get('reviewGated')?.serviceIdentity !== this.serviceIdentity
        || this.ctx.sessions.get(agent.id) !== session || this.ctx.agents.get(agent.id) !== agent
        || agent.ctx.fiber.state !== FiberState.ACTIVE || this.retiredViewAgents.has(agent) || this.uncertainViews.has(session)) {
        throw new RgError('RG_NOT_READY', 'The RG owner changed before model entry. Inspect the Session before continuing.')
      }
      const current = this.projection.stateOf(session)
      const cut = this.ctx.sessionProjections.snapshot(session, ['reviewGated', 'agentClaim'])
      if (current.failure !== null || cut.asOfSeq !== session.seq - 1 || cut.values.reviewGated === undefined
        || cut.values.agentClaim === undefined || JSON.stringify(current.value) !== expectedJson
        || JSON.stringify(cut.values.reviewGated) !== expectedJson) {
        throw new RgError('RG_NOT_READY', 'The RG Session changed before model entry. Inspect it before continuing.')
      }
      const claim = cut.values.agentClaim
      if (claimed.length > 0 && (claim?.phase !== 'entered' || claim.intentSeq !== agent.claimRecovery?.intentSeq)) {
        throw new RgError('RG_NOT_READY', 'The admitted input could not be confirmed. Inspect the Session before continuing.')
      }
      if (directIntent !== undefined && (current.directClaim?.phase !== 'settled' || current.directClaim.intentSeq !== directIntent)) {
        throw new RgError('RG_NOT_READY', TASK_SAVE_UNCERTAIN)
      }
      if (current.value?.role === 'main') {
        if (current.value.policy === null || current.value.diagnostic !== null
          || !current.value.policy.main.candidates.some(route => route.provider === selection.provider
            && route.model === selection.model && route.reasoningEffort === selection.reasoningEffort)
          || this.ctx.agents.modelPolicyFor(agent) === null) {
          throw new RgError('RG_NOT_READY', 'The RG model authorization changed before model entry.')
        }
        this.ctx.agents.assertModelSelectionAllowed(agent, selection)
      } else {
        this.assertRequest(agent, selection)
      }
      return undefined
    })
  }

  /** Check every request against its frozen policy and, for children, its exact live reservation.
   * @param agent - requesting Agent.
   * @param selection - frozen request selection.
   * @param context - exact pre-step messages and signal for a confirmed first claim.
   */
  assertRequest(agent: Agent, selection: Readonly<ModelSelection>,
    context?: { readonly signal: AbortSignal; readonly messages: readonly UserMessage[] }): void {
    this.lifecycle.signal.throwIfAborted()
    if (this.ctx.agents.get(agent.id) !== agent || agent.ctx.fiber.state !== FiberState.ACTIVE) {
      throw new RgError('RG_NOT_READY', 'RG requests require the current live Agent. Inspect the Session before continuing.')
    }
    context?.signal.throwIfAborted()
    if (agent.enableClaimProtection === undefined || agent.claimProtectionStatus === undefined
      || agent.claimRecovery === undefined || agent.exclusiveAdmission === undefined) {
      throw new RgError('RG_NOT_READY', 'Protected input claims are unavailable. Update the Agent provider before continuing.')
    }
    const projected = this.projection.stateOf(agent.session)
    if (projected.failure !== null) throw new RgError('RG_NOT_READY', projected.failure)
    const durableClaim = this.consistentClaim(agent.session)
    if (claimRejectedOrigin(durableClaim, projected.value?.task)) {
      throw new RgError('RG_NOT_READY', 'The task input was rejected before model entry. Inspect the Session before continuing.')
    }
    const claimUnknown = agent.claimProtectionStatus === 'unknown' || (agent.claimProtectionStatus === null && agent.claimRecovery !== null)
    if (projected.value?.role === 'main' && claimUnknown) {
      throw new RgError('RG_NOT_READY', 'The input claim outcome is uncertain. Inspect the Session before continuing.')
    }
    const message = context?.messages.length === 1 ? context.messages[0] : undefined
    const block = message?.content.length === 1 ? message.content[0] : undefined
    const firstClaim = context !== undefined && message !== undefined && block?.type === 'text'
      && projected.value?.role === 'main' && projected.value.task?.originMessageId === message.id
      && projected.taskInputText !== null && block.text === projected.taskInputText
      // The claim is a wire-derived message and must retain the expected role.
      // oxlint-disable-next-line typescript/no-unnecessary-condition
      && message.role === 'user' && message.source.kind === 'user' && Object.keys(message.source).length === 1
      && Object.keys(block).length === 2 && Object.keys(message).length === 4
      && agent.isExclusiveAdmissionClaim?.(RG_TASK_ADMISSION_OWNER, message.id, context.signal) === true
    if (this.tasks.has(agent) && !firstClaim) throw new RgError('RG_BUSY', 'Wait for the new task to finish saving before starting work.')
    if (agent.exclusiveAdmission?.owner === RG_TASK_ADMISSION_OWNER && !firstClaim) {
      throw new RgError('RG_NOT_READY', 'The task input has not been claimed. Inspect the Session before continuing.')
    }
    if (this.departures.has(agent) || this.git.busy(agent)) throw new RgError('RG_BUSY', 'Wait for the local Git operation to settle before starting work.')
    const state = firstClaim ? projected.value : this.read(agent.session)
    if (state?.policy === null || state === null || state.diagnostic !== null) throw new RgError('RG_NOT_READY', state?.diagnostic ?? 'RG is not ready. Configure the plugin and open a new RG Session.')
    let candidates = state.policy[state.role].candidates
    if (state.role !== 'main') {
      const live = this.runs.get(agent.id)
      const parent = live === undefined ? null : this.read(live.parent.session)
      const active = parent?.task?.active
      if (live === undefined || live.child !== agent || this.ctx.agents.get(agent.id) !== agent
        || this.ctx.agents.get(live.parent.id) !== live.parent || parent?.role !== 'main'
        || state.parentSessionId !== live.parent.id || agent.session.header.parentSession !== live.parent.id
        || state.taskId !== live.taskId || parent.task?.id !== live.taskId || state.runId !== live.run.id
        || active?.id !== live.run.id || active.childId !== agent.id || active.role !== state.role
        || live.run.role !== state.role) {
        throw new RgError('RG_UNAUTHORIZED_START', 'This RG child has no current live task reservation. Start a fresh role within the remaining budget.')
      }
      candidates = [live.run.selection]
    }
    if (claimUnknown) throw new RgError('RG_NOT_READY', 'The input claim outcome is uncertain. Inspect the Session before continuing.')
    const allowed = candidates.some(route => route.provider === selection.provider
      && route.model === selection.model && route.reasoningEffort === selection.reasoningEffort)
    if (!allowed) throw new RgError('RG_MODEL_NOT_ALLOWED', 'This request does not match the Session role model pool and configured reasoning. Choose an authorized candidate.')
    if (this.ctx.agents.modelPolicyFor(agent) === null) throw new RgError('RG_NOT_READY', 'The RG Session model policy was not fully initialized. Open a new configured RG Session.')
    this.ctx.agents.assertModelSelectionAllowed(agent, selection)
  }

  /** Start a new budget only from a human-owned Remote action. Concurrent actions on the same Agent are refused.
   * A failed save or interrupted delivery leaves the task outcome uncertain and refuses further RG work.
   * @param agent - exact Session selected in the GUI.
   * @param objective - human-entered next task.
   * @returns the new task after its input is submitted.
   */
  @Remote
  async newTask(agent: Agent, objective: string): Promise<RgTask> {
    return this.remoteAction(async () => {
      if (principalOf(this.ctx.invocation) !== undefined) throw new RgError('RG_NOT_READY', 'Only the workspace owner may create a new RG task budget.')
      if (agent.status !== 'idle' || this.tasks.has(agent)) throw new RgError('RG_BUSY', 'Wait until the RG main Agent is idle before starting a new task.')
      if (agent.inbox.nextStep.length !== 0 || agent.inbox.nextTurn.length !== 0) {
        throw new RgError('RG_BUSY', 'Clear or process pending Agent input before starting a new RG task.')
      }
      const state = this.requireMain(agent)
      this.git.assertSettled(agent)
      const normalized = objective.trim()
      if (normalized === '' || normalized.length > state.policy.maxHandoffChars) throw new RgError('RG_NOT_READY', 'Give RG a non-empty task within its configured handoff limit.')
      if (state.task?.active != null) throw new RgError('RG_BUSY', 'Finish or stop the current RG role before starting a new task.')
      if (agent.runExclusiveAdmission === undefined || agent.exclusiveAdmission === undefined
        || agent.isExclusiveAdmissionClaim === undefined) {
        throw new RgError('RG_NOT_READY', 'Exclusive task admission is unavailable. Update the Agent provider or open a new RG Session.')
      }
      const message: UserMessage = { id: brandString<MessageId>(randomUUID()), role: 'user', content: [{ type: 'text', text: objective }], source: { kind: 'user' } }
      const task: RgTask = { id: brandString<RgTaskId>(`rg-task-${randomUUID()}`), originMessageId: message.id, objective: normalized,
        workRevision: 0, workerAttempts: 0, reviewAttempts: 0, active: null, lastWorker: null, lastReview: null, reviewStatus: 'not-reviewed' }
      const done = Promise.withResolvers<void>()
      const pending: { stopped: boolean; deliveryId?: MessageId; readonly settled: Promise<void> } = {
        stopped: false, deliveryId: message.id, settled: done.promise,
      }
      const unowned = () => pending.stopped || this.lifecycle.signal.aborted || this.ctx.agents.get(agent.id) !== agent
        || this.ctx.sessions.get(agent.id) !== agent.session || agent.ctx.fiber.state !== FiberState.ACTIVE
      const hasInput = () => agent.inbox.nextStep.length !== 0 || agent.inbox.nextTurn.length !== 0
      this.tasks.set(agent, pending)
      this.publishView(agent.session.id)
      try {
        this.ownParent(agent)
        try {
          await agent.runExclusiveAdmission(RG_TASK_ADMISSION_OWNER, message, async (signal) => {
            signal.throwIfAborted()
            const opened = this.projection.stateOf(agent.session)
            if (unowned() || opened.failure !== null
              || opened.taskAdmission?.messageId !== message.id || opened.taskAdmission.taskId !== null
              || JSON.stringify(opened.value) !== JSON.stringify({ ...state, diagnostic: TASK_SAVE_UNCERTAIN })
              || hasInput()) throw new RgError('RG_NOT_READY', TASK_SAVE_UNCERTAIN)
            this.git.assertSettled(agent)
            agent.session.append('review-gated/task-prepared', { version: 1, messageId: message.id, input: objective,
              state: { ...state, task, diagnostic: TASK_SAVE_UNCERTAIN } })
            const prepared = this.projection.stateOf(agent.session)
            if (prepared.failure !== null || prepared.taskAdmission?.taskId !== task.id) throw new RgError('RG_NOT_READY', TASK_SAVE_UNCERTAIN)
            this.git.clear(agent.session)
            await this.flushRequired(agent.session)
            signal.throwIfAborted()
            const current = this.projection.stateOf(agent.session)
            if (unowned() || current.failure !== null
              || current.taskAdmission?.messageId !== message.id || current.taskAdmission.taskId !== task.id
              || hasInput()) throw new RgError('RG_NOT_READY', TASK_SAVE_UNCERTAIN)
            return task
          })
          const committed = this.projection.stateOf(agent.session)
          if (unowned() || committed.failure !== null || committed.value?.task?.id !== task.id
            || committed.value.diagnostic !== null || this.git.read(agent.session) !== null) throw new RgError('RG_NOT_READY', TASK_SAVE_UNCERTAIN)
          return task
        } catch (error) {
          this.uncertainViews.add(agent.session)
          this.ctx.logger.error('RG task admission failed: %s', error)
          throw new RgError('RG_NOT_READY', TASK_SAVE_UNCERTAIN)
        }
      } finally { this.tasks.delete(agent); this.publishView(agent.session.id); done.resolve() }
    })
  }

  /** Authorize local commits for one unused task; no remote publication is granted.
   * @param agent - exact idle main Agent selected by the workspace owner.
   * @param scope - explicit repository-relative files or directories approved by the human.
   * @param signal - cancels Git inspection; accepted work remains owned until its flush settles.
   * @returns the committed local-only task grant.
   */
  @Remote
  async authorizeLocalGit(agent: Agent, scope: readonly string[], signal: AbortSignal): Promise<RgGitState> {
    return this.remoteAction(async () => {
      if (principalOf(this.ctx.invocation) !== undefined) throw new RgError('RG_GIT_AUTH_REQUIRED', 'Only the workspace owner may authorize local Git delivery.')
      const state = this.requireMain(agent)
      if (agent.status !== 'idle' || state.task === null || state.task.active !== null
        || state.task.workerAttempts !== 0 || state.task.reviewAttempts !== 0) {
        throw new RgError('RG_BUSY', 'Authorize local Git delivery on an idle, unused human task before starting any role.')
      }
      this.ownParent(agent)
      const taskId = state.task.id
      let publishedGrant: RgGitState | null = null
      const getPublishedGrant = () => publishedGrant
      const stillIdle = () => agent.status === 'idle'
      const stop = this.ctx.on('session/event', (session, event) => {
        if (session === agent.session && publishedGrant === null && event.type === 'review-gated/git-state'
          && event.data.state?.status === 'authorized') publishedGrant = event.data.state
      })
      let operation: Promise<RgGitState>
      try { operation = this.git.authorize(agent, state.task, state.policy, scope, AbortSignal.any([signal, this.lifecycle.signal]), () => {
        const current = this.requireMain(agent)
        if (agent.status !== 'idle' || current.task?.id !== taskId || current.task.active !== null
          || current.task.workerAttempts !== 0 || current.task.reviewAttempts !== 0) {
          throw new RgError('RG_BUSY', 'The task changed during Git inspection; authorize the current idle task again.')
        }
      }) } catch (error) { stop(); throw error }
      this.publishView(agent.id)
      try {
        const grant = await operation
        const current = this.read(agent.session)
        if (this.lifecycle.signal.aborted || this.ctx.agents.get(agent.id) !== agent || this.ctx.sessions.get(agent.id) !== agent.session
          || agent.ctx.fiber.state !== FiberState.ACTIVE || !stillIdle() || agent.claimProtectionStatus !== null
          || agent.claimRecovery !== null || JSON.stringify(current) !== JSON.stringify(state)
          || JSON.stringify(this.git.read(agent.session)) !== JSON.stringify(grant)) {
          this.uncertainViews.add(agent.session)
          throw new RgError('RG_GIT_CHANGED', 'The Git authorization owner or grant changed while saving. Inspect the Session and retained workspace.')
        }
        return grant
      } catch (error) {
        if (error instanceof RgError && error.code === 'RG_GIT_CHANGED') this.uncertainViews.add(agent.session)
        if (error instanceof RgError && error.code === 'RG_GIT_UNKNOWN') {
          try {
            const actual = this.git.read(agent.session)
            const grant = getPublishedGrant()
            const current = this.read(agent.session)
            if (actual?.status !== 'unknown' || grant === null || JSON.stringify(current) !== JSON.stringify(state)
              || this.lifecycle.signal.aborted || this.ctx.agents.get(agent.id) !== agent || !stillIdle()
              || agent.claimProtectionStatus !== null || agent.claimRecovery !== null
              || this.ctx.sessions.get(agent.id) !== agent.session || agent.ctx.fiber.state !== FiberState.ACTIVE
              || JSON.stringify({ ...grant, status: 'unknown', diagnostic: actual.diagnostic }) !== JSON.stringify(actual)) {
              this.uncertainViews.add(agent.session)
            }
          } catch (inspectionError) {
            this.uncertainViews.add(agent.session)
            this.ctx.logger.error('RG could not inspect uncertain Git authorization: %s', inspectionError)
          }
        }
        throw error
      } finally { stop(); this.publishView(agent.id) }
    })
  }

  /** Explicitly leave local Git delivery, retaining all branches and checkouts for human inspection.
   * @param agent - idle coordinating Agent selected by the workspace owner.
   */
  @Remote
  async leaveLocalGit(agent: Agent): Promise<void> {
    return this.remoteAction(async () => {
      if (principalOf(this.ctx.invocation) !== undefined) throw new RgError('RG_GIT_AUTH_REQUIRED', 'Only the workspace owner may leave local Git delivery.')
      const state = this.requireMain(agent)
      if (agent.status !== 'idle' || state.task?.active != null || this.git.busy(agent)) throw new RgError('RG_BUSY', 'Wait until the Git role and its accepted operations have settled.')
      const done = Promise.withResolvers<void>()
      this.departures.set(agent, done.promise)
      this.publishView(agent.id)
      try {
        this.ownParent(agent)
        this.git.clear(agent.session)
        if (state.task?.lastReview != null) this.commit(agent.session, { ...state, task: { ...state.task, reviewStatus: 'stale' } })
        const pending = JSON.stringify(this.read(agent.session))
        try {
          await this.flushRequired(agent.session)
          if (this.git.read(agent.session) !== null || JSON.stringify(this.read(agent.session)) !== pending) {
            throw new RgError('RG_GIT_CHANGED', 'The Session or local Git grant changed during departure. Inspect both before continuing.')
          }
        } catch (error) {
          const current = this.read(agent.session)
          if (current?.role === 'main') this.commit(agent.session, { ...current, diagnostic: 'Local Git departure may not be saved. Inspect the Session and retained worktrees before continuing.' })
          throw error
        }
      } finally { this.departures.delete(agent); this.publishView(agent.id); done.resolve() }
    })
  }

  /** Read the task's committed local Git facts without starting commands.
   * @param session - prepared owner Session.
   * @returns null in workspace mode, otherwise the current local delivery facts.
   */
  readGit(session: Session): RgGitState | null { return this.git.read(session) }

  /** Recheck a previous report's exact scope without launching another model.
   * @param agent - Session owning the review.
   * @param signal - cancels file inspection.
   * @returns current RG state after any stale-report mutation.
   */
  @Remote
  async recheck(agent: Agent, signal: AbortSignal): Promise<RgSessionState | null> {
    return this.remoteAction(async () => {
      const state = this.read(agent.session)
      const review = state?.task?.lastReview
      if (state?.role !== 'main' || state.policy === null || state.task?.reviewStatus !== 'reported-pass' || review == null) return state
      if (this.git.read(agent.session) !== null) {
        if (this.git.busy(agent)) throw new RgError('RG_BUSY', 'The Git candidate is still being checked. Wait for that verification before relying on the review.')
        this.ownParent(agent)
        const verification = this.git.verifyReview(agent, review.id, state.policy, signal)
        this.publishView(agent.id)
        try {
          const valid = await verification
          const current = this.read(agent.session)
          if (!valid && current?.task?.id === state.task.id && current.task.lastReview?.id === review.id) {
            this.commit(agent.session, { ...current, task: { ...current.task, reviewStatus: 'stale' } })
          }
          return this.read(agent.session)
        } finally { this.publishView(agent.id) }
      }
      if (review.scope === null) {
        this.commit(agent.session, { ...state, task: { ...state.task, reviewStatus: 'stale' } })
        return this.read(agent.session)
      }
      const scope = await captureScope(this.ctx.fs, review.scope.root, review.scope.paths, state.policy, signal)
      const current = this.read(agent.session)
      if (current?.task?.id !== state.task.id || current.task.lastReview?.id !== review.id) return current
      if (scope.fingerprint === null || scope.fingerprint !== review.scope.fingerprint) {
        this.commit(agent.session, { ...current, task: { ...current.task, reviewStatus: 'stale' } })
      }
      return this.read(agent.session)
    })
  }

  private async remoteAction<T>(action: () => Promise<T>): Promise<T> {
    try { return await action() } catch (error) {
      if (error instanceof RgError) throw new RemoteError('review-gated/refused', error.message, { reason: error.code })
      throw error
    }
  }

  /** Admit one fresh role after model preflight, then notify its parent on formal settlement.
   * @param parent - coordinating main Agent.
   * @param role - worker or reviewer.
   * @param input - complete structured handoff.
   * @param requested - optional candidate route.
   * @param signal - cancellation of startup, not the lifetime of an already-returned tool call.
   * @returns the started role identity; it is not a completion or pass.
   */
  async startRole(parent: Agent, role: 'worker' | 'reviewer', input: RgHandoff, requested: { provider: string; model: string } | undefined, signal: AbortSignal): Promise<{ kind: 'activation'; subagentId: SessionId; runId: RgRunId }> {
    const handoff = handoffSchema.parse(input)
    const initial = this.requireMain(parent)
    const initialState = JSON.stringify(initial)
    const initialGit = JSON.stringify(this.git.read(parent.session))
    const policy = initial.policy
    if (JSON.stringify(handoff).length > policy.maxHandoffChars) throw new RgError('RG_NOT_READY', 'The complete handoff exceeds the configured RG character limit. Narrow its scope.')
    const selection = resolveModel(policy[role], requested)
    await this.ctx.llm.resolveCallConfig(rgSelection(selection), signal)
    signal.throwIfAborted()
    this.lifecycle.signal.throwIfAborted()
    const state = this.requireMain(parent)
    this.git.assertSettled(parent)
    if (JSON.stringify(state) !== initialState || JSON.stringify(this.git.read(parent.session)) !== initialGit) {
      throw new RgError('RG_BUSY', 'The RG task or local Git delivery changed during role preflight. Inspect the current task before starting a role.')
    }
    if (state.task === null) throw new RgError('RG_TASK_REQUIRED', 'RG needs a direct human task before starting a role.')
    this.git.preflight(parent, state.task, policy, role, handoff)
    const childId = SessionId(`rg-child-${randomUUID()}`)
    const run: RgRun = { id: brandString<RgRunId>(`rg-run-${randomUUID()}`), childId, role,
      workRevision: state.task.workRevision + (role === 'worker' ? 1 : 0), selection, status: 'reserved', report: null, diagnostic: null, scope: null }
    const task = reserveRun(state.task, policy, run)
    const startup = Promise.withResolvers<void>()
    const live: LiveRun = {
      parent, run, taskId: task.id, child: undefined, control: new AbortController(), startup: startup.promise,
      parentCancelled: false, settling: false, activation: undefined, completion: undefined, delivery: null,
    }
    this.ownParent(parent)
    this.runs.set(childId, live)
    this.commit(parent.session, { ...state, task })
    let reservationSaved = false
    try {
      await this.flushRequired(parent.session)
      reservationSaved = true
      signal.throwIfAborted()
      live.control.signal.throwIfAborted()
      this.lifecycle.signal.throwIfAborted()
      this.activeState(live)
      const control = AbortSignal.any([signal, live.control.signal, this.lifecycle.signal])
      const gitWorkspace = await this.git.prepare(parent, task, policy, run, handoff, control)
      const prepared = this.git.read(parent.session)
      if (gitWorkspace === null) {
        if (prepared !== null) throw new RgError('RG_GIT_CHANGED', 'The local Git grant changed during role preparation.')
        live.delivery = { kind: 'workspace' }
      } else {
        if (prepared?.taskId !== task.id || prepared.binding?.runId !== run.id || prepared.binding.role !== run.role
          || prepared.binding.checkout?.root !== gitWorkspace.cwd) {
          throw new RgError('RG_GIT_CHANGED', 'The prepared Git checkout is no longer bound to this role. Inspect retained worktrees before continuing.')
        }
        live.delivery = { kind: 'git', prepared }
      }
      const cwd = gitWorkspace?.cwd ?? await this.ctx.workingDirectory.ensure(parent, control)
      const scope = role === 'reviewer' && gitWorkspace === null ? await captureScope(this.ctx.fs, cwd, handoff.scope, policy, control) : null
      this.replaceActive(live, { scope })
      const prompt = ['Original human task:', task.objective, 'Assigned requirements and evidence:', JSON.stringify(handoff),
        ...gitWorkspace === null ? [] : ['Host-verified local Git delivery:', gitWorkspace.context],
        role === 'reviewer' ? 'Inspect actual files independently. Report only evidence-based defects; do not edit. A pass covers only the stated scope and state.' : 'Perform only the assigned implementation. Preserve existing user changes and run relevant validation.',
        'Return the formal result using the structured_output SDK binding inside run_code. Ordinary progress messages are not the final report.'].join('\n\n')
      const lifetime = AbortSignal.any([live.control.signal, this.lifecycle.signal])
      const startupAbort = () =>{  live.control.abort(signal.reason) }
      signal.addEventListener('abort', startupAbort, { once: true })
      try {
        live.activation = await this.ctx.subagents.startActivation({ provider: 'spawn', lifecycle: 'one-shot', childId, label: `RG ${role}: ${handoff.objective}`,
          request: { parent, cwd, agentPreset: `rg-${role}`, prompt: [{ type: 'text', text: prompt }],
            agentOptions: { ...rgSelection(selection),
              reasoningEffort: selection.reasoningEffort === undefined
                ? undefined : brandString<ReasoningEffortId>(selection.reasoningEffort) },
            outputSchema: role === 'worker' ? workerOutputSchema : reviewerOutputSchema }, signal: lifetime, delivery: 'caller' })
      } finally { signal.removeEventListener('abort', startupAbort) }
      this.replaceActive(live, { status: 'running' })
      live.completion = this.finish(live, live.activation.result, policy).catch((error: unknown) => {
        this.uncertainViews.add(parent.session)
        const diagnostic = 'RG_RESULT_SAVE_FAILED: the role result could not be saved reliably. Inspect the Session and workspace before continuing.'
        const failed = this.failureState(live)
        if (failed !== null) {
          this.commit(parent.session, { ...failed, diagnostic, task: { ...failed.task, active: null, reviewStatus: 'inconclusive' } })
          parent.cancel({ kind: 'parent' })
        }
        this.ctx.logger.error('RG role result could not be durably settled: %s', error)
      }).finally(() => { this.runs.delete(childId); this.publishView(parent.id) })
      return { kind: 'activation', subagentId: childId, runId: run.id }
    } catch (error) {
      const failures: unknown[] = []
      if (!reservationSaved) failures.push(new Error('The role reservation may not have been saved. Inspect the Session before continuing.'))
      try {
        const cleanup = await Promise.allSettled([
          Promise.resolve().then(() => live.activation?.dispose()),
          Promise.resolve().then(() => this.git.failedRun(parent, run.id)),
        ])
        for (const result of cleanup) if (result.status === 'rejected') failures.push(result.reason)
        try {
          const active = this.failureState(live)?.task.active
          if (active?.id === run.id && active.childId === run.childId) {
            this.settle(live, { status: signal.aborted || live.control.signal.aborted || this.lifecycle.signal.aborted ? 'cancelled' : 'failed',
              report: null, scope: active.scope, diagnostic: 'The RG role did not start. Inspect the Session and partial workspace changes before another attempt.' }, false)
            await this.flushRequired(parent.session)
          }
        } catch (settlementError) { failures.push(settlementError) }
        if (failures.length > 0) {
          const diagnostic = 'RG_RESULT_SAVE_FAILED: startup cleanup or its result could not be saved reliably. Inspect the Session and workspace before continuing.'
          let owned = false
          try {
            const failed = this.failureState(live)
            if (failed !== null) {
              owned = true
              this.commit(parent.session, { ...failed, diagnostic, task: { ...failed.task, active: null, reviewStatus: 'inconclusive' } })
              await this.flushRequired(parent.session)
            }
          } catch (saveError) { failures.push(saveError) }
          if (owned) parent.cancel({ kind: 'parent' })
          throw new AggregateError([error, ...failures], 'RG startup or cleanup has an uncertain outcome. Inspect the Session and retained workspace before continuing.')
        }
        throw error
      } finally { this.runs.delete(childId); this.publishView(parent.id) }
    } finally { startup.resolve() }
  }

  private requireMain(agent: Agent, permitPendingTask = false): RgSessionState & { policy: RgPolicy } {
    this.lifecycle.signal.throwIfAborted()
    if (!permitPendingTask && this.tasks.has(agent)) throw new RgError('RG_BUSY', 'Wait for the new task to finish saving before starting work.')
    if (this.departures.has(agent)) throw new RgError('RG_BUSY', 'Wait for local Git departure to finish saving before starting work.')
    if (agent.enableClaimProtection === undefined || agent.claimProtectionStatus === undefined
      || agent.claimRecovery === undefined || agent.exclusiveAdmission === undefined) {
      throw new RgError('RG_NOT_READY', 'Protected input claims are unavailable. Update the Agent provider before continuing.')
    }
    if (agent.claimProtectionStatus === 'unknown' || (agent.claimProtectionStatus === null && agent.claimRecovery !== null)
      || (!permitPendingTask && (agent.claimProtectionStatus === 'saving' || agent.exclusiveAdmission?.owner === RG_TASK_ADMISSION_OWNER))) {
      throw new RgError('RG_NOT_READY', 'The input claim outcome is uncertain. Inspect the Session before continuing.')
    }
    if (this.ctx.agents.get(agent.id) !== agent || agent.ctx.fiber.state !== FiberState.ACTIVE) {
      throw new RgError('RG_NOT_READY', 'RG work requires the current live main Agent before its scope starts disposing.')
    }
    if ([...this.runs.values()].some(run => run.parent === agent && run.parent.id === agent.id && this.read(agent.session)?.task?.active === null)) throw new RgError('RG_BUSY', 'The previous role result is still being saved. Wait before starting more RG work.')
    const state = this.read(agent.session)
    const claim = this.consistentClaim(agent.session)
    if (this.ctx.sessions.get(agent.id) !== agent.session || claimRejectedOrigin(claim, state?.task)
      || state === null || state.role !== 'main' || state.policy === null || state.diagnostic !== null) {
      throw new RgError('RG_NOT_READY', state?.diagnostic ?? 'Only an initialized RG main Agent may start roles.')
    }
    return { ...state, policy: state.policy }
  }

  private ownParent(parent: Agent): void {
    if (this.parents.has(parent)) return
    const dispose = parent.ctx.effect(() => async () => {
      const pending = this.tasks.get(parent)
      if (pending !== undefined) pending.stopped = true
      try {
        await Promise.all([
          pending?.settled,
          this.departures.get(parent),
          this.drain([...this.runs.values()].filter(live => live.parent === parent),
            new Error('The RG parent Agent was disposed; no further role work is authorized.')),
          this.git.cancelParent(parent),
        ])
      } finally { this.parents.delete(parent) }
    })
    this.parents.set(parent, dispose)
  }

  private async drain(pending: readonly LiveRun[], reason: unknown): Promise<void> {
    for (const live of pending) { live.parentCancelled = true; live.control.abort(reason) }
    const results = await Promise.all(pending.map(async (live) => {
      await live.startup
      return Promise.allSettled([
        Promise.resolve().then(() => live.activation?.dispose()),
        live.completion,
      ])
    }))
    const failures: unknown[] = []
    for (const outcomes of results) {
      for (const result of outcomes) {
        if (result.status === 'rejected') failures.push(result.reason)
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'RG role cleanup failed')
  }

  private bindModel(agent: Agent, policy: RgPolicy, role: RgRole, chosen?: RgModel): void {
    const pool = policy[role]
    const selected = chosen ?? resolveModel(pool)
    this.ctx.agents.bindModelPolicy(agent, {
      allowedSelections: (role === 'main' ? pool.candidates : [selected]).map(rgSelection), defaultSelection: rgSelection(selected), rememberDefault: false,
    })
    agent.model.select(rgSelection(selected))
  }

  private guardStart(spec: Readonly<SubagentActivationSpec>): void {
    const parent = this.read(spec.request.parent.session)
    const rgPreset = spec.request.agentPreset === 'rg-worker' || spec.request.agentPreset === 'rg-reviewer'
    if (parent === null && !rgPreset) return
    if (parent?.role !== 'main' || parent.policy === null) throw new RgError('RG_UNAUTHORIZED_START', 'An RG role requires its main Agent and a durable task reservation.')
    const run = parent.task?.active
    const options = spec.request.agentOptions
    const git = this.git.read(spec.request.parent.session)
    if (git !== null && (git.binding?.runId !== run?.id || git.binding?.checkout?.root !== spec.request.cwd)) {
      throw new RgError('RG_UNAUTHORIZED_START', 'The Git role must start in its exact Host-prepared checkout.')
    }
    if (run === null || run === undefined || spec.childId !== run.childId || !this.runs.has(run.childId)
      || spec.lifecycle !== 'one-shot' || spec.provider !== 'spawn' || spec.request.agentPreset !== `rg-${run.role}`
      || options?.provider !== run.selection.provider || options.model !== run.selection.model
      || options.reasoningEffort !== run.selection.reasoningEffort
      || spec.request.outputSchema !== (run.role === 'worker' ? workerOutputSchema : reviewerOutputSchema)) {
      throw new RgError('RG_UNAUTHORIZED_START', 'Start RG roles through rg_worker or rg_reviewer; unreserved, continued, or mismatched role starts are refused.')
    }
  }

  private commit(session: Session, state: RgSessionState | null): void {
    session.append('review-gated/state', { version: 1, state })
  }

  private async flushRequired(session: Session): Promise<void> {
    if (!await this.ctx.sessions.flush(session)) {
      throw new RgError('RG_NOT_READY', 'The Session save outcome is uncertain. Inspect the Session and retained workspace before continuing.')
    }
  }

  private failureState(live: LiveRun): (RgSessionState & { task: RgTask }) | null {
    const state = this.read(live.parent.session)
    const task = state?.task
    if (state?.role !== 'main' || state.policy === null || task == null || task.id !== live.taskId
      || this.runs.get(live.run.childId) !== live) return null
    const run = task.active ?? (live.run.role === 'worker' ? task.lastWorker : task.lastReview)
    if (run?.id !== live.run.id || run.childId !== live.run.childId || run.role !== live.run.role) return null
    return { ...state, task }
  }

  private activeState(live: LiveRun): RgSessionState & { task: RgTask & { active: RgRun } } {
    const state = this.read(live.parent.session)
    const task = state?.task
    const active = task?.active
    if (state?.role !== 'main' || state.policy === null || task === null || task === undefined
      || active === null || active === undefined || task.id !== live.taskId || active.id !== live.run.id
      || active.childId !== live.run.childId || this.runs.get(active.childId) !== live) {
      throw new RgError('RG_UNAUTHORIZED_START', 'The RG role reservation is no longer current.')
    }
    return { ...state, task: { ...task, active } }
  }

  private replaceActive(live: LiveRun, patch: Partial<RgRun>): void {
    const state = this.activeState(live)
    this.commit(live.parent.session, { ...state, task: { ...state.task, active: { ...state.task.active, ...patch } } })
  }

  private settle(live: LiveRun, outcome: Pick<RgRun, 'status' | 'report' | 'diagnostic' | 'scope'>, matches: boolean): void {
    const state = this.activeState(live)
    live.settling = true
    try { this.commit(live.parent.session, { ...state, task: settleRun(state.task, live.run.id, outcome, matches) }) }
    finally { live.settling = false }
  }

  private async failDelivery(live: LiveRun): Promise<void> {
    if (live.delivery?.kind !== 'git') return
    const before = live.delivery.prepared
    const current = this.git.read(live.parent.session)
    if (current === null || current.taskId !== before.taskId || current.configurationHash !== before.configurationHash
      || current.worktreeName !== before.worktreeName || JSON.stringify(current.source) !== JSON.stringify(before.source)
      || JSON.stringify(current.scope) !== JSON.stringify(before.scope)) return
    await this.git.failedRun(live.parent, live.run.id)
  }

  private resultOwnerIsLive(live: LiveRun): boolean {
    return !this.lifecycle.signal.aborted && !live.control.signal.aborted && !live.parentCancelled
      && this.ctx.agents.get(live.parent.id) === live.parent && this.ctx.sessions.get(live.parent.id) === live.parent.session
      && live.parent.ctx.fiber.state === FiberState.ACTIVE
  }

  private async finish(live: LiveRun, result: Promise<SubagentResult>, policy: RgPolicy): Promise<void> {
    let report: RgReport | null = null
    let diagnostic: string | null = null
    let status: RgRun['status'] = 'failed'
    let matches = false
    let verifiedGit: string | null = null
    let scope = this.read(live.parent.session)?.task?.active?.scope ?? null
    try {
      const settled = await result
      await live.activation?.dispose()
      status = settled.stopReason === 'aborted' ? 'cancelled' : settled.stopReason === 'completed' ? 'completed' : 'failed'
      diagnostic = status === 'completed' ? null : 'The RG role did not complete. Inspect its child Session log and partial workspace changes before another attempt.'
      if (status === 'completed') {
        /* v8 ignore next -- the local manager only completes required-schema runs after capture; retain the malformed-result guard. */
        const serialized = settled.structured === undefined ? undefined : JSON.stringify(settled.structured)
        if (serialized === undefined || serialized.length > policy.maxReportChars) throw new RgError('RG_INVALID_REPORT', 'The structured role report exceeds its configured character limit. Narrow the report before another attempt.')
        const parsed = (live.run.role === 'worker' ? workerReportSchema : reviewReportSchema).safeParse(settled.structured)
        if (!parsed.success) throw new RgError('RG_INVALID_REPORT', 'The structured role report is invalid. Inspect the child Session log and correct the report before another attempt.')
        report = parsed.data
        const delivery = live.delivery
        if (delivery === null) throw new RgError('RG_GIT_CHANGED', 'The role delivery mode was not prepared.')
        const currentGit = this.git.read(live.parent.session)
        if (delivery.kind === 'workspace' && currentGit !== null) {
          throw new RgError('RG_GIT_CHANGED', 'The delivery mode changed while the role was running. Inspect the Session before continuing.')
        }
        if (delivery.kind === 'git') {
          if (JSON.stringify(currentGit) !== JSON.stringify(delivery.prepared)) {
            throw new RgError('RG_GIT_CHANGED', 'The prepared Git grant changed while the role was running. Inspect the retained checkout before continuing.')
          }
          if (report.kind === 'worker' && report.outcome === 'completed') {
            this.activeState(live)
            const boundedReport = boundCompletion({ role: live.run.role, status, report, diagnostic,
              reviewStatus: currentReviewStatus(this.read(live.parent.session)) }, policy.maxReportChars)
            if (boundedReport.report === null) throw new RgError('RG_INVALID_REPORT', 'The complete formal report exceeds its configured parent-notice limit.')
            await this.git.finalize(live.parent, live.run.id, policy, report, AbortSignal.any([live.control.signal, this.lifecycle.signal]))
            const after = this.git.read(live.parent.session)
            const before = delivery.prepared
            const workspace = before.workspace
            if (after === null || workspace === null || after.taskId !== before.taskId
              || after.configurationHash !== before.configurationHash
              || after.worktreeName !== before.worktreeName || JSON.stringify(after.source) !== JSON.stringify(before.source)
              || JSON.stringify(after.scope) !== JSON.stringify(before.scope) || after.status !== 'candidate' || after.binding !== null
              || after.candidate?.workerRunId !== live.run.id || after.workspace?.root !== workspace.root
              || after.workspace.gitDir !== workspace.gitDir || after.workspace.commonDir !== workspace.commonDir
              || JSON.stringify(after.candidate.inspection) !== JSON.stringify(after.workspace)) {
              throw new RgError('RG_GIT_UNKNOWN', 'The Git grant or candidate changed after finalization. A commit may exist in the retained checkout; inspect it before continuing.')
            }
            verifiedGit = JSON.stringify(after)
          } else if (report.kind === 'reviewer') {
            matches = await this.git.verifyReview(live.parent, live.run.id, policy,
              AbortSignal.any([live.control.signal, this.lifecycle.signal]))
            if (matches) {
              const after = this.git.read(live.parent.session)
              matches = JSON.stringify(after) === JSON.stringify({ ...delivery.prepared, status: 'candidate' })
              if (matches) verifiedGit = JSON.stringify(after)
            }
            if (!matches) diagnostic = 'The Git candidate or independent review checkout is no longer the exact verified version.'
          } else await this.failDelivery(live)
        }
        if (scope !== null && live.run.role === 'reviewer') {
          const end = await captureScope(this.ctx.fs, scope.root, scope.paths, policy, this.lifecycle.signal)
          matches = scope.fingerprint !== null && end.fingerprint === scope.fingerprint
          if (!matches) diagnostic = end.diagnostic ?? 'The inspected scope changed during review.'
          else if (scope.treeFingerprint !== null && end.treeFingerprint !== scope.treeFingerprint) {
            // Reported, not enforced: the pass covers the declared scope only.
            diagnostic = 'Workspace content outside the declared review scope changed during the review. Treat the pass as scoped and inspect the other changes separately.'
          }
          scope = end
        }
      }
    } catch (error) {
      report = null
      status = live.control.signal.aborted || this.lifecycle.signal.aborted ? 'cancelled' : 'failed'
      diagnostic = error instanceof RgError ? error.message : 'The RG role result could not be verified. Inspect the child Session log and partial workspace changes before another attempt.'
      this.ctx.logger.warn('RG role result could not be verified: %s', error)
    }
    if (status !== 'completed') await this.failDelivery(live)
    const current = this.activeState(live)
    const outcome = { status, report, diagnostic, scope }
    const reviewStatus = settleRun(current.task, live.run.id, outcome, matches).reviewStatus
    const bounded = boundCompletion({ role: live.run.role, status, report, diagnostic, reviewStatus }, policy.maxReportChars)
    if (bounded.status !== 'completed') {
      this.replaceActive(live, { status: 'saving', report: null, diagnostic: bounded.diagnostic, scope })
      await this.flushRequired(live.parent.session)
      this.settle(live, { status: bounded.status, report: null, diagnostic: bounded.diagnostic, scope }, false)
      await this.flushRequired(live.parent.session)
      if (!this.lifecycle.signal.aborted && !live.parentCancelled && this.ctx.agents.get(live.parent.id) === live.parent) {
        live.parent.followup(this.notice(bounded.text))
      }
      return
    }
    this.replaceActive(live, { status: 'saving', report: null, diagnostic: null, scope })
    const saving = this.activeState(live)
    const candidate = { ...saving, task: settleRun(saving.task, live.run.id,
      { status: bounded.status, report: bounded.report, diagnostic: bounded.diagnostic, scope }, matches) }
    const identity = { version: 1 as const, taskId: live.taskId, runId: live.run.id, childId: live.run.childId }
    live.parent.session.append('review-gated/result-prepared', { ...identity, scopeMatches: matches, state: candidate })
    await this.flushRequired(live.parent.session)
    this.lifecycle.signal.throwIfAborted()
    live.control.signal.throwIfAborted()
    if (live.parentCancelled || this.ctx.agents.get(live.parent.id) !== live.parent
      || live.parent.ctx.fiber.state !== FiberState.ACTIVE) throw new RgError('RG_NOT_READY', 'The RG parent stopped before its result was confirmed.')
    this.activeState(live)
    if (live.delivery?.kind === 'workspace' && this.git.read(live.parent.session) !== null) {
      throw new RgError('RG_GIT_CHANGED', 'The delivery mode changed before the role result was confirmed. Inspect the Session before continuing.')
    }
    if (verifiedGit !== null && JSON.stringify(this.git.read(live.parent.session)) !== verifiedGit) {
      throw new RgError('RG_GIT_UNKNOWN', 'The verified Git delivery changed before the role result was confirmed. A commit may exist in the retained checkout; inspect it before continuing.')
    }
    const pending = this.projection.stateOf(live.parent.session).pending
    if (pending?.taskId !== live.taskId || pending.runId !== live.run.id || pending.childId !== live.run.childId) {
      throw new RgError('RG_NOT_READY', 'The RG result preparation is no longer current.')
    }
    const confirmed = JSON.stringify(pending.state)
    const confirmedGit = JSON.stringify(this.git.read(live.parent.session))
    live.parent.session.append('review-gated/result-confirmed', identity)
    await this.flushRequired(live.parent.session)
    const confirmedState = this.read(live.parent.session)
    const gitMatches = JSON.stringify(this.git.read(live.parent.session)) === confirmedGit
    const ownsResult = JSON.stringify(confirmedState) === confirmed
    const liveParent = this.resultOwnerIsLive(live)
    if (!liveParent || !ownsResult || !gitMatches) {
      this.uncertainViews.add(live.parent.session)
      this.publishView(live.parent.id)
    }
    if (liveParent && !gitMatches && ownsResult && confirmedState?.task != null) {
      this.commit(live.parent.session, { ...confirmedState, diagnostic: 'Local Git delivery changed after result confirmation. Inspect the Session and retained worktrees before continuing.',
        task: { ...confirmedState.task, reviewStatus: confirmedState.task.reviewStatus === 'reported-pass' ? 'stale' : confirmedState.task.reviewStatus } })
    }
    if (liveParent && ownsResult && gitMatches) {
      if (bounded.report?.kind === 'reviewer' && bounded.reviewStatus === 'changes-requested') {
        this.steerChangesRequested(live.parent, bounded.report, policy.maxReportChars)
      }
      live.parent.followup(this.notice(bounded.text))
    }
  }

  private notice(text: string): UserMessage {
    return { id: brandString<MessageId>(randomUUID()), role: 'user', content: [{ type: 'text', text }], source: { kind: 'review-gated' } }
  }

  /** Tell the parent that a review asked for changes, so it cannot report a pass.
   * @param parent - the live main Agent owning the task.
   * @param report - the settled reviewer report, already validated.
   * @param maxChars - frozen complete-notice budget.
   */
  private steerChangesRequested(parent: Agent, report: RgReviewReport, maxChars: number): void {
    if (this.ctx.agents.get(parent.id) !== parent || parent.ctx.fiber.state !== FiberState.ACTIVE) return
    const findings = report.findings.map(finding => '- ' + finding.location + ': ' + finding.impact)
    const notice = ['The RG reviewer requested changes. This review is not a pass; report these findings and fix or disclose them before delivering.',
      ...findings, ...report.unverified.length === 0 ? [] : ['Unverified areas:', ...report.unverified.map(item => '- ' + item)]].join('\n')
    const bounded = notice.length <= maxChars ? notice : notice.slice(0, maxChars - 3) + '...'
    parent.steer({ id: brandString<MessageId>(randomUUID()), role: 'user', content: [{ type: 'text', text: bounded }], source: { kind: 'review-gated' } })
  }
}
