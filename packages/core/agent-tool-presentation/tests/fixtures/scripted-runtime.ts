/** Scripted PTC backend only; it does not execute source or model Node process cancellation. */
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Entry } from '@deepseek-ai/cordis-plugin-loader'
import { PtcRuntime, type PtcRunRequest, type PtcRunResult, type PtcRunSpec } from '@deepseek-ai/dsh-ptc-runtime'

interface Config {
  label: string
  language: string
  defaultMs: number
  maxMs: number
}

/** The fixture backend translates this fixed program into a real filesystem tool binding. */
export const READ_PROGRAM = 'return await tools.read({ file_path: "input.txt" })'
/** Active-run barrier for cancellation and provider teardown tests. */
export const HOLD_PROGRAM = 'await fixtureHold()'

/** Provider-local barriers expose cancellation and quiescent completion without timers. */
export default class ScriptedRuntime extends PtcRuntime {
  static Config = z.object({
    label: z.string().required(),
    language: z.string().required(),
    defaultMs: z.number().required(),
    maxMs: z.number().required(),
  })

  readonly language: string
  readonly ownerEntry: Entry | undefined
  readonly isolation = 'scripted-test'
  readonly started = Promise.withResolvers<undefined>()
  readonly aborted = Promise.withResolvers<undefined>()
  readonly release = Promise.withResolvers<undefined>()
  readonly requests: PtcRunSpec[] = []
  private readonly teardown = new AbortController()
  private readonly active = new Set<Promise<PtcRunResult>>()

  constructor(ctx: Context, readonly config: Config) {
    super(ctx)
    this.ownerEntry = ctx.fiber.entry
    this.language = config.language
    ctx.effect(() => async () => {
      this.teardown.abort('fixture provider disposed')
      await Promise.all([...this.active])
    }, 'scripted runtime cleanup')
  }

  override get executionInstructions(): string { return 'Fixture provider: ' + this.config.label }
  override get timeout(): { defaultMs: number; maxMs: number } {
    return { defaultMs: this.config.defaultMs, maxMs: this.config.maxMs }
  }
  get activeRuns(): number { return this.active.size }

  resolve(request: PtcRunRequest): PtcRunSpec {
    return { ...request, cwd: request.cwd ?? process.cwd(), timeoutMs: request.timeoutMs ?? this.config.defaultMs }
  }

  run(spec: PtcRunSpec): Promise<PtcRunResult> {
    this.requests.push(spec)
    const task = this.execute(spec).finally(() => { this.active.delete(task) })
    this.active.add(task)
    return task
  }

  private async execute(spec: PtcRunSpec): Promise<PtcRunResult> {
    if (spec.program === HOLD_PROGRAM) {
      const signal = spec.signal === undefined ? this.teardown.signal : AbortSignal.any([spec.signal, this.teardown.signal])
      const abort = Promise.withResolvers<undefined>()
      const onAbort = (): void => { abort.resolve(undefined) }
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) abort.resolve(undefined)
      this.started.resolve(undefined)
      try {
        await abort.promise
        this.aborted.resolve(undefined)
        await this.release.promise
        return { logs: [], error: { kind: 'abort', message: String(signal.reason) } }
      } finally {
        signal.removeEventListener('abort', onAbort)
      }
    }
    if (spec.program !== READ_PROGRAM) throw new Error('Unsupported fixture program: ' + spec.program)
    const read = spec.bindings.find(binding => binding.global === 'tools')?.functions.read
    if (read === undefined) throw new Error('Fixture did not receive the real read binding')
    const value = await read({ file_path: 'input.txt' })
    return { logs: [], value: { provider: this.config.label, read: value } }
  }
}
