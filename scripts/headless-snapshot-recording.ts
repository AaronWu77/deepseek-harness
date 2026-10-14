/** Explicit input for a headless owner's first real recording, before its primary JSONL exists. */
import type { SnapshotManifest } from '@deepseek-ai/dsh-session-snapshot'

/** Resolved task and model route for first-recording process launch. */
export interface FirstHeadlessRecordingInput {
  readonly task: string
  readonly model: { readonly provider: string; readonly model: string }
}

/** Require explicit temporary inputs rather than synthesizing a replay Session.
 * @param manifest Parsed scenario manifest used only when record mode has no primary fixture.
 * @returns Task and model route supplied by the recording owner.
 * @throws When the bootstrap task or either model route field is absent or blank.
 */
export function firstHeadlessRecordingInput(manifest: Pick<SnapshotManifest, 'input' | 'environment'>): FirstHeadlessRecordingInput {
  const task = manifest.input?.task
  if (!task?.trim()) throw new Error('First headless recording requires an explicit input.task')
  const provider = manifest.environment?.DSH_SNAPSHOT_PROVIDER
  const model = manifest.environment?.DSH_SNAPSHOT_MODEL
  if (!provider?.trim() || !model?.trim()) throw new Error('First headless recording requires explicit DSH_SNAPSHOT_PROVIDER and DSH_SNAPSHOT_MODEL')
  return { task, model: { provider, model } }
}
