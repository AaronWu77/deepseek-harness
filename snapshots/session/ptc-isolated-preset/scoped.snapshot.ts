/** Canonical Node execution evidence; the standard adapter independently compares workspace.expected. */
import { readFile, readdir } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { fixtureContext, normalizeSessionSnapshots, parseToolSchemasSnapshot, redactSessionSnapshotIds, sessionFixtureNames } from '@deepseek-ai/dsh-session-snapshot'
const root = new URL('./', import.meta.url)
describe('ptc-isolated-preset evidence', () => {
  it.skipIf(process.env.DSH_SNAPSHOT === 'record')('retains one actual writer role as a normalization fixed point', async () => {
    const names = sessionFixtureNames(await readdir(root))
    expect(names).toHaveLength(1)
    const logs = await Promise.all(names.map(name => readFile(new URL(name, root), 'utf8')))
    expect(redactSessionSnapshotIds(logs)).toEqual(logs)
    const normalized = normalizeSessionSnapshots(logs, fixtureContext(logs[0]!))
    expect(normalizeSessionSnapshots(normalized, fixtureContext(normalized[0]!))).toEqual(normalized)
  })
  it('advertises the private runtime rather than deployment bounds', async () => {
    const schema = parseToolSchemasSnapshot(await readFile(new URL('tool-schemas.expected.json', root), 'utf8')).initial
    expect(schema.map(tool => (tool as { name: string }).name)).toEqual(['run_code'])
    expect(JSON.stringify(schema)).toContain('Default 3000; capped at 4000.')
    expect(JSON.stringify(schema)).not.toContain('Default 1000; capped at 1000.')
  })
  it('records an actual private V8 process and successful SDK filesystem dispatch', async () => {
    const name = sessionFixtureNames(await readdir(root))[0]!
    const text = await readFile(new URL(name, root), 'utf8')
    expect(text).toContain('--max-old-space-size=64')
    expect(text).toContain('write_snapshot_proof')
    expect(text).toContain('"type":"tool/ptc-dispatch"')
    expect(text).toContain('"isError":false')
    expect(text).toContain('isolated-ptc-marker')
    expect(await readFile(new URL('workspace.expected/proof.txt', root), 'utf8')).toBe('isolated Node PTC SDK write complete\n')
  })
})
