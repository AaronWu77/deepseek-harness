/** Declarative package details reject malformed attribution and unsafe links atomically. */

import { describe, expect, it } from 'vitest'
import { readPackageDetails } from '../src/package-details.ts'

const path = 'plugin/package.json'
const upstream = { name: 'Upstream', repository: 'https://github.com/example/upstream', relation: 'adapted',
  ref: 'v1.2.3', license: 'MIT', changes: { en: 'Adapted loader.', zh: '调整加载器。' },
  record: 'https://github.com/example/plugin/blob/main/UPSTREAM.md' }

function read(value: Record<string, unknown>) { return readPackageDetails(value, path) }

describe('package declarations', () => {
  it('keeps absent declarations absent without inferring original authorship or maintainers', () => {
    expect(read({ name: 'plugin', dsh: { bundle: {} } })).toBeUndefined()
    expect(read({ author: { name: 'Original author', email: 'author@example.org' } })).toEqual({ author: 'Original author' })
    expect(read({ dsh: { upstreams: [] } })).toEqual({ upstreams: [] })
  })

  it('keeps current repository, author, maintainers, and several upstream relationships separate', () => {
    const declarations = {
      repository: { type: 'git', url: 'git+https://github.com/example/plugin.git', directory: 'packages/plugin' },
      homepage: 'https://example.org/plugin', license: 'Apache-2.0', author: 'Original author',
      maintainers: ['Current maintainer', { name: 'Maintainer two', email: 'two@example.org', url: 'file:///ignored-person-link' }],
      dsh: { documentation: { en: 'https://example.org/docs', zh: 'https://example.org/zh/docs' },
        upstreams: [upstream, { name: 'Integration', repository: 'git+http://github.com/example/integration', relation: 'integration' },
          { name: 'Reference', repository: 'https://github.com/example/reference', relation: 'reference', changes: 'API reference only.' }] },
    }
    expect(read(declarations)).toEqual({
      repository: { url: 'https://github.com/example/plugin.git', directory: 'packages/plugin' },
      homepage: declarations.homepage, license: declarations.license, author: declarations.author,
      maintainers: ['Current maintainer', 'Maintainer two'], documentation: declarations.dsh.documentation,
      upstreams: [upstream, { name: 'Integration', repository: 'http://github.com/example/integration', relation: 'integration' },
        declarations.dsh.upstreams[2]],
    })
    expect(read({ repository: 'git+http://example.org/repo' })).toEqual({ repository: { url: 'http://example.org/repo' } })
    expect(read({ repository: { type: 'git', url: 'https://example.org/repo' } })).toEqual({ repository: { url: 'https://example.org/repo' } })
    expect(read({ dsh: { documentation: 'https://example.org/docs' } })).toEqual({ documentation: 'https://example.org/docs' })
  })

  it.each(['copied', 'adapted', 'patched'])('requires license and changes for %s code without inventing a missing baseline', (relation) => {
    for (const field of ['license', 'changes']) {
      for (const invalid of [undefined, '', '  ', null, 1]) {
        expect(() => read({ dsh: { upstreams: [{ ...upstream, relation, [field]: invalid }] } })).toThrow(field)
      }
    }
    const { ref: _ref, ...unrecorded } = upstream
    expect(read({ dsh: { upstreams: [{ ...unrecorded, relation }] } })?.upstreams?.[0]?.ref).toBeUndefined()
    expect(() => read({ dsh: { upstreams: [{ ...upstream, relation, ref: '' }] } })).toThrow('ref')
    expect(read({ dsh: { upstreams: [{ ...upstream, relation }] } })?.upstreams?.[0]?.relation).toBe(relation)
  })

  it.each(['javascript:alert(1)', 'file:///repo', 'ssh://github.com/example/repo', 'git@github.com:example/repo',
    '//example.org/repo', 'https://user:password@example.org/repo', 'https://user@example.org',
    'https://example.org/a\\b', 'https://example.org/a b', 'https://example.org/%zz', 'https://[invalid'])
  ('rejects unsafe or malformed link %s', (url) => {
    expect(() => read({ repository: url })).toThrow()
    expect(() => read({ homepage: url })).toThrow()
    expect(() => read({ dsh: { documentation: { en: url } } })).toThrow()
    expect(() => read({ dsh: { upstreams: [{ ...upstream, repository: url }] } })).toThrow()
    expect(() => read({ dsh: { upstreams: [{ ...upstream, record: url }] } })).toThrow()
  })

  it('allows homepage fragments but rejects queries on current and upstream repository URLs', () => {
    expect(read({ homepage: 'https://example.org/#readme' })?.homepage).toBe('https://example.org/#readme')
    expect(() => read({ repository: 'https://example.org/repo?token=secret' })).toThrow()
    expect(() => read({ dsh: { upstreams: [{ ...upstream, repository: 'https://example.org/repo?token=secret' }] } })).toThrow()
  })

  it.each(['', '.', '..', '../plugin', '/plugin', 'a/../plugin', 'a/./plugin', 'a//plugin', 'C:/plugin',
    'a\\plugin', 'a/%2e%2e/plugin', 'a?file', 'a#file', 'a\u0000file'])('rejects unsafe repository directory %j', (directory) => {
    expect(() => read({ repository: { url: 'https://example.org/repo', directory } })).toThrow('directory')
  })

  it.each([null, false, 'not-an-array', [null], [{ ...upstream, relation: 'original' }],
    [{ ...upstream, name: '' }], [{ ...upstream, changes: { zh: '缺少英文' } }],
    [{ ...upstream, changes: { en: 'Changes', 'pt-BR': 'Changes' } }],
    [{ ...upstream, changes: { en: 'Changes', bad_locale: 'Changes' } }],
    [{ ...upstream, changes: { en: 'Changes', zh: 1 } }]].map(value => [value]))('rejects malformed upstream declarations %j', (upstreams) => {
    expect(() => read({ license: 'MIT', dsh: { upstreams } })).toThrow()
  })

  it.each([{ dsh: null }, { dsh: [] }, { repository: null }, { repository: {} }, { repository: { url: null } },
    { homepage: false }, { license: '' }, { author: {} }, { author: null }, { maintainers: 'person' }, { maintainers: [false] },
    { maintainers: [{}] }, { dsh: { documentation: {} } }, { dsh: { documentation: null } }])
  ('rejects invalid package declaration %j', (manifest) => { expect(() => read(manifest)).toThrow() })

  it('bounds each text, URL, array, and localized map', () => {
    expect(read({ author: 'a'.repeat(8192) })?.author).toHaveLength(8192)
    expect(() => read({ author: 'é'.repeat(4096) + 'x' })).toThrow('8192 UTF-8 bytes')
    const url = 'https://example.org/' + 'a'.repeat(2048 - 'https://example.org/'.length)
    expect(read({ homepage: url })?.homepage).toBe(url)
    expect(() => read({ homepage: url + 'a' })).toThrow('2048 UTF-8 bytes')
    expect(() => read({ homepage: 'https://example.org/' + '汉'.repeat(300) })).toThrow('2048 UTF-8 bytes')
    expect(read({ maintainers: Array(64).fill('Maintainer') })?.maintainers).toHaveLength(64)
    expect(() => read({ maintainers: Array(65).fill('Maintainer') })).toThrow('64 entries')
    const integration = { name: 'Integration', repository: 'https://example.org/repo', relation: 'integration' }
    expect(read({ dsh: { upstreams: Array(32).fill(integration) } })?.upstreams).toHaveLength(32)
    expect(() => read({ dsh: { upstreams: Array(33).fill(integration) } })).toThrow('32 entries')
    const locales = Object.fromEntries(['en', ...Array.from({ length: 31 }, (_, index) => `en-${index}`)].map(id => [id, 'Changes']))
    expect(read({ dsh: { upstreams: [{ ...upstream, changes: locales }] } })).toBeDefined()
    expect(() => read({ dsh: { upstreams: [{ ...upstream, changes: { ...locales, zh: 'Changes' } }] } })).toThrow('32 locales')
  })

  it('checks the complete projected record after web URL normalization expands it', () => {
    const manifest = { author: 'a'.repeat(7000), maintainers: Array(7).fill('a'.repeat(8192)),
      homepage: 'https://example.org/' + 'é'.repeat(300) }
    expect(Buffer.byteLength(JSON.stringify(manifest))).toBeLessThan(64 * 1024)
    expect(() => read(manifest)).toThrow('package details exceed 64 KiB')
  })

  it('bounds complete records including wrappers at exact and multibyte limits', () => {
    const maintainers = Array<string>(8).fill('a'.repeat(8192))
    const excess = Buffer.byteLength(JSON.stringify({ maintainers })) - 64 * 1024
    maintainers[7] = maintainers[7]!.slice(excess)
    expect(Buffer.byteLength(JSON.stringify({ maintainers }))).toBe(64 * 1024)
    expect(read({ maintainers })?.maintainers).toEqual(maintainers)
    maintainers[7] += 'é'
    expect(() => read({ maintainers })).toThrow('package details exceed 64 KiB')
  })
})
