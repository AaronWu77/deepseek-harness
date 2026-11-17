/** Browser-local RG role layout preference; task state is unaffected. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'

/** Available presentations of the same role and attempt facts. */
export type RgRoleLayout = 'classic' | 'flow' | 'focus' | 'trace'

/**
 * Resolve a stored view choice; unsupported values retain the classic presentation.
 * @param value - browser-persisted choice.
 * @returns a supported role layout.
 */
export function resolveRoleLayout(value: unknown): RgRoleLayout {
  return value === 'flow' || value === 'focus' || value === 'trace' ? value : 'classic'
}

/**
 * Create one browser-wide preference source for this plugin lifetime.
 * @returns the persisted view choice shared by RG sidebar tabs.
 */
export function createRgRoleLayout() {
  return createSnapshotStore<RgRoleLayout>('classic', { persist: { name: 'dsh.rg.role-layout' } })
}
