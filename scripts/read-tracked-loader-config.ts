/** Read tracked Loader links from native or text-only Git checkouts. */
import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep, win32 } from 'node:path'

function inside(root: string, path: string): boolean {
  const suffix = relative(root, path)
  return suffix !== '..' && !suffix.startsWith('..' + sep) && !isAbsolute(suffix)
}

/**
 * Read a Loader config, resolving a Git symlink stored as text only when the
 * worktree bytes agree with its index entry. Both forms remain inside the repo.
 * @param root - repository root containing the index and config.
 * @param file - repository-relative Loader config path.
 * @returns source YAML to validate, never an unverified link target.
 */
export function readTrackedLoaderConfig(root: string, file: string): string {
  const base = resolve(root)
  const realBase = realpathSync(base)
  const visited = new Set<string>()

  function read(path: string): string {
    const full = resolve(path)
    if (!inside(base, full)) throw new Error('Loader link leaves repository: ' + file)
    if (visited.has(full)) throw new Error('Loader link cycle: ' + file)
    visited.add(full)
    if (!inside(realBase, realpathSync(full))) throw new Error('Loader link leaves repository: ' + file)

    const source = readFileSync(full, 'utf8')
    const relativePath = relative(base, full).replaceAll('\\', '/')
    const entry = execFileSync('git', ['ls-files', '--stage', '--', relativePath], {
      cwd: base,
      encoding: 'utf8',
    })
    if (!/^120000 [0-9a-f]{40,64} 0\t/.test(entry) || lstatSync(full).isSymbolicLink()) return source

    const targetName = execFileSync('git', ['show', ':' + relativePath], {
      cwd: base,
      encoding: 'utf8',
    })
    if (source !== targetName) throw new Error('Loader link differs from Git index: ' + relativePath)
    if (isAbsolute(targetName) || win32.isAbsolute(targetName)) {
      throw new Error('Loader link must be relative: ' + relativePath)
    }
    return read(resolve(dirname(full), targetName))
  }

  return read(resolve(base, file))
}
