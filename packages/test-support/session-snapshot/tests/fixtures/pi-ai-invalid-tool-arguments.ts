/** Real PI streaming with completed malformed arguments and a filesystem tripwire. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import * as piAiPlugin from '@deepseek-ai/dsh-llm-pi-ai'
import type {} from '@deepseek-ai/dsh-tools'

/** Loader identity for the keyless invalid-arguments fixture. */
export const name = 'snapshot-pi-ai-invalid-tool-arguments'

/** Register the tripwire beside the real model runtime. */
export const inject = ['llm', 'tools']

/** Mount the real PI adapter against one owned loopback SSE response.
 * @param ctx - fixture owner, including the adapter and its transport.
 */
export async function apply(ctx: Context): Promise<void> {
  let requests = 0
  const server = createServer((request, response) => {
    request.resume()
    assert.equal(request.method, 'POST')
    assert.equal(request.url, '/v1/chat/completions')
    assert.equal(request.headers.authorization, 'Bearer snapshot-key')
    assert.equal(++requests, 1, 'malformed completed arguments must not trigger another request')
    const data = [
      JSON.stringify({ choices: [{ index: 0, delta: {
        role: 'assistant', tool_calls: [
          { index: 0, id: 'call_valid', type: 'function', function: { name: 'snapshot_record', arguments: '{}' } },
          { index: 1, id: 'call_invalid', type: 'function', function: { name: 'snapshot_record', arguments: '{"value":' } },
        ],
      }, finish_reason: null }] }),
      JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 3, completion_tokens: 2 } }),
      '[DONE]',
    ]
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(data.map(event => 'data: ' + event + '\n\n').join(''))
  })
  let consumer: ReturnType<Context['plugin']> | undefined
  ctx.effect(() => async () => {
    try {
      await consumer?.dispose()
    } finally {
      if (server.listening) {
        const closed = new Promise<void>((resolve, reject) => {
          server.close(error => error === undefined ? resolve() : reject(error))
        })
        server.closeAllConnections()
        await closed
      }
    }
  }, 'snapshot PI adapter and SSE transport')
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object')
  // An empty parameter schema lets the unsafe repaired {} reach execute if the adapter loses argumentsError.
  ctx.effect(() => ctx.tools.register({
    name: 'snapshot_record', description: 'Record one value in the workspace.',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute() {
      await writeFile(join(process.cwd(), 'tool-executed.txt'), 'unsafe tool execution\n')
      return 'executed'
    },
  }), 'snapshot filesystem tripwire')
  consumer = ctx.plugin(piAiPlugin, { providers: { 'snapshot-pi-ai': {
    api: 'openai-completions', baseURL: 'http://127.0.0.1:' + address.port + '/v1',
    apiKeyEnv: 'PI_AI_SNAPSHOT_KEY', cacheRetention: 'none',
    models: [{ id: 'invalid-tool-arguments', contextWindow: 262_144, maxTokens: 2048 }],
  } } })
}
