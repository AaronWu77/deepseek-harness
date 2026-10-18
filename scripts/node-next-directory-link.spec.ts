/** NodeNext consumer links resolve built declarations without symlink privileges. */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { linkNodeNextDirectory } from './node-next-directory-link.ts'

describe('NodeNext consumer directory links', () => {
  it('resolves a package declaration from its temporary node_modules directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-node-next-directory-link-'))
    try {
      const packageDir = join(root, 'package')
      const nodeModules = join(root, 'consumer', 'node_modules')
      mkdirSync(packageDir, { recursive: true })
      mkdirSync(nodeModules, { recursive: true })
      writeFileSync(join(packageDir, 'index.d.ts'), 'export type Working = true\n')

      const link = join(nodeModules, 'sample')
      linkNodeNextDirectory(packageDir, link)
      expect(realpathSync(link)).toBe(realpathSync(packageDir))
      expect(readFileSync(join(link, 'index.d.ts'), 'utf8')).toBe('export type Working = true\n')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
