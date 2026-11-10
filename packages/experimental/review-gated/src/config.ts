/** Validated live settings; each new RG Session captures one immutable copy. */
import type { Volatile } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { createHash } from 'node:crypto'
import { settingsSchema } from './schemas.ts'
import type { RgModel, RgModelPool, RgPolicy, RgSettings } from './types.ts'
import type { GitExecutorConfig } from './git-executor.ts'

/** Loader-owned volatile document, edited atomically by the RG configuration page. */
export interface Config {
  /** Complete Host document saved atomically and captured by newly initialized RG Sessions. */
  readonly settings: Volatile<RgSettings>
  /** Local-only Git command budgets; explicit human task authorization is still required. */
  readonly git: GitExecutorConfig
}

const route = Schema.object({ provider: Schema.string().required(), model: Schema.string().required(), reasoningEffort: Schema.string() })
const pool = Schema.object({
  candidates: Schema.array(route).default([]),
  default: Schema.union([
    Schema.object({ provider: Schema.string().required(), model: Schema.string().required() }),
    Schema.const(null),
  ]).default(null),
})
const positive = () => Schema.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER)

/** Complete defaults keep a fresh installation unconfigured rather than granting every route.
 * @returns detached editable defaults.
 */
export function defaultSettings(): RgSettings {
  return { configured: false, main: { candidates: [], default: null }, worker: { candidates: [], default: null },
    reviewer: { mode: 'inherit-main' }, maxWorkerAttempts: 2, maxReviewAttempts: 2,
    maxHandoffChars: 16384, maxReportChars: 16384, maxScopeFiles: 1024, maxScopeBytes: 16777216 }
}

/** Loader schema validates cross-field invariants before publishing a live document. */
export const Config: Schema<Config> = Schema.object({
  git: Schema.object({
    gitCommand: Schema.string().default('git'),
    timeoutMs: Schema.number().step(1).min(1).max(2147483647).default(60000),
    graceMs: Schema.number().step(1).min(1).max(2147483647).default(3000),
    maxOutputBytes: Schema.number().step(1).min(1).max(2147483647).default(1048576),
  }).default({}),
  settings: Schema.transform(Schema.object({
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
  }), value => settingsSchema.parse(value)).default(settingsSchema.parse(defaultSettings())).volatile(),
})

/** Resolve an authorized route, using the pool default when no explicit route is supplied.
 * @param pool - frozen role authorization.
 * @param requested - exact provider/model pair, or omission for the configured default.
 * @returns detached route with its configured reasoning specification.
 */
export function resolveModel(pool: RgModelPool, requested?: { readonly provider: string; readonly model: string }): RgModel {
  const wanted = requested ?? pool.default
  const selected = wanted === null ? undefined
    : pool.candidates.find(route => route.provider === wanted.provider && route.model === wanted.model)
  if (selected === undefined) throw new Error('RG_MODEL_NOT_ALLOWED: choose a model from the role candidate pool.')
  return { ...selected }
}

/** Resolve reviewer inheritance and bind an exact configuration identity.
 * @param input - one complete settings document.
 * @returns immutable-by-ownership JSON policy; unconfigured settings are rejected.
 */
export function capturePolicy(input: RgSettings): RgPolicy {
  const settings = settingsSchema.parse(input)
  if (!settings.configured) throw new Error('RG_NOT_CONFIGURED: configure RG models in Settings before starting a task.')
  const { configured: _configured, reviewer, ...rest } = settings
  const resolved = { ...rest, reviewer: reviewer.mode === 'inherit-main' ? structuredClone(settings.main) : reviewer.pool, reviewerInherited: reviewer.mode === 'inherit-main' }
  return { version: 1, configurationHash: createHash('sha256').update(JSON.stringify(resolved)).digest('hex'), ...resolved }
}
