/** Validated live settings; each new RG Session captures one immutable copy. */
import type { Volatile } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { createHash } from 'node:crypto'
import { settingsDocument } from './settings-document.ts'
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


/** Complete defaults keep a fresh installation unconfigured rather than granting every route.
 * @returns detached editable defaults.
 */
export function defaultSettings(): RgSettings {
  return { configured: false, main: { candidates: [], default: null }, worker: { candidates: [], default: null },
    reviewer: { mode: 'inherit-main' }, maxWorkerAttempts: 2, maxReviewAttempts: 2,
    maxHandoffChars: 16384, maxReportChars: 16384, maxScopeFiles: 1024, maxScopeBytes: 16777216 }
}


/** Complete loader schema; `git` stays a separate non-volatile section. */
export const Config: Schema<Config> = Schema.object({
  git: Schema.object({
    gitCommand: Schema.string().default('git'),
    timeoutMs: Schema.number().step(1).min(1).max(2147483647).default(60000),
    graceMs: Schema.number().step(1).min(1).max(2147483647).default(3000),
    maxOutputBytes: Schema.number().step(1).min(1).max(2147483647).default(1048576),
  }).default({}),
  // Every field above declares its own default, so an empty document resolves
  // to exactly `defaultSettings()`; a host test pins that equality.
  settings: settingsDocument.default({}).volatile(),
})

/**
 * Validate one complete settings document at its consumption boundary.
 *
 * The loader schema deliberately carries no transform: a transform callback
 * does not survive schema serialization, and the settings page decodes a saved
 * document through that serialized schema. Cross-field invariants therefore run
 * here, before a policy is captured or a Session is initialized, and the error
 * names each offending path.
 * @param value - candidate complete document.
 * @returns the parsed document, owned by the caller.
 * @throws when a field or cross-field invariant fails.
 */
export function parseSettings(value: unknown): RgSettings {
  const parsed = settingsSchema.safeParse(value)
  if (!parsed.success) {
    const issues = parsed.error.issues.map(issue => `${issue.path.join('.') || '<document>'}: ${issue.message}`).join('; ')
    throw new Error(`RG settings are invalid: ${issues}`)
  }
  return parsed.data
}

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
