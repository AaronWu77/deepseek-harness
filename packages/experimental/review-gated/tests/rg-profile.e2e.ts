/** Real headless-profile composition: RG mount health, PTC tools, and durable role sessions. */
import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FiberState } from '@deepseek-ai/cordis'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-tool-executor-ptc/types'
import { describe, expect, it } from 'vitest'

const binScript = fileURLToPath(new URL('../../../../apps/cli/src/bin.ts', import.meta.url))
const observer = new URL('./fixtures/rg-driver.ts', import.meta.url).href
const tsconfigPath = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))
const bundleFixture = new URL('./fixtures/rg-bundle.ts', import.meta.url).href
const scriptedLlm = new URL('./fixtures/rg-scripted-llm.ts', import.meta.url).href
const selectRoot = new URL('./fixtures/select-rg.ts', import.meta.url).href
const tempDirParent = fileURLToPath(new URL('.', import.meta.url))
const task = 'Use rg_worker, then rg_reviewer, and report both result markers.'
const presetIds = ['rg', 'rg-worker', 'rg-reviewer']

interface PersistedSession {
  header: SessionHeader
  events: SessionEvent[]
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('expected fixture JSON object')
  return value as Record<string, unknown>
}

/** The real bundle stays unchanged; only host automation, model I/O, and private paths vary. */
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
      name: ${JSON.stringify(bundleFixture)}
    - id: rg-preset-registry
      name: '@deepseek-ai/dsh-agent-preset-registry'
      config:
        default: rg
    - id: rg-scripted-llm
      name: ${JSON.stringify(scriptedLlm)}
    - id: rg-select-root
      name: ${JSON.stringify(selectRoot)}
    - id: rg-observer
      name: ${JSON.stringify(observer)}
`
}

async function persistedSessions(root: string): Promise<PersistedSession[]> {
  const entries = await readdir(root, { withFileTypes: true })
  const sessions = await Promise.all(entries.map(async (entry): Promise<PersistedSession[]> => {
    const path = join(root, entry.name)
    if (entry.isDirectory()) return persistedSessions(path)
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) return []
    const [header, ...events] = (await readFile(path, 'utf8')).trimEnd().split('\n')
    return [{ header: JSON.parse(header ?? '') as SessionHeader, events: events.map(line => JSON.parse(line) as SessionEvent) }]
  }))
  return sessions.flat()
}

async function runProfile(input: string, inspect?: (cwd: string) => Promise<void>) {
  return runLoaderSmoke({
    label: 'review-gated-profile',
    tempDirPrefix: '.rg-profile-',
    tempDirParent,
    binScript,
    libBinScript: fileURLToPath(new URL('../../../../apps/cli/lib/bin.js', import.meta.url)),
    configPath: 'rg.patch.yml',
    binArgs: ['--profile', 'headless', '--patch', 'rg.patch.yml', '--json', input === '--mount' ? 'RG_MOUNT_ONLY' : input],
    tsconfigPath,
    sourceImport: 'tsx/esm',
    env: { DSH_TELEMETRY_DISABLED: '1', DEEPSEEK_API_KEY: '', DSH_PERMISSION_MODE: 'danger-full-access' },
    prepare: async (cwd) => {
      const packageName = '@deepseek-ai/dsh-experimental-review-gated'
      const modules = join(cwd, 'node_modules', '@deepseek-ai')
      await mkdir(modules, { recursive: true })
      await symlink(fileURLToPath(new URL('../', import.meta.url)), join(modules, 'dsh-experimental-review-gated'),
        process.platform === 'win32' ? 'junction' : 'dir')
      await writeFile(join(cwd, 'package.json'), JSON.stringify({ private: true, type: 'module',
        dependencies: { [packageName]: 'workspace:*' } }) + '\n')
      await writeFile(join(cwd, 'rg.patch.yml'), overlay())
      await writeFile(join(cwd, 'probe.txt'), 'RG integration probe\n')
    },
    ...inspect === undefined ? {} : { inspect },
  })
}

function expectHealthy(stdout: string): Record<string, unknown>[] {
  const rows = stdout.trimEnd().split('\n').map(line => record(JSON.parse(line)))
  const health = rows.find(row => row['type'] === 'preset_health')
  const presets = record(health)['presets'] as Record<string, unknown>[]
  expect(presets.map(preset => preset['id']).sort()).toEqual([...presetIds].sort())
  for (const preset of presets) {
    expect(preset).not.toHaveProperty('broken')
    const enabled = (preset['rows'] as Record<string, unknown>[]).filter(row => row['enabled'] === true)
    expect(enabled.length).toBeGreaterThan(0)
    expect(enabled.filter(row => row['fiberState'] !== FiberState.ACTIVE)).toEqual([])
  }
  const scopes = rows.filter(row => row['type'] === 'scope_health')
  expect(scopes.map(row => row['preset'])).toEqual(presetIds)
  for (const scope of [...scopes, ...rows.filter(row => row['type'] === 'agent_health')]) {
    expect((scope['tools'] as string[]).filter(name => name === 'list_agents')).toEqual(['list_agents'])
  }
  return rows
}

/** Node's PTC TypeScript-transform warning is the only permitted stderr. */
function expectCleanStderr(stderr: string): void {
  if (stderr === '') return
  const lines = stderr.trimEnd().split(/\r?\n/)
  expect(lines).toHaveLength(2)
  expect(lines[0]).toMatch(
    /^\(node:\d+\) ExperimentalWarning: stripTypeScriptTypes is an experimental feature and might change at any time$/,
  )
  expect(lines[1]).toBe('(Use `node --trace-warnings ...` to show where the warning was created)')
}

function systemText(events: SessionEvent[]): string {
  return events.flatMap(event => event.type === 'system/message'
    ? event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []) : []).join('\n')
}

describe('RG through the shipped headless profile', () => {
  it('mounts all three presets with one list_agents registration per scope', async () => {
    const result = await runProfile('--mount')
    expectHealthy(result.stdout)
    expectCleanStderr(result.stderr)
  })

  it('runs worker and reviewer via PTC with separate personas and durable parent-child logs', async () => {
    let logs: PersistedSession[] = []
    const result = await runProfile(task, async (cwd) => { logs = await persistedSessions(join(cwd, '.sessions')) })
    const rows = expectHealthy(result.stdout)
    const diagnostics = logs.map(log => ({ preset: log.header.agentPreset, events: log.events.filter(event => event.type === 'review-gated/state' || event.type === 'tool/result' && event.data.message.isError) }))
    expect(rows.findLast(row => row['type'] === 'final'), result.stderr + JSON.stringify(diagnostics)).toMatchObject({ type: 'final', text: 'PARENT_DONE WORKER_OK REVIEW_OK' })
    const agents = rows.filter(row => row['type'] === 'agent_health')
    expect(agents.map(row => row['preset']).sort()).toEqual([...presetIds].sort())
    expectCleanStderr(result.stderr)

    expect(logs).toHaveLength(3)
    const roots = logs.filter(log => log.header.parentSession === undefined)
    expect(roots).toHaveLength(1)
    const parent = roots[0]
    if (parent === undefined) throw new Error('missing persisted root session')
    expect(parent.events).toContainEqual(expect.objectContaining({ type: 'agent-preset/selected', data: { agentPreset: 'rg' } }))
    expect(systemText(parent.events)).toContain('RG: work and independent review')
    expect(systemText(parent.events)).not.toContain('RG execution worker')
    expect(systemText(parent.events)).not.toContain('RG independent reviewer')
    expect(parent.events.flatMap(event => event.type === 'tool/ptc-dispatch' && ['rg_worker', 'rg_reviewer'].includes(event.data.name)
      ? [event.data.name] : [])).toEqual(['rg_worker', 'rg_reviewer'])

    for (const [preset, persona, marker] of [
      ['rg-worker', 'RG execution worker', 'WORKER_OK'],
      ['rg-reviewer', 'RG independent reviewer', 'REVIEW_OK'],
    ] as const) {
      const children = logs.filter(log => log.header.agentPreset === preset)
      expect(children).toHaveLength(1)
      const child = children[0]
      if (child === undefined) throw new Error(`missing persisted ${preset} session`)
      expect(child.header).toMatchObject({ parentSession: parent.header.id, origin: 'subagent', delegationDepth: 1, isSeeded: false })
      expect(child.events).toContainEqual(expect.objectContaining({ type: 'agent-preset/selected', data: { agentPreset: preset } }))
      const prompt = systemText(child.events)
      expect(prompt).toContain(persona)
      expect(prompt).not.toContain('RG: work and independent review')
      expect(prompt).not.toContain(preset === 'rg-worker' ? 'RG independent reviewer' : 'RG execution worker')
      const reports = child.events.filter(event => event.type === 'tool/ptc-dispatch' && event.data.name === 'structured_output')
      expect(reports).toHaveLength(1)
      const report = reports[0]
      if (report?.type !== 'tool/ptc-dispatch') throw new Error('missing structured role report dispatch')
      expect(report.data.arguments).toMatchObject({ summary: marker })
      expect(report.data.isError).toBe(false)
      expect(parent.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'review-gated')
        .some(event => JSON.stringify(event.data).includes(marker))).toBe(true)
      expect(child.events.filter(event => event.type === 'request/header')
        .every(event => event.type === 'request/header' && event.data.header.config.model === preset)).toBe(true)
    }
    const prepared = parent.events.filter(event => event.type === 'review-gated/result-prepared').at(-1)
    if (prepared?.type !== 'review-gated/result-prepared') throw new Error('missing prepared reviewer result')
    expect(prepared.data.state.task).toMatchObject({ workerAttempts: 1, reviewAttempts: 1, active: null, reviewStatus: 'reported-pass' })
    expect(parent.events.filter(event => event.type === 'review-gated/result-confirmed').at(-1)).toMatchObject({ data: {
      taskId: prepared.data.taskId, runId: prepared.data.runId, childId: prepared.data.childId,
    } })
    for (const { events } of logs) {
      expect(events.filter(event => event.type === 'tool/ptc-dispatch' && event.data.name === 'list_agents')).toHaveLength(1)
      expect(events.filter(event => event.type === 'tool/ptc-dispatch' && event.data.isError)).toEqual([])
      expect(events.filter(event => event.type === 'tool/result' && event.data.message.isError)).toEqual([])
      expect(events.filter(event => event.type === 'turn/end' && event.data.reason.kind !== 'completed')).toEqual([])
      const requests = events.filter(event => event.type === 'request/header')
      expect(requests.length).toBeGreaterThan(0)
      for (const request of requests) expect(request.data.header.tools?.map(tool => tool.name)).toEqual(['run_code'])
    }
  })
})
