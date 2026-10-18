import { fileURLToPath } from 'node:url'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import { describe, expect, it } from 'vitest'

const patchPath = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))
const ptcPath = fileURLToPath(new URL('../../../bundle/web-app/presets/ptc.patch.yml', import.meta.url))

function definition(rows: EntryOptions[], id: string): PresetDefinition {
  const row = rows.find(row => row.id === id)
  if (row === undefined) throw new Error('Missing preset: ' + id)
  return row.config as PresetDefinition
}

type PluginRow = PresetDefinition['plugins'][number]

function leaves(rows: readonly PluginRow[]): PluginRow[] {
  return rows.flatMap(row => row.group && Array.isArray(row.config) ? leaves(row.config as readonly PluginRow[]) : [row])
}

function group(preset: PresetDefinition): PluginRow {
  const row = preset.plugins.find(row => row.id === 'rg-tools')
  if (row === undefined) throw new Error('Missing shared PTC tool group')
  return row
}

describe('RG optional bundle', () => {
  it('adds only its three preset declarations without changing the shipped PTC preset', () => {
    const ptc = loadOverlayPatches('rg-test', ptcPath)
    const rg = loadOverlayPatches('rg-test', patchPath)
    const warnings: string[] = []
    const before = composeEntries([ptc])
    const after = composeEntries([ptc, rg], warning => warnings.push(warning))
    expect(warnings).toEqual([])
    expect(after.map(row => row.id)).toEqual(['preset-ptc', 'preset-rg-worker', 'preset-rg-reviewer', 'preset-rg'])
    expect(after[0]).toEqual(before[0])
    expect(rg).toHaveLength(1)
    expect(rg[0]).toHaveProperty('insert')
    expect(definition(after, 'preset-rg').plugins.find(row => row.id === 'persona'))
      .toEqual(definition(before, 'preset-ptc').plugins.find(row => row.id === 'persona'))
  })

  it('gives all roles identical unrestricted PTC tools and reserves coordination for the main role', () => {
    const rows = composeEntries([loadOverlayPatches('rg-test', patchPath)])
    const worker = definition(rows, 'preset-rg-worker')
    const reviewer = definition(rows, 'preset-rg-reviewer')
    const main = definition(rows, 'preset-rg')
    expect(main.selectable).not.toBe(false)
    const shipped = definition(composeEntries([loadOverlayPatches('rg-test', ptcPath)]), 'preset-ptc')
    expect(group(worker)).toEqual(group(reviewer))
    expect(group(main)).toEqual(group(worker))
    const withoutRoles = leaves(shipped.plugins).filter(row => ![
      'persona', 'tool-subagent', 'tool-subagent-fork', 'workflow-ptc', 'tool-workflow',
    ].includes(row.id ?? ''))
    expect(leaves(group(worker).config as readonly PluginRow[])).toEqual(withoutRoles)
    for (const preset of [worker, reviewer, main]) {
      const tools = leaves(group(preset).config as readonly PluginRow[])
      expect(tools.find(row => row.id === 'tool-presentation')).toMatchObject({ config: { mode: 'ptc' } })
      expect(tools.filter(row => row.name === '@deepseek-ai/dsh-tool-subagent')).toHaveLength(0)
      expect(tools.filter(row => row.name === '@deepseek-ai/dsh-tool-subagent-control')).toHaveLength(1)
      expect(tools.filter(row => row.name === '@deepseek-ai/dsh-tool-subagent-control/list-agents')).toHaveLength(1)
    }
    for (const preset of [worker, reviewer]) {
      expect(preset.selectable).toBe(false)
      expect(preset.plugins.map(row => row.id)).toEqual(['persona', 'rg-tools'])
      expect(leaves(preset.plugins).some(row => row.name === '@deepseek-ai/dsh-experimental-review-gated')).toBe(false)
    }
    expect(main.plugins.find(row => row.id === 'rg-coordination')).toMatchObject({
      name: '@deepseek-ai/dsh-experimental-review-gated', config: { maxReviewRounds: 2 },
    })
    for (const [id, toolName, agentPreset] of [['rg-worker', 'rg_worker', 'rg-worker'], ['rg-reviewer', 'rg_reviewer', 'rg-reviewer']]) {
      const tool = main.plugins.find(row => row.id === id)
      expect(tool).toMatchObject({ name: '@deepseek-ai/dsh-tool-subagent', config: { provider: 'spawn', toolName, agentPreset } })
      expect(tool?.config).not.toHaveProperty('modelSelectionSettings')
      expect(tool?.config).not.toHaveProperty('maxDepth')
      expect(tool?.config).not.toHaveProperty('persona')
      expect(tool?.config).not.toHaveProperty('toolFilter')
    }
    const workerPersona = worker.plugins.find(row => row.id === 'persona')
    const reviewerPersona = reviewer.plugins.find(row => row.id === 'persona')
    expect(JSON.stringify(workerPersona)).toContain('RG execution worker')
    expect(JSON.stringify(reviewerPersona)).toContain('RG independent reviewer')
    expect(JSON.stringify(reviewerPersona)).toContain('not a restricted tool set')
    expect(workerPersona).not.toEqual(reviewerPersona)
    expect(main.plugins.filter(row => row.name === '@deepseek-ai/dsh-tool-subagent')).toHaveLength(2)
  })
})
