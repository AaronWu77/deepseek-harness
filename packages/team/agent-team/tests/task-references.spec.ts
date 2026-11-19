import { expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import SessionStore, { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { ArtifactHeader, MaintenanceEpoch, SessionEventLike, SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { TeamJournal } from '../src/journal.ts'
import { teamProjectionDefinition } from '../src/projection.ts'
import { inspectSessionTaskReferences } from '../src/task-references.ts'

const epoch = brandString<MaintenanceEpoch>('reference-fixture')
const root = SessionId('archived-lead')
const child = SessionId('child')
const revision = brandString<SessionPersistenceRevision>('fixture-revision')

function artifact(id: SessionId, metadata: Partial<ArtifactHeader> = {}): ArtifactHeader {
  return {
    id, isSeeded: false, delegationDepth: 0, location: { kind: 'active' }, revision,
    identity: { device: '1', inode: id, entriesHash: id, bytes: 0, generations: [] },
    generations: [], layout: 'current', ...metadata,
  }
}

function row(type: string, data: unknown, seq = 0): SessionEventLike {
  return { type, data, seq, time: 0 }
}

function task(status = 'in_progress', revision = 1, seq = 0) {
  return row('team/task', { teamId: root, version: 2,
    task: { id: 'task-1', revision, status, ownerId: child, subject: '', description: '', blockedBy: [], writeScopes: [] },
  }, seq)
}

async function fixture(events: readonly SessionEventLike[]) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  const projection = await ctx.sessionProjections.register(teamProjectionDefinition)
  const journal = new TeamJournal(ctx, projection)
  const lead = artifact(root)
  const fork = artifact(SessionId('ordinary-fork'), { parentSession: root, isSeeded: true })
  const read: NonNullable<Parameters<typeof inspectSessionTaskReferences>[0]> = {
    isMaintenanceEpochActive: provided => provided === epoch,
    inspectReferenceCorpus: async () => ({ state: 'complete', epoch, items: [fork, lead, artifact(child)] }),
    inspectReferenceLog: async (_, artifact, visit) => {
      const rows = artifact.id === child ? [] : events
      for (const event of rows) visit(event)
      return { state: 'complete', epoch, items: [{
        events: rows.length, inheritedEventCount: SessionLogOffset(artifact === fork ? rows.length : 0),
      }] }
    },
  }
  return { read, journal, ctx }
}

it('finds an owner in a cold archived Lead log without publishing a Session or counting a fork copy', async () => {
  const { ctx, read, journal } = await fixture([task()])
  expect(ctx.sessions.list()).toEqual([])
  expect(await inspectSessionTaskReferences(read, journal, epoch, [child])).toEqual({ state: 'complete', epoch, items: [
    { kind: 'reference', rootId: root, ownerId: child, taskId: 'task-1', status: 'in_progress', revision: 1 },
  ] })
  expect(ctx.sessions.list()).toEqual([])
})

it('finds pending tasks by owning Lead even when their owner is not a candidate', async () => {
  const { read, journal } = await fixture([task('pending')])
  expect(await inspectSessionTaskReferences(read, journal, epoch, [root])).toMatchObject({ state: 'complete', items: [
    { kind: 'reference', status: 'pending', rootId: root },
  ] })
})

it('records deleted tombstones without returning them as references and excludes completed tasks', async () => {
  const { read, journal } = await fixture([task(), task('deleted', 2, 1)])
  expect(await inspectSessionTaskReferences(read, journal, epoch, [child])).toEqual({ state: 'complete', epoch, items: [
    { kind: 'tombstone', rootId: root, ownerId: child, taskId: 'task-1', status: 'deleted', revision: 2 },
  ] })
  const completed = await fixture([task(), task('completed', 2, 1)])
  expect(await inspectSessionTaskReferences(completed.read, completed.journal, epoch, [root, child]))
    .toEqual({ state: 'complete', epoch, items: [] })
})

it('rejects a damaged or missing Team projection instead of using the last good board', async () => {
  const { read, journal } = await fixture([task(), row('team/task', { teamId: root, version: 2 }, 1)])
  expect(await inspectSessionTaskReferences(read, journal, epoch, [child])).toMatchObject({ state: 'unknown', reason: { code: 'io' } })
  delete read.inspectReferenceLog
  expect(await inspectSessionTaskReferences(read, journal, epoch, [child])).toMatchObject({ state: 'unknown', reason: { code: 'io' } })
})

it('rejects an expired epoch and an epoch invalidated in a board read', async () => {
  const { read, journal } = await fixture([task()])
  const stale = { state: 'unknown', reason: { code: 'stale-epoch' } }
  expect(await inspectSessionTaskReferences(read, journal, brandString<MaintenanceEpoch>('expired'), [root])).toEqual(stale)
  const original = read.inspectReferenceLog
  if (original === undefined) throw new Error('missing fixture reader')
  read.inspectReferenceLog = async (...args) => {
    const result = await original(...args)
    read.isMaintenanceEpochActive = () => false
    return result
  }
  expect(await inspectSessionTaskReferences(read, journal, epoch, [root])).toEqual(stale)
})

it('reads a Lead only after an earlier transaction for that Lead settles', async () => {
  const events = [task()]
  const { read, journal } = await fixture(events)
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const queuedRoot = Promise.withResolvers<void>()
  const observationQueue: Pick<TeamJournal, 'transact'> = {
    transact: (id, operation) => {
      const result = journal.transact(id, operation)
      if (id === root) queuedRoot.resolve()
      return result
    },
  }
  let observedRoot = false
  const original = read.inspectReferenceLog
  if (original === undefined) throw new Error('missing fixture reader')
  read.inspectReferenceLog = (...args) => {
    if (args[1].id === root) observedRoot = true
    return original(...args)
  }
  const mutation = journal.transact(root, async () => {
    entered.resolve()
    await release.promise
    events.push(task('deleted', 2, 1))
  })
  const observation = inspectSessionTaskReferences(read, observationQueue, epoch, [child])
  try {
    await entered.promise
    await queuedRoot.promise
    expect(observedRoot).toBe(false)
  } finally {
    release.resolve()
  }
  await mutation
  expect(await observation).toMatchObject({ state: 'complete', items: [{ kind: 'tombstone', revision: 2 }] })
})
