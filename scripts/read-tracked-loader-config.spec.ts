/** Git-tracked Loader links must be validated in either checkout representation. */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readTrackedLoaderConfig } from './read-tracked-loader-config.ts'

function fixture(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'dsh-tracked-loader-'))
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: root })
    run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function stageTextLink(root: string, file: string, target: string): void {
  const path = join(root, file)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, target)
  const object = execFileSync('git', ['hash-object', '-w', '--stdin'], {
    cwd: root,
    input: target,
    encoding: 'utf8',
  }).trim()
  execFileSync('git', ['update-index', '--add', '--cacheinfo', '120000,' + object + ',' + file], { cwd: root })
}

describe('tracked Loader config links', () => {
  it('reads the target YAML when a Git link is checked out as text', () => {
    fixture((root) => {
      const target = join(root, 'snapshots', 'sample.yml')
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, '[]\n')
      stageTextLink(root, 'profiles/cordis.yml', '../snapshots/sample.yml')
      expect(readTrackedLoaderConfig(root, 'profiles/cordis.yml')).toBe('[]\n')
    })
  })

  it('never follows a path-like ordinary config without a Git link entry', () => {
    fixture((root) => {
      const file = join(root, 'profiles', 'cordis.yml')
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, '../snapshots/sample.yml')
      expect(readTrackedLoaderConfig(root, 'profiles/cordis.yml')).toBe('../snapshots/sample.yml')
    })
  })

  it('rejects changed checkout text instead of trusting a target-shaped string', () => {
    fixture((root) => {
      stageTextLink(root, 'profiles/cordis.yml', '../snapshots/approved.yml')
      const file = join(root, 'profiles', 'cordis.yml')
      writeFileSync(file, '../snapshots/other.yml')
      expect(() => readTrackedLoaderConfig(root, 'profiles/cordis.yml')).toThrow(/differs from Git index/)
      writeFileSync(file, '[]\n')
      expect(() => readTrackedLoaderConfig(root, 'profiles/cordis.yml')).toThrow(/differs from Git index/)
    })
  })

  it('rejects an indexed link that escapes the repository', () => {
    fixture((root) => {
      stageTextLink(root, 'profiles/cordis.yml', '../../outside.yml')
      expect(() => readTrackedLoaderConfig(root, 'profiles/cordis.yml')).toThrow(/leaves repository/)
    })
  })

  it('rejects missing targets and cycles', () => {
    fixture((root) => {
      stageTextLink(root, 'profiles/missing.cordis.yml', './missing.yml')
      expect(() => readTrackedLoaderConfig(root, 'profiles/missing.cordis.yml')).toThrow(/ENOENT/)
      stageTextLink(root, 'profiles/a.cordis.yml', './b.cordis.yml')
      stageTextLink(root, 'profiles/b.cordis.yml', './a.cordis.yml')
      expect(() => readTrackedLoaderConfig(root, 'profiles/a.cordis.yml')).toThrow(/link cycle/)
    })
  })

  it.skipIf(process.platform === 'win32')('follows a native in-repository symbolic link', () => {
    fixture((root) => {
      const file = join(root, 'profiles', 'cordis.yml')
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(join(root, 'source.yml'), '[]\n')
      symlinkSync('../source.yml', file)
      expect(readTrackedLoaderConfig(root, 'profiles/cordis.yml')).toBe('[]\n')
    })
  })
})
