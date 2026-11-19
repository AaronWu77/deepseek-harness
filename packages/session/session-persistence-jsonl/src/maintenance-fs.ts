/** Filesystem checks and durable namespace updates for reversible maintenance. */
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises'
import { dirname, join, parse, sep } from 'node:path'
import type { ReferenceFailure, SessionMaintenanceIdentity, SessionMaintenanceRefusal } from '@deepseek-ai/dsh-session-persistence'
import { ensureDurableDirectoryWin32, publishNewFileWin32 } from './win32.ts'
import { parseGenerationLogFilename, type JsonlCompression } from './format.ts'
import { LEASE_FILENAME } from './lease.ts'

/** Internal control flow for an expected maintenance refusal. */
export class MaintenanceRefused extends Error {
  /** @param reason - machine-readable result. @param detail - diagnostic. */
  constructor(readonly reason: SessionMaintenanceRefusal['reason'], detail: string) {
    super(detail)
  }
}

/** An inconclusive strict header inventory. */
export class CorpusIncomplete extends Error {
  /** @param code - corpus failure classification. @param detail - diagnostic. */
  constructor(readonly code: ReferenceFailure['code'], detail: string) {
    super(detail)
  }
}

/** @param error - filesystem rejection. @returns errno, if present. */
export function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code
}

/** @param path - absolute object path. @returns lstat without following the final link. */
export async function readIdentity(path: string) {
  try {
    return await lstat(path, { bigint: true })
  } catch (error) {
    if (errno(error) === 'ENOENT') return undefined
    throw error
  }
}

/**
 * Inspect each directory component without following symlinks or junctions.
 * @param path - absolute directory path.
 * @returns the deepest existing directory, and whether it is the requested directory.
 */
export async function directoryChain(path: string) {
  const root = parse(path).root
  let current = root
  let identity = await readIdentity(root)
  if (!identity?.isDirectory() || identity.isSymbolicLink()) throw new MaintenanceRefused('corrupt', 'unusable volume root')
  for (const part of path.slice(root.length).split(sep).filter(Boolean)) {
    const before = current
    current = join(current, part)
    const entry = await readIdentity(current)
    if (entry === undefined) return { path: before, identity, exists: false }
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new MaintenanceRefused('corrupt', 'non-directory or linked path component: ' + current)
    }
    identity = entry
  }
  return { path: current, identity, exists: true }
}

/** @param dir - directory whose namespace updates must survive a restart. */
export async function syncDirectory(dir: string): Promise<void> {
  if (process.platform === 'win32') return // durable Windows namespace moves use MoveFileExW.
  const handle = await open(dir, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** @param path - absolute owned directory to create durably. */
export async function createDirectories(path: string): Promise<void> {
  const existing = await directoryChain(path)
  if (existing.exists) return
  if (process.platform === 'win32') {
    await ensureDurableDirectoryWin32(path)
  } else {
    await createDirectories(dirname(path))
    try {
      await mkdir(path, { mode: 0o700 })
    } catch (error) {
      if (errno(error) !== 'EEXIST' || !(await directoryChain(path)).exists) throw error
    }
    await syncDirectory(dirname(path))
  }
  await directoryChain(path)
}

/**
 * Save one journal state atomically and durably. A crash can leave a staging file;
 * neither recovery nor artifact discovery interprets it as a receipt.
 * @param path - final journal path.
 * @param record - complete validated journal payload.
 * @param replace - whether a former state of this operation should already exist.
 */
export async function writeJournal(path: string, record: object, replace: boolean): Promise<void> {
  const current = await readIdentity(path)
  if (replace ? !current?.isFile() || current.isSymbolicLink() : current !== undefined) {
    throw new MaintenanceRefused('conflict', 'journal target was reoccupied or replaced')
  }
  const temporary = join(dirname(path), '.journal-' + randomUUID() + '.tmp')
  const handle = await open(temporary, 'wx', 0o600)
  try {
    try {
      await handle.writeFile(JSON.stringify(record) + '\n')
      await handle.sync()
    } finally {
      await handle.close()
    }
    if (process.platform === 'win32') await publishNewFileWin32(temporary, path, replace)
    else {
      await rename(temporary, path)
      await syncDirectory(dirname(path))
    }
  } catch (error) {
    await rm(temporary, { force: true }).catch((cleanup: unknown) => {
      throw new AggregateError([error, cleanup], 'maintenance journal and staging cleanup failed')
    })
    throw error
  }
}

/**
 * Identify the whole artifact using directory identity and the names, file identities
 * and contents of all committed generations. The legacy lock is not log content.
 * @param path - canonical session directory under a verified root.
 * @param compression - supported physical encoding.
 * @param currentVersion - latest understood generation number.
 * @param minimumReadableVersion - when set, admit historical headers down to this version instead of requiring a current generation.
 * @param signal - optional cancellation for streaming file digests.
 * @returns directory identity and content fingerprint, or undefined if absent.
 */
export async function identifyArtifact(
  path: string, compression: JsonlCompression, currentVersion: number, minimumReadableVersion?: number, signal?: AbortSignal,
): Promise<SessionMaintenanceIdentity | undefined> {
  signal?.throwIfAborted()
  const tree = await directoryChain(path)
  if (!tree.exists) return undefined
  const { identity } = tree
  if (identity.ino === 0n) throw new MaintenanceRefused('corrupt', 'filesystem supplies no artifact identity')
  const hash = createHash('sha256').update(String(identity.birthtimeNs))
  let bytes = 0
  const generations: SessionMaintenanceIdentity['generations'][number][] = []
  let current = false
  for (const name of (await readdir(path)).sort()) {
    signal?.throwIfAborted()
    if (/^session\.migration\..+\.tmp$/u.test(name)) throw new MaintenanceRefused('migration-pending', 'migration staging entry: ' + name)
    const version = parseGenerationLogFilename(name, compression)
    const file = join(path, name)
    const before = await readIdentity(file)
    if (!before?.isFile() || before.isSymbolicLink() || before.dev !== identity.dev) {
      throw new MaintenanceRefused('corrupt', 'non-regular or foreign-volume artifact entry: ' + name)
    }
    if (name === LEASE_FILENAME) {
      if (minimumReadableVersion !== undefined && before.nlink !== 1n) throw new CorpusIncomplete('layout', 'aliased legacy lock: ' + file)
      continue
    }
    if (minimumReadableVersion !== undefined && version !== undefined && (version < minimumReadableVersion || version > currentVersion)) {
      throw new CorpusIncomplete('unsupported-generation', 'unsupported committed generation: ' + name)
    }
    if (version === undefined || version > currentVersion || before.nlink !== 1n) {
      throw new MaintenanceRefused('corrupt', 'unrecognized or aliased artifact entry: ' + name)
    }
    current ||= version === currentVersion
    const entryHash = createHash('sha256')
    for await (const chunk of createReadStream(file, signal === undefined ? {} : { signal })) entryHash.update(chunk)
    const after = await readIdentity(file)
    if (after === undefined || !after.isFile() || fingerprint(before) !== fingerprint(after)) {
      throw new MaintenanceRefused('identity-changed', 'artifact generation changed: ' + name)
    }
    const generation = { name, version, bytes: Number(before.size), digest: entryHash.digest('hex'), modifiedNs: String(before.mtimeNs), fileId: String(before.ino) }
    generations.push(generation)
    hash.update(JSON.stringify(generation))
    bytes += generation.bytes
    if (!Number.isSafeInteger(bytes)) throw new MaintenanceRefused('corrupt', 'artifact size exceeds the supported count')
  }
  const after = await readIdentity(path)
  if (after === undefined || fingerprint(identity) !== fingerprint(after)) {
    throw new MaintenanceRefused('identity-changed', 'artifact directory changed during inspection')
  }
  if (generations.length === 0) throw new MaintenanceRefused('corrupt', 'committed generation is missing')
  if (!current && minimumReadableVersion === undefined) throw new MaintenanceRefused('migration-pending', 'highest generation requires migration')
  return { device: String(identity.dev), inode: String(identity.ino), entriesHash: hash.digest('hex'), bytes, generations }
}

function fingerprint(s: NonNullable<Awaited<ReturnType<typeof readIdentity>>>): string {
  return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(':')
}

/** @param left - one observation. @param right - another observation. @returns whether both identify the same complete artifact. */
export function sameArtifact(left: SessionMaintenanceIdentity | undefined, right: SessionMaintenanceIdentity): boolean {
  return left !== undefined && left.device === right.device && left.inode === right.inode
    && left.entriesHash === right.entriesHash && left.bytes === right.bytes
    && left.generations.length === right.generations.length
    && left.generations.every((entry, index) => {
      const other = right.generations[index]
      return other !== undefined && entry.name === other.name && entry.version === other.version && entry.bytes === other.bytes
        && entry.digest === other.digest && entry.modifiedNs === other.modifiedNs && entry.fileId === other.fileId
    })
}
