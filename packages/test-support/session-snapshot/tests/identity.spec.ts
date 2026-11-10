import { describe, expect, it } from 'vitest'
import { redactSessionSnapshotIds } from '../src/identity.ts'

const parentId = '11111111-1111-4111-8111-111111111111'
const childId = '22222222-2222-4222-8222-222222222222'
const messageId = '33333333-3333-4333-8333-333333333333'
const approvalId = '44444444-4444-4444-8444-444444444444'
const runId = '55555555-5555-4555-8555-555555555555'
const otherId = '66666666-6666-4666-8666-666666666666'
const proseUuid = '77777777-7777-4777-8777-777777777777'

describe('session snapshot identity redaction', () => {
  it('preserves feedback versions and target relationships without redacting unrelated prose', () => {
    const source = [
      { type: 'session', id: parentId },
      { type: 'assistant/message', data: { message: { id: messageId, role: 'assistant', content: [], source: {} } } },
      { type: 'feedback/message-put', data: { sessionId: parentId, item: { messageId, version: approvalId, note: proseUuid } } },
      { type: 'feedback/message-put', data: { sessionId: parentId, item: { messageId, version: runId } } },
      { type: 'feedback/message-delete', data: { sessionId: parentId, messageId } },
      { type: 'example', data: { version: proseUuid } },
    ].map(record => JSON.stringify(record)).join('\n')
    const [output] = redactSessionSnapshotIds([source])
    expect(output).toContain('"version":"{{id:1}}"')
    expect(output).toContain('"version":"{{id:2}}"')
    expect(output?.match(/"messageId":"{{message:1}}"/g)).toHaveLength(3)
    expect(output).toContain(proseUuid)
    expect(redactSessionSnapshotIds([output!])).toEqual([output])
  })

  it('preserves typed relationships across parent and child logs', () => {
    const parent = [
      JSON.stringify({ type: 'session', id: parentId, createdAt: 1, cwd: '/tmp/work' }),
      JSON.stringify({
        type: 'agent/inbox/spliced',
        data: {
          inserted: [{
            role: 'user',
            content: [{ type: 'text', text: `keep unrelated ${proseUuid}; session ${childId}` }],
            source: { kind: 'user' },
            id: messageId,
          }],
        },
      }),
      JSON.stringify({ type: 'approval/asked', data: { id: approvalId } }),
      JSON.stringify({ type: 'tool-workflow/run-start', data: { runId } }),
      JSON.stringify({ type: 'example', data: { requestId: otherId, echoed: otherId } }),
      '',
    ].join('\n')
    const child = [
      JSON.stringify({ type: 'session', id: childId, parentSession: parentId, createdAt: 2, cwd: '/tmp/work' }),
      JSON.stringify({
        type: 'user/message',
        data: {
          role: 'user', content: [], source: { kind: 'user' }, id: messageId,
        },
      }),
      '',
    ].join('\n')

    const redacted = redactSessionSnapshotIds([parent, child])
    expect(redacted[0]).toContain('"id":"{{session:1}}"')
    expect(redacted[1]).toContain('"id":"{{session:2}}"')
    expect(redacted[1]).toContain('"parentSession":"{{session:1}}"')
    expect(redacted.join('\n').match(/\{\{message:1\}\}/g)).toHaveLength(2)
    expect(redacted[0]).toContain('"id":"{{approval:1}}"')
    expect(redacted[0]).toContain('"runId":"{{workflow:1}}"')
    expect(redacted[0]).toContain('"requestId":"{{id:1}}"')
    expect(redacted[0]).toContain('"echoed":"{{id:1}}"')
    expect(redacted[0]).toContain(proseUuid)
    expect(redacted[0]).toContain('session {{session:2}}')
    expect(redactSessionSnapshotIds(redacted)).toEqual(redacted)
  })

  it('classifies semantic text plus command, RPC, and retry identity fields', () => {
    const semanticMessage = '88888888-8888-4888-8888-888888888888'
    const anonymousUser = '99999999-9999-4999-8999-999999999999'
    const retryId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const source = [
      JSON.stringify({ type: 'not-a-session', data: { value: 'plain' } }),
      JSON.stringify({
        type: 'example',
        data: {
          commandId: 'command-7',
          rpcId: 'rpc-9',
          retryId,
          requestId: 'stable-readable-id',
          text: `Retain this as message ${semanticMessage}. Anonymous user: ${anonymousUser}`,
        },
      }),
    ].join('\n')

    const [redacted] = redactSessionSnapshotIds([source])
    expect(redacted).toContain('"commandId":"{{command:1}}"')
    expect(redacted).toContain('"rpcId":"{{rpc:1}}"')
    expect(redacted).toContain('"retryId":"{{retry:1}}"')
    expect(redacted).toContain('as message {{message:1}}')
    expect(redacted).toContain('Anonymous user: {{id:1}}')
    expect(redacted).toContain('"requestId":"stable-readable-id"')
    expect(redacted?.endsWith('\n')).toBe(false)
  })

  it('registers RG task and run leaves before replacing cross-session references', () => {
    const taskId = 'rg-task-' + approvalId
    const workerRun = 'rg-run-' + runId
    const reviewRun = 'rg-run-' + otherId
    const unregistered = 'rg-run-' + proseUuid
    const parent = [
      { type: 'session', id: parentId },
      { type: 'tool/result', data: { text: JSON.stringify({ taskId, runId: workerRun, unregistered }) } },
      { type: 'review-gated/state', data: { state: { task: {
        id: taskId, originMessageId: messageId,
        active: { id: workerRun, childId }, lastWorker: { id: workerRun, childId },
        lastReview: { id: reviewRun, childId },
      } } } },
      { type: 'user/message', data: { id: messageId, role: 'user', source: { kind: 'user' },
        content: [{ type: 'text', text: 'Keep unregistered ' + unregistered }] } },
      { type: 'tool-workflow/run-start', data: { runId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } },
      { type: 'review-gated/state', data: { state: null } },
      { type: 'review-gated/state', data: null },
    ].map(record => JSON.stringify(record)).join('\n') + '\n'
    const child = [
      { type: 'session', id: childId, parentSession: parentId },
      { type: 'review-gated/state', data: { state: { parentSessionId: parentId,
        taskId, runId: workerRun, task: null } } },
    ].map(record => JSON.stringify(record)).join('\n') + '\n'
    const redacted = redactSessionSnapshotIds([parent, child])
    expect(redacted[0]).toContain('"id":"{{rg-task:1}}"')
    expect(redacted[0]?.match(/"id":"{{rg-run:1}}"/g)).toHaveLength(2)
    expect(redacted[0]).toContain('"id":"{{rg-run:2}}"')
    expect(redacted[0]).toContain('"originMessageId":"{{message:1}}"')
    expect(redacted[0]).toContain('"runId":"{{workflow:1}}"')
    expect(redacted[1]).toContain('"parentSessionId":"{{session:1}}"')
    expect(redacted[1]).toContain('"taskId":"{{rg-task:1}}","runId":"{{rg-run:1}}"')
    const firstResult = JSON.parse(redacted[0]!.split('\n')[1]!) as { data: { text: string } }
    expect(JSON.parse(firstResult.data.text)).toEqual({ taskId: '{{rg-task:1}}', runId: '{{rg-run:1}}', unregistered })
    expect(redacted[0]).toContain('Keep unregistered ' + unregistered)
    expect(redactSessionSnapshotIds(redacted)).toEqual(redacted)
  })

  it.each(['review-gated/result-prepared', 'review-gated/result-confirmed'])('registers %s identities without another state event', (type) => {
    const data = { taskId: 'task-key', runId: 'run-key', childId: 'child-key' }
    const source = [
      { type: 'session', id: parentId },
      { type, data },
      { type: 'tool/result', data: { taskId: 'ordinary-task', runId: 'ordinary-run', childId: 'ordinary-child' } },
    ].map(record => JSON.stringify(record)).join('\n')
    const [output] = redactSessionSnapshotIds([source])
    const rows = output!.split('\n').map(line => JSON.parse(line) as { data: typeof data })
    expect(rows[1]!.data).toEqual({ taskId: '{{rg-task:1}}', runId: '{{rg-run:1}}', childId: '{{session:2}}' })
    expect(rows[2]!.data).toEqual({ taskId: 'ordinary-task', runId: 'ordinary-run', childId: 'ordinary-child' })
    expect(redactSessionSnapshotIds([output!])).toEqual([output])
  })

  it('registers RG identities nested only in prepared state', () => {
    const source = [
      { type: 'session', id: parentId },
      { type: 'review-gated/result-prepared', data: { state: { task: {
        id: 'task-key', originMessageId: 'message-key', lastReview: { id: 'run-key', childId: 'child-key' },
      } } } },
    ].map(record => JSON.stringify(record)).join('\n')
    const [output] = redactSessionSnapshotIds([source])
    expect(output).toContain('"id":"{{rg-task:1}}","originMessageId":"{{message:1}}"')
    expect(output).toContain('"id":"{{rg-run:1}}","childId":"{{session:2}}"')
    expect(redactSessionSnapshotIds([output!])).toEqual([output])
  })

  it.each(['active', 'lastWorker', 'lastReview'])('registers an RG %s run without another copy', (slot) => {
    const source = [
      { type: 'session', id: parentId },
      { type: 'review-gated/state', data: { state: { task: { id: 'task-key', [slot]: { id: 'run-key', childId } } } } },
    ].map(record => JSON.stringify(record)).join('\n')
    const [output] = redactSessionSnapshotIds([source])
    expect(output).toContain('"id":"{{rg-task:1}}"')
    expect(output).toContain('"id":"{{rg-run:1}}"')
    expect(output).toContain('"childId":"{{session:2}}"')
    expect(redactSessionSnapshotIds([output!])).toEqual([output])
  })

  it('registers child RG task and run references without a parent task record', () => {
    const source = [
      { type: 'session', id: childId },
      { type: 'review-gated/state', data: { state: { parentSessionId: parentId, taskId: 'task-key', runId: 'run-key', task: null } } },
    ].map(record => JSON.stringify(record)).join('\n')
    const [output] = redactSessionSnapshotIds([source])
    expect(output).toContain('"parentSessionId":"{{session:2}}"')
    expect(output).toContain('"taskId":"{{rg-task:1}}","runId":"{{rg-run:1}}"')
    expect(redactSessionSnapshotIds([output!])).toEqual([output])
  })

  it('keeps a canonical token first seen through a generic id key', () => {
    const canonical = '{{message:7}}'
    const nextMessage = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const source = [
      JSON.stringify({ type: 'example', data: { requestId: canonical } }),
      JSON.stringify({
        type: 'user/message',
        data: { role: 'user', content: [], source: { kind: 'user' }, id: canonical },
      }),
      JSON.stringify({
        type: 'user/message',
        data: { role: 'user', content: [], source: { kind: 'user' }, id: nextMessage },
      }),
      '',
    ].join('\n')

    const [redacted] = redactSessionSnapshotIds([source])
    expect(redacted?.match(/\{\{message:7\}\}/g)).toHaveLength(2)
    expect(redacted).toContain('"id":"{{message:8}}"')
    expect(redacted).not.toContain('{{id:')
  })
})
