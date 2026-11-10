/** Browser-safe validation shared by RG settings reads and Host writes. */
import { z } from 'zod'

const text = z.string().trim().min(1)
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
/** Exact candidate including the configured reasoning specification. */
export const modelSchema = z.object({
  provider: text, model: text, reasoningEffort: text.exactOptional(),
}).strict()
/** Editable candidate pool; an unconfigured pool may be empty. */
export const poolSchema = z.object({
  candidates: z.array(modelSchema),
  default: z.object({ provider: text, model: text }).strict().nullable(),
}).strict().superRefine((pool, context) => {
  const keys = pool.candidates.map(route => JSON.stringify([route.provider, route.model]))
  if (new Set(keys).size !== keys.length) context.addIssue({ code: 'custom', path: ['candidates'], message: 'Model routes must be unique.' })
  if (pool.default !== null
    && !pool.candidates.some(route => route.provider === pool.default?.provider && route.model === pool.default.model)) {
    context.addIssue({ code: 'custom', path: ['default'], message: 'The default must belong to its model pool.' })
  }
})
/** Settings are validated as a whole before saving or snapshotting. */
export const settingsSchema = z.object({
  configured: z.boolean(),
  main: poolSchema, worker: poolSchema,
  reviewer: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('inherit-main') }).strict(),
    z.object({ mode: z.literal('custom'), pool: poolSchema }).strict(),
  ]),
  maxWorkerAttempts: positive, maxReviewAttempts: positive,
  maxHandoffChars: positive, maxReportChars: positive, maxScopeFiles: positive, maxScopeBytes: positive,
}).strict().superRefine((settings, context) => {
  if (!settings.configured) return
  const pools = [['main', settings.main], ['worker', settings.worker],
    ...settings.reviewer.mode === 'custom' ? [['reviewer', settings.reviewer.pool] as const] : []] as const
  for (const [role, pool] of pools) {
    if (pool.candidates.length === 0 || pool.default === null) context.addIssue({ code: 'custom', path: [role], message: 'Choose candidates and a default model.' })
  }
})
