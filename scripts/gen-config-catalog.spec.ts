/** Plugin classification and schema aliases retain the catalog's declared-field checks. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { collectConfigCatalog, render, type CatalogEntry } from './gen-config-catalog.ts'
import { computeTranslationPairingRecord, translationPairPaths } from './translation-pairing-record.ts'
import { generatedRegions } from './translation-pairing.ts'

const roots: string[] = []
const sharedSchema = `
import Schema from '@deepseek-ai/schemastery'
export interface LaunchConfig {
  /** Browser ownership mode. */
  mode: 'launch'
  /** Hide the launched browser. */
  headless: boolean
}
export interface AttachConfig {
  /** Browser ownership mode. */
  mode: 'attach'
  /** Existing browser address. */
  endpoint: string
}
export type BrowserConfig = LaunchConfig | AttachConfig
export const Shared = Schema.union([
  Schema.object({ mode: Schema.const('launch'), headless: Schema.boolean() }),
  Schema.object({ mode: Schema.const('attach'), endpoint: Schema.string() }),
])
`

function fixture(schema = sharedSchema) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-config-catalog-'))
  roots.push(root)
  const write = (path: string, value: string): void => {
    const file = join(root, path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, value)
  }
  write('tsconfig.json', JSON.stringify({ compilerOptions: {
    baseUrl: '.', module: 'ESNext', moduleResolution: 'Bundler',
    paths: { '@test/runtime/config': ['./packages/test/runtime/src/config.ts'] },
  }, include: ['packages/**/*.ts'] }))
  write('packages/test/runtime/package.json', JSON.stringify({
    name: '@test/runtime', exports: { './config': { types: './lib/types/config.d.ts', default: './lib/config.js' } },
  }))
  write('packages/test/runtime/src/index.ts', "export { Shared } from './config.ts'\n")
  write('packages/test/runtime/src/config.ts', schema)
  write('packages/test/provider/package.json', JSON.stringify({ name: '@test/provider' }))
  write('packages/test/provider/src/index.ts', `
import { Shared as SharedConfig, type BrowserConfig } from '@test/runtime/config'
export type Config = BrowserConfig
export const Config = SharedConfig
export function apply(ctx: unknown, config: Config): void {}
`)
  return { root, write }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('shared config schema catalog', () => {
  it('collects every branch through a renamed named import from a public source subpath', () => {
    const { root } = fixture()
    const provider = collectConfigCatalog(root).find(entry => entry.pkg === '@test/provider')
    expect(new Set(provider?.schemaKeys)).toEqual(new Set(['mode', 'headless', 'endpoint']))
    expect(provider?.configTypeName).toBe('Config')
    expect(provider?.pastes?.[0]?.text).toBe('export type Config = BrowserConfig')
  })

  it.each([false, true])('checks package-local schema imports and undeclared fields (invalid=%s)', (invalid) => {
    const { root, write } = fixture()
    write('packages/test/provider/src/config.ts', invalid
      ? sharedSchema.replace('headless: Schema.boolean()', 'headless: Schema.boolean(), hidden: Schema.string()')
      : sharedSchema)
    write('packages/test/provider/src/index.ts', `
import { Shared, type BrowserConfig } from './config.ts'
export type Config = BrowserConfig
export const Config = Shared
export function apply(ctx: unknown, config: Config): void {}
`)
    if (invalid) expect(() => collectConfigCatalog(root)).toThrow("schema validates key 'hidden'")
    else expect(new Set(collectConfigCatalog(root).find(entry => entry.pkg === '@test/provider')?.schemaKeys))
      .toEqual(new Set(['mode', 'headless', 'endpoint']))
  })

  it('rejects a schema field absent from the shared config type', () => {
    const { root } = fixture(sharedSchema.replace('headless: Schema.boolean()', 'headless: Schema.boolean(), hidden: Schema.string()'))
    expect(() => collectConfigCatalog(root)).toThrow("schema validates key 'hidden' but config type 'Config' declares no such member")
  })

  it('follows a local const alias without treating a completed branch as a cycle', () => {
    const { root } = fixture(sharedSchema.replace('export const Shared = Schema.union', 'export const Shared = Base\nconst Base = Schema.union'))
    const provider = collectConfigCatalog(root).find(entry => entry.pkg === '@test/provider')
    expect(new Set(provider?.schemaKeys)).toEqual(new Set(['mode', 'headless', 'endpoint']))
  })

  it.each([false, true])('checks a class Config imported from a sibling module (invalid field: %s)', (invalid) => {
    const { root, write } = fixture()
    write('packages/test/provider/src/config.ts', `
import Schema from '@deepseek-ai/schemastery'
export interface Config {
  /** Maximum result count. */
  limit: number
}
export const Config = Schema.object({ ${invalid ? 'hidden' : 'limit'}: Schema.number() })
`)
    write('packages/test/provider/src/index.ts', `
import { Config } from './config.ts'
export default class Provider {
  static Config = Config
  constructor(ctx: unknown, config: Config) {}
}
`)
    if (invalid) {
      expect(() => collectConfigCatalog(root)).toThrow("schema validates key 'hidden' but config type 'Config' declares no such member")
    } else {
      const provider = collectConfigCatalog(root).find(entry => entry.pkg === '@test/provider')
      expect(provider?.schemaKeys).toEqual(['limit'])
    }
  })

  it('rejects type-only imports used as runtime schemas', () => {
    const { root, write } = fixture()
    write('packages/test/provider/src/index.ts', `
import type { Shared as SharedConfig, BrowserConfig } from '@test/runtime/config'
export type Config = BrowserConfig
export const Config = SharedConfig
export function apply(ctx: unknown, config: Config): void {}
`)
    expect(() => collectConfigCatalog(root)).toThrow("schema alias 'SharedConfig' must name a const or named value import")
  })

  it('rejects a private subpath even when TypeScript can resolve its source', () => {
    const { root, write } = fixture()
    write('packages/test/runtime/package.json', JSON.stringify({ name: '@test/runtime', exports: {} }))
    expect(() => collectConfigCatalog(root)).toThrow("does not explicitly export './config'")
  })

  it('rejects a missing source mapping', () => {
    const { root, write } = fixture()
    write('tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@test/runtime/config': ['./missing.ts'] } } }))
    expect(() => collectConfigCatalog(root)).toThrow('has no workspace source mapping')
  })

  it('rejects a source mapping into another package', () => {
    const { root, write } = fixture()
    write('tsconfig.json', JSON.stringify({ compilerOptions: {
      baseUrl: '.', paths: { '@test/runtime/config': ['./packages/test/provider/src/index.ts'] },
    } }))
    expect(() => collectConfigCatalog(root)).toThrow('must resolve inside packages/test/runtime/src')
  })

  it('rejects a schema value that the imported module does not export', () => {
    const { root } = fixture(sharedSchema.replace('export const Shared', 'const Shared'))
    expect(() => collectConfigCatalog(root)).toThrow("has no exported const 'Shared'")
  })

  it('rejects recursive const aliases', () => {
    const { root } = fixture(`${sharedSchema.slice(0, sharedSchema.indexOf('export const Shared'))}
export const Shared = Loop
const Loop = Shared
`)
    expect(() => collectConfigCatalog(root)).toThrow('cyclic schema alias')
  })

  it('rejects a dynamic schema factory instead of dropping its keys', () => {
    const { root } = fixture(`${sharedSchema.slice(0, sharedSchema.indexOf('export const Shared'))}
export const Shared = makeSchema()
`)
    expect(() => collectConfigCatalog(root)).toThrow('not a statically walkable schemastery call')
  })

  it('rejects an unresolved alias within a schema union', () => {
    const { root } = fixture(`${sharedSchema.slice(0, sharedSchema.indexOf('export const Shared'))}
export const Shared = Schema.union([MissingSchema])
`)
    expect(() => collectConfigCatalog(root)).toThrow("schema alias 'MissingSchema' must name a const or named value import")
  })
})

describe('default plugin export classification', () => {
  const config = `
import Schema from '@deepseek-ai/schemastery'
export interface Settings {
  /** Whether the feature is enabled. */
  enabled: boolean
}
export interface Config {
  /** Complete feature settings. */
  settings: Settings
}
export const Config = Schema.object({ settings: Schema.object({ enabled: Schema.boolean() }) })
`
  const runtime = `
import { Config } from './config.ts'
export default class Provider {
  static inject = ['agents']
  static Config = Config
  constructor(ctx: unknown, config: Config) {}
}
`

  it.each(['declaration', 'identifier', 're-export'])('collects the declaration context for a default service (%s)', (mode) => {
    const { root, write } = fixture()
    write('packages/test/provider/src/config.ts', config)
    write('packages/test/provider/src/runtime.ts', runtime)
    write('packages/test/provider/src/barrel.ts', "export { default } from './runtime.ts'\n")
    const entry = mode === 're-export' ? "export { default } from './barrel.ts'\n"
      : mode === 'identifier' ? runtime.replace('export default class', 'class') + '\nexport default Provider\n' : runtime
    write('packages/test/provider/src/index.ts', entry)
    const provider = collectConfigCatalog(root).find(entry => entry.pkg === '@test/provider')
    expect(provider).toMatchObject({ kind: 'config', className: 'Provider', configTypeName: 'Config',
      entry: 'packages/test/provider/src/index.ts', inject: ['agents'], schemaKeys: ['settings', 'settings.enabled'] })
    expect(provider?.pastes?.map(paste => paste.source)).toEqual([
      'packages/test/provider/src/config.ts:7', 'packages/test/provider/src/config.ts:3',
    ])
    expect(provider?.pastes?.[0]?.text).toContain('settings: Settings')
  })

  it.each([
    { entry: "export { Provider as default } from './runtime.ts'", named: true },
    { entry: "import { Provider as Service } from './runtime.ts'; export default Service", named: true },
    { entry: "import Service from './runtime.ts'; export { Service as default }", named: false },
  ])('resolves an explicit plugin alias: $entry', ({ entry, named }) => {
    const { root, write } = fixture()
    write('packages/test/provider/src/config.ts', config)
    write('packages/test/provider/src/runtime.ts', named ? runtime.replace('export default class', 'export class') : runtime)
    write('packages/test/provider/src/index.ts', entry)
    const provider = collectConfigCatalog(root).find(entry => entry.pkg === '@test/provider')
    expect(provider).toMatchObject({ kind: 'config', className: 'Provider', inject: ['agents'], schemaKeys: ['settings', 'settings.enabled'] })
  })

  it.each([
    { entry: "export { default } from './runtime.ts'", target: 'export const Other = 1', error: "does not export plugin 'default'" },
    { entry: "export { default } from './runtime.ts'", target: "export { default } from './index.ts'", error: 'cyclic plugin export' },
    { entry: "export { Missing as default } from './runtime.ts'", target: runtime, error: "does not export plugin 'Missing'" },
    { entry: "export type { Provider as default } from './runtime.ts'", target: runtime, error: 'type-only plugin export' },
    { entry: "export { type Provider as default } from './runtime.ts'", target: runtime, error: 'type-only plugin export' },
    { entry: "import type Service from './runtime.ts'; export default Service", target: runtime, error: 'type-only plugin export' },
    { entry: "export { default } from './runtime.js'", target: runtime, error: 'package-relative .ts' },
    { entry: 'export default Missing', target: runtime, error: "cannot resolve plugin binding 'Missing'" },
  ])('rejects an unresolved plugin export instead of classifying a library: $entry', ({ entry, target, error }) => {
    const { root, write } = fixture()
    write('packages/test/provider/src/config.ts', config)
    write('packages/test/provider/src/runtime.ts', target)
    write('packages/test/provider/src/index.ts', entry)
    expect(() => collectConfigCatalog(root)).toThrow(error)
  })

  it('checks schema fields in a re-exported service declaration', () => {
    const { root, write } = fixture()
    write('packages/test/provider/src/config.ts', config.replace('enabled: Schema.boolean()', 'hidden: Schema.boolean()'))
    write('packages/test/provider/src/runtime.ts', runtime)
    write('packages/test/provider/src/index.ts', "export { default } from './runtime.ts'\n")
    expect(() => collectConfigCatalog(root)).toThrow("schema validates key 'settings.hidden'")
  })
})

describe('config catalog rendering', () => {
  const entries = (inject: string[]): CatalogEntry[] => [
    {
      pkg: '@deepseek-ai/dsh-demo',
      dir: 'packages/demo/demo',
      entry: 'packages/demo/demo/src/index.ts',
      kind: 'config',
      inject,
      pastes: [{ text: 'export interface DemoConfig {}', source: 'packages/demo/demo/src/index.ts:3' }],
    },
    { pkg: '@deepseek-ai/dsh-plain', dir: 'packages/demo/plain', entry: 'packages/demo/plain/src/index.ts', kind: 'no-config', inject },
  ]
  const paths = translationPairPaths('docs/config-catalog.md')
  const record = (inject: string[]) => computeTranslationPairingRecord(
    paths,
    render(entries(inject), 'en'),
    render(entries(inject), 'zh'),
    { repoRoot: process.cwd(), isTranslationPairSource: () => false },
  )

  it('keeps package data in generated regions shared by both languages', () => {
    const en = generatedRegions(render(entries(['jobs']), 'en')).map(region => region.text)
    expect(en.map(region => region.split('\n')[0])).toEqual([
      '<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-demo -->',
      '<!-- BEGIN GENERATED config-catalog:no-config -->',
      '<!-- BEGIN GENERATED config-catalog:seam -->',
      '<!-- BEGIN GENERATED config-catalog:library -->',
    ])
    expect(generatedRegions(render(entries(['jobs']), 'zh')).map(region => region.text)).toEqual(en)
    expect(en[0]).toContain('- `inject`: `jobs`')
  })

  it('leaves the consistency record unchanged when only package data changes', () => {
    expect(record(['jobs', 'typert'])).toEqual(record(['jobs']))
    expect([...record(['jobs']).keys()].some(key => key.includes('dsh-demo'))).toBe(false)
  })
})
