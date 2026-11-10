/** Bounded file-scope fingerprints through the configured filesystem provider. */
import { createHash } from 'node:crypto'
import type { FileSystem, FsInfo, FsPathInfo, FsTarget } from '@deepseek-ai/dsh-fs'
import type { RgPolicy, RgScopeSnapshot } from './types.ts'

/** Capture explicitly inspected content, including additions, deletions, and local Git metadata.
 * @param fs - filesystem in the Agent's execution world.
 * @param cwd - captured task directory.
 * @param paths - explicit file or directory scope.
 * @param limits - frozen file-count and byte budgets.
 * @param signal - cancels inspection without producing a successful fingerprint.
 * @returns a fingerprint or an explicit unverified result; never a truncated successful identity.
 */
export async function captureScope(fs: FileSystem, cwd: string, paths: readonly string[],
  limits: Pick<RgPolicy, 'maxScopeFiles' | 'maxScopeBytes'>, signal: AbortSignal): Promise<RgScopeSnapshot> {
  const base = { root: cwd, paths: [...paths], capturedAt: Date.now() }
  let count = 0
  let bytes = 0
  const hash = createHash('sha256').update('review-gated/scope/v2\0')
  const observed: { target: FsTarget; info: FsInfo | undefined }[] = []
  const observedPaths: { path: string; cwd: string; info: FsPathInfo | undefined }[] = []
  const contents = new Map<string, Uint8Array>()
  const frame = (value: string | Uint8Array): void => {
    const length = typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : value.byteLength
    hash.update(String(length) + ':').update(value)
  }
  const seen = new Set<string>()
  let root: FsTarget
  try { root = await fs.resolve(cwd, { signal }) } catch (error) {
    signal.throwIfAborted()
    return { ...base, fingerprint: null, diagnostic: error instanceof Error ? error.message : String(error) }
  }
  const rootUri = fs.fileUrl(root).replace(/\/$/, '')
  const byName = (left: { name: string }, right: { name: string }) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0
  const observePath = async (path: string, base: string, retain = true): Promise<void> => {
    const info = await fs.lstat(path, { cwd: base }, signal)
    if (info?.type === 'symlink') throw new Error('The review scope contains a symbolic link.')
    if (info?.type === 'other') throw new Error('The review scope contains an unsupported file.')
    if (retain) observedPaths.push({ path, cwd: base, info })
  }
  const resolvePath = async (path: string): Promise<FsTarget> => {
    const info = await fs.lstat(path, { cwd }, signal)
    if (info?.type === 'symlink') throw new Error('The review scope contains a symbolic link.')
    const target = await fs.resolve(path, { cwd, signal })
    if (!fs.contains(root, target)) throw new Error('The review scope contains a path outside its workspace.')
    for (const match of path.matchAll(/[^\\/]+(?=[\\/]|$)/g)) {
      const prefix = path.slice(0, match.index + match[0].length)
      const ancestor = await fs.resolve(prefix, { cwd, signal })
      await observePath(prefix, cwd, fs.contains(root, ancestor))
    }
    return target
  }
  const visit = async (target: FsTarget): Promise<Uint8Array | undefined> => {
    signal.throwIfAborted()
    if (!fs.contains(root, target)) throw new Error('The review scope contains a path outside its workspace.')
    const uri = fs.fileUrl(target)
    if (seen.has(uri)) return contents.get(uri)
    seen.add(uri)
    if (++count > limits.maxScopeFiles) throw new Error('The review scope exceeds its configured file-count limit.')
    const before = await fs.stat(target, signal)
    observed.push({ target, info: before })
    frame(JSON.stringify([uri === rootUri ? '.' : uri.slice(rootUri.length + 1), before?.type ?? 'absent']))
    if (before === undefined) return
    if (before.type === 'directory') {
      const entries = (await fs.listDir(target, signal)).sort(byName)
      for (const entry of entries) {
        if (entry.name === '.git') continue
        await observePath(entry.name, fs.processPath(target))
        await visit(entry.target)
      }
      const after = (await fs.listDir(target, signal)).sort(byName)
      if (JSON.stringify(entries.map(entry => [entry.name, entry.type])) !== JSON.stringify(after.map(entry => [entry.name, entry.type]))) {
        throw new Error('The review directory changed while its contents were inspected.')
      }
    } else if (before.type === 'file') {
      const remaining = limits.maxScopeBytes - bytes
      const content = await fs.readBytes(target, signal, remaining)
      bytes += content.byteLength
      contents.set(uri, content)
      frame(content)
    } else throw new Error('The review scope contains an unsupported file.')
    const after = await fs.stat(target, signal)
    if (after?.version !== before.version) throw new Error('The review scope changed while its contents were inspected.')
    return contents.get(uri)
  }
  try {
    for (const path of [...new Set(paths)].sort()) {
      await visit(await resolvePath(path))
    }
    const git = await resolvePath('.git')
    const gitInfo = await fs.stat(git, signal)
    observed.push({ target: git, info: gitInfo })
    if (gitInfo?.type === 'file') throw new Error('External Git metadata requires a separate review; content identity is unverified.')
    if (gitInfo?.type === 'directory') {
      const headBytes = await visit(await resolvePath('.git/HEAD'))
      if (headBytes === undefined) throw new Error('The Git HEAD cannot be inspected safely.')
      for (const path of ['.git/index', '.git/packed-refs']) await visit(await resolvePath(path))
      if (headBytes.includes(0)) throw new Error('The Git HEAD cannot be inspected safely.')
      const head = new TextDecoder('utf-8', { fatal: true }).decode(headBytes)
      if (head.startsWith('ref: ')) {
        const reference = head.slice(5).trim()
        if (!reference.startsWith('refs/') || reference.includes('..') || reference.includes('\\')) throw new Error('The Git reference cannot be inspected safely.')
        await visit(await resolvePath(`.git/${reference}`))
      }
    }
    for (const { target, info } of observed) {
      const current = await fs.stat(target, signal)
      if (current?.version !== info?.version || current?.type !== info?.type) {
        throw new Error('The review scope changed while its contents were inspected.')
      }
    }
    for (const { path, cwd: pathCwd, info } of observedPaths) {
      const current = await fs.lstat(path, { cwd: pathCwd }, signal)
      if (current?.version !== info?.version || current?.type !== info?.type) {
        throw new Error('The review scope changed while its contents were inspected.')
      }
    }
    return { ...base, fingerprint: `v2:${hash.digest('hex')}`, diagnostic: null }
  } catch (error) {
    signal.throwIfAborted()
    return { ...base, fingerprint: null, diagnostic: error instanceof Error ? error.message : String(error) }
  }
}
