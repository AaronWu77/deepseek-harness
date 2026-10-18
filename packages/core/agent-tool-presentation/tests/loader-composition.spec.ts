/** YAML Loader presets keep PTC projection and execution on the same scoped provider. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, FiberState } from '@deepseek-ai/cordis'
import Loader, { type Entry, type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Group from '@deepseek-ai/cordis-plugin-group'
import * as sessionPlugin from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as projectionPlugin from '@deepseek-ai/dsh-session-projection'
import * as llmPlugin from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as promptPlugin from '@deepseek-ai/dsh-system-prompt'
import * as toolsPlugin from '@deepseek-ai/dsh-tools'
import { RUN_CODE_NAME } from '@deepseek-ai/dsh-tools'
import * as fsPlugin from '@deepseek-ai/dsh-fs-local'
import * as directoryPlugin from '@deepseek-ai/dsh-working-directory'
import * as toolFsPlugin from '@deepseek-ai/dsh-tool-fs'
import * as agentPlugin from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as loopPlugin from '@deepseek-ai/dsh-agent-loop'
import * as presetsPlugin from '@deepseek-ai/dsh-agent-preset-registry'
import * as presetPlugin from '@deepseek-ai/dsh-agent-preset'
import * as presentationPlugin from '@deepseek-ai/dsh-agent-tool-presentation'
import * as backendPlugin from './fixtures/scripted-runtime.ts'
import ScriptedRuntime, { HOLD_PROGRAM, READ_PROGRAM } from './fixtures/scripted-runtime.ts'

let root: string | undefined
let context: Context | undefined
const runtimes = new Set<ScriptedRuntime>()
let nextCall = 0

afterEach(async () => {
  // Assertion failures must release an active fixture barrier before Cordis awaits provider cleanup.
  for (const runtime of runtimes) runtime.finishRun.resolve(undefined)
  await context?.fiber.dispose()
  context = undefined
  runtimes.clear()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function boot(mode: 'ptc' = 'ptc') {
  root = await mkdtemp(join(tmpdir(), 'dsh-presentation-loader-'))
  const fixture = await readFile(new URL('./fixtures/scoped-runtime.yml', import.meta.url), 'utf8')
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, fixture.replace('{{root}}', root.replaceAll('\\', '/')).replace('{{mode}}', mode))
  await writeFile(join(root, 'input.txt'), 'REAL_SCOPED_READ\n')
  const ctx = context = new Context()
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.builtins.group = Group
  // Static imports use the isolated tsconfig source paths; built package exports are not test inputs.
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-session', sessionPlugin],
    ['@deepseek-ai/dsh-session-projection', projectionPlugin],
    ['@deepseek-ai/dsh-llm', llmPlugin],
    ['@deepseek-ai/dsh-system-prompt', promptPlugin],
    ['@deepseek-ai/dsh-tools', toolsPlugin],
    ['@deepseek-ai/dsh-fs-local', fsPlugin],
    ['@deepseek-ai/dsh-tool-fs', toolFsPlugin],
    ['@deepseek-ai/dsh-working-directory', directoryPlugin],
    ['@deepseek-ai/dsh-agent', agentPlugin],
    ['@deepseek-ai/dsh-agent-loop', loopPlugin],
    ['@deepseek-ai/dsh-agent-preset-registry', presetsPlugin],
    ['@deepseek-ai/dsh-agent-preset', presetPlugin],
    ['@deepseek-ai/dsh-agent-tool-presentation', presentationPlugin],
    ['./scripted-runtime.ts', backendPlugin],
  ])
  const unsupported = (): never => { throw new Error('Unexpected Node module loader operation') }
  const internal: ModuleLoaderV2 = {
    version: 'v2', loadCache: new Map(),
    import(specifier) {
      if (!modules.has(specifier)) throw new Error('Unexpected Loader import: ' + specifier)
      return Promise.resolve(modules.get(specifier))
    },
    register: unsupported, getOrCreateModuleJob: unsupported, resolveSync: unsupported, load: unsupported,
  }
  ctx.loader.internal = internal
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  expect((await ctx.agentPresets.list()).map(row => ({ id: row.id, broken: row.broken }))).toEqual([
    { id: 'deployment', broken: undefined }, { id: 'native', broken: undefined }, { id: 'scoped', broken: undefined },
  ])
  const create = async (preset: string, id = preset) => (await ctx.agents.create({
    sessionId: SessionId(id), meta: { cwd: root! },
    setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, preset) },
  })).agent
  const scoped = await create('scoped')
  const joined = await create('scoped', 'joined')
  const deployment = await create('deployment')
  const native = await create('native')
  const runtime = provider(ctx, scoped)
  const hostRuntime = ctx.ptcRuntime as ScriptedRuntime
  runtimes.add(hostRuntime)
  const entry = runtime.ownerEntry
  const presentation = entry === undefined ? undefined
    : [...entry.parent.tree.entries()].find(value => value.options.id === 'presentation')
  if (entry === undefined || presentation === undefined) throw new Error('Scoped Loader rows are missing')
  return { ctx, scoped, joined, deployment, native, runtime, hostRuntime, entry, presentation }
}

function provider(ctx: Context, agent: Agent): ScriptedRuntime {
  const runtime = ctx.agentPresets.serviceFor(agent, 'ptcRuntime')
  if (!(runtime instanceof ScriptedRuntime)) throw new Error('Scoped backend is missing')
  runtimes.add(runtime)
  return runtime
}

async function assembly(ctx: Context, agent: Agent) {
  return ctx.systemPrompt.assemble({ scope: agent, agent })
}

function runCode(ctx: Context, agent: Agent, code = READ_PROGRAM, signal = new AbortController().signal) {
  return ctx.tools.execute({ callId: ToolCallId('code-' + agent.id + '-' + String(++nextCall)), name: RUN_CODE_NAME,
    arguments: { code, description: 'Read isolated composition fixture through scoped tools' }, agent, signal })
}

async function disable(ctx: Context, entry: Entry) {
  const fiber = entry.fiber
  await entry.update({ disabled: true })
  await fiber?.dispose()
  await ctx.loader.await()
}

async function assertSiblings(ctx: Context, deployment: Agent, native: Agent) {
  const coded = await assembly(ctx, deployment)
  expect(coded.tools.map(tool => tool.name)).toEqual([RUN_CODE_NAME])
  expect(coded.tools[0]?.description).toContain('Python')
  expect(coded.tools[0]?.description).toContain('Fixture provider: deployment')
  expect(coded.sections.find(section => section.name === 'tools:sdk')?.text).toContain('async def read')
  const plain = await assembly(ctx, native)
  expect(plain.tools.map(tool => tool.name)).toEqual(['edit', 'read', 'write'])
  expect(plain.sections.some(section => section.name === 'tools:sdk')).toBe(false)
}

describe('agent tool presentation through YAML Loader presets', () => {
  it.each(['ptc'] as const)('uses the isolated provider for %s projection, SDK and real nested reads', async (mode) => {
    const { ctx, scoped, joined, deployment, native, runtime, hostRuntime } = await boot(mode)
    expect(runtime.config.label).toBe('scoped-v1')
    expect(hostRuntime.config.label).toBe('deployment')
    expect(ctx.agentPresets.serviceFor(joined, 'ptcRuntime')?.language).toBe('typescript')
    for (const agent of [scoped, joined]) {
      const prompt = await assembly(ctx, agent)
      expect(prompt.tools.map(tool => tool.name).sort()).toEqual([RUN_CODE_NAME])
      const schema = prompt.tools.find(tool => tool.name === RUN_CODE_NAME)
      expect(schema?.description).toContain('TypeScript')
      expect(schema?.description).toContain('Fixture provider: scoped-v1')
      expect(JSON.stringify(schema?.parameters)).toContain('Default 11000; capped at 12000')
      expect(prompt.sections.find(section => section.name === 'tools:sdk')?.text).toContain('declare const tools: {')
      const result = await runCode(ctx, agent)
      expect(result.isError).toBe(false)
      expect(result.value).toMatchObject({ result: { provider: 'scoped-v1', read: { lines: [{ number: 1, text: 'REAL_SCOPED_READ' }] } } })
      const dispatches = agent.session.snapshotEvents().filter(event => event.type === 'tool/ptc-dispatch')
      expect(dispatches).toHaveLength(1)
      expect(dispatches[0]?.data).toMatchObject({ name: 'read', arguments: { file_path: 'input.txt' }, isError: false })
    }
    expect(runtime.requests).toHaveLength(2)
    expect(runtime.requests[0]).toMatchObject({ cwd: root, timeoutMs: 11000, program: READ_PROGRAM })
    expect(hostRuntime.requests).toHaveLength(0)
    await assertSiblings(ctx, deployment, native)
    expect((await runCode(ctx, deployment)).value).toMatchObject({ result: { provider: 'deployment' } })
    expect(hostRuntime.requests).toHaveLength(1)
  })

  it('removes and rebinds the scoped mode when its provider changes while presentation remains live', async () => {
    const { ctx, scoped, joined, deployment, native, runtime, hostRuntime, entry, presentation } = await boot()
    const presentationFiber = presentation.fiber
    expect(presentationFiber?.state).toBe(FiberState.ACTIVE)
    await runCode(ctx, scoped)
    await disable(ctx, entry)
    expect(presentation.fiber).toBe(presentationFiber)
    expect(presentationFiber?.state).toBe(FiberState.ACTIVE)
    for (const agent of [scoped, joined]) {
      const prompt = await assembly(ctx, agent)
      expect(prompt.tools.map(tool => tool.name).sort()).toEqual(['edit', 'read', 'write'])
      expect(prompt.sections.some(section => section.name === 'tools:sdk')).toBe(false)
      expect((await runCode(ctx, agent)).isError).toBe(true)
    }
    expect(runtime.requests).toHaveLength(1)
    expect(hostRuntime.requests).toHaveLength(0)
    await assertSiblings(ctx, deployment, native)
    await entry.update({ disabled: false, config: { label: 'scoped-v2', language: 'typescript', defaultMs: 21000, maxMs: 22000 } })
    await ctx.loader.await()
    const replacement = provider(ctx, scoped)
    expect(replacement.requests).toHaveLength(0)
    expect(runtime.config.label).toBe('scoped-v1')
    for (const agent of [scoped, joined]) {
      const prompt = await assembly(ctx, agent)
      expect(prompt.tools.map(tool => tool.name).sort()).toEqual([RUN_CODE_NAME])
      expect(prompt.tools[0]?.description).toContain('Fixture provider: scoped-v2')
      expect(JSON.stringify(prompt.tools[0]?.parameters)).toContain('Default 21000; capped at 22000')
      expect((await runCode(ctx, agent)).value).toMatchObject({ result: { provider: 'scoped-v2' } })
    }
    expect(replacement.requests).toHaveLength(2)
    expect(runtime.requests).toHaveLength(1)
    expect(hostRuntime.requests).toHaveLength(0)
    expect(presentation.fiber).toBe(presentationFiber)
    await assertSiblings(ctx, deployment, native)
  })

  it.each(['caller abort', 'provider disposal'] as const)('waits for fixture-run quiescence on %s without disturbing siblings', async (cause) => {
    const { ctx, scoped, deployment, native, runtime, entry } = await boot()
    const controller = new AbortController()
    let runSettled = false
    let disposalSettled = false
    const running = runCode(ctx, scoped, HOLD_PROGRAM, controller.signal).then((result) => { runSettled = true; return result })
    await runtime.started.promise
    expect(runtime.activeRuns).toBe(1)
    const disposing = cause === 'provider disposal'
      ? disable(ctx, entry).then(() => { disposalSettled = true })
      : Promise.resolve()
    if (cause === 'caller abort') controller.abort('fixture caller canceled')
    await runtime.aborted.promise
    expect(runSettled).toBe(false)
    expect(runtime.activeRuns).toBe(1)
    if (cause === 'provider disposal') expect(disposalSettled).toBe(false)
    await assertSiblings(ctx, deployment, native)
    expect((await runCode(ctx, deployment)).value).toMatchObject({ result: { provider: 'deployment' } })
    runtime.finishRun.resolve(undefined)
    const result = await running
    await disposing
    expect(result.isError).toBe(true)
    expect(result.error?.message).toContain('code run failed (abort)')
    expect(runtime.activeRuns).toBe(0)
    if (cause === 'caller abort') expect((await runCode(ctx, scoped)).value).toMatchObject({ result: { provider: 'scoped-v1' } })
    else expect((await assembly(ctx, scoped)).tools.map(tool => tool.name)).toEqual(['edit', 'read', 'write'])
  })
})
