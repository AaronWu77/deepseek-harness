import { execFile } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedModel, unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import SandboxProvider from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, SandboxMode, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import LocalSandbox from '@deepseek-ai/dsh-sandbox-local'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import WorkingDirectoryService from '@deepseek-ai/dsh-working-directory'
import WorktreeService from '../src/index.ts'
import type { Config } from '../src/index.ts'

const execute = promisify(execFile)

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execute('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '', GIT_CONFIG_PARAMETERS: '', GIT_CONFIG_COUNT: '0', GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined },
  })
  return result.stdout.trim()
}

/** Unconfined fixtures must never accidentally exercise the confined branch. */
export class UnusedSandbox extends SandboxProvider {
  async confine(_argv: readonly string[], _policy: SandboxPolicy): Promise<ConfinedArgv> {
    throw new Error('unexpected confinement in a danger-full-access fixture')
  }
}

export function testAgent(ctx: Context, cwd: string, name = 'worktree-test'): Agent {
  const scope = ctx.plugin(() => {})
  const id = SessionId(name)
  const session = Session.create(id, [], { version: SESSION_FORMAT_VERSION, id, createdAt: 0, isSeeded: false, cwd })
  const agent: Agent = {
    id, session, options: {}, status: 'idle', ctx: scope.ctx, model: unsupportedModel(),
    inbox: unsupportedInbox(),
    send() {}, followup() {}, steer() {}, inject() {}, cancel() {},
    whenIdle: async () => {}, runMaintenance: task => task(new AbortController().signal),
  }
  ctx.agents.register(agent)
  return agent
}

export async function repository(parent = tmpdir()): Promise<string> {
  const path = await realpath(await mkdtemp(join(parent, 'dsh-worktree-')))
  try {
    await git(path, 'init', '-b', 'main')
    await git(path, 'config', 'core.autocrlf', 'false')
    await git(path, 'config', 'user.name', 'Worktree fixture')
    await git(path, 'config', 'user.email', 'worktree@example.invalid')
    await git(path, 'config', 'commit.gpgSign', 'false')
    await writeFile(join(path, 'tracked.txt'), 'initial\n')
    await git(path, 'add', 'tracked.txt')
    await git(path, 'commit', '-m', 'initial')
    return path
  } catch (error) {
    await rm(path, { recursive: true, force: true })
    throw error
  }
}

export async function harness(root: string, config: Config = {}, mode: SandboxMode = 'danger-full-access'): Promise<Context> {
  const ctx = new Context()
  try {
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(LocalFileSystem, { cwd: root })
    await ctx.plugin(LocalSubprocessRuntime)
    if (mode === 'danger-full-access') await ctx.plugin(UnusedSandbox)
    else await ctx.plugin(LocalSandbox)
    await ctx.plugin(SandboxPolicyService, { mode, workspaceRoot: root })
    await ctx.plugin(WorkingDirectoryService)
    await ctx.plugin(WorktreeService, config)
    return ctx
  } catch (error) {
    await ctx.fiber.dispose()
    throw error
  }
}

/** Boot the real service providers from a private Loader config, without a model request. */
export async function loaderHarness(root: string, mode: SandboxMode = 'danger-full-access'): Promise<Context> {
  const modules = new Map<string, unknown>([
    ['session-projections', SessionProjectionRegistry],
    ['agents', AgentRegistry],
    ['system-prompt', SystemPrompt],
    ['fs', LocalFileSystem],
    ['subprocess', LocalSubprocessRuntime],
    ['sandbox', LocalSandbox],
    ['sandbox-policy', SandboxPolicyService],
    ['working-directory', WorkingDirectoryService],
    ['worktree', WorktreeService],
  ])
  const config = [...modules.keys()].flatMap(name => [
    `- name: 'cordis:${name}'`,
    ...name === 'fs' ? ['  config:', `    cwd: ${JSON.stringify(root)}`] : [],
    ...name === 'sandbox-policy' ? ['  config:', `    mode: ${mode}`, `    workspaceRoot: ${JSON.stringify(root)}`] : [],
  ]).join('\n') + '\n'
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, config)
  const ctx = new Context()
  try {
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    for (const [name, plugin] of modules) ctx.loader.builtins[name] = plugin
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await ctx.loader.await()
    return ctx
  } catch (error) {
    await ctx.fiber.dispose()
    throw error
  }
}

export async function contents(path: string): Promise<string> {
  return readFile(path, 'utf8')
}

/**
 * Create a filter whose file marker and transformed output reveal its execution.
 * @param root - the owning test's private repository directory.
 * @param processFilter - fail the process-filter handshake instead of transforming stdin.
 * @returns a Git shell command and the marker it writes.
 */
export async function filterCommand(root: string, processFilter = false): Promise<{ command: string; marker: string }> {
  const script = join(root, 'filter.cjs')
  const marker = join(root, 'filter-executed')
  await writeFile(script, `
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(marker)}, 'executed\\n');
${processFilter ? 'process.exit(1);' : "process.stdout.write('filtered\\n' + fs.readFileSync(0, 'utf8'));"}
`)
  const quoted = (value: string) => `'${value.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`
  return { command: `${quoted(process.execPath)} ${quoted(script)}`, marker }
}
