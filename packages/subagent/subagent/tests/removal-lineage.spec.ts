import { expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { ArtifactHeader, MaintenanceEpoch, SessionEventLike, SessionMaintenanceBatchId, SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import { inspectRemovalLineage } from '../src/removal-lineage.ts'

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

const leaf = SessionId('forked-child')
const parent = artifact(root)
const worker = artifact(child, { parentSession: root, origin: 'subagent', delegationDepth: 1 })
const catalog = row('subagent/catalog', {
  version: 3, childId: child, childCreatedAt: 0, mode: 'continuable', label: 'worker', name: 'worker',
})
const descriptor = row('subagent/descriptor', { version: 3, mode: 'continuable', provider: 'fixture', label: 'worker' })

function fixture(
  entries: readonly [ArtifactHeader, readonly SessionEventLike[], number?][],
  active: () => boolean = () => true,
): NonNullable<Parameters<typeof inspectRemovalLineage>[0]> {
  return {
    isMaintenanceEpochActive: provided => active() && provided === epoch,
    inspectReferenceCorpus: async () => ({ state: 'complete', epoch, items: entries.map(([header]) => header) }),
    inspectReferenceLog: async (_epoch, artifact, visit) => {
      const entry = entries.find(([header]) => header === artifact)
      if (entry === undefined) return { state: 'unknown', reason: { code: 'io' } }
      const [, events, cut = 0] = entry
      for (const event of events) visit(event)
      return { state: 'complete', epoch, items: [{ events: events.length, inheritedEventCount: SessionLogOffset(cut) }] }
    },
  }
}

it('reports an active descendant confirmed by the parent catalog and child descriptor', async () => {
  const store = fixture([[parent, [catalog]], [worker, [descriptor]]])
  expect(await inspectRemovalLineage(store, epoch, root)).toEqual({ state: 'complete', epoch, items: [
    { parentId: root, childId: child, depth: 1, kind: 'subagent', location: { kind: 'active' } },
  ] })
})

it('reports a transitive restorable fork without replaying the inherited child descriptor as its own', async () => {
  const location = { kind: 'trash', batchId: brandString<SessionMaintenanceBatchId>('batch') } as const
  const fork = artifact(leaf, { parentSession: child, isSeeded: true, location })
  const store = fixture([[parent, [catalog]], [worker, [descriptor]], [fork, [descriptor], 1]])
  expect(await inspectRemovalLineage(store, epoch, root)).toMatchObject({ state: 'complete', epoch, items: [
    { childId: child, depth: 1 }, { parentId: child, childId: leaf, depth: 2, kind: 'fork', location },
  ] })
})

it('cannot clear a parent when the retained child only has a child-side descriptor', async () => {
  const store = fixture([[parent, []], [worker, [descriptor]]])
  expect(await inspectRemovalLineage(store, epoch, root)).toMatchObject({ state: 'unknown', reason: { code: 'lineage' } })
})

it.each([
  ['missing', []],
  ['unsupported', [row('subagent/descriptor', { version: 100 })]],
  ['invalid', [row('subagent/descriptor', { version: 3, mode: 'continuable' })]],
])('cannot clear a parent with a %s child descriptor', async (_case, rows) => {
  const store = fixture([[parent, [catalog]], [worker, rows]])
  expect(await inspectRemovalLineage(store, epoch, root)).toMatchObject({ state: 'unknown', reason: { code: 'lineage' } })
})

it('does not establish absence when the parent catalog points to an unretained child', async () => {
  const store = fixture([[parent, [catalog]]])
  expect(await inspectRemovalLineage(store, epoch, root)).toMatchObject({ state: 'unknown', reason: { code: 'lineage' } })
})

it('returns complete empty evidence for a retained leaf with a validated empty catalog', async () => {
  expect(await inspectRemovalLineage(fixture([[parent, []]]), epoch, root)).toEqual({ state: 'complete', epoch, items: [] })
})

it('does not use ordinary reads when retained log inspection is absent', async () => {
  const store = fixture([[parent, []]])
  delete store.inspectReferenceLog
  expect(await inspectRemovalLineage(store, epoch, root)).toMatchObject({ state: 'unknown', reason: { code: 'lineage' } })
})

it('rejects an expired epoch and an epoch invalidated in a body read', async () => {
  let active = false
  const store = fixture([[parent, []]], () => active)
  const stale = { state: 'unknown', reason: { code: 'stale-epoch' } }
  expect(await inspectRemovalLineage(store, epoch, root)).toEqual(stale)
  active = true
  const read = store.inspectReferenceLog
  if (read === undefined) throw new Error('missing fixture reader')
  store.inspectReferenceLog = async (...args) => {
    const result = await read(...args)
    active = false
    return result
  }
  expect(await inspectRemovalLineage(store, epoch, root)).toEqual(stale)
})

function quarantinedTrash() {
  const store = fixture([[parent, [catalog]]])
  store.inspectReferenceCorpus = async () => ({
    state: 'unknown', reason: { code: 'trash-unresolved', detail: 'quarantined batch containing ' + child },
  })
  return store
}

it('preserves unknown for a quarantined trash descendant', async () => {
  expect(await inspectRemovalLineage(quarantinedTrash(), epoch, root)).toMatchObject({
    state: 'unknown', reason: { code: 'trash-unresolved' },
  })
})

it('does not satisfy a caller admission check for a quarantined trash descendant', async () => {
  const store = quarantinedTrash()
  const evidence = await inspectRemovalLineage(store, epoch, root)
  const admitted = evidence.state === 'complete' && evidence.epoch === epoch
    && store.isMaintenanceEpochActive(epoch) && evidence.items.length === 0
  expect(admitted).toBe(false)
})
