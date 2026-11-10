/** RG bundle settings and projection-backed task controls for the Web client. */
import type { Context } from '@deepseek-ai/cordis'
import contribution from '@deepseek-ai/dsh-experimental-review-gated/remote'
import { mountRg } from './mount.ts'

export { inject } from './mount.ts'
export type { RgDockFace } from './RgDock.tsx'

/**
 * Mount generated RG methods and their settings and conversation contributions.
 * @param ctx - the browser plugin lifetime.
 * @returns the disposer that withdraws the UI before its Remote methods.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  return await mountRg(ctx, contribution)
}
