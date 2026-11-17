/** RG policy and budget owner; the existing subagent manager owns child lifecycles. */
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { Context, FiberState, Service } from '@deepseek-ai/cordis'
import type { Disposable } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Agent, InboxWireState, ModelSelection } from '@deepseek-ai/dsh-agent'
import { isAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { MessageId, UserMessage } from '@deepseek-ai/dsh-llm'
import { appendPluginRecord, pluginRecordOf, SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import type { SubagentActivation, SubagentActivationSpec, SubagentResult } from '@deepseek-ai/dsh-subagent'
import { Remote, RemoteError, TypertRemoteService, principalOf } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-goal'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-working-directory'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-tool-subagent/model-selection-settings'
import type {} from '@deepseek-ai/dsh-tool-executor-ptc/types'
import { Config, capturePolicy, resolveModel } from './config.ts'
import { RgError } from './errors.ts'
import { rgClaimPreview,
  type RgPreviewClaim, rgProjectionDefinition, rgProjectionReady, rgProjectionView, rgProjectionViewSchema, TASK_SAVE_UNCERTAIN } from './projection.ts'
import { gitProjectionDefinition, gitStateRecordSchema, gitStateSchema } from './git-projection.ts'
import { claimSettledRecordSchema, stateRecordSchema } from './records.ts'
import type { RgClaimReport, RgReviewReport, RgView } from './types.ts'
import { LocalGitDelivery } from './git-delivery.ts'
import type { RgGitState } from './git-types.ts'
import type { RgProjectionState } from './projection.ts'
import { handoffSchema, reviewReportSchema, workerReportSchema } from './schemas.ts'
import { reviewerOutputSchema, workerOutputSchema } from './report-schema.ts'
import { boundCompletion } from './report-result.ts'
import { captureScope } from './scope.ts'
import { reserveRun, settleRun } from './task.ts'
import { reviewWorkflow } from './review-workflow.ts'
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

interface StepClaimContext {
  readonly signal: AbortSignal
  readonly messages: readonly UserMessage[]
  readonly turn: number
  readonly step: number
}

interface LiveClaim {
  readonly agent: Agent
  readonly signal: AbortSignal
  readonly intentSeq: SessionSeq
  readonly claimedIds: ReadonlySet<MessageId>
  readonly turn: number
  readonly step: number
  readonly dispose: () => void
  admitted: readonly UserMessage[] | undefined
  readonly recorded: UserMessage[]
  started: boolean
}

interface LiveRun {
  readonly parent: Agent
  readonly run: RgRun
  readonly taskId: RgTaskId
  child: Agent | undefined
  readonly control: AbortController
  readonly startup: Promise<void>
  readonly publication: Promise<void>
  parentCancelled: boolean
  settling: boolean
  activation: (SubagentActivation & { readonly messageId: MessageId }) | undefined
  disposal: Promise<void> | undefined
  completion: Promise<void> | undefined
  delivery: { readonly kind: 'workspace' } | { readonly kind: 'git'; readonly prepared: RgGitState } | null
}

/** Exclude loop-injected messages whose identities may change before the request is committed. */
function claimedBatch(claimed: readonly UserMessage[], admitted: readonly UserMessage[]): UserMessage[] {
  const claimedIds = new Set(claimed.map(message => message.id))
  return admitted.filter(message => claimedIds.has(message.id))
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

/** A rejected or empty RG claim cannot establish the task whose origin it captured. */
function claimRejectedOrigin(claim: RgProjectionState['claim'], task: RgTask | null | undefined): boolean {
  if (claim === null || task == null || (claim.phase !== 'rejected' && claim.phase !== 'empty')) return false
  return claim.inputs.some(({ message }) => message.id === task.originMessageId)
}

/** A missing, malformed, or still-pending origin cannot authorize a cold task view.
 * The inbox projection is wire JSON, so each entry is validated before its id is
 * compared; absence of the projection is not evidence of an empty inbox.
 */
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
  private readonly tasks = new Map<Agent, {
    stopped: boolean
    deliveryId: MessageId
    readonly settled: Promise<void>
    readonly objective: string
    readonly task: RgTask
    readonly state: RgSessionState
  }>()
  private readonly departures = new Map<Agent, Promise<void>>()
  private readonly uncertainViews = new WeakSet<Session>()
  private readonly retiredViewAgents = new WeakSet<Agent>()
  private readonly viewListeners = new Map<SessionId, Set<() => void>>()
  private liveClaims = new WeakMap<Session, LiveClaim>()
  private readonly claimCleanups = new Set<() => void>()
  private readonly modelEntries = new Map<SessionId, { readonly agent: Agent; readonly verify: (options: GenerateOptions) => void }>()

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
    // The registry publishes the Agent before some preset bindings are readable, so retry once
    // the current task settles: a Session created before its first turn must not stay bare.
    ctx.on('agent/created', ({ agent }) => {
      // An unauthorized role start is refused by throwing from creation, which is RG's own check.
      this.initialize(agent)
      queueMicrotask(() => {
        if (this.lifecycle.signal.aborted) return
        try { this.ensureInitialized(agent); this.publishView(agent.session.id) } catch (error: unknown) {
          this.ctx.logger.warn('RG deferred initialization failed: %s', error instanceof Error ? error.message : String(error))
        }
      })
      this.publishView(agent.session.id)
      return undefined
    }, { global: true })
    // The preset registry emits this ambient event for a committed selection; it is upstream.
    ctx.on('agent-preset/selected', (sessionId) => {
      // This ambient emit runs inside the Session append that committed the selection, so an
      // immediate initialize would append from an observer and be rejected as reentrant.
      queueMicrotask(() => {
        if (this.lifecycle.signal.aborted) return
        const agent = this.ctx.agents.get(sessionId)
        if (agent === undefined) return
        try { this.initialize(agent); this.publishView(agent.session.id) } catch (error: unknown) {
          this.ctx.logger.warn('RG preset initialization failed: %s', error instanceof Error ? error.message : String(error))
        }
      })
    }, { global: true })
    // A preset binding can become readable only after the Agent is created, so initialize
    // when the driver actually starts: that precedes pre-step, which freezes the step route.
    ctx.on('agent/status', ({ agent, status }) => {
      if (status !== 'running') return
      this.ensureInitialized(agent)
    }, { global: true })
    ctx.on('agent/inbox/claimed', ({ agent, message }) => {
      const pending = this.tasks.get(agent)
      if (pending !== undefined && (message.id !== pending.deliveryId || message.source.kind !== 'user')) pending.stopped = true
    }, { global: true })
    // Service initialization precedes preset mounting, so this wraps role.ts's pre-step decisions.
    // The inbox has already claimed these inputs: a crash before this flush leaves only durable
    // inbox splices, not an RG intent. Recovery must treat that window as uncertain, never replay it.
    ctx.on('agent/pre-step', async ({ agent, messages, turn, step, signal, modelSelection }, next) => {
      const session = agent.session
      if (this.modelEntries.get(agent.id)?.agent === agent) this.modelEntries.delete(agent.id)
      this.ensureInitialized(agent)
      const context = { messages: structuredClone(messages), signal, turn, step }
      const role = this.projection.stateOf(session).value?.role
      // Only the main role owns task admission; every RG role prepares authorization
      // after the pristine waterfall decision and rechecks it at the stream barrier.
      if (messages.length === 0 || role !== 'main') {
        const decision = await next()
        if (decision.kind === 'enter') await this.prepareModelEntry(agent, context, decision.messages, modelSelection)
        return decision
      }
      signal.throwIfAborted()
      this.liveClaims.get(session)?.dispose()
      const claimedIds = new Set(context.messages.map(message => message.id))
      const intentSeq = appendPluginRecord(session, 'plugin:review-gated/claim', {
        version: 1, phase: 'intent', turn, step,
        // The pre-step payload carries no inbox target, and step order does not prove one:
        // a first step can carry steering inputs. Absent target means unknown, not a default.
        inputs: messages.map(message => ({ message,
          ...this.tasks.get(agent)?.deliveryId === message.id ? { target: 'next-turn' as const } : {},
        })),
      })
      const dispose = () => {
        if (this.liveClaims.get(session) === claim) this.liveClaims.delete(session)
        signal.removeEventListener('abort', dispose)
        this.claimCleanups.delete(dispose)
      }
      const claim: LiveClaim = { agent, signal, intentSeq, claimedIds, turn, step, dispose,
        admitted: undefined, recorded: [], started: false }
      this.liveClaims.set(session, claim)
      this.claimCleanups.add(dispose)
      signal.addEventListener('abort', dispose, { once: true })
      const pending = this.tasks.get(agent)
      if (pending !== undefined) {
        const opened = this.projection.stateOf(session)
        if (pending.stopped || this.lifecycle.signal.aborted || this.ctx.agents.get(agent.id) !== agent
          || messages.length !== 1 || messages[0]?.id !== pending.deliveryId || messages[0].source.kind !== 'user'
          || opened.failure !== null || opened.taskAdmission?.intentSeq !== intentSeq
          || opened.taskAdmission.messageId !== pending.deliveryId || opened.taskAdmission.taskId !== null
          || !isDeepStrictEqual(opened.value, pending.state)) throw new RgError('RG_NOT_READY', TASK_SAVE_UNCERTAIN)
        this.git.assertSettled(agent)
        appendPluginRecord(session, 'plugin:review-gated/task-prepared', { version: 1, intentSeq,
          messageId: pending.deliveryId, input: pending.objective,
          state: { ...pending.state, task: pending.task, diagnostic: TASK_SAVE_UNCERTAIN } })
        const prepared = this.projection.stateOf(session)
        if (prepared.failure !== null || prepared.taskAdmission?.taskId !== pending.task.id) throw new RgError('RG_NOT_READY', TASK_SAVE_UNCERTAIN)
        this.git.clear(session)
      }
      await this.flushRequired(session)
      signal.throwIfAborted()
      if (pending?.stopped) throw new RgError('RG_NOT_READY', TASK_SAVE_UNCERTAIN)
      const decision = await next()
      const admitted = decision.kind === 'enter' ? claimedBatch(context.messages, decision.messages) : []
      if (decision.kind === 'reject' || admitted.length === 0) {
        appendPluginRecord(session, 'plugin:review-gated/claim-settled', {
          version: 1, phase: 'settled', intentSeq,
          outcome: decision.kind === 'reject' ? 'rejected' : 'empty', messages: [],
        })
        await this.flushRequired(session)
        dispose()
      } else {
        claim.admitted = structuredClone(admitted)
      }
      if (decision.kind === 'enter') await this.prepareModelEntry(agent, context, decision.messages, modelSelection)
      return decision
      // Admission must wrap the preset role guard in role.ts: that guard rejects an
      // unrecorded claim, so this wrapper has to record intent before it runs.
    }, { global: true, prepend: true })
    ctx.on('llm/stream', (options, next) => {
      if (!isAgentLoopRequest(options) || options.purpose !== undefined || options.sessionId === undefined) return next()
      const id = options.sessionId
      const entry = this.modelEntries.get(id)
      const session = this.ctx.sessions.get(id)
      const agent = this.ctx.agents.get(id)
      if (entry === undefined && (session === undefined || this.projection.stateOf(session).value === null)
        && (agent === undefined || !this.isRoleChild(agent))) return next()
      const verify = () => {
        if (entry === undefined || this.modelEntries.get(id) !== entry) {
          throw new RgError('RG_NOT_READY', 'The RG request has no current model-entry authorization. Inspect the Session before continuing.')
        }
        entry.verify(options)
      }
      // Pristine stream middleware owns the last check: intent/decision preparation precedes
      // user/message appends; their durable settlement precedes authorization and delegation.
      // Start the append/flush at stream creation, not on the first iterator pull.
      const barrier = this.settleEntered(options)
      return (async function* () { await barrier; verify(); yield* next() })()
    })
    ctx.on('session/event', (session, event) => { this.observeClaim(session, event) })
    ctx.on('agent/disposed', ({ agent }) => {
      this.liveClaims.get(agent.session)?.dispose()
      if (this.modelEntries.get(agent.id)?.agent === agent) this.modelEntries.delete(agent.id)
    }, { global: true })
    ctx.effect(() => () => {
      for (const dispose of this.claimCleanups) dispose()
      this.liveClaims = new WeakMap()
      this.modelEntries.clear()
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
      if (changes.some(change => change.key === 'reviewGated' || change.key === 'reviewGatedGit')) this.publishView(session.id)
    }))
    ctx.on('session/created', (session) => { this.publishView(session.id) }, { global: true })
    ctx.on('agent/disposed', ({ agent }) => { this.retiredViewAgents.add(agent); this.publishView(agent.session.id) }, { global: true })
    ctx.on('session/event', (session, event) => {
      const agent = ctx.agents.get(session.id)
      if (agent === undefined) return
      if (event.type === 'turn/end' && event.data.reason.kind === 'aborted') {
        const live = [...this.runs.values()].find(run => run.parent === agent)
        if (live !== undefined) { live.parentCancelled = true; live.control.abort(event.data.reason.reason) }
      }
      const record = pluginRecordOf(event)
      if (record?.type === 'plugin:review-gated/state') {
        const live = [...this.runs.values()].find(run => run.parent === agent)
        if (live === undefined) return
        const parsed = stateRecordSchema.safeParse(record.data)
        const value = parsed.success ? parsed.data.state : null
        const task = value?.task
        const active = task?.active
        if (!live.settling && (value?.role !== 'main' || value.policy === null
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
      const state = this.read(agent.session)
      if (state?.role === 'main' && state.policy !== null && state.task !== null
        && reviewWorkflow(state.task, state.policy).needsHumanDecision) {
        const goals = ctx.get('goals')
        if (goals !== undefined) {
          const goal = goals.get(agent)
          if (goal?.phase === 'active' && goal.activation === 'armed') goals.disarm(agent)
        }
      }
      if (before === 'reported-pass' && this.read(agent.session)?.task?.reviewStatus === 'stale') {
        agent.steer(this.notice('The reviewed file scope changed. The previous reviewer pass is stale; report this or request a new review within the remaining budget.'))
      }
    })
    // Pristine tools.guard rejects role delegation before tool execution, including PTC.
    // Direct Service starts bypass that admission: pre-step rejects them only after allocation,
    // before model entry, unless RG owns the exact activation and its initial message receipt.
    ctx.on('agent/pre-step', async ({ agent, modelSelection, signal, messages, turn, step }, next) => {
      this.ensureInitialized(agent)
      if (!this.isRoleChild(agent)) return next()
      const live = this.runs.get(agent.id)
      if (live !== undefined) {
        const cancelled = Promise.withResolvers<never>()
        const abort = () => { cancelled.reject(signal.reason) }
        signal.addEventListener('abort', abort, { once: true })
        try {
          if (signal.aborted) abort()
          await Promise.race([live.publication, cancelled.promise])
        } finally { signal.removeEventListener('abort', abort) }
      }
      const context = { signal, messages, turn, step }
      this.assertRequest(agent, modelSelection, context)
      const decision = await next()
      this.assertRequest(agent, modelSelection, context)
      // A role admits only its reserved initial handoff. Compare by claimed identity so the
      // loop's injected context message is ignored without naming a message source kind that
      // this package would otherwise have to import a core module to declare.
      if (decision.kind === 'enter' && !isDeepStrictEqual(claimedBatch(messages, decision.messages), messages)) {
        throw new RgError('RG_UNAUTHORIZED_START', 'An RG role accepts only its reserved initial handoff, not replacement or follow-up input.')
      }
      return decision
    }, { global: true })
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
  /**
   * Initialize an RG Agent whose preset was not observable when it was created.
   * Both `agent/created` and the ambient preset event can fire before the preset
   * binding is readable, so the first pre-step closes that gap instead of leaving
   * the Session without an RG projection for its whole first turn.
   * @param agent - agent about to run a step.
   */
  private ensureInitialized(agent: Agent): void {
    const preset = this.ctx.agentPresets.presetForSession(agent.session)
    if (preset !== 'rg' && preset !== 'rg-worker' && preset !== 'rg-reviewer') return
    // A failed projection is not an uninitialized Session: re-initializing would erase the
    // recorded failure and append to a Session that must stay inspectable.
    const projected = this.projection.stateOf(agent.session)
    if (projected.failure !== null || projected.value !== null) return
    this.initialize(agent)
  }

  /** Record this Agent's RG role and freeze its captured policy.
   * @param agent - Agent whose preset composition determines the RG role.
   */
  initialize(agent: Agent): void {
    const preset = this.ctx.agentPresets.presetForSession(agent.session)
    const role: RgRole | undefined = preset === 'rg' ? 'main' : preset === 'rg-worker' ? 'worker' : preset === 'rg-reviewer' ? 'reviewer' : undefined
    const recovered = this.projection.stateOf(agent.session)
    if (role === undefined) {
      if (recovered.value !== null && !recovered.hasRequested) {
        // Clearing the RG projection revokes its policy before restoring the prior route.
        this.commit(agent.session, null)
        if (recovered.value.priorModel !== null && recovered.value.priorModel !== undefined) {
          agent.model.select(rgSelection(recovered.value.priorModel))
        }
      }
      return
    }
    if (recovered.value !== null) {
      const state = recovered.value
      // The inherited RG projection owns authorization; recovery only seeds a missing main selection.
      if (state.role === 'main' && !recovered.hasRequested && state.policy !== null) this.bindModel(agent, state.policy, state.role)
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
    if (state.value?.task != null && state.value.diagnostic === null && state.taskReceipt !== 'proven') {
      throw new RgError('RG_NOT_READY', 'The task input has no confirmed RG receipt. Inspect the Session before continuing.')
    }
    if (state.value !== null && state.taskAdmission?.taskId != null && state.value.diagnostic !== null) {
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
      || this.ctx.agents.get(session.id) !== agent || agent.ctx.fiber.state !== FiberState.ACTIVE
      || this.retiredViewAgents.has(agent) || this.uncertainViews.has(session)) return 'unknown'
    let claim: RgProjectionState['claim']
    try { claim = this.consistentClaim(session) } catch { return 'unknown' }
    if (claim?.phase === 'intent' && claim.closed) return 'unknown'
    if (claim?.phase === 'intent' || this.tasks.has(agent) || this.departures.has(agent) || this.git.busy(agent)) return 'saving'
    const state = this.projection.stateOf(session)
    if (state.taskAdmission !== null || state.value?.diagnostic != null || claimRejectedOrigin(claim, state.value?.task)
      || claim?.phase === 'entered') return 'unknown'
    const active = state.value?.task?.active
    if ([...this.runs.values()].some(run => run.parent === agent
      && (active?.status === 'saving' || active == null))) return 'saving'
    return rgProjectionReady(state) ? 'ready' : 'unknown'
  }

  private consistentClaim(session: Session): RgProjectionState['claim'] {
    const cut = this.ctx.sessionProjections.snapshot(session, ['reviewGated'])
    const state = this.projection.stateOf(session)
    if (cut.asOfSeq !== session.seq - 1 || cut.values.reviewGated === undefined || state.failure !== null
      || !isDeepStrictEqual(cut.values.reviewGated, rgProjectionView(state))) {
      throw new RgError('RG_NOT_READY', 'The RG projection is unavailable or inconsistent. Inspect the Session before continuing.')
    }
    return state.claim
  }

  private claimSettled(session: Session): boolean {
    this.consistentClaim(session)
    return rgProjectionReady(this.projection.stateOf(session))
  }

  /** Read the original RG claim without starting an Agent.
   * @param session - prepared Session.
   * @returns the owned claim, or undefined when its current projection is unavailable or invalid.
   */
  claimOf(session: Session): RgProjectionState['claim'] | undefined {
    try {
      return this.consistentClaim(session)
    } catch { return undefined }
  }

  private claimView(claim: RgPreviewClaim | null): RgView['claim'] {
    return rgClaimPreview(claim)
  }

  /** Bound model-visible claim details including the complete JSON wrapper.
   * @param session - Session owning the input.
   * @param status - live claim durability state.
   * @param claim - original claim retained by the RG projection.
   * @returns a bounded summary; omitted raw fields and text are explicitly marked.
   * @throws RgError when the configured budget cannot hold the minimum summary.
   */
  claimReport(session: Session, status: 'saving' | 'unknown' | null, claim: RgPreviewClaim | null): RgClaimReport {
    let limit = this.config.settings.get().maxReportChars
    try {
      const state = this.projection.stateOf(session)
      if (state.failure === null && state.value?.policy != null) limit = state.value.policy.maxReportChars
    } catch (error) {
      this.ctx.logger.warn('RG claim report budget uses current settings: %s', error)
    }
    const preview = this.claimView(claim)
    const phase = preview?.phase ?? 'unsettled'
    const summary = { claimStatus: status, sessionId: session.id.slice(0, 8192), sessionIdTruncated: session.id.length > 8192,
      rawPayloadTruncated: true as const,
      hint: 'Inspect the authorized Session view or log. Input may be unsaved; do not replay automatically.',
      claim: claim === null ? null : { intentSeq: claim.intentSeq,
        ...(claim.target === undefined ? {} : { target: claim.target }), turn: claim.turn,
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
    const current = this.claimOf(session)
    const status = current === undefined ? 'unknown' : this.statusOf(session)
    const claim = this.claimView(current ?? null)
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
        const projected = rgProjectionViewSchema.safeParse(values?.reviewGated)
        const git = gitStateSchema.nullable().safeParse(values?.reviewGatedGit)
        if (observation.header.id === id && observation.header.cwd !== undefined && projected.success && git.success) {
          const { state, claim, ready } = projected.data
          initial = {
            status: ready && (state?.task == null || noPendingOrigin(values?.inbox, state.task.originMessageId)) ? 'ready' : 'unknown',
            state, git: git.data, claim: claim === null ? null : {
              phase: claim.phase, text: claim.text, truncated: claim.truncated, otherContent: claim.otherContent,
            },
          }
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

  /** Observe committed events only for the active operation; this is not recovery or projection state. */
  private observeClaim(session: Session, event: SessionEvent): void {
    const claim = this.liveClaims.get(session)
    if (claim === undefined) return
    switch (event.type) {
      case 'step/start':
        if (claim.started || event.data.turn !== claim.turn || event.data.step !== claim.step) claim.dispose()
        else claim.started = true
        return
      case 'user/message':
        if (!claim.started) claim.dispose()
        else if (claim.claimedIds.has(event.data.id)) claim.recorded.push(event.data)
        return
      case 'turn/end':
      case 'step/end':
        claim.dispose()
        return
      default: {
        const record = pluginRecordOf(event)
        if (record?.type === 'plugin:review-gated/claim') claim.dispose()
        if (record?.type !== 'plugin:review-gated/claim-settled') return
        const parsed = claimSettledRecordSchema.safeParse(record.data)
        if (!parsed.success || (parsed.data.phase === 'settled' && parsed.data.intentSeq === claim.intentSeq)) claim.dispose()
      }
    }
  }

  /** Append only for the live loop request whose complete admitted batch is already committed. */
  private async settleEntered(options: GenerateOptions): Promise<void> {
    if (!isAgentLoopRequest(options) || options.purpose !== undefined || options.sessionId === undefined) return
    const session = this.ctx.sessions.get(options.sessionId)
    if (session === undefined) return
    const claim = this.liveClaims.get(session)
    // user/message appends complete synchronously before llm.stream(). Compare the whole batch;
    // partial knowledge is not settled, and no await can admit a late message before the append.
    if (claim !== undefined && claim.agent.session === session && this.ctx.agents.get(options.sessionId) === claim.agent
      && claim.agent.ctx.fiber.state === FiberState.ACTIVE && claim.signal === options.signal && !claim.signal.aborted
      && claim.started && claim.recorded.length > 0
      // Settle what the log actually appended: a pre-step listener that wraps RG can rewrite the
      // decision after RG has seen it, and the committed log is the truth that was admitted.
      && claim.recorded.every(message => claim.claimedIds.has(message.id))
      && new Set(claim.recorded.map(message => message.id)).size === claim.recorded.length
      && claim.recorded.every(message => options.messages.some(input => isDeepStrictEqual(input, message)))) {
      appendPluginRecord(session, 'plugin:review-gated/claim-settled', {
        version: 1, phase: 'settled', intentSeq: claim.intentSeq, outcome: 'entered', messages: claim.recorded,
      })
      claim.dispose()
    }
    // Child and empty-input steps have no main-role claim but still require a durable log.
    await this.flushRequired(session)
  }

  private async prepareModelEntry(agent: Agent, context: StepClaimContext, accepted: readonly UserMessage[],
    route: Readonly<ModelSelection>): Promise<void> {
    const { signal, messages: claimed } = context
    const admitted = structuredClone(claimedBatch(claimed, accepted))
    const selection = Object.freeze({ ...route })
    const session = agent.session
    let projected = this.projection.stateOf(session)
    if (projected.failure !== null) throw new RgError('RG_NOT_READY', projected.failure)
    if (projected.value === null) return
    if (this.ctx.get('reviewGated')?.serviceIdentity !== this.serviceIdentity) throw new RgError('RG_NOT_READY', 'The RG service is unavailable. Inspect the Session before continuing.')
    this.assertRequest(agent, selection, context)
    const originalClaim = projected.claim
    const direct = projected.directClaim
    let directIntent: number | undefined
    if (projected.value.role === 'main' && projected.value.task === null && direct?.phase === 'intent') {
      if (direct.objective === null) {
        throw new RgError('RG_NOT_READY', `The direct task exceeds its frozen limit of ${direct.limit} characters. Inspect the input and open a new RG Session with a shorter task.`)
      }
      if (admitted.length === 0) return
      const originals = claimed.filter(message => message.id === direct.messageId)
      const accepted = admitted.filter(message => message.id === direct.messageId)
      if (!this.isCurrentClaim(agent, context, originalClaim) || originalClaim?.intentSeq !== direct.intentSeq
        || originals.length !== 1 || originals[0]?.source.kind !== 'user'
        || accepted.length !== 1 || accepted[0]?.source.kind !== 'user') {
        throw new RgError('RG_NOT_READY', 'The original task input could not be matched to the admitted message. Inspect the Session before continuing.')
      }
      this.git.assertSettled(agent)
      const task: RgTask = { id: brandString<RgTaskId>(`rg-task-${randomUUID()}`), originMessageId: direct.messageId,
        objective: direct.objective, workRevision: 0, workerAttempts: 0, reviewAttempts: 0,
        active: null, lastWorker: null, lastReview: null, reviewStatus: 'not-reviewed' }
      this.git.clear(session)
      appendPluginRecord(session, 'plugin:review-gated/direct-task-prepared', { version: 1, intentSeq: direct.intentSeq, messageId: direct.messageId,
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
        || JSON.stringify(this.projection.stateOf(session).value) !== prepared
        || !this.isCurrentClaim(agent, context, this.consistentClaim(session))) {
        throw new RgError('RG_NOT_READY', `${TASK_SAVE_UNCERTAIN} The task owner or saved state changed during the checkpoint.`)
      }
      directIntent = direct.intentSeq
    }
    const preparedTask = directIntent !== undefined || projected.taskAdmission?.taskId != null
    const expected = { ...projected.value, ...preparedTask ? { diagnostic: null } : {} }
    const expectedJson = JSON.stringify(expected)
    this.modelEntries.set(agent.id, { agent, verify: (options) => {
      signal.throwIfAborted()
      // An omitted effort authorizes the adapter default for that route; a pinned effort must match exactly.
      if (options.signal !== signal || options.sessionId !== session.id || options.provider !== selection.provider
        || options.model !== selection.model
        || (selection.reasoningEffort !== undefined && options.reasoningEffort !== selection.reasoningEffort)) {
        throw new RgError('RG_NOT_READY', 'The RG request no longer matches its prepared owner or model route. Inspect the Session before continuing.')
      }
      if (this.lifecycle.signal.aborted || this.ctx.get('reviewGated')?.serviceIdentity !== this.serviceIdentity
        || this.ctx.sessions.get(agent.id) !== session || this.ctx.agents.get(agent.id) !== agent
        || agent.ctx.fiber.state !== FiberState.ACTIVE || this.retiredViewAgents.has(agent) || this.uncertainViews.has(session)) {
        throw new RgError('RG_NOT_READY', 'The RG owner changed before model entry. Inspect the Session before continuing.')
      }
      const current = this.projection.stateOf(session)
      const claim = this.consistentClaim(session)
      if (JSON.stringify(current.value) !== expectedJson) {
        throw new RgError('RG_NOT_READY', 'The RG Session changed before model entry. Inspect it before continuing.')
      }
      if (current.value?.role === 'main' && claimed.length > 0 && (originalClaim === null || claim?.phase !== 'entered'
        || claim.closed || claim.intentSeq !== originalClaim.intentSeq || claim.turn !== context.turn || claim.step !== context.step
        || !isDeepStrictEqual(claim.inputs, originalClaim.inputs))) {
        throw new RgError('RG_NOT_READY', 'The admitted input could not be confirmed. Inspect the Session before continuing.')
      }
      if (directIntent !== undefined && (current.directClaim?.phase !== 'settled' || current.directClaim.intentSeq !== directIntent)) {
        throw new RgError('RG_NOT_READY', TASK_SAVE_UNCERTAIN)
      }
      if (current.value?.role === 'main') {
        if (claimed.length === 0) this.assertRequest(agent, selection)
        // The current RG projection is the post-flush model-policy readiness authority.
        if (current.value.policy === null || current.value.diagnostic !== null
          || (current.value.task !== null && current.taskReceipt !== 'proven')
          || !current.value.policy.main.candidates.some(route => route.provider === selection.provider
            && route.model === selection.model && route.reasoningEffort === selection.reasoningEffort)) {
          throw new RgError('RG_NOT_READY', 'The RG model authorization changed before model entry.')
        }
        // The exact frozen-pool comparison above authorizes this main request.
      } else {
        this.assertRequest(agent, selection, context)
      }
    } })
  }

  private isCurrentClaim(agent: Agent, context: StepClaimContext, claim: RgProjectionState['claim']): boolean {
    const live = this.liveClaims.get(agent.session)
    return claim?.phase === 'intent' && !claim.closed && !context.signal.aborted
      && live?.agent === agent && live.signal === context.signal && live.intentSeq === claim.intentSeq
      && live.turn === context.turn && live.step === context.step && claim.turn === context.turn && claim.step === context.step
      && isDeepStrictEqual(claim.inputs.map(input => input.message), context.messages)
  }

  private isRoleChild(agent: Agent): boolean {
    const state = this.projection.stateOf(agent.session).value
    const preset = this.ctx.agentPresets.presetForSession(agent.session)
    const parentId = agent.session.header.parentSession
    const parent = parentId === undefined ? undefined : this.ctx.sessions.get(parentId)
    return this.runs.has(agent.id) || (state !== null && state.role !== 'main')
      || preset === 'rg-worker' || preset === 'rg-reviewer'
      || (parent !== undefined && this.projection.stateOf(parent).value !== null)
  }

  /** Check every request against its frozen policy and, for children, its exact live reservation.
   * @param agent - requesting Agent.
   * @param selection - frozen request selection.
   * @param context - exact pre-step position, messages, and signal for the RG-owned claim.
   */
  assertRequest(agent: Agent, selection: Readonly<ModelSelection>, context?: StepClaimContext): void {
    this.lifecycle.signal.throwIfAborted()
    if (this.ctx.agents.get(agent.id) !== agent || this.ctx.sessions.get(agent.id) !== agent.session
      || agent.ctx.fiber.state !== FiberState.ACTIVE || this.retiredViewAgents.has(agent) || this.uncertainViews.has(agent.session)) {
      throw new RgError('RG_NOT_READY', 'RG requests require the current live Agent. Inspect the Session before continuing.')
    }
    context?.signal.throwIfAborted()
    const projected = this.projection.stateOf(agent.session)
    if (this.isRoleChild(agent)) {
      const live = this.runs.get(agent.id)
      // The child's first pre-step can fire while the activation receipt is still pending, so the
      // reserved run identity is the authority; the receipt only refines the handoff id once known.
      if (live === undefined || live.child !== agent || live.run.childId !== agent.id
        || (live.activation !== undefined && live.activation.childId !== agent.id)
        || live.disposal !== undefined || live.control.signal.aborted || projected.value?.role !== live.run.role
        || (context !== undefined && (context.turn !== 1 || (context.step === 1
          // The loop may inject non-user context alongside the handoff; only human input counts here.
          ? context.messages.filter(message => message.source.kind === 'user').length !== 1
            || (live.activation !== undefined
              && context.messages.find(message => message.source.kind === 'user')?.id !== live.activation.messageId)
          : context.messages.length !== 0)))) {
        throw new RgError('RG_UNAUTHORIZED_START', 'This RG child must use its owned activation and initial handoff. Unreserved starts and follow-up input are refused.')
      }
    }
    const durableClaim = this.consistentClaim(agent.session)
    if (claimRejectedOrigin(durableClaim, projected.value?.task)) {
      throw new RgError('RG_NOT_READY', 'The task input was rejected before model entry. Inspect the Session before continuing.')
    }
    const currentClaim = context !== undefined && this.isCurrentClaim(agent, context, durableClaim)
    const claimUnknown = (durableClaim?.phase === 'intent' && !currentClaim) || durableClaim?.phase === 'entered'
      || (projected.value?.role === 'main' && context !== undefined && context.messages.length > 0 && !currentClaim)
    if (claimUnknown) {
      throw new RgError('RG_NOT_READY', 'The input claim outcome is uncertain. Inspect the Session before continuing.')
    }
    const message = context?.messages.length === 1 ? context.messages[0] : undefined
    const block = message?.content.length === 1 ? message.content[0] : undefined
    const admission = projected.taskAdmission
    const firstClaim = currentClaim && message !== undefined && block?.type === 'text'
      && projected.value?.role === 'main' && projected.value.task?.originMessageId === message.id
      && projected.taskInputText !== null && block.text === projected.taskInputText
      && message.source.kind === 'user' && Object.keys(message.source).length === 1
      && Object.keys(block).length === 2 && Object.keys(message).length === 4
      && admission !== null && admission.intentSeq === durableClaim?.intentSeq && admission.messageId === message.id
      && admission.taskId === projected.value.task.id
    if (admission !== null && (!currentClaim || (admission.taskId !== null && !firstClaim))) {
      throw new RgError('RG_NOT_READY', 'The task input has not been claimed. Inspect the Session before continuing.')
    }
    if (this.tasks.has(agent) && !firstClaim) throw new RgError('RG_BUSY', 'Wait for the new task to finish saving before starting work.')
    if (this.departures.has(agent) || this.git.busy(agent)) throw new RgError('RG_BUSY', 'Wait for the local Git operation to settle before starting work.')
    const preparedDirect = currentClaim && projected.directClaim?.phase === 'prepared'
      && projected.directClaim.intentSeq === durableClaim?.intentSeq
      && projected.value?.task?.originMessageId === projected.directClaim.messageId
    const prepared = firstClaim || preparedDirect
    const state = prepared ? projected.value : this.read(agent.session)
    if (state?.policy === null || state === null
      || (state.diagnostic !== null && !(prepared && state.diagnostic === TASK_SAVE_UNCERTAIN))) {
      throw new RgError('RG_NOT_READY', state?.diagnostic ?? 'RG is not ready. Configure the plugin and open a new RG Session.')
    }
    let allowed = state.policy[state.role].candidates.some(route => route.provider === selection.provider
      && route.model === selection.model && route.reasoningEffort === selection.reasoningEffort)
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
      allowed &&= live.run.selection.provider === selection.provider && live.run.selection.model === selection.model
        && live.run.selection.reasoningEffort === selection.reasoningEffort
    }
    if (claimUnknown) throw new RgError('RG_NOT_READY', 'The input claim outcome is uncertain. Inspect the Session before continuing.')
    if (!allowed) throw new RgError('RG_MODEL_NOT_ALLOWED', 'This request does not match the Session role model pool and configured reasoning. Choose an authorized candidate.')
    // The current Session's frozen RG policy establishes readiness, without a separate core binding.
    if (this.projection.stateOf(agent.session).value?.policy == null) throw new RgError('RG_NOT_READY', 'The RG Session model policy was not fully initialized. Open a new configured RG Session.')
    // The exact role-pool and child-reservation comparisons above own request authorization.
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
      const message: UserMessage = { id: brandString<MessageId>(randomUUID()), role: 'user', content: [{ type: 'text', text: objective }], source: { kind: 'user' } }
      const task: RgTask = { id: brandString<RgTaskId>(`rg-task-${randomUUID()}`), originMessageId: message.id, objective: normalized,
        workRevision: 0, workerAttempts: 0, reviewAttempts: 0, active: null, lastWorker: null, lastReview: null, reviewStatus: 'not-reviewed' }
      const done = Promise.withResolvers<void>()
      const pending = { stopped: false, deliveryId: message.id, settled: done.promise, objective, task, state }
      const unowned = () => pending.stopped || this.lifecycle.signal.aborted || this.ctx.agents.get(agent.id) !== agent
        || this.ctx.sessions.get(agent.id) !== agent.session || agent.ctx.fiber.state !== FiberState.ACTIVE
      const accepted = Promise.withResolvers<void>()
      const stopObserving = this.ctx.on('session/event', (session, event) => {
        if (session !== agent.session) return
        const record = pluginRecordOf(event)
        if (record?.type === 'plugin:review-gated/claim-settled' || event.type === 'turn/end') accepted.resolve()
      })
      this.tasks.set(agent, pending)
      this.publishView(agent.session.id)
      try {
        this.ownParent(agent)
        try {
          if (unowned()) throw new RgError('RG_NOT_READY', TASK_SAVE_UNCERTAIN)
          agent.followup(message)
          // Disposal must release this wait: the parent effect awaits this admission, so waiting on a
          // turn that disposal cancelled would deadlock teardown.
          const disposed = Promise.withResolvers<void>()
          const offDisposed = this.ctx.on('agent/disposed', ({ agent: candidate }) => {
            if (candidate === agent) disposed.resolve()
          }, { global: true })
          try {
            await Promise.race([accepted.promise, agent.whenIdle(), disposed.promise])
          } finally { offDisposed() }
          await this.flushRequired(agent.session)
          const committed = this.projection.stateOf(agent.session)
          if (unowned() || committed.failure !== null || committed.value?.task?.id !== task.id
            || committed.taskAdmission?.taskId != null
            || committed.value.diagnostic !== null || this.git.read(agent.session) !== null) throw new RgError('RG_NOT_READY', TASK_SAVE_UNCERTAIN)
          return task
        } catch (error) {
          this.uncertainViews.add(agent.session)
          this.ctx.logger.error('RG task admission failed: %s', error)
          throw new RgError('RG_NOT_READY', TASK_SAVE_UNCERTAIN)
        }
      } finally { stopObserving(); this.tasks.delete(agent); this.publishView(agent.session.id); done.resolve() }
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
        const record = pluginRecordOf(event)
        if (session !== agent.session || publishedGrant !== null || record?.type !== 'plugin:review-gated/git-state') return
        const parsed = gitStateRecordSchema.safeParse(record.data)
        if (parsed.success && parsed.data.state?.status === 'authorized') publishedGrant = parsed.data.state
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
          || agent.ctx.fiber.state !== FiberState.ACTIVE || !stillIdle() || !this.claimSettled(agent.session)
          || JSON.stringify(current) !== JSON.stringify(state)
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
              || !this.claimSettled(agent.session)
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
    const publication = Promise.withResolvers<void>()
    const live: LiveRun = {
      parent, run, taskId: task.id, child: undefined, control: new AbortController(),
      startup: startup.promise, publication: publication.promise,
      parentCancelled: false, settling: false, activation: undefined, disposal: undefined, completion: undefined, delivery: null,
    }
    this.ownParent(parent)
    this.runs.set(childId, live)
    let reservationSaved = false
    let removeAbort: (() => void) | undefined
    try {
      this.commit(parent.session, { ...state, task })
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
      const startupAbort = () => { live.control.abort(signal.reason) }
      signal.addEventListener('abort', startupAbort, { once: true })
      try {
        if (signal.aborted) startupAbort()
        const spec: SubagentActivationSpec & { readonly childId: SessionId } = {
          provider: 'spawn', childId, label: `RG ${role}: ${handoff.objective}`,
          request: { parent, cwd, agentPreset: `rg-${role}`, prompt: [{ type: 'text', text: prompt }],
            agentOptions: { ...rgSelection(selection),
              reasoningEffort: selection.reasoningEffort === undefined
                ? undefined : brandString<ReasoningEffortId>(selection.reasoningEffort) },
            outputSchema: role === 'worker' ? workerOutputSchema : reviewerOutputSchema }, signal: lifetime, delivery: 'caller',
        }
        // Pristine local activation is continuable. RG validates its own spec before allocation;
        // other Service callers are rejected later by child pre-step, not by a manager veto.
        // RG owns one-shot behavior through result disposal and a joined lifetime-abort bridge.
        this.guardStart(spec)
        live.activation = await this.ctx.subagents.startActivation(spec)
      } finally {
        signal.removeEventListener('abort', startupAbort)
        publication.resolve()
      }
      const abort = () => {
        void this.disposeRole(live).catch((error) => { this.ctx.logger.error('RG cancellation cleanup failed: %s', error) })
      }
      lifetime.addEventListener('abort', abort, { once: true })
      removeAbort = () => { lifetime.removeEventListener('abort', abort) }
      if (lifetime.aborted) abort()
      this.replaceActive(live, { status: 'running' })
      live.completion = this.finish(live, live.activation.result, policy).catch((error: unknown) => {
        // Recording the failure must never reject the completion: the Session may already be
        // unreadable, and callers await this promise for teardown ordering only.
        try {
          this.uncertainViews.add(parent.session)
          const diagnostic = 'RG_RESULT_SAVE_FAILED: the role result could not be saved reliably. Inspect the Session and workspace before continuing.'
          const failed = this.failureState(live)
          if (failed !== null) {
            this.commit(parent.session, { ...failed, diagnostic, task: { ...failed.task, active: null, reviewStatus: 'inconclusive' } })
            parent.cancel({ kind: 'parent' })
          }
        } catch (recording: unknown) {
          this.ctx.logger.error('RG role failure could not be recorded: %s', recording)
        }
        this.ctx.logger.error('RG role result could not be durably settled: %s', error)
      }).finally(() => { removeAbort?.(); this.runs.delete(childId); this.publishView(parent.id) })
      return { kind: 'activation', subagentId: childId, runId: run.id }
    } catch (error) {
      publication.resolve()
      removeAbort?.()
      const failures: unknown[] = []
      if (!reservationSaved) failures.push(new Error('The role reservation may not have been saved. Inspect the Session before continuing.'))
      try {
        const cleanup = await Promise.allSettled([
          this.disposeRole(live),
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
    } finally { publication.resolve(); startup.resolve() }
  }

  private requireMain(agent: Agent, permitPendingTask = false): RgSessionState & { policy: RgPolicy } {
    this.lifecycle.signal.throwIfAborted()
    // Remote actions can arrive before the Agent's first turn, when its preset binding was not
    // yet readable at creation time; initialize here so the action sees the frozen policy.
    this.ensureInitialized(agent)
    if (!permitPendingTask && this.tasks.has(agent)) throw new RgError('RG_BUSY', 'Wait for the new task to finish saving before starting work.')
    if (this.departures.has(agent)) throw new RgError('RG_BUSY', 'Wait for local Git departure to finish saving before starting work.')
    const claim = this.consistentClaim(agent.session)
    const projected = this.projection.stateOf(agent.session)
    if (claim?.phase === 'entered' || (claim?.phase === 'intent' && claim.closed)
      || (!permitPendingTask && (claim?.phase === 'intent' || projected.taskAdmission !== null))) {
      throw new RgError('RG_NOT_READY', 'The input claim outcome is uncertain. Inspect the Session before continuing.')
    }
    if (this.ctx.agents.get(agent.id) !== agent || agent.ctx.fiber.state !== FiberState.ACTIVE) {
      throw new RgError('RG_NOT_READY', 'RG work requires the current live main Agent before its scope starts disposing.')
    }
    if ([...this.runs.values()].some(run => run.parent === agent && run.parent.id === agent.id && this.read(agent.session)?.task?.active === null)) throw new RgError('RG_BUSY', 'The previous role result is still being saved. Wait before starting more RG work.')
    const state = this.read(agent.session)
    if (this.ctx.sessions.get(agent.id) !== agent.session || this.retiredViewAgents.has(agent) || this.uncertainViews.has(agent.session)
      || claimRejectedOrigin(claim, state?.task)
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

  private disposeRole(live: LiveRun): Promise<void> {
    if (live.disposal !== undefined) return live.disposal
    const activation = live.activation
    if (activation === undefined) return Promise.resolve()
    live.disposal = Promise.resolve().then(() => activation.dispose()).finally(() => { live.activation = undefined })
    return live.disposal
  }

  private async drain(pending: readonly LiveRun[], reason: unknown): Promise<void> {
    for (const live of pending) { live.parentCancelled = true; live.control.abort(reason) }
    const results = await Promise.all(pending.map(async (live) => {
      await live.startup
      return Promise.allSettled([
        this.disposeRole(live),
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
    // A child role runs on its reservation's exact route; that is authorization, not a preference.
    if (chosen !== undefined) {
      agent.model.select(rgSelection(selected))
      return
    }
    // Seeding must never overwrite a choice the Session already recorded, including a human
    // choice made in a blank Session before it entered RG. The frozen policy owns authorization;
    // this path owns only the starting route.
    const recorded = this.ctx.sessionProjections.snapshot(agent.session, ['modelSelection']).values.modelSelection
    if (recorded === undefined) {
      throw new RgError('RG_NOT_READY', 'The model selection projection is unavailable. Inspect the Session before continuing.')
    }
    // The published view computes `next` as `pending ?? lastUsed`, so both null means
    // no recorded selection and no pending one.
    if (recorded.lastUsed !== null || recorded.next !== null) return
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
    const live = spec.childId === undefined ? undefined : this.runs.get(spec.childId)
    if (run === null || run === undefined || spec.childId !== run.childId || live === undefined
      || live.parent !== spec.request.parent || live.taskId !== parent.task?.id || live.run.id !== run.id
      || live.activation !== undefined || live.disposal !== undefined || live.control.signal.aborted
      || this.ctx.agents.get(live.parent.id) !== live.parent || this.ctx.sessions.get(live.parent.id) !== live.parent.session
      || spec.provider !== 'spawn' || spec.request.agentPreset !== `rg-${run.role}`
      || options?.provider !== run.selection.provider || options.model !== run.selection.model
      || options.reasoningEffort !== run.selection.reasoningEffort
      || spec.request.outputSchema !== (run.role === 'worker' ? workerOutputSchema : reviewerOutputSchema)) {
      throw new RgError('RG_UNAUTHORIZED_START', 'Start RG roles through rg_worker or rg_reviewer; unreserved, continued, or mismatched role starts are refused.')
    }
  }

  private commit(session: Session, state: RgSessionState | null): void {
    appendPluginRecord(session, 'plugin:review-gated/state', { version: 1, state })
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
    let scope: RgRun['scope'] = null
    try {
      const settled = await result.then(async (value) => {
        await this.disposeRole(live)
        return value
      }, async (error: unknown) => {
        try { await this.disposeRole(live) } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'The RG role result and activation cleanup both failed.')
        }
        throw error
      })
      scope = this.read(live.parent.session)?.task?.active?.scope ?? null
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
    appendPluginRecord(live.parent.session, 'plugin:review-gated/result-prepared', { ...identity, scopeMatches: matches, state: candidate })
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
    appendPluginRecord(live.parent.session, 'plugin:review-gated/result-confirmed', identity)
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
