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
    if (system.includes('RG execution worker')) {
      if (system.includes(GUIDANCE)) throw new Error('worker inherited the coordinator guidance')
      yield* text('WORKER_OK')
      return
    }
    if (system.includes('RG independent reviewer')) {
      if (system.includes(GUIDANCE)) throw new Error('reviewer inherited the coordinator guidance')
      yield* text('REVIEW_OK')
      return
    }
    if (!system.includes(GUIDANCE)) throw new Error('coordinator prompt lacks RG guidance')
    if (system.includes('RG execution worker') || system.includes('RG independent reviewer')) {
      throw new Error('coordinator prompt contains a role persona')
    }

    const history = JSON.stringify(options.messages)
    if (!history.includes('WORKER_OK')) {
      yield* toolCall('rg-worker-call', 'rg_worker', {
        description: 'Worker probe',
        prompt: 'Reply with exactly WORKER_OK and nothing else.',
      })
      return
    }
    if (!history.includes('REVIEW_OK')) {
      yield* toolCall('rg-reviewer-call', 'rg_reviewer', {
        description: 'Reviewer probe',
        prompt: 'Reply with exactly REVIEW_OK and nothing else.',
      })
      return
    }
    yield* text('PARENT_DONE WORKER_OK REVIEW_OK')
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
