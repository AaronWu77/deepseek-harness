/** Keyless model fixture; the Node PTC runtime and SDK filesystem tool remain real. */
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { JsonSchemaNode } from '@deepseek-ai/dsh-tools'

class IsolatedPtcAdapter extends LlmAdapter {
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted()
    const tools = options.tools ?? []
    const timeout = (tools[0]?.parameters as JsonSchemaNode).properties?.timeoutMs
    if (tools.length !== 1 || tools[0]?.name !== 'run_code'
      || timeout?.description !== 'Positive elapsed-time budget in milliseconds, including nested tool and approval waits. Default 3000; capped at 4000. Zero does not disable the deadline.') {
      throw new Error('Isolated preset request must advertise only run_code with scoped maximum 4000 ms')
    }
    const called = options.messages.some(message => message.content.some(block => block.type === 'tool-call'))
    if (!called) {
      const id = ToolCallId('isolated-ptc-write')
      const args = JSON.stringify({
        code: 'const p = await import("node:process"); if (!p.execArgv.includes("--max-old-space-size=64")) throw new Error("Wrong deployment runtime executed"); await tools.write_snapshot_proof({}); return "isolated-ptc-marker";',
        description: 'Write proof through private Node runtime',
        timeoutMs: 2000,
      })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: 'run_code', argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'run_code', arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const result = options.messages.filter(message => message.role === 'tool')
    if (!JSON.stringify(result).includes('isolated-ptc-marker')) {
      throw new Error('Real PTC dispatch did not return its marker')
    }
    const text = 'Isolated Node PTC preset wrote proof.txt through the SDK.'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Cordis fixture identity. */
export const name = 'isolated-scripted-llm'
/** Only the model provider is replaced. */
export const inject = ['llm']

/** Register the local model provider through an ordinary plugin effect.
 * @param ctx Profile plugin context carrying the LLM registry.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.llm.registerAdapter(['ptc-isolated-scripted'], new IsolatedPtcAdapter()))
}
