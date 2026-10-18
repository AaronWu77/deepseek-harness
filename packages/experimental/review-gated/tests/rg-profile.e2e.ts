/** Real headless-profile composition: RG presets, guidance, worker, and reviewer. */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const binScript = join(repoRoot, 'packages/test-support/loader-smoke/tests/fixtures/headless-driver.ts')
const tsconfigPath = join(repoRoot, 'tsconfig.json')
const bundlePatch = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))
const scriptedLlm = new URL('./fixtures/rg-scripted-llm.ts', import.meta.url).href
const selectRoot = new URL('./fixtures/select-rg.ts', import.meta.url).href

const task = 'Use rg_worker, then rg_reviewer, and report both result markers.'

/** Narrow one parsed session event. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Headless overlay: keyless model, RG registry, root selection, and isolated paths. */
function overlay(): string {
  return [
    '- id: headless-startup',
    '  disabled: true',
    '',
    '- id: headless-runner',
    '  disabled: true',
    '',
    '- id: llm-deepseek',
    '  disabled: true',
    '',
    '- id: plugin-package-inventory-deepseek',
    '  disabled: true',
    '',
    '- id: session-title-llm',
    '  disabled: true',
    '',
    '- id: session-log-deepseek',
    '  config:',
    '    enabled: false',
    '',
    '- id: agent-instructions',
    '  disabled: true',
    '',
    '- id: agent-loop',
    '  config:',
    '    agents:',
    '      - id: main',
    '        provider: rg-scripted',
    '        model: rg-scripted',
    '        cwd: !!js process.cwd()',
    '',
    '- id: shell-env',
    '  config:',
    "    dshHome: './.dsh-home'",
    '',
    '- id: skill-filesystem',
    '  config:',
    "    dshHome: './.dsh-home'",
    "    agentsHome: './.agents-home'",
    '',
    '- id: session-persistence-jsonl',
    '  config:',
    "    root: './.sessions'",
    '',
    '- insert:',
    '    - id: rg-preset-registry',
    "      name: '@deepseek-ai/dsh-agent-preset-registry'",
    '      config:',
    '        default: rg',
    '    - id: rg-scripted-llm',
    `      name: ${JSON.stringify(scriptedLlm)}`,
    '    - id: rg-select-root',
    `      name: ${JSON.stringify(selectRoot)}`,
    '',
  ].join('\n')
}

describe('RG through the shipped headless profile', () => {
  it('selects RG, mounts the guidance, and runs worker and reviewer personas', async () => {
    const result = await runLoaderSmoke({
      label: 'review-gated-profile',
      tempDirPrefix: 'review-gated-',
      binScript,
      configPath: 'rg.patch.yml',
      binArgs: ['rg.patch.yml', task],
      tsconfigPath,
      processTimeoutMs: LOADER_SMOKE_TEST_TIMEOUT_MS,
      env: { DSH_TELEMETRY_DISABLED: '1' },
      prepare: async (cwd) => {
        const bundle = await import('node:fs/promises').then(fs => fs.readFile(bundlePatch, 'utf8'))
        await writeFile(join(cwd, 'rg.patch.yml'), `${bundle}\n${overlay()}`)
      },
    })

    const lines = result.stdout.trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    const summary = lines.at(-1) as Record<string, unknown>
    const events = lines.flatMap((line) => {
      const event = line['event']
      return isRecord(event) ? [event] : []
    })
    expect(String(summary['output'])).toContain('PARENT_DONE WORKER_OK REVIEW_OK')
    const called = events.flatMap(event => event['type'] === 'tool/call'
      ? [String((event['data'] as Record<string, unknown>)['name'])] : [])
    expect(called).toEqual(expect.arrayContaining(['rg_worker', 'rg_reviewer']))
    expect(result.stderr).not.toContain('Error')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS + 30_000)
})
