/** Keyless shipped headless profile with real PTC and local Git delivery. */
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { describe, expect, it, onTestFinished } from 'vitest'
import { z } from 'zod'

const execute = promisify(execFile)
const fixture = (name: string) => new URL('./fixtures/' + name, import.meta.url).href
const bin = fileURLToPath(new URL('../../../../apps/cli/src/bin.ts', import.meta.url))
const libBin = fileURLToPath(new URL('../../../../apps/cli/lib/bin.js', import.meta.url))
const tsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))
const worktree = new URL('../../worktree/src/index.ts', import.meta.url).href

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execute('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '', GIT_CONFIG_PARAMETERS: '',
      GIT_CONFIG_COUNT: '0', GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined } })
  return result.stdout.trim()
}

function overlay(): string {
  return `
- id: llm-deepseek
  disabled: true
- id: llm-deepseek-account
  disabled: true
- id: plugin-package-inventory-deepseek
  disabled: true
- id: session-title-llm
  disabled: true
- id: session-log-deepseek
  config:
    enabled: false
- id: agent-loop
  config:
    agents: []
- id: session-persistence-jsonl
  config:
    root: './.sessions'
    compression: none
- id: sandbox-policy
  inject: []
  config:
    mode: danger-full-access
    workspaceRoot: !!js process.cwd()
- insert:
    - id: rg-bundle
      name: ${JSON.stringify(fixture('rg-bundle.ts'))}
    - id: rg-preset-registry
      name: '@deepseek-ai/dsh-agent-preset-registry'
      config:
        default: rg
    - id: rg-scripted-llm
      name: ${JSON.stringify(fixture('git-ptc-llm.ts'))}
    - id: rg-select-root
      name: ${JSON.stringify(fixture('select-rg.ts'))}
    - id: worktree
      name: ${JSON.stringify(worktree)}
    - id: git-driver
      name: ${JSON.stringify(fixture('git-ptc-driver.ts'))}
`
}

const outputRow = z.looseObject({ type: z.string() })
const observationSchema = z.object({
  state: z.object({ task: z.unknown() }),
  git: z.object({
    candidate: z.object({ headOid: z.string(), baseOid: z.string(), inspection: z.object({ root: z.string() }) }),
    binding: z.object({ checkout: z.object({ root: z.string() }) }),
  }),
})

interface Log { header: SessionHeader; events: SessionEvent[] }
async function logs(root: string): Promise<Log[]> {
  const entries = await readdir(root, { withFileTypes: true })
  return (await Promise.all(entries.map(async (entry) => {
    const path = join(root, entry.name)
    if (entry.isDirectory()) return logs(path)
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) return []
    const [header, ...events] = (await readFile(path, 'utf8')).trimEnd().split('\n')
    return [{ header: JSON.parse(header ?? '') as SessionHeader, events: events.map(line => JSON.parse(line) as SessionEvent) }]
  }))).flat()
}

describe('Git delivery through the headless PTC profile', { timeout: 300_000, retry: 0 }, () => {
  it('commits the worker candidate, independently reviews it, and preserves source state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rg-git-ptc-'))
    onTestFinished(async () => {
      const link = join(root, 'node_modules', '@deepseek-ai', 'dsh-experimental-review-gated')
      try { await unlink(link) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      await rm(root, { recursive: true, force: true })
    }, 120_000)
    let head = ''
    let status = ''
    let index = Buffer.alloc(0)
    let sessions: Log[] = []
    const result = await runLoaderSmoke({ label: 'rg-git-ptc', cwd: root, binScript: bin,
      libBinScript: libBin, tsconfigPath: tsconfig, sourceImport: 'tsx/esm', configPath: 'rg.patch.yml',
      processTimeoutMs: 240_000,
      binArgs: ['--profile', 'headless', '--patch', 'rg.patch.yml', '--json', 'Deliver tracked.txt'],
      env: { DSH_TELEMETRY_DISABLED: '1', DEEPSEEK_API_KEY: '', DSH_PERMISSION_MODE: 'danger-full-access',
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '', GIT_CONFIG_PARAMETERS: '', GIT_CONFIG_COUNT: '0',
        GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined },
      prepare: async (cwd) => {
        await git(cwd, 'init', '-b', 'main')
        await git(cwd, 'config', 'core.autocrlf', 'false')
        await git(cwd, 'config', 'user.name', 'Git PTC fixture')
        await git(cwd, 'config', 'user.email', 'git-ptc@example.invalid')
        await git(cwd, 'config', 'commit.gpgSign', 'false')
        await writeFile(join(cwd, 'tracked.txt'), 'initial\n')
        await git(cwd, 'add', 'tracked.txt')
        await git(cwd, 'commit', '-m', 'initial')
        await writeFile(join(cwd, 'tracked.txt'), 'source staged\n')
        await git(cwd, 'add', 'tracked.txt')
        await writeFile(join(cwd, 'tracked.txt'), 'source unstaged\n')
        await writeFile(join(cwd, 'untracked.txt'), 'source untracked\n')
        await writeFile(join(cwd, '.git/info/exclude'), '.agents/\n.dsh/\n.sessions/\nnode_modules/\npackage.json\nrg.patch.yml\n')
        const modules = join(cwd, 'node_modules', '@deepseek-ai')
        await mkdir(modules, { recursive: true })
        await symlink(fileURLToPath(new URL('../', import.meta.url)), join(modules, 'dsh-experimental-review-gated'),
          process.platform === 'win32' ? 'junction' : 'dir')
        await writeFile(join(cwd, 'package.json'), JSON.stringify({ private: true, type: 'module',
          dependencies: { '@deepseek-ai/dsh-experimental-review-gated': 'workspace:*' } }) + '\n')
        await writeFile(join(cwd, 'rg.patch.yml'), overlay())
        head = await git(cwd, 'rev-parse', 'HEAD')
        status = await git(cwd, 'status', '--porcelain')
        index = await readFile(join(cwd, '.git/index'))
      },
      inspect: async (cwd) => {
        expect(await git(cwd, 'rev-parse', 'HEAD')).toBe(head)
        expect(await git(cwd, 'status', '--porcelain')).toBe(status)
        expect(await readFile(join(cwd, '.git/index'))).toEqual(index)
        expect(await readFile(join(cwd, 'tracked.txt'), 'utf8')).toBe('source unstaged\n')
        expect(await readFile(join(cwd, 'untracked.txt'), 'utf8')).toBe('source untracked\n')
        sessions = await logs(join(cwd, '.sessions'))
      },
    })
    const rows = result.stdout.trim().split('\n').map(line => outputRow.parse(JSON.parse(line)))
    const observation = observationSchema.parse(rows.find(row => row.type === 'git_ptc_state'))
    expect(observation.state.task).toMatchObject({ workerAttempts: 1, reviewAttempts: 1, active: null, reviewStatus: 'reported-pass' })
    const candidate = observation.git.candidate
    const reviewer = observation.git.binding.checkout.root
    expect(candidate.headOid).not.toBe(head)
    expect(candidate.baseOid).toBe(head)
    const scratch = await realpath(root)
    for (const path of [candidate.inspection.root, reviewer]) {
      const child = relative(scratch, await realpath(path))
      expect(child !== '' && child !== '..' && !child.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) && !isAbsolute(child)).toBe(true)
    }
    expect(reviewer).not.toBe(candidate.inspection.root)
    expect(await git(candidate.inspection.root, 'show', 'HEAD:tracked.txt')).toBe('candidate delivery')
    expect(await git(reviewer, 'rev-parse', 'HEAD')).toBe(candidate.headOid)
    expect(await git(reviewer, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD')
    expect(rows.findLast(row => row.type === 'final')).toMatchObject({ text: 'PARENT_DONE WORKER_OK REVIEW_OK' })
    expect(sessions).toHaveLength(3)
    const parent = sessions.find(log => log.header.parentSession === undefined)
    expect(parent).toBeDefined()
    expect(parent?.events.flatMap(event => event.type === 'tool/ptc-dispatch' && ['rg_worker', 'rg_reviewer'].includes(event.data.name)
      ? [event.data.name] : [])).toEqual(['rg_worker', 'rg_reviewer'])
    for (const log of sessions) {
      expect(log.events.filter(event => event.type === 'tool/ptc-dispatch' && event.data.isError)).toEqual([])
      expect(log.events.filter(event => event.type === 'tool/result' && event.data.message.isError)).toEqual([])
    }
    for (const [preset, operation] of [['rg-worker', 'write'], ['rg-reviewer', 'read']] as const) {
      const child = sessions.find(log => log.header.agentPreset === preset)
      expect(child?.header.parentSession).toBe(parent?.header.id)
      expect(child?.events.filter(event => event.type === 'tool/ptc-dispatch').map(event => event.data.name)).toContain(operation)
      expect(child?.events.filter(event => event.type === 'tool/ptc-dispatch').map(event => event.data.name)).toContain('structured_output')
    }
  })
})
