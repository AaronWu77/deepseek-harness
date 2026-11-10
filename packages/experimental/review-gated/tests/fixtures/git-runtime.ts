/** Real AgentLoop, preset, JSONL, subprocess and retained-worktree fixture for local delivery. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import FsLocal from '@deepseek-ai/dsh-fs-local'
import { createUserMessage, LlmAdapter, ReasoningEffortId, ToolCallId,
  type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Subagents from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import Worktrees from '@deepseek-ai/dsh-experimental-worktree'
import { onTestFinished } from 'vitest'
import ReviewGated from '../../src/runtime.ts'
import * as Role from '../../src/role.ts'
import { defaultSettings } from '../../src/config.ts'
import type { RgHandoff, RgSessionState, RgSettings, RgWorkerReport, RgReviewReport } from '../../src/types.ts'
import { git, repository, UnusedSandbox } from '../../../worktree/tests/harness.ts'

const low = ReasoningEffortId('low')
const route = (model: string) => ({ candidates: [{ provider: 'fixture', model }], default: { provider: 'fixture', model } })
/** Complete frozen settings, including independent reviewer routing for observable role execution.
 * @returns a fresh configured settings document.
 */
export function gitSettings(): RgSettings {
  return { ...defaultSettings(), configured: true, main: route('main'), worker: route('worker'),
    reviewer: { mode: 'custom', pool: route('reviewer') } }
}
/** Exact tracked-file assignment used by the composed local-Git roles. */
export const gitHandoff: RgHandoff = { objective: 'Deliver the scoped implementation', acceptance: ['Update tracked.txt'],
  scope: ['tracked.txt'], constraints: ['Preserve source edits'], facts: [], validation: ['Read the actual candidate'] }
/** Formal report from the controlled external model adapter. */
export const workerReport: RgWorkerReport = { kind: 'worker', outcome: 'completed', summary: 'Updated the assigned file',
  changes: ['tracked.txt'], validation: ['Read the managed checkout'], unverified: [] }
/** Formal independent review report. */
export const reviewReport: RgReviewReport = { kind: 'reviewer', verdict: 'pass', summary: 'The inspected candidate meets the assignment',
  inspectedScope: ['tracked.txt'], findings: [], validation: ['Read the exact committed candidate'], unverified: [] }

function text(value: string): StreamChunk[] {
  return [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text: value },
    { type: 'block-end', index: 0, block: { type: 'text', text: value } }, { type: 'finish', reason: { kind: 'stop' } }]
}
function formal(value: RgWorkerReport | RgReviewReport): StreamChunk[] {
  const args = JSON.stringify(value)
  const id = ToolCallId('git-formal-report')
  return [{ type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name: 'structured_output', argumentsDelta: args },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'structured_output', arguments: args } },
    { type: 'finish', reason: { kind: 'tool-calls' } }]
}
type RoleScript = (agent: Agent, options: GenerateOptions) => Promise<RgWorkerReport | RgReviewReport>
class GitAdapter extends LlmAdapter {
  readonly calls: GenerateOptions[] = []
  worker: RoleScript = async () => workerReport
  reviewer: RoleScript = async () => reviewReport
  beforeMain: (options: GenerateOptions) => Promise<void> = async () => {}
  constructor(private readonly ctx: Context) { super() }
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model, reasoning: { efforts: [{ id: low, name: 'Low' }], defaultEffort: low } }
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    if (options.model === 'worker' || options.model === 'reviewer') {
      const agent = options.sessionId === undefined ? undefined : this.ctx.agents.get(SessionId(options.sessionId))
      if (agent === undefined) throw new Error('A role request must address a published production Agent.')
      const value = await (options.model === 'worker' ? this.worker : this.reviewer)(agent, options)
      options.signal?.throwIfAborted()
      yield* formal(value)
    } else { await this.beforeMain(options); yield* text('The coordinator is idle.') }
  }
}

/** Compose the real services in an isolated scratch root; no main-checkout Git operation is performed.
 * @param options - omit Git services to test optional-backend behavior, or supply complete model budgets.
 * @returns the composed runtime, public Agents, observable barriers, and backend filesystem helpers.
 */
export async function gitRuntimeFixture(
  options: { readonly backend?: boolean; readonly settings?: RgSettings; readonly noGit?: boolean } = {},
) {
  const base = await mkdtemp(join(tmpdir(), 'dsh-rg-local-runtime-'))
  const releases: (() => void)[] = []
  const pending = new Set<Promise<unknown>>()
  const track = <T>(operation: Promise<T>): Promise<T> => {
    pending.add(operation)
    operation.then(() => { pending.delete(operation) }, () => { pending.delete(operation) })
    return operation
  }
  const ctx = new Context()
  onTestFinished(async () => {
    for (const release of releases) release()
    await Promise.allSettled([...pending])
    await ctx.fiber.dispose()
    await rm(base, { recursive: true, force: true })
  })
  const root = options.noGit ? base : await repository(base)
  if (options.noGit) await writeFile(join(root, 'tracked.txt'), 'fixture content\n')
  await ctx.plugin(Loader)
  await ctx.plugin(FsLocal, { cwd: root })
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await mountAgentLoopTestHarness(ctx)
  await ctx.plugin(Jsonl, { root: join(base, 'sessions'), compression: 'none' })
  let worktreeFiber: Fiber | undefined
  // The reviewer enforces its read-only claim through the sandbox policy, so the
  // fixture composes it even when no Git backend is requested.
  await ctx.plugin(SandboxPolicy, { mode: 'danger-full-access', workspaceRoot: root })
  if (options.backend !== false) {
    await ctx.plugin(Subprocess)
    await ctx.plugin(UnusedSandbox)
    worktreeFiber = ctx.plugin(Worktrees)
    await worktreeFiber.await()
  }
  ctx.loader.builtins.rgGitRole = Role
  await ctx.plugin(AgentPresets, { default: 'standard' })
  for (const [id, role] of [['standard', null], ['rg', 'main'], ['rg-worker', 'worker'], ['rg-reviewer', 'reviewer']] as const) {
    await ctx.plugin({ inject: ['agentPresets'], async *apply(child: Context) {
      yield await child.agentPresets.register({ id, plugins: role === null ? [] : [{ name: 'cordis:rgGitRole', config: { role } }] })
    } })
  }
  await ctx.plugin(Subagents)
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  const adapter = new GitAdapter(ctx)
  ctx.effect(() => ctx.llm.registerAdapter(['fixture'], adapter))
  ctx.loader.builtins.rgGitRuntime = ReviewGated
  const runtimeId = await ctx.loader.create({ name: 'cordis:rgGitRuntime', config: {
    settings: options.settings ?? gitSettings(), git: { gitCommand: 'git', timeoutMs: 60_000, graceMs: 1_000, maxOutputBytes: 1_000_000 },
  } })
  const entry = ctx.loader.resolve(runtimeId)
  if (entry.fiber === undefined) throw new Error('The local Git runtime must activate.')
  await entry.fiber.await()
  let sequence = 0
  const create = async (seed?: readonly SessionEvent[], agentOptions: AgentOptions = { provider: 'fixture', model: 'prior', reasoningEffort: low }) =>
    ctx.agents.create({ sessionId: SessionId('rg-git-parent-' + String(++sequence)), agentOptions, meta: { cwd: root },
      ...seed === undefined ? {} : { seed }, setup: async (child, agent) => {
        await ctx.agentPresets.mount(child, 'rg')
        if (ctx.agentPresets.presetForSession(agent.session) === null) agent.session.append('agent-preset/selected', { agentPreset: 'rg' })
      } })
  const task = async () => {
    const handle = await create()
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Deliver the scoped implementation' }], source: { kind: 'user' } }))
    await handle.agent.whenIdle()
    return handle
  }
  const gate = () => {
    const deferred = Promise.withResolvers<undefined>()
    releases.push(() => { deferred.resolve(undefined) })
    return deferred
  }
  const until = (agent: Agent, predicate: (state: RgSessionState | null) => boolean) => {
    const current = ctx.reviewGated.read(agent.session)
    if (predicate(current)) return Promise.resolve(current)
    return new Promise<RgSessionState | null>((resolve) => {
      const off = ctx.on('session/event', (session, event) => {
        if (session !== agent.session || (event.type !== 'review-gated/state' && event.type !== 'review-gated/result-confirmed')) return
        const state = ctx.reviewGated.read(session)
        if (predicate(state)) { off(); resolve(state) }
      })
      releases.push(off)
    })
  }
  const notice = (agent: Agent) => new Promise<void>((resolve) => {
    const off = ctx.on('agent/inbox/claimed', (event) => {
      if (event.agent === agent && event.message.source.kind === 'review-gated') { off(); resolve() }
    })
    releases.push(off)
  })
  const role = async (agent: Agent, role: 'worker' | 'reviewer', handoff = gitHandoff) => {
    const delivered = notice(agent)
    const result = await ctx.reviewGated.startRole(agent, role, handoff, undefined, new AbortController().signal)
    await until(agent, state => state?.task?.active === null && (role === 'worker'
      ? state.task.lastWorker?.id === result.runId : state.task.lastReview?.id === result.runId))
    await delivered
    await agent.whenIdle()
    return result
  }
  const write = async (agent: Agent, path: string, content: string, signal?: AbortSignal) => {
    const target = await ctx.fs.resolve(path, { cwd: ctx.workingDirectory.get(agent.session), ...signal === undefined ? {} : { signal } })
    return ctx.fs.writeText(target, content, undefined, signal, ctx.get('sandboxPolicy')?.resolve({ session: agent.session }))
  }
  adapter.worker = async (agent, request) => { await write(agent, 'tracked.txt', 'worker delivery\n', request.signal); return workerReport }
  const enabled = async (value: boolean) => {
    await entry.update({ disabled: !value })
    if (value) {
      if (entry.fiber === undefined) throw new Error('The runtime must reactivate.')
      await entry.fiber.await()
    }
  }
  return { ctx, root, base, adapter, create, task, gate, until, notice, role, write, enabled, track, worktreeFiber,
    get runtime() { return ctx.reviewGated }, entry }
}

export { git }
