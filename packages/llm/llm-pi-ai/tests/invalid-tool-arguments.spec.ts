/** Malformed provider tool arguments must never reach the real tool scheduler. */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { PiAiAdapter } from '../src/adapter.ts'
import { resolveProfiles } from '../src/config.ts'
import { memoryAuth } from './auth-double.ts'
import {
  anthropicFrame, anthropicMessageStart, anthropicTextEvents, closeMockServers, mockServer, textEvents,
} from './mock-server.ts'

type Api = 'openai-completions' | 'anthropic-messages' | 'openai-responses'
const apis: Api[] = ['openai-completions', 'anthropic-messages', 'openai-responses']
const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await closeMockServers()
})

function toolEvents(api: Api, raw: string, validFirst: boolean, truncated: boolean) {
  const calls = validFirst ? ['{}', raw] : [raw]
  if (api === 'openai-completions') return [
    JSON.stringify({ choices: [{ index: 0, delta: {
      role: 'assistant',
      tool_calls: calls.map((argumentsText, index) => ({
        index, id: 'call_' + index, type: 'function', function: { name: 'record', arguments: argumentsText },
      })),
    }, finish_reason: null }] }),
    JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: truncated ? 'length' : 'tool_calls' }],
      usage: { prompt_tokens: 3, completion_tokens: 2 } }),
    '[DONE]',
  ]
  if (api === 'anthropic-messages') return [
    anthropicMessageStart,
    ...calls.flatMap((argumentsText, index) => [
      anthropicFrame({ type: 'content_block_start', index,
        content_block: { type: 'tool_use', id: 'call_' + index, name: 'record', input: {} } }),
      anthropicFrame({ type: 'content_block_delta', index,
        delta: { type: 'input_json_delta', partial_json: argumentsText } }),
      anthropicFrame({ type: 'content_block_stop', index }),
    ]),
    anthropicFrame({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 2 } }),
    anthropicFrame({ type: 'message_stop' }),
  ]
  const items = calls.map((argumentsText, index) => ({
    type: 'function_call', id: 'item_' + index, call_id: 'call_' + index, name: 'record', arguments: argumentsText,
  }))
  return [
    JSON.stringify({ type: 'response.created', response: { id: 'response-tools' } }),
    ...items.flatMap((item, output_index) => [
      JSON.stringify({ type: 'response.output_item.added', output_index, item: { ...item, arguments: '' } }),
      JSON.stringify({ type: 'response.function_call_arguments.delta', output_index, delta: item.arguments }),
      JSON.stringify({ type: 'response.function_call_arguments.done', output_index, arguments: item.arguments }),
      JSON.stringify({ type: 'response.output_item.done', output_index, item }),
    ]),
    JSON.stringify({ type: 'response.completed', response: { id: 'response-tools', status: 'completed', output: items,
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } } }),
  ]
}

function replyEvents(api: Api) {
  if (api === 'openai-completions') return textEvents
  if (api === 'anthropic-messages') return anthropicTextEvents
  const item = { type: 'message', id: 'message-reply', role: 'assistant',
    content: [{ type: 'output_text', text: 'hello', annotations: [] }] }
  return [
    JSON.stringify({ type: 'response.created', response: { id: 'response-reply' } }),
    JSON.stringify({ type: 'response.output_item.added', output_index: 0, item }),
    JSON.stringify({ type: 'response.output_item.done', output_index: 0, item }),
    JSON.stringify({ type: 'response.completed', response: { id: 'response-reply', status: 'completed', output: [item],
      usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 } } }),
  ]
}

async function runTurn(api: Api, raw: string, validFirst = false, truncated = false) {
  const server = await mockServer([
    { events: toolEvents(api, raw, validFirst, truncated) },
    { events: replyEvents(api) },
  ])
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  const profiles = resolveProfiles({ fixture: {
    api, baseURL: server.url, models: [{ id: 'fixture-model' }], cacheRetention: 'none',
  } })
  ctx.llm.registerAdapter(['fixture'], new PiAiAdapter({
    profiles: () => profiles, resolveApiKey: () => Promise.resolve('fixture-key'), auth: memoryAuth(),
  }))
  const invocations: unknown[] = []
  // A low-level tool deliberately accepts any input, so its own validation cannot hide an unsafe adapter.
  ctx.tools.register({
    name: 'record', description: 'Record a value', parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    execute: (args) => { invocations.push(args); return Promise.resolve('executed') },
  })
  const agent = await ctx.agentLoop.create(SessionId('pi-invalid-tool-arguments'), { provider: 'fixture', model: 'fixture-model' })
  const idle = new Promise<void>((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') { dispose(); resolve() }
    })
  })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Record a value.' }], source: { kind: 'user' } }))
  await idle
  return { events: agent.session.snapshotEvents(), invocations, requests: server.requests }
}

describe('pi-ai completed tool arguments', () => {
  it.each(apis.flatMap(api => [
    { api, label: 'truncated object', raw: '{"text":"kept",' },
    { api, label: 'array', raw: '[]' },
    { api, label: 'scalar', raw: '"text"' },
    { api, label: 'null', raw: 'null' },
  ]))('$api rejects a $label before dispatching any sibling call', async ({ api, raw }) => {
    const { events, invocations, requests } = await runTurn(api, raw, true)
    expect(invocations).toEqual([])
    expect(requests).toHaveLength(1)
    expect(events.some(event => event.type === 'tool/call' || event.type === 'tool/result' || event.type === 'assistant/message')).toBe(false)
    const attempt = events.find(event => event.type === 'assistant/attempt')
    expect(attempt).toBeDefined()
    expect(JSON.stringify(attempt)).toContain('Received arguments:')
    expect(events.find(event => event.type === 'turn/end')).toMatchObject({
      data: { reason: { kind: 'error', error: { code: 'INVALID_REQUEST', message: expect.stringContaining('tool "record"') } } },
    })
  })

  it.each(apis)('%s executes repaired string escapes without dropping later fields', async (api) => {
    const { events, invocations, requests } = await runTurn(api, '{"text":"\\usepackage","tail":"retained"}')
    expect(invocations).toEqual([{ text: '\\usepackage', tail: 'retained' }])
    expect(requests).toHaveLength(2)
    expect(events.filter(event => event.type === 'tool/call')).toHaveLength(1)
    expect(events.find(event => event.type === 'turn/end')).toMatchObject({ data: { reason: { kind: 'completed' } } })
  })

  it('keeps output-token truncation non-executable without turning it into an argument failure', async () => {
    const { events, invocations, requests } = await runTurn('openai-completions', '{"text":', false, true)
    expect(invocations).toEqual([])
    expect(requests).toHaveLength(1)
    expect(events.some(event => event.type === 'tool/call' || event.type === 'assistant/attempt')).toBe(false)
    expect(events.find(event => event.type === 'turn/end')).toMatchObject({ data: { reason: { kind: 'max-tokens' } } })
  })
})
