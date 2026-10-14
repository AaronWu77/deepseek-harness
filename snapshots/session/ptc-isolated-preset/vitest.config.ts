/** Standard snapshot discovery with scenario-owned caches and a single worker. */
import { defineConfig, mergeConfig } from 'vitest/config'
import snapshotConfig from '../../../vitest.snapshot.config.ts'

const cacheDir = process.env.DSH_TEST_CACHE
if (!cacheDir) throw new Error('DSH_TEST_CACHE must name an isolated temporary root')
export default mergeConfig(snapshotConfig, defineConfig({
  cacheDir,
  test: {
    cache: false,
    include: [
      'snapshots/session/headless.snapshot.ts',
      'snapshots/session/ptc-isolated-preset/*.snapshot.ts',
    ],
    maxWorkers: 1,
    maxConcurrency: 1,
    fileParallelism: false,
  },
}))
