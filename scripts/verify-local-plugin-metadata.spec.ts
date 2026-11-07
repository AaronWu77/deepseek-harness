/** Independent plugin collections use private fixture roots and never activate a plugin or profile. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { localPluginMetadataProblems } from './verify-local-plugin-metadata.ts'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'dsh-local-metadata-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

function fixture(patch: Record<string, unknown> = {}): void {
  const dir = join(root, 'plugin')
  mkdirSync(join(dir, 'locale'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'test-plugin', version: '1.0.0', repository: 'https://example.test/plugin', license: 'MIT',
    dsh: { documentation: { en: 'https://example.test/en', zh: 'https://example.test/zh' }, upstreams: [] },
    exports: { './locale/*.json': './locale/*.json' }, files: ['locale/*.json'], ...patch,
  }))
  for (const lang of ['en', 'zh']) writeFileSync(join(dir, 'locale', lang + '.json'), JSON.stringify({ meta: { title: lang, description: 'Description' } }))
}

it('rejects an empty collection rather than declaring zero audited plugins successful', () => {
  expect(localPluginMetadataProblems(root).join(' ')).toContain('no local plugin package manifests')
})
it('checks the complete bilingual declaration without inspecting node_modules', () => {
  fixture()
  mkdirSync(join(root, 'node_modules'), { recursive: true })
  writeFileSync(join(root, 'node_modules', 'package.json'), 'invalid')
  expect(localPluginMetadataProblems(root)).toEqual([])
})
it.each([
  [{ name: null }, 'name and version'],
  [{ repository: undefined }, 'repository and license'],
  [{ dsh: { documentation: { en: 'https://example.test/en', zh: 'https://example.test/zh' } } }, 'dsh.upstreams'],
  [{ dsh: { upstreams: [], documentation: 'https://example.test/en' } }, 'explicit en and zh'],
  [{ exports: {} }, 'exports must expose'],
  [{ files: [] }, 'files must publish'],
  [{ repository: 'javascript:alert(1)' }, 'HTTP(S)'],
  [{ dsh: { upstreams: [{ name: 'Original', relation: 'adapted', repository: 'https://example.test/upstream' }] } }, 'license'],
] as const)('rejects invalid package declarations: %j', (patch, message) => {
  fixture(patch)
  expect(localPluginMetadataProblems(root).join(' ')).toContain(message)
})
it('rejects missing or empty localized display fields', () => {
  fixture()
  writeFileSync(join(root, 'plugin', 'locale', 'zh.json'), JSON.stringify({ meta: { title: ' ', description: 'Description' } }))
  expect(localPluginMetadataProblems(root).join(' ')).toContain('nonempty strings')
})
