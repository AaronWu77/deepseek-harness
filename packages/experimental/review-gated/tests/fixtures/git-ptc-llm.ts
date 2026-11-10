/** Keyless model fixture: verifies RG role prompts and drives worker and reviewer children. */
import type { Context } from '@deepseek-ai/cordis'
import {
  LlmAdapter,
  ReasoningEffortId,
  ToolCallId,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'

const OFF = ReasoningEffortId('off')
const GUIDANCE = 'RG: work and independent review'

function text(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function toolCall(id: string, name: string, args: unknown): StreamChunk[] {
  const argumentsText = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: ToolCallId(id), name, argumentsDelta: argumentsText },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(id), name, arguments: argumentsText } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

class RgScriptedAdapter extends LlmAdapter {
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return {
      provider,
      id: model,
      name: model,
      reasoning: { efforts: [{ id: OFF, name: 'Off' }], defaultEffort: OFF },
    }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted()
    const system = options.system ?? options.messages
      .filter(message => message.role === 'system')
      .flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []))
      .join('\n')
    if (options.tools?.length !== 1 || options.tools[0]?.name !== 'run_code') {
      throw new Error('RG request must expose only the PTC run_code tool')
    }
    const calls = options.messages.flatMap(message => message.content.flatMap(block =>
      block.type === 'tool-call' ? [block.arguments] : []))
    const history = options.messages.filter(message => message.role === 'user')
      .flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []))
      .join('\n')
    const worker = system.includes('RG execution worker')
    const reviewer = system.includes('RG independent reviewer')
    if (worker || reviewer) {
      if (worker && reviewer) throw new Error('child prompt contains both role personas')
      if (system.includes(GUIDANCE)) throw new Error('child inherited the coordinator guidance')
      const marker = worker ? 'WORKER_OK' : 'REVIEW_OK'
      const report = worker
        ? { kind: 'worker', outcome: 'completed', summary: marker, changes: ['tracked.txt'], validation: ['Wrote tracked.txt'], unverified: [] }
        : { kind: 'reviewer', verdict: 'pass', summary: marker, inspectedScope: ['tracked.txt'], findings: [], validation: ['Inspected tracked.txt'], unverified: [] }
      yield* toolCall(worker ? 'rg-worker-report' : 'rg-reviewer-report', 'run_code', {
        code: worker ? `await tools.write({ file_path: "tracked.txt", content: "candidate delivery\\n" }); return await tools.structured_output(${JSON.stringify(report)});` : `const result = await tools.read({ file_path: "tracked.txt" }); if (!JSON.stringify(result).includes("candidate delivery")) throw new Error("wrong reviewer content"); return await tools.structured_output(${JSON.stringify(report)});`,
        description: 'Submit the structured RG role report',
      })
      return
    }
    if (!system.includes(GUIDANCE)) throw new Error('coordinator prompt lacks RG guidance')
    if (system.includes('RG execution worker') || system.includes('RG independent reviewer')) {
      throw new Error('coordinator prompt contains a role persona')
    }

    if (history.includes('RG_MOUNT_ONLY')) { yield* text('MOUNT_OK'); return }
    if (!history.includes('START_GIT')) { yield* text('AWAITING_AUTHORIZATION'); return }
    if (!calls.some(args => args.includes('tools.rg_worker'))) {
      yield* toolCall('rg-worker-call', 'run_code', {
        code: `console.log(await tools.list_agents({})); return await tools.rg_worker(${JSON.stringify({
          handoff: { objective: 'Worker probe', acceptance: ['Update tracked.txt'], scope: ['tracked.txt'], constraints: ['Stay within scope'], facts: [], validation: ['Inspect tracked.txt'] },
        })});`,
        description: 'Run the RG worker probe',
      })
      return
    }
    if (history.includes('WORKER_OK') && !calls.some(args => args.includes('tools.rg_reviewer'))) {
      yield* toolCall('rg-reviewer-call', 'run_code', {
        code: `return await tools.rg_reviewer(${JSON.stringify({
          handoff: { objective: 'Reviewer probe', acceptance: ['Independently inspect the probe'], scope: ['tracked.txt'], constraints: ['Stay within scope'], facts: ['Worker inspected tracked.txt'], validation: ['Inspect tracked.txt'] },
        })});`,
        description: 'Run the RG reviewer probe',
      })
      return
    }
    yield* text(history.includes('WORKER_OK') && history.includes('REVIEW_OK')
      ? 'PARENT_DONE WORKER_OK REVIEW_OK'
      : 'Waiting for the RG child report.')
  }
}

/** Cordis fixture identity. */
export const name = 'rg-scripted-llm'
/** Only the model provider is replaced. */
export const inject = ['llm']

/**
 * Register the keyless RG fixture adapter.
 * @param ctx - Composition context with the LLM registry.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.llm.registerAdapter(['rg-scripted'], new RgScriptedAdapter()))
}
