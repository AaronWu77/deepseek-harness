/** Host-owned opt-in setting for model-selectable subagent delegation. */
import type { Volatile } from '@deepseek-ai/cordis'

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  subagentModelSelectionPolicy,
  subagentModelSelectionProjectionDefinition,
} from './model-selection-state.ts'
import {
  AllowedModelRouteSchema,
  assertAllowedModelRoutes,
  type AllowedModelRoute,
} from './model-selection.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** User preference sampled during Agent creation. */
    subagentModelSelection: SubagentModelSelectionConfig
  }
}

/** Stored user preference; the shipped composition defaults it off. */
export interface SubagentModelSelectionSettings {
  /** Whether new top-level Sessions receive model selection. */
  enabled: boolean
  /** Exact child LLM routes offered to new top-level Sessions. */
  allowedModels: AllowedModelRoute[]
}

/** A composition-owned authorization choice for a fresh top-level Session. */
export interface SubagentModelSelectionSource {
  /** Unique diagnostic name of the contribution. */
  readonly name: string
  /**
   * Supply exact routes for a matching Agent, or abstain to use another source.
   * @param agent - unpublished fresh top-level Agent after its preset is mounted.
   * @returns a non-empty route list, or undefined when this source does not apply.
   */
  resolve(agent: Agent): readonly AllowedModelRoute[] | undefined | Promise<readonly AllowedModelRoute[] | undefined>
}

export type { AllowedModelRoute } from './model-selection.ts'

/** Optional deployment base for the preference. */
export interface Config {
  /** Initial enabled state inherited when the user document does not override it. */
  enabled: Volatile<boolean>
  /** Initial route list inherited when the user document does not override it. */
  allowedModels: Volatile<AllowedModelRoute[]>
}

/** Host settings owner that records Session authorization before the first model request. */
export class SubagentModelSelectionConfig extends Service {
  static inject = ['sessionProjections', 'sessions']

  static Config = z.object({
    enabled: z.boolean().default(false).volatile(),
    allowedModels: z.array(AllowedModelRouteSchema).default([]).volatile(),
  })

  private readonly sources = new Map<string, SubagentModelSelectionSource>()
  private sourcesRevision = 0

  constructor(ctx: Context, private config: Config) {
    super(ctx, 'subagentModelSelection')
  }

  protected async [Service.init](): Promise<void> {
    const ctx = this.ctx
    const policyReady = ctx.sessionProjections.register(subagentModelSelectionProjectionDefinition)
    ctx.on('agent/created', async ({ agent }) => {
      const policy = await policyReady
      ctx.fiber.assertActive()
      const target = agent.session
      if (subagentModelSelectionPolicy(policy, target) !== undefined) return
      let allowedModels: AllowedModelRoute[] | undefined
      const parentId = target.header.origin === 'subagent' ? target.header.parentSession : undefined
      if (parentId !== undefined) {
        const parent = ctx.sessions.get(parentId)
        if (parent !== undefined) allowedModels = subagentModelSelectionPolicy(policy, parent)
      } else if (target.firstLiveSeq === 0
        // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
        && target.eventAt(SessionSeq(0))?.type !== 'session/end-seed') {
        await this.captureFreshPolicy(agent)
        return
      }
      if (allowedModels !== undefined) target.append('subagent/model-selection-policy', { allowedModels })
    })
    await policyReady
  }

  /**
   * Register a composition-owned authorization source without changing global preferences.
   * Sources are sampled only for new root Sessions. Existing, resumed, seeded and
   * child Sessions retain their recorded or inherited decision. More than one
   * matching source, or removal/replacement during resolution, rejects creation.
   * @param source - named resolver returning a non-empty route list or abstaining.
   * @returns the effect disposer that withdraws this source for later creations.
   */
  registerSource(source: SubagentModelSelectionSource): () => void {
    // oxlint-disable-next-line typescript/no-misused-promises -- synchronous effect disposer
    return this.ctx.effect(() => {
      if (this.sources.has(source.name)) {
        throw new Error(`subagent model selection source "${source.name}" is already registered`)
      }
      this.sources.set(source.name, source)
      this.sourcesRevision += 1
      return () => {
        this.sources.delete(source.name)
        this.sourcesRevision += 1
      }
    }, 'subagentModelSelection.registerSource()')
  }

  /** Resolve and commit one fresh Session policy without an intervening await. */
  private async captureFreshPolicy(agent: Agent): Promise<void> {
    const revision = this.sourcesRevision
    const sources = [...this.sources.values()]
    let selected: { name: string; routes: AllowedModelRoute[] } | undefined
    for (const source of sources) {
      const routes = await source.resolve(agent)
      this.ctx.fiber.assertActive()
      agent.ctx.fiber.assertActive()
      if (revision !== this.sourcesRevision) {
        throw new Error('subagent model selection sources changed during Agent creation; retry creation')
      }
      if (routes === undefined) continue
      assertAllowedModelRoutes(routes)
      if (routes.length === 0) {
        throw new Error(`subagent model selection source "${source.name}" requires at least one route`)
      }
      if (selected !== undefined) {
        throw new Error(`subagent model selection sources "${selected.name}" and "${source.name}" both match the Agent`)
      }
      selected = { name: source.name, routes: routes.map(route => ({ ...route })) }
    }
    this.ctx.fiber.assertActive()
    agent.ctx.fiber.assertActive()
    let allowedModels = selected?.routes
    if (allowedModels === undefined) {
      const current = this.current()
      allowedModels = current.enabled ? current.allowedModels : undefined
    }
    if (allowedModels !== undefined) agent.session.append('subagent/model-selection-policy', { allowedModels })
  }

  /**
   * Read a detached selection preference for the next fresh top-level Session.
   * @returns the enabled state and exact allowed routes.
   */
  private current(): SubagentModelSelectionSettings {
    const enabled = this.config.enabled.get()
    const allowedModels = this.config.allowedModels.get()
    assertAllowedModelRoutes(allowedModels)
    if (enabled && allowedModels.length === 0) {
      throw new Error('enabled subagent model selection requires at least one allowed model')
    }
    return { enabled, allowedModels: allowedModels.map(route => ({ ...route })) }
  }

}

export const name = 'subagent-model-selection-settings'
export default SubagentModelSelectionConfig
