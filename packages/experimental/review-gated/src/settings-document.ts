/** Loader-side settings document schema shared with the browser settings page. */
import Schema from '@deepseek-ai/schemastery'

const route = Schema.object({ provider: Schema.string().required(), model: Schema.string().required(), reasoningEffort: Schema.string() })
const pool = Schema.object({
  candidates: Schema.array(route).default([]),
  default: Schema.union([
    Schema.object({ provider: Schema.string().required(), model: Schema.string().required() }),
    Schema.const(null),
  ]).default(null),
})
const positive = () => Schema.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER)

/**
 * Loader schema for the settings document. It carries no transform: the
 * settings page validates every section against this schema's serialized form,
 * and a transform callback cannot survive that serialization, which would make
 * the whole section undecodable. Cross-field invariants therefore run at
 * consumption (`capturePolicy`) and before every save in the settings page.
 */
export const settingsDocument = Schema.object({
  configured: Schema.boolean().default(false),
  main: pool.default({ candidates: [], default: null }),
  worker: pool.default({ candidates: [], default: null }),
  reviewer: Schema.union([
    Schema.object({ mode: Schema.const('inherit-main') }),
    Schema.object({ mode: Schema.const('custom'), pool: pool.required() }),
  ]).default({ mode: 'inherit-main' }),
  maxWorkerAttempts: positive().default(2), maxReviewAttempts: positive().default(2),
  maxHandoffChars: positive().default(16384), maxReportChars: positive().default(16384),
  maxScopeFiles: positive().default(1024), maxScopeBytes: positive().default(16777216),
})

/**
 * The settings document node the settings page receives as its wire schema.
 * Exported so client regression tests exercise this exact declaration instead of
 * a copy that can drift from it.
 */
export const settingsDocumentSchema = settingsDocument
