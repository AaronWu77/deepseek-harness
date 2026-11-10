/** Review-scope content identity, configured limits, and explicit unverified observations. */
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { mkdir, mkdtemp, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { captureScope } from '../src/scope.ts'

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-rg-scope-'))
  const root = join(directory, 'workspace')
  const outside = join(directory, 'outside')
  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    await rm(directory, { recursive: true, force: true })
  })
  await mkdir(root)
  await mkdir(outside)
  await ctx.plugin(LocalFileSystem, { cwd: root })
  const limits = { maxScopeFiles: 100, maxScopeBytes: 65536 }
  const capture = (paths: readonly string[], overrides: Partial<typeof limits> = {}) =>
    captureScope(ctx.fs, root, paths, { ...limits, ...overrides }, new AbortController().signal)
  return { ctx, root, outside, capture, limits }
}

function expectUnverified(result: Awaited<ReturnType<typeof captureScope>>, diagnostic: RegExp): void {
  expect(result.fingerprint).toBeNull()
  expect(result.diagnostic).toMatch(diagnostic)
}

describe('RG bounded review scope', () => {
  it('captures stable content independently of path order and duplicated scope entries', async () => {
    const h = await fixture()
    await writeFile(join(h.root, 'a.txt'), 'alpha')
    await writeFile(join(h.root, 'b.txt'), 'beta')
    const first = await h.capture(['b.txt', 'a.txt', 'a.txt'])
    const second = await h.capture(['a.txt', 'b.txt'])
    expect(first.fingerprint).toMatch(/^v3:[a-f0-9]{64}$/)
    expect(first.treeFingerprint).toMatch(/^v1:[a-f0-9]{64}$/)
    expect(first.treeDiagnostic).toBeNull()
    expect(first.diagnostic).toBeNull()
    expect(first.root).toBe(h.root)
    expect(first.paths).toEqual(['b.txt', 'a.txt', 'a.txt'])
    expect(first.capturedAt).toEqual(expect.any(Number))
    expect(second.fingerprint).toBe(first.fingerprint)
  })

  it('accepts an absolute path inside the workspace', async () => {
    const h = await fixture()
    await writeFile(join(h.root, 'source'), 'source')
    expect((await h.capture([join(h.root, 'source')])).fingerprint).toMatch(/^v3:[a-f0-9]{64}$/)
  })

  it('detects changed files even when content contains another file metadata record', async () => {
    const h = await fixture()
    const nextRecord = JSON.stringify(['b', 'file'])
    await writeFile(join(h.root, 'a'), 'x')
    await writeFile(join(h.root, 'b'), 'y' + nextRecord + 'z')
    const before = await h.capture(['a', 'b'])
    await writeFile(join(h.root, 'a'), 'x' + nextRecord + 'y')
    await writeFile(join(h.root, 'b'), 'z')
    const after = await h.capture(['a', 'b'])
    expect(before.fingerprint).not.toBeNull()
    expect(after.fingerprint).not.toBeNull()
    expect(after.fingerprint).not.toBe(before.fingerprint)
  })

  it('detects content changes, new files, removed files and negative observations', async () => {
    const h = await fixture()
    const absent = await h.capture(['a.txt'])
    await writeFile(join(h.root, 'a.txt'), 'alpha')
    const created = await h.capture(['a.txt'])
    expect(created.fingerprint).not.toBe(absent.fingerprint)
    await writeFile(join(h.root, 'a.txt'), 'ALPHA')
    const edited = await h.capture(['a.txt'])
    expect(edited.fingerprint).not.toBe(created.fingerprint)
    const directoryBefore = await h.capture(['.'])
    await writeFile(join(h.root, 'b.txt'), 'new file')
    expect((await h.capture(['.'])).fingerprint).not.toBe(directoryBefore.fingerprint)
    await unlink(join(h.root, 'a.txt'))
    expect((await h.capture(['a.txt'])).fingerprint).toBe(absent.fingerprint)
  })

  it('rejects out-of-workspace files without publishing a partial successful fingerprint', async () => {
    const h = await fixture()
    await writeFile(join(h.root, 'safe.txt'), 'safe')
    await writeFile(join(h.outside, 'private.txt'), 'outside')
    const result = await h.capture(['safe.txt', join(h.outside, 'private.txt')])
    expectUnverified(result, /outside its workspace/)
  })

  it('rejects explicit and nested directory links using a real local filesystem', async () => {
    const h = await fixture()
    await writeFile(join(h.outside, 'outside.txt'), 'outside')
    await symlink(h.outside, join(h.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    expectUnverified(await h.capture(['linked']), /symbolic link/)
    expectUnverified(await h.capture(['.']), /symbolic link|outside its workspace/)
    expectUnverified(await h.capture(['linked/outside.txt']), /outside its workspace/)
  })

  it('rejects an outside linked ancestor even when parent traversal returns inside', async () => {
    const h = await fixture()
    await writeFile(join(h.root, 'source'), 'source')
    await symlink(h.outside, join(h.root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir')
    expectUnverified(await h.capture(['alias/../workspace/source']), /symbolic link/)
  })

  it('does not silently traverse internal symbolic links while reviewing a directory', async () => {
    const h = await fixture()
    await mkdir(join(h.root, 'actual'))
    await writeFile(join(h.root, 'actual', 'source.txt'), 'source')
    await symlink(join(h.root, 'actual'), join(h.root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir')
    expectUnverified(await h.capture(['.']), /symbolic link/)
  })

  it('rejects an internal linked ancestor of an explicit file or absent path', async () => {
    const h = await fixture()
    await mkdir(join(h.root, 'actual'))
    await writeFile(join(h.root, 'actual', 'source.txt'), 'source')
    await symlink(join(h.root, 'actual'), join(h.root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir')
    expectUnverified(await h.capture(['alias/source.txt']), /symbolic link/)
    expectUnverified(await h.capture(['alias/missing']), /symbolic link/)
  })

  it('rejects an ancestor replaced by a junction after its file was inspected', async () => {
    const h = await fixture()
    await mkdir(join(h.root, 'alias'))
    await writeFile(join(h.root, 'alias', 'a'), 'first')
    await writeFile(join(h.root, 'z'), 'later')
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const read = h.ctx.fs.readBytes.bind(h.ctx.fs)
    const spy = vi.spyOn(h.ctx.fs, 'readBytes').mockImplementation(async (target, signal, maxBytes) => {
      const bytes = await read(target, signal, maxBytes)
      if (h.ctx.fs.processPath(target) === join(h.root, 'z')) { entered.resolve(undefined); await release.promise }
      return bytes
    })
    onTestFinished(() => { release.resolve(undefined); spy.mockRestore() })
    const pending = h.capture(['alias/a', 'z'])
    await entered.promise
    await rename(join(h.root, 'alias'), join(h.root, 'moved'))
    await symlink(join(h.root, 'moved'), join(h.root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir')
    release.resolve(undefined)
    expectUnverified(await pending, /symbolic link|changed while/)
  })

  it('uses the bounded HEAD bytes without a second unbounded text read', async () => {
    const h = await fixture()
    await mkdir(join(h.root, '.git', 'refs', 'heads'), { recursive: true })
    await writeFile(join(h.root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    await writeFile(join(h.root, '.git', 'refs', 'heads', 'main'), 'commit')
    const spy = vi.spyOn(h.ctx.fs, 'readText').mockRejectedValue(new Error('unbounded read'))
    onTestFinished(() => { spy.mockRestore() })
    const result = await h.capture([])
    expect(result.fingerprint).not.toBeNull()
    expect(spy).not.toHaveBeenCalled()
  })

  it('rejects missing Git HEAD', async () => {
    const h = await fixture()
    await mkdir(join(h.root, '.git'))
    expectUnverified(await h.capture([]), /Git HEAD/)
  })

  it('rejects binary and invalid UTF-8 Git HEAD bytes', async () => {
    const h = await fixture()
    await mkdir(join(h.root, '.git'))
    await writeFile(join(h.root, '.git', 'HEAD'), Buffer.from([0]))
    expectUnverified(await h.capture([]), /Git HEAD/)
    await writeFile(join(h.root, '.git', 'HEAD'), Buffer.from([255]))
    expectUnverified(await h.capture([]), /.+/)
  })

  it('counts HEAD bytes once when the same file is in the explicit scope', async () => {
    const h = await fixture()
    await mkdir(join(h.root, '.git'))
    await writeFile(join(h.root, '.git', 'HEAD'), 'detached')
    const result = await h.capture(['.git/HEAD'], { maxScopeBytes: 8 })
    expect(result.fingerprint).toMatch(/^v3:[a-f0-9]{64}$/)
    expectUnverified(await h.capture([], { maxScopeBytes: 7 }), /.+/)
  })

  it('rejects linked Git reference ancestors', async () => {
    const h = await fixture()
    await mkdir(join(h.root, '.git', 'refs'), { recursive: true })
    await mkdir(join(h.root, '.git', 'actual'))
    await writeFile(join(h.root, '.git', 'HEAD'), 'ref: refs/heads/main')
    await writeFile(join(h.root, '.git', 'actual', 'main'), 'commit')
    await symlink(join(h.root, '.git', 'actual'), join(h.root, '.git', 'refs', 'heads'),
      process.platform === 'win32' ? 'junction' : 'dir')
    expectUnverified(await h.capture([]), /symbolic link/)
  })

  it('enforces complete file-count and UTF-8 byte limits, including exact bounds', async () => {
    const h = await fixture()
    await writeFile(join(h.root, 'utf8.txt'), '汉🙂')
    expect((await h.capture(['utf8.txt'], { maxScopeFiles: 1, maxScopeBytes: 7 })).fingerprint).not.toBeNull()
    expectUnverified(await h.capture(['utf8.txt'], { maxScopeBytes: 6 }), /.+/)
    expectUnverified(await h.capture(['.'], { maxScopeFiles: 1 }), /file-count limit/)
  })

  it('includes Git index and referenced branch content, not only HEAD text', async () => {
    const h = await fixture()
    await writeFile(join(h.root, 'source.txt'), 'source')
    await mkdir(join(h.root, '.git', 'refs', 'heads'), { recursive: true })
    await writeFile(join(h.root, '.git', 'HEAD'), 'ref: refs/heads/main' + String.fromCharCode(10))
    await writeFile(join(h.root, '.git', 'index'), 'index-v1')
    await writeFile(join(h.root, '.git', 'refs', 'heads', 'main'), 'commit-one' + String.fromCharCode(10))
    const before = await h.capture(['source.txt'])
    await writeFile(join(h.root, '.git', 'refs', 'heads', 'main'), 'commit-two' + String.fromCharCode(10))
    const newBase = await h.capture(['source.txt'])
    expect(newBase.fingerprint).not.toBeNull()
    expect(newBase.fingerprint).not.toBe(before.fingerprint)
    await writeFile(join(h.root, '.git', 'index'), 'index-v2')
    expect((await h.capture(['source.txt'])).fingerprint).not.toBe(newBase.fingerprint)
  })

  it('marks external Git metadata and unsafe ref names as unverified', async () => {
    const h = await fixture()
    await writeFile(join(h.root, 'source.txt'), 'source')
    await writeFile(join(h.root, '.git'), 'gitdir: ../external' + String.fromCharCode(10))
    expectUnverified(await h.capture(['source.txt']), /External Git metadata/)
    await unlink(join(h.root, '.git'))
    await mkdir(join(h.root, '.git'))
    await writeFile(join(h.root, '.git', 'HEAD'), 'ref: ../../outside' + String.fromCharCode(10))
    expectUnverified(await h.capture(['source.txt']), /Git reference/)
  })

  it('rejects an early file changed while a later file is being inspected', async () => {
    const h = await fixture()
    await writeFile(join(h.root, 'a'), 'first')
    await writeFile(join(h.root, 'b'), 'second')
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const read = h.ctx.fs.readBytes.bind(h.ctx.fs)
    const spy = vi.spyOn(h.ctx.fs, 'readBytes').mockImplementation(async (target, signal, maxBytes) => {
      const bytes = await read(target, signal, maxBytes)
      if (h.ctx.fs.processPath(target) === join(h.root, 'b')) { entered.resolve(undefined); await release.promise }
      return bytes
    })
    onTestFinished(() => { release.resolve(undefined); spy.mockRestore() })
    const pending = h.capture(['a', 'b'])
    await entered.promise
    await writeFile(join(h.root, 'a'), 'changed after initial inspection')
    release.resolve(undefined)
    expectUnverified(await pending, /changed while/)
  })

  it('does not report success when content changes during the read', async () => {
    const h = await fixture()
    await writeFile(join(h.root, 'source.txt'), 'before')
    const read = h.ctx.fs.readBytes.bind(h.ctx.fs)
    const spy = vi.spyOn(h.ctx.fs, 'readBytes').mockImplementationOnce(async (target, signal, maxBytes) => {
      const content = await read(target, signal, maxBytes)
      await writeFile(join(h.root, 'source.txt'), 'changed while inspected')
      return content
    })
    onTestFinished(() => { spy.mockRestore() })
    expectUnverified(await h.capture(['source.txt']), /changed while/)
  })

  it('does not report success when directory membership changes during inspection', async () => {
    const h = await fixture()
    await writeFile(join(h.root, 'source.txt'), 'source')
    const list = h.ctx.fs.listDir.bind(h.ctx.fs)
    const spy = vi.spyOn(h.ctx.fs, 'listDir').mockImplementationOnce(async (target, signal) => {
      const content = await list(target, signal)
      await writeFile(join(h.root, 'arrived.txt'), 'new member')
      return content
    })
    onTestFinished(() => { spy.mockRestore() })
    expectUnverified(await h.capture(['.']), /directory changed/)
  })

  it('deduplicates overlapping scope and unsorted repeated directory observations', async () => {
    const h = await fixture()
    await writeFile(join(h.root, 'a.txt'), 'first')
    await writeFile(join(h.root, 'z.txt'), 'last')
    const baseline = await h.capture(['.'])
    const list = h.ctx.fs.listDir.bind(h.ctx.fs)
    const spy = vi.spyOn(h.ctx.fs, 'listDir').mockImplementation(async (target, signal) => {
      const entries = await list(target, signal)
      return [...entries, ...entries].reverse()
    })
    onTestFinished(() => { spy.mockRestore() })
    expect((await h.capture(['.', 'a.txt'])).fingerprint).toBe(baseline.fingerprint)
  })

  it('includes repository metadata once while reviewing the repository directory', async () => {
    const h = await fixture()
    await mkdir(join(h.root, '.git'))
    await writeFile(join(h.root, '.git', 'HEAD'), '0123456789abcdef')
    await writeFile(join(h.root, 'source.txt'), 'source')
    const baseline = await h.capture(['.'])
    expect(baseline.fingerprint).not.toBeNull()
    await writeFile(join(h.root, '.git', 'packed-refs'), 'new packed refs')
    expect((await h.capture(['.'])).fingerprint).not.toBe(baseline.fingerprint)
  })

  it.each([new Error('working directory unavailable'), 'provider cannot resolve directory'])(
    'reports a failed root resolution as unverified', async (error) => {
      const h = await fixture()
      const spy = vi.spyOn(h.ctx.fs, 'resolve').mockRejectedValueOnce(error)
      onTestFinished(() => { spy.mockRestore() })
      expectUnverified(await h.capture(['.']), /working directory unavailable|provider cannot resolve/)
    },
  )

  it('preserves a provider rejection without producing a partial fingerprint', async () => {
    const h = await fixture()
    await writeFile(join(h.root, 'source.txt'), 'source')
    const spy = vi.spyOn(h.ctx.fs, 'readBytes').mockRejectedValueOnce('provider read unavailable')
    onTestFinished(() => { spy.mockRestore() })
    expectUnverified(await h.capture(['source.txt']), /provider read unavailable/)
  })

  it('refuses provider-supported special file metadata rather than reading it as a regular file', async () => {
    const h = await fixture()
    await writeFile(join(h.root, 'source.txt'), 'source')
    const target = await h.ctx.fs.resolve('source.txt')
    const metadata = await h.ctx.fs.stat(target)
    if (metadata === undefined) throw new Error('The test file must exist')
    const spy = vi.spyOn(h.ctx.fs, 'stat').mockResolvedValueOnce({ ...metadata, type: 'other' })
    onTestFinished(() => { spy.mockRestore() })
    expectUnverified(await h.capture(['source.txt']), /unsupported file/)
  })

  it('rejects unsupported path metadata before reading its contents', async () => {
    const h = await fixture()
    await writeFile(join(h.root, 'source'), 'source')
    const lstat = h.ctx.fs.lstat.bind(h.ctx.fs)
    const spy = vi.spyOn(h.ctx.fs, 'lstat').mockImplementation(async (path, opts, signal) => {
      const info = await lstat(path, opts, signal)
      return info && path === 'source' ? { ...info, type: 'other' } : info
    })
    onTestFinished(() => { spy.mockRestore() })
    expectUnverified(await h.capture(['source']), /unsupported file/)
  })

  it('rejects a listed target that resolves outside the workspace', async () => {
    const h = await fixture()
    await writeFile(join(h.root, 'source'), 'source')
    await writeFile(join(h.outside, 'source'), 'outside')
    const outside = await h.ctx.fs.resolve(join(h.outside, 'source'))
    const list = h.ctx.fs.listDir.bind(h.ctx.fs)
    const spy = vi.spyOn(h.ctx.fs, 'listDir').mockImplementation(async (target, signal) =>
      (await list(target, signal)).map(entry => ({ ...entry, target: outside })))
    onTestFinished(() => { spy.mockRestore() })
    expectUnverified(await h.capture(['.']), /outside its workspace/)
  })

  it('detects disappearance between reading bytes and the closing metadata check', async () => {
    const h = await fixture()
    await writeFile(join(h.root, 'source.txt'), 'source')
    const read = h.ctx.fs.readBytes.bind(h.ctx.fs)
    const spy = vi.spyOn(h.ctx.fs, 'readBytes').mockImplementationOnce(async (target, signal, maxBytes) => {
      const bytes = await read(target, signal, maxBytes)
      await unlink(join(h.root, 'source.txt'))
      return bytes
    })
    onTestFinished(() => { spy.mockRestore() })
    expectUnverified(await h.capture(['source.txt']), /changed while/)
  })

  it('propagates cancellation instead of turning it into a successful or retryable scope capture', async () => {
    const h = await fixture()
    const signal = AbortSignal.abort(new Error('stop scope capture'))
    await expect(captureScope(h.ctx.fs, h.root, ['.'], h.limits, signal)).rejects.toThrow()
  })
  it('reports an unchanged declared scope separately from whole-tree drift', async () => {
    const h = await fixture()
    await writeFile(join(h.root, 'a.txt'), 'alpha')
    await writeFile(join(h.root, 'shared.txt'), 'shared')
    const before = await h.capture(['a.txt'])
    expect(before.fingerprint).not.toBeNull()
    expect(before.treeFingerprint).not.toBeNull()
    // A change outside the declared scope keeps the declared fingerprint while
    // the whole-tree identity moves, which is what makes the gap observable.
    await writeFile(join(h.root, 'shared.txt'), 'shared changed')
    const after = await h.capture(['a.txt'])
    expect(after.fingerprint).toBe(before.fingerprint)
    expect(after.treeFingerprint).not.toBe(before.treeFingerprint)
  })

  it('reports an uninspectable workspace as an explicit tree diagnostic', async () => {
    const h = await fixture()
    await writeFile(join(h.root, 'a.txt'), 'a')
    await writeFile(join(h.root, 'shared.txt'), 'x'.repeat(64))
    // The declared scope fits its budget; the whole workspace does not, so the
    // scope still has an identity while the tree reports why it has none.
    const result = await h.capture(['a.txt'], { maxScopeBytes: 32 })
    expect(result.fingerprint).toMatch(/^v3:[a-f0-9]{64}$/)
    expect(result.treeFingerprint).toBeNull()
    expect(result.treeDiagnostic).toMatch(/byte limit/i)
  })

})
