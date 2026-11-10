/** Local Git delivery through the Agent's filesystem, subprocess, and current sandbox policy.
 * The caller owns exclusive task-worktree access and a per-commonDir operation queue.
 * Failures retain files, index entries, objects, and commits; this executor never rolls them back.
 */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { FsError, type FsVersion } from '@deepseek-ai/dsh-fs'
import type { SubprocessCollectedOutputs } from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { deadline } from '@deepseek-ai/dsh-timeout'

/** Explicit command budgets; no operation widens the Agent's permissions. */
export interface GitExecutorConfig {
  /** Git executable resolved in the calling Agent's execution world. */
  readonly gitCommand: string
  /** Deadline for each Git subprocess, in milliseconds. */
  readonly timeoutMs: number
  /** Termination grace period for managed Git subprocesses, in milliseconds. */
  readonly graceMs: number
  /** Maximum bytes per output stream, Git metadata file, and complete captured result. */
  readonly maxOutputBytes: number
}
/** Inclusive bounds on changed files and their complete UTF-8 contents. */
export interface GitCaptureLimits {
  readonly maxScopeFiles: number
  readonly maxScopeBytes: number
}
import type { GitInspection, GitCandidateIdentity } from './git-types.ts'
export type { GitInspection, GitCandidateIdentity } from './git-types.ts'
/** A changed regular UTF-8 file, or a deletion, relative to the repository root. */
export type GitManifestEntry = {
  readonly path: string
  readonly bytes: number
  readonly mode: string
} & ({ readonly kind: 'file'; readonly content: string } | { readonly kind: 'delete'; readonly content: null })
/** Verified base-to-working-tree changes, including exact untracked paths and contents. */
export interface GitCapture {
  readonly inspection: GitInspection
  readonly baseOid: string
  readonly headOid: string
  readonly scope: readonly string[]
  readonly scopeIdentity: string
  readonly manifest: readonly GitManifestEntry[]
  /** Complete tracked diff; additions not yet in the index are represented by the manifest. */
  readonly diff: string
}
/** A clean, committed candidate; treeOid and scopeIdentity are independently rechecked. */
export interface GitCandidate extends GitCapture {
  readonly treeOid: string
}
/** Stable failure categories for the RG owner to map into its persisted error vocabulary. */
export type GitExecutorErrorCode = 'RG_GIT_FAILED' | 'RG_GIT_UNSUPPORTED' | 'RG_GIT_SCOPE'
  | 'RG_GIT_STAGED' | 'RG_GIT_CONFLICT' | 'RG_GIT_CHANGED' | 'RG_GIT_LIMIT'
  | 'RG_GIT_NO_CHANGES' | 'RG_GIT_CANCELLED' | 'RG_GIT_TIMEOUT' | 'RG_GIT_UNKNOWN'
/** A failure's effects are not a rollback guarantee; unknown requires human inspection before retry. */
export class GitExecutorError extends Error {
  override readonly name = 'GitExecutorError'
  constructor(readonly code: GitExecutorErrorCode, readonly diagnostic: string,
    readonly effect: 'none' | 'partial' | 'unknown' = 'none', options?: ErrorOptions) {
    super(diagnostic, options)
  }
}

const SELECTORS = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT',
  'GIT_CEILING_DIRECTORIES', 'GIT_PREFIX', 'GIT_SHALLOW_FILE', 'GIT_GRAFT_FILE',
  'GIT_REPLACE_REF_BASE', 'GIT_ATTR_SOURCE', 'GIT_EXTERNAL_DIFF', 'GIT_DIFF_OPTS',
  'GIT_GLOB_PATHSPECS', 'GIT_NOGLOB_PATHSPECS', 'GIT_ICASE_PATHSPECS',
]
const ENV: NodeJS.ProcessEnv = {
  ...Object.fromEntries(SELECTORS.map(key => [key, undefined])),
  GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_ALLOW_PROTOCOL: '',
  GIT_LITERAL_PATHSPECS: '1', GIT_OPTIONAL_LOCKS: '0', GIT_LFS_SKIP_SMUDGE: '1',
  GIT_PAGER: '', GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true', LC_ALL: 'C',
}
const PREFIX = ['--literal-pathspecs', '--no-optional-locks', '-c', 'core.fsmonitor=false',
  '-c', 'core.untrackedCache=false', '-c', 'protocol.allow=never', '-c', 'core.fileMode=false',
  '-c', 'maintenance.auto=false', '-c', 'gc.auto=0']
const DIFF = ['--no-ext-diff', '--no-textconv', '--no-renames', '--ignore-submodules=none']
type GitResult = { stdout: string; stderr: string; exitCode: number }
type RawEntry = { path: string; oldMode: string; mode: string }

function fail(code: GitExecutorErrorCode, diagnostic: string): never {
  throw new GitExecutorError(code, diagnostic)
}
function oid(value: string): string {
  const result = value.trim()
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(result)) fail('RG_GIT_UNSUPPORTED', 'Git did not return a full object id.')
  return result
}
function line(value: string): string {
  const result = value.replace(/\r?\n$/, '')
  if (!result || /[\0\r\n]/.test(result)) fail('RG_GIT_UNSUPPORTED', 'Git metadata must contain one complete path or reference.')
  return result
}
function nul(value: string): string[] {
  if (value === '') return []
  if (!value.endsWith('\0') || value.includes('�')) fail('RG_GIT_UNSUPPORTED', 'Git returned incomplete NUL records or a non-UTF-8 path.')
  return value.slice(0, -1).split('\0')
}
function safePath(value: string, allowRoot = false): string {
  if (allowRoot && value === '.') return value
  if (!value || value.startsWith('/') || /[\\\0\r\n:]/.test(value)
    || value.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) {
    fail('RG_GIT_SCOPE', 'Git scope paths must be normalized repository-relative literal paths without Git metadata.')
  }
  return value
}
function scoped(path: string, scope: readonly string[]): boolean {
  return scope.some(item => item === '.' || path === item || path.startsWith(item + '/'))
}
function rawEntries(value: string): RawEntry[] {
  const records = nul(value)
  const result: RawEntry[] = []
  for (let index = 0; index < records.length; index += 2) {
    const header = /^:([0-7]{6}) ([0-7]{6}) [a-f0-9]+ [a-f0-9]+ ([A-Z])$/.exec(records[index] as string)
    const path = records[index + 1]
    if (!header || path === undefined) fail('RG_GIT_UNSUPPORTED', 'Git returned an unsupported raw diff record.')
    const oldMode = String(header[1])
    const mode = String(header[2])
    const status = String(header[3])
    if (status === 'U') fail('RG_GIT_CONFLICT', 'Resolve Git conflicts before capturing a candidate.')
    for (const value of [oldMode, mode]) {
      if (!['000000', '100644', '100755'].includes(value)) {
        fail('RG_GIT_UNSUPPORTED', 'Symbolic links and submodules are not supported in a Git candidate.')
      }
    }
    result.push({ path: safePath(path), oldMode, mode })
  }
  return result
}
function statusPaths(value: string): string[] {
  return nul(value).map((record) => {
    if (!/^[ MADRCU?!]{2} /.test(record)) fail('RG_GIT_UNSUPPORTED', 'Git returned an unsupported status record.')
    const state = record.slice(0, 2)
    if (state.includes('U') || state === 'AA' || state === 'DD') fail('RG_GIT_CONFLICT', 'Resolve Git conflicts before capturing a candidate.')
    if (/[RC]/.test(state)) fail('RG_GIT_UNSUPPORTED', 'Rename status must be expanded to literal added and deleted paths.')
    return safePath(record.slice(3))
  })
}
function identity(scope: readonly string[], manifest: readonly GitManifestEntry[]): string {
  return createHash('sha256').update(JSON.stringify([scope, manifest])).digest('hex')
}
function sameCheckout(left: GitInspection, right: GitInspection, head: boolean): void {
  if (left.root !== right.root || left.gitDir !== right.gitDir || left.commonDir !== right.commonDir
    || left.branch !== right.branch || left.linkedWorktree !== right.linkedWorktree
    || (head && (left.headOid !== right.headOid || left.treeOid !== right.treeOid))) {
    fail('RG_GIT_CHANGED', 'The checkout, Git metadata, branch, or expected HEAD changed; inspect the retained worktree.')
  }
}

/** Policy-aware local Git delivery. Calls must share the RG owner's common-directory queue. */
export class GitExecutor {
  constructor(private readonly ctx: Context, private readonly config: GitExecutorConfig) {
    for (const value of [config.timeoutMs, config.graceMs, config.maxOutputBytes]) {
      if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) throw new Error('Git executor budgets must be positive timer-sized integers.')
    }
    if (!config.gitCommand || config.gitCommand.includes('\0')) throw new Error('Git executor requires a literal executable name or path.')
  }

  /** Inspect canonical checkout metadata without modifying files or configuration.
   * @param agent - Agent whose current sandbox policy applies to every command.
   * @param cwd - directory in the mounted filesystem and subprocess execution world.
   * @param signal - cancellation, settled only after managed subprocess quiescence.
   * @returns canonical checkout metadata with a full HEAD and tree object id.
   */
  async inspect(agent: Agent, cwd: string, signal: AbortSignal): Promise<GitInspection> {
    return this.readonlyOperation(signal, async () => {
      const directory = this.ctx.fs.processPath(await this.ctx.fs.resolve(cwd, { signal }))
      const run = (args: readonly string[], codes?: readonly number[]) => this.git(agent, directory, args, signal, codes)
      if (line((await run(['rev-parse', '--is-inside-work-tree'])).stdout) !== 'true') fail('RG_GIT_UNSUPPORTED', 'A non-bare Git checkout is required.')
      const canonical = async (value: string) => this.ctx.fs.processPath(await this.ctx.fs.resolve(line(value), { cwd, signal }))
      const facts = (await run(['rev-parse', '--path-format=absolute', '--show-toplevel', '--absolute-git-dir', '--git-common-dir', 'HEAD^{commit}', 'HEAD^{tree}'])).stdout.trimEnd().split('\n')
      if (facts.length !== 5) fail('RG_GIT_UNSUPPORTED', 'Git checkout metadata must contain exactly five complete records.')
      const [rootPath, gitPath, commonPath, head, tree] = facts as [string, string, string, string, string]
      const root = await canonical(rootPath)
      const gitDir = await canonical(gitPath)
      const commonDir = await canonical(commonPath)
      const rootTarget = await this.ctx.fs.resolve(root, { signal })
      const commonTarget = await this.ctx.fs.resolve(commonDir, { signal })
      const gitTarget = await this.ctx.fs.resolve(gitDir, { signal })
      const metadata = await this.ctx.fs.lstat('.git', { cwd: root }, signal)
      const linkedWorktree = gitDir !== commonDir
      if (linkedWorktree) {
        const pool = await this.ctx.fs.resolve('worktrees', { cwd: commonDir, signal })
        if (metadata?.type !== 'file' || !this.ctx.fs.contains(pool, gitTarget)) fail('RG_GIT_UNSUPPORTED', 'Linked worktree metadata must belong to its canonical shared Git directory.')
        const backlink = new TextDecoder('utf-8', { fatal: true }).decode(await this.ctx.fs.readBytes(
          await this.ctx.fs.resolve('gitdir', { cwd: gitDir, signal }), signal, this.config.maxOutputBytes))
        if (await canonical(backlink) !== this.ctx.fs.processPath(await this.ctx.fs.resolve('.git', { cwd: root, signal }))) {
          fail('RG_GIT_CHANGED', 'The linked worktree registration does not point back to this checkout.')
        }
      } else if (metadata?.type !== 'directory' || !this.ctx.fs.contains(rootTarget, commonTarget)) {
        fail('RG_GIT_UNSUPPORTED', 'External Git directories are not supported for a source checkout.')
      }
      const headOid = oid(head)
      const treeOid = oid(tree)
      const symbolic = await run(['symbolic-ref', '--quiet', 'HEAD'], [0, 1])
      const branch = symbolic.exitCode === 0 ? line(symbolic.stdout) : null
      if (branch !== null && !branch.startsWith('refs/heads/')) fail('RG_GIT_UNSUPPORTED', 'HEAD must name a local branch or be detached.')
      const result = { root, gitDir, commonDir, headOid, treeOid, branch, linkedWorktree }
      this.bound(result)
      return result
    })
  }

  /** Capture all actual changes from a pinned ancestor, including untracked UTF-8 files.
   * @param agent - policy-owning Agent.
   * @param cwd - source or task checkout; this method never stages files.
   * @param baseOid - full commit id that must be an ancestor of HEAD.
   * @param expectedHead - exact HEAD when supplied; omission pins the inspected HEAD for this capture.
   * @param scope - normalized repository-relative files or directory prefixes; dot authorizes the root.
   * @param limits - complete file-count and content-byte budgets.
   * @param signal - cancellation with subprocess quiescence.
   * @returns verified contents and identity; ignored untracked files anywhere in the checkout are refused.
   * No truncated result succeeds.
   */
  async capture(agent: Agent, cwd: string, baseOid: string, expectedHead: string | undefined,
    scope: readonly string[], limits: GitCaptureLimits, signal: AbortSignal): Promise<GitCapture> {
    return this.readonlyOperation(signal, async () => {
      const inspection = await this.inspect(agent, cwd, signal)
      const base = oid(baseOid)
      if (expectedHead !== undefined && inspection.headOid !== oid(expectedHead)) fail('RG_GIT_CHANGED', 'HEAD does not match the expected commit.')
      const normalized = [...new Set(scope.map(path => safePath(path, true)))].sort()
      if (normalized.length === 0) fail('RG_GIT_SCOPE', 'An explicit nonempty Git scope is required.')
      const overrides = await this.filters(agent, inspection.root, signal)
      const git = (args: readonly string[], codes?: readonly number[]) => this.git(agent, inspection.root, args, signal, codes, overrides)
      await this.assertNoIgnored(agent, inspection.root, signal)
      const flags = nul((await git(['ls-files', '-v', '-z', '--'])).stdout)
      if (flags.some(record => /^[a-zS]/.test(record))) fail('RG_GIT_UNSUPPORTED', 'Assume-unchanged and skip-worktree index entries are not supported.')
      if ((await git(['merge-base', '--is-ancestor', base, inspection.headOid], [0, 1])).exitCode !== 0) {
        fail('RG_GIT_CHANGED', 'Only a HEAD descended from the pinned base commit is supported.')
      }
      const statusArgs = ['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all', '--ignore-submodules=none']
      const rawArgs = ['diff', ...DIFF, '--raw', '--full-index', '-z', base, '--']
      const status = (await git(statusArgs)).stdout
      const raw = (await git(rawArgs)).stdout
      const entries = rawEntries(raw)
      const untracked = nul((await git(['ls-files', '--others', '--exclude-standard', '-z', '--'])).stdout).map(path => safePath(path))
      const paths = [...new Set([...entries.map(entry => entry.path), ...untracked])].sort()
      for (const path of [...statusPaths(status), ...paths]) {
        if (!scoped(path, normalized)) fail('RG_GIT_SCOPE', 'A changed or untracked path is outside the authorized Git scope: ' + path)
      }
      if (paths.length > limits.maxScopeFiles) fail('RG_GIT_LIMIT', 'The Git manifest exceeds maxScopeFiles.')
      const numstat = nul((await git(['diff', ...DIFF, '--numstat', '-z', base, '--'])).stdout)
      if (numstat.some(record => record.startsWith('-	-	'))) fail('RG_GIT_UNSUPPORTED', 'Binary Git changes are not supported.')
      const manifest: GitManifestEntry[] = []
      const versions = new Map<string, FsVersion | undefined>()
      let bytes = 0
      for (const path of paths) {
        const entry = entries.find(item => item.path === path)
        await this.pathInside(inspection.root, path, signal)
        const target = await this.ctx.fs.resolve(path, { cwd: inspection.root, signal })
        const before = await this.ctx.fs.stat(target, signal)
        versions.set(path, before?.version)
        if (before === undefined) {
          if (entry === undefined || entry.mode !== '000000') fail('RG_GIT_CHANGED', 'A candidate file disappeared during capture: ' + path)
          manifest.push({ path, kind: 'delete', content: null, bytes: 0, mode: '000000' })
          continue
        }
        if (before.type !== 'file') fail('RG_GIT_UNSUPPORTED', 'A Git candidate contains a non-regular file: ' + path)
        const contentBytes = await this.ctx.fs.readBytes(target, signal, limits.maxScopeBytes - bytes)
        let content: string
        try { content = new TextDecoder('utf-8', { fatal: true }).decode(contentBytes) } catch (cause) {
          throw new GitExecutorError('RG_GIT_UNSUPPORTED', 'A Git candidate contains non-UTF-8 content: ' + path, 'none', { cause })
        }
        if (content.includes('\0')) fail('RG_GIT_UNSUPPORTED', 'A Git candidate contains binary content: ' + path)
        bytes += contentBytes.byteLength
        const after = await this.ctx.fs.stat(target, signal)
        if (before.version !== after?.version) fail('RG_GIT_CHANGED', 'A candidate file changed during inspection: ' + path)
        manifest.push({ path, kind: 'file', content, bytes: contentBytes.byteLength, mode: entry?.mode ?? '100644' })
      }
      const diff = (await git(['diff', ...DIFF, '--full-index', base, '--'])).stdout
      if (diff.includes('\ufffd')) fail('RG_GIT_UNSUPPORTED', 'Git diff output cannot be verified as lossless UTF-8.')
      if (status !== (await git(statusArgs)).stdout || raw !== (await git(rawArgs)).stdout) fail('RG_GIT_CHANGED', 'The Git index or working tree changed during capture.')
      sameCheckout(inspection, await this.inspect(agent, inspection.root, signal), true)
      for (const entry of manifest) {
        await this.pathInside(inspection.root, entry.path, signal)
        const target = await this.ctx.fs.resolve(entry.path, { cwd: inspection.root, signal })
        if ((await this.ctx.fs.stat(target, signal))?.version !== versions.get(entry.path)) {
          fail('RG_GIT_CHANGED', 'A candidate file changed before capture completed: ' + entry.path)
        }
      }
      await this.assertNoIgnored(agent, inspection.root, signal)
      const result = { inspection, baseOid: base, headOid: inspection.headOid, scope: normalized,
        scopeIdentity: identity(normalized, manifest), manifest, diff }
      this.bound(result)
      return result
    })
  }

  /** Stage only the verified manifest in an exclusively owned linked task worktree and run normal commit hooks.
   * @param agent - Agent whose unchanged, current policy applies to every command.
   * @param taskWorktree - previously inspected linked worktree; root, metadata, branch, and HEAD are checked again.
   * @param baseOid - pinned ancestor commit.
   * @param expectedHead - mandatory exact HEAD before any staging.
   * @param scope - literal authorized paths.
   * @param commitMessage - literal commit message passed as one argv item.
   * @param limits - manifest budgets.
   * @param signal - cancellation, including awaiting process termination.
   * @returns a clean actual commit/tree identity, or a typed no-changes failure without an empty commit.
   * @throws GitExecutorError with partial or unknown effects after mutations; the caller retains the worktree for inspection.
   */
  async finalize(agent: Agent, taskWorktree: GitInspection, baseOid: string, expectedHead: string,
    scope: readonly string[], commitMessage: string, limits: GitCaptureLimits, signal: AbortSignal): Promise<GitCandidate> {
    let effect: 'none' | 'partial' | 'unknown' = 'none'
    try {
      if (!taskWorktree.linkedWorktree) fail('RG_GIT_UNSUPPORTED', 'Commits are allowed only in an exclusively owned linked task worktree.')
      const current = await this.inspect(agent, taskWorktree.root, signal)
      sameCheckout(taskWorktree, current, false)
      if (current.headOid !== oid(expectedHead)) fail('RG_GIT_CHANGED', 'Task HEAD does not match the expected commit.')
      const safeOverrides = await this.filters(agent, current.root, signal)
      const git = (args: readonly string[], codes?: readonly number[],
        overrides: Readonly<Record<string, string>> = safeOverrides, input?: string) =>
        this.git(agent, current.root, args, signal, codes, overrides, input)
      if ((await git(['diff', ...DIFF, '--cached', '--name-only', '-z', 'HEAD', '--'])).stdout !== '') {
        fail('RG_GIT_STAGED', 'The task index already contains staged changes; inspect and retain them before retrying.')
      }
      const before = await this.capture(agent, current.root, baseOid, expectedHead, scope, limits, signal)
      if (before.manifest.length === 0) fail('RG_GIT_NO_CHANGES', 'There are no changes relative to the pinned base commit.')
      const refs = await this.resourceState(agent, current.root, signal)
      let expectedResources = refs
      const dirty = (await git(['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all'])).stdout !== ''
      if (dirty) {
        const overrides = await this.filters(agent, current.root, signal)
        // One path per invocation keeps argv bounded and never stages an unrelated path.
        for (const entry of before.manifest) {
          effect = 'partial'
          await git(['add', '--', entry.path], undefined, overrides)
        }
        const staged = (await git(['diff', ...DIFF, '--cached', '--name-only', '-z', 'HEAD', '--'])).stdout
        for (const path of nul(staged)) if (!before.manifest.some(entry => entry.path === path)) fail('RG_GIT_CHANGED', 'An unrelated staged path appeared during finalization.')
        for (const entry of before.manifest) {
          if (entry.kind === 'delete') continue
          const actual = (await git(['ls-files', '--stage', '-z', '--', entry.path])).stdout
          const expectedBlob = oid((await git(['hash-object', '--no-filters', '--stdin'], undefined, undefined, entry.content)).stdout)
          if (actual !== entry.mode + ' ' + expectedBlob + ' 0	' + entry.path + '\0') {
            fail('RG_GIT_UNSUPPORTED', 'Git attributes, filters, or file modes changed staged content: ' + entry.path)
          }
        }
        const stagedTree = oid((await git(['write-tree'])).stdout)
        const ready = await this.capture(agent, current.root, baseOid, expectedHead, scope, limits, signal)
        if (ready.scopeIdentity !== before.scopeIdentity || refs !== await this.resourceState(agent, current.root, signal)) {
          fail('RG_GIT_CHANGED', 'Candidate contents, refs, or worktree registrations changed before commit.')
        }
        effect = 'unknown'
        await git(['commit', '-m', commitMessage], undefined, overrides)
        const committed = await this.inspect(agent, current.root, signal)
        sameCheckout(current, committed, false)
        if (committed.headOid === current.headOid || committed.treeOid !== stagedTree
          || line((await git(['rev-parse', committed.headOid + '^'])).stdout) !== current.headOid) {
          fail('RG_GIT_CHANGED', 'Commit hooks or external Git activity changed the expected commit or tree.')
        }
        const afterRefs = await this.resourceState(agent, current.root, signal)
        expectedResources = this.advanceResourceState(refs, current, committed.headOid)
        if (afterRefs !== expectedResources) fail('RG_GIT_CHANGED', 'Refs or worktree registrations changed during commit.')
      }
      const final = await this.capture(agent, current.root, baseOid, undefined, scope, limits, signal)
      sameCheckout(current, final.inspection, false)
      const finalFilters = await this.filters(agent, current.root, signal)
      if ((await git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], undefined, finalFilters)).stdout !== ''
        || final.scopeIdentity !== before.scopeIdentity) {
        fail('RG_GIT_CHANGED', 'The committed worktree is dirty or differs from the verified candidate; retain it for inspection.')
      }
      if (expectedResources !== await this.resourceState(agent, current.root, signal)) {
        fail('RG_GIT_CHANGED', 'Refs or worktree registrations changed before finalization completed.')
      }
      await this.assertNoIgnored(agent, current.root, signal)
      const candidate = { ...final, treeOid: final.inspection.treeOid }
      this.bound(candidate)
      return candidate
    } catch (cause) {
      throw this.error(cause, signal, effect)
    }
  }

  /** Recompute a retained candidate without staging, committing, or altering its metadata.
   * @param agent - Agent whose current permissions apply.
   * @param candidate - persisted candidate identity and canonical checkout metadata.
   * @param limits - complete capture budgets.
   * @param signal - cancellation with process quiescence.
   * @returns freshly verified candidate, or a structured failure when any retained identity differs.
   */
  async verifyCandidate(agent: Agent, candidate: GitCandidateIdentity,
    limits: GitCaptureLimits, signal: AbortSignal): Promise<GitCandidate> {
    return this.readonlyOperation(signal, async () => {
      const actual = await this.capture(agent, candidate.inspection.root, candidate.baseOid,
        candidate.headOid, candidate.scope, limits, signal)
      sameCheckout(candidate.inspection, actual.inspection, true)
      const finalFilters = await this.filters(agent, actual.inspection.root, signal)
      if (actual.inspection.treeOid !== candidate.treeOid || actual.scopeIdentity !== candidate.scopeIdentity
        || (await this.git(agent, actual.inspection.root,
          ['status', '--porcelain=v1', '-z', '--untracked-files=all'], signal, undefined, finalFilters)).stdout !== '') {
        fail('RG_GIT_CHANGED', 'The retained candidate no longer has its recorded clean commit, tree, and scope identity.')
      }
      await this.assertNoIgnored(agent, actual.inspection.root, signal)
      const result = { ...actual, treeOid: actual.inspection.treeOid }
      this.bound(result)
      return result
    })
  }

  private async assertNoIgnored(agent: Agent, cwd: string, signal: AbortSignal): Promise<void> {
    const output = await this.git(agent, cwd, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--'], signal)
    const paths = nul(output.stdout)
    if (paths.length !== 0) {
      throw new GitExecutorError('RG_GIT_SCOPE', 'Ignored untracked files prevent a complete Git candidate or review: ' + safePath(paths[0] as string))
    }
  }
  private async pathInside(root: string, path: string, signal: AbortSignal): Promise<void> {
    const rootTarget = await this.ctx.fs.resolve(root, { signal })
    const parts = path.split('/')
    for (let index = 1; index <= parts.length; index++) {
      const prefix = parts.slice(0, index).join('/')
      const info = await this.ctx.fs.lstat(prefix, { cwd: root }, signal)
      if (info?.type === 'symlink' || info?.type === 'other') fail('RG_GIT_UNSUPPORTED', 'Symbolic links and special files are not supported: ' + prefix)
      if (!this.ctx.fs.contains(rootTarget, await this.ctx.fs.resolve(prefix, { cwd: root, signal }))) fail('RG_GIT_SCOPE', 'A candidate path escapes its canonical checkout: ' + prefix)
    }
  }
  private async filters(agent: Agent, cwd: string, signal: AbortSignal): Promise<Readonly<Record<string, string>>> {
    const configured = await this.git(agent, cwd, ['config', '--null', '--name-only', '--get-regexp', '^filter\\.'], signal, [0, 1])
    const drivers = new Set<string>()
    for (const key of nul(configured.stdout)) {
      const separator = key.lastIndexOf('.')
      if (separator > 7 && ['clean', 'smudge', 'process', 'required'].includes(key.slice(separator + 1))) drivers.add(key.slice(7, separator))
    }
    return Object.fromEntries([...drivers].flatMap(driver => ['clean', 'smudge', 'process', 'required'].map(attribute =>
      ['filter.' + driver + '.' + attribute, attribute === 'required' ? 'false' : ''])))
  }
  private async resourceState(agent: Agent, cwd: string, signal: AbortSignal): Promise<string> {
    const refs = (await this.git(agent, cwd, ['for-each-ref', '--format=%(refname) %(objectname)'], signal)).stdout
    const worktrees = nul((await this.git(agent, cwd, ['worktree', 'list', '--porcelain', '-z'], signal)).stdout)
    const canonical: string[] = []
    for (const record of worktrees) {
      canonical.push(record.startsWith('worktree ')
        ? 'worktree ' + this.ctx.fs.processPath(await this.ctx.fs.resolve(record.slice(9), { cwd, signal })) : record)
    }
    return JSON.stringify([refs, canonical.join('\0') + '\0'])
  }
  private advanceResourceState(state: string, before: GitInspection, next: string): string {
    const [refs, worktrees] = JSON.parse(state) as [string, string]
    const updatedRefs = before.branch === null ? refs : refs.replace(before.branch + ' ' + before.headOid + '\n', before.branch + ' ' + next + '\n')
    const records = worktrees.split('\0\0')
    const updatedTrees = records.map((record) => {
      const branch = before.branch === null ? 'detached' : 'branch ' + before.branch
      const fields = record.split('\0')
      return fields[0] === 'worktree ' + before.root && fields.includes(branch)
        ? fields.map(field => field === 'HEAD ' + before.headOid ? 'HEAD ' + next : field).join('\0') : record
    }).join('\0\0')
    return JSON.stringify([updatedRefs, updatedTrees])
  }
  private bound(value: object): void {
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > this.config.maxOutputBytes) fail('RG_GIT_LIMIT', 'The complete Git result exceeds maxOutputBytes.')
  }
  private error(cause: unknown, signal: AbortSignal, effect: 'none' | 'partial' | 'unknown'): GitExecutorError {
    if (effect === 'unknown' || (cause instanceof GitExecutorError && cause.effect === 'unknown')) return new GitExecutorError('RG_GIT_UNKNOWN', 'Git may have committed or retained partial changes; inspect the task worktree before retrying.', 'unknown', { cause })
    if (signal.aborted) return new GitExecutorError('RG_GIT_CANCELLED', 'Git delivery was cancelled after managed subprocess termination.', effect, { cause })
    if (cause instanceof GitExecutorError) return new GitExecutorError(cause.code, cause.diagnostic, effect === 'none' ? cause.effect : effect, { cause })
    if (cause instanceof FsError) return new GitExecutorError(cause.code === 'FS_TOO_LARGE' ? 'RG_GIT_LIMIT' : 'RG_GIT_UNSUPPORTED', cause.message, effect, { cause })
    return new GitExecutorError('RG_GIT_FAILED', cause instanceof Error ? cause.message : String(cause), effect, { cause })
  }
  private async readonlyOperation<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    try { signal.throwIfAborted(); return await operation() } catch (cause) { throw this.error(cause, signal, 'none') }
  }
  private async git(agent: Agent, cwd: string, args: readonly string[], signal: AbortSignal,
    codes: readonly number[] = [0], overrides: Readonly<Record<string, string>> = {}, input?: string): Promise<GitResult> {
    using timeout = deadline(signal, this.config.timeoutMs, 'RG_GIT_TIMEOUT')
    try {
      timeout.signal.throwIfAborted()
      const policy = this.ctx.sandboxPolicy.resolve({ session: agent.session })
      const program = await this.ctx.subprocess.resolveExecutable(this.config.gitCommand, undefined, timeout.signal)
      const command = [program, ...PREFIX, ...args]
      const argv = policy.mode === 'danger-full-access' ? command : (await this.ctx.sandbox.confine(command, { ...policy, mode: policy.mode }, timeout.signal)).argv
      timeout.signal.throwIfAborted()
      const values = Object.entries(overrides)
      const child = this.ctx.subprocess.spawn({ argv, cwd, signal: timeout.signal, graceMs: this.config.graceMs,
        env: { ...ENV, GIT_CONFIG_COUNT: String(values.length), ...Object.fromEntries(values.flatMap(([key, value], index) =>
          [['GIT_CONFIG_KEY_' + String(index), key], ['GIT_CONFIG_VALUE_' + String(index), value]])) },
        stdio: { stdin: input === undefined ? 'ignore' : { data: input }, stdout: { maxBytes: this.config.maxOutputBytes }, stderr: { maxBytes: this.config.maxOutputBytes } } })
      try {
        const outcome = await child.done
        timeout.signal.throwIfAborted()
        const streams = child.collected as Required<SubprocessCollectedOutputs>
        const stdout = streams.stdout.readFrom(0)
        const stderr = streams.stderr.readFrom(0)
        if (stdout.lossy || stderr.lossy) fail('RG_GIT_LIMIT', 'Git output exceeded maxOutputBytes; no truncated result is trusted.')
        if (outcome.signal !== null || outcome.exitCode === null || !codes.includes(outcome.exitCode)) {
          fail('RG_GIT_FAILED', 'Git ' + String(args[0]) + ' failed (' + String(outcome.signal ?? outcome.exitCode) + '): ' + stderr.text.trim())
        }
        return { stdout: stdout.text, stderr: stderr.text, exitCode: outcome.exitCode }
      } finally {
        try { child.terminate() } finally {
          try {
            if (!await child.waitForExit()) {
              throw new GitExecutorError('RG_GIT_UNKNOWN', 'The subprocess provider could not confirm Git quiescence.', 'unknown')
            }
          } catch (cause) {
            throw new GitExecutorError('RG_GIT_UNKNOWN', 'The subprocess provider could not confirm Git quiescence.', 'unknown', { cause })
          }
        }
      }
    } catch (cause) {
      if (cause instanceof GitExecutorError && cause.effect === 'unknown') throw cause
      if (timeout.signal.aborted && !signal.aborted) throw new GitExecutorError('RG_GIT_TIMEOUT', 'Git exceeded timeoutMs after managed subprocess termination.', 'none', { cause })
      throw cause
    }
  }
}
