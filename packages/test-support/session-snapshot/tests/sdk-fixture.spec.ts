import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SESSION_FORMAT_VERSION, SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import { parseSessionHeader, parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import { materializeSdkReplayFixtureCwd } from '../src/sdk-fixture.ts'
import { sessionFixtureNames } from '../src/session-files.ts'

const workingDirectories = [
  '/tmp/sdk-snapshot',
  '/',
  'C:\\Users\\SDK user\\workspace',
  'C:\\',
  '\\\\server\\share\\workspace',
  '/tmp/quoted "workspace"/$&',
]

const header: SessionHeader = {
  version: SESSION_FORMAT_VERSION, id: SessionId('fixture-session'), createdAt: 0,
  cwd: '{{cwd}}', isSeeded: false, delegationDepth: 0,
}

function fields(cwd: string): object {
  return {
    context: 'Current working directory: ' + JSON.stringify(cwd) + '.',
    arguments: JSON.stringify({ file_path: cwd + '/file.txt', note: 'keep this text' }, null, 2),
    nested: JSON.stringify(JSON.stringify({ cwd })),
    bare: 'at ' + cwd + '/file.txt',
    untouched: 'Keep C:\\known\\path, "quoted" prose, π, {{session:1}}, and {{system}}.',
    other: [null, true, 17],
  }
}

function message(text: string): object {
  return {
    type: 'user/message', surfaceOp: 'append',
    data: { content: [{ type: 'text', text }], source: { kind: 'user' }, role: 'user', id: 'fixture-user' },
  }
}

describe('materializeSdkReplayFixtureCwd', () => {
  it.each(workingDirectories)('retains native cwd and nested JSON text for %s', (cwd) => {
    const raw = '  ' + JSON.stringify({ type: 'session', ...header }) + '\r\n'
      + JSON.stringify(message(JSON.stringify(fields('{{cwd}}')))) + '\r\n\n'
    const expected = '  ' + JSON.stringify({ type: 'session', ...header, cwd }) + '\r\n'
      + JSON.stringify(message(JSON.stringify(fields(cwd)))) + '\r\n\n'
    const actual = materializeSdkReplayFixtureCwd(raw, cwd)
    expect(actual).toBe(expected)
    const parsed = JSON.parse(actual.split('\r\n')[0]!) as SessionHeader
    expect(parsed.cwd).toBe(cwd)
    expect(parsed.version).toBe(SESSION_FORMAT_VERSION)
    expect(parseSessionHeader(JSON.stringify({ type: 'session', ...parsed })).id).toBe(header.id)
    const bodyMessage = JSON.parse(actual.split('\r\n')[1]!) as { data: { content: { text: string }[] } }
    const body = JSON.parse(bodyMessage.data.content[0]!.text) as { arguments: string; nested: string }
    expect(JSON.parse(body.arguments)).toEqual({ file_path: cwd + '/file.txt', note: 'keep this text' })
    expect(JSON.parse(JSON.parse(body.nested) as string)).toEqual({ cwd })
  })

  it.each(['text-turn', 'ptc-turn', 'session-resume', 'subagent-spawn-in-process'])(
    'restores the selected %s fixture before the SDK subprocess starts', (scenario) => {
      const root = new URL('../../../../snapshots/sdk/' + scenario + '/', import.meta.url)
      for (const file of sessionFixtureNames(readdirSync(fileURLToPath(root)))) {
        const raw = readFileSync(new URL(file, root), 'utf8')
        const actual = materializeSdkReplayFixtureCwd(raw, 'C:\\Users\\SDK user\\workspace')
        expect(() => parseSessionLog(actual)).not.toThrow()
        expect(parseSessionHeader(actual).id).toBe(parseSessionHeader(raw).id)
        const prefix = 'Current working directory: '
        const cwdLines = parseSessionLog(actual).flatMap(event =>
          event.type === 'user/message' && event.data.source.kind === 'runtime-context'
            ? event.data.content.flatMap(block => block.type === 'text'
              ? block.text.split('\n').filter(line => line.startsWith(prefix)) : [])
            : [])
        expect(cwdLines.length).toBeGreaterThan(0)
        for (const line of cwdLines) {
          expect(JSON.parse(line.slice(prefix.length, -1)) as string).toBe('C:\\Users\\SDK user\\workspace')
        }
      }
    },
  )

  it('retains unrelated literal escapes and formatting beside a cwd token', () => {
    const prefix = JSON.stringify({ type: 'session', ...header }) + '\r\n'
    const event = JSON.stringify(message('Keep π, /, and {{cwd}}')).replace('π', '\\u03c0').replace(', /,', ', \\/,')
    const raw = prefix + '  ' + event + '\r\n\n'
    const expected = raw.replaceAll('{{cwd}}', '/tmp/sdk')
    expect(materializeSdkReplayFixtureCwd(raw, '/tmp/sdk')).toBe(expected)
  })

  it('rejects cwd markers introduced by decoding a mixed literal before SDK boot', () => {
    const prefix = JSON.stringify({ type: 'session', ...header }) + '\n'
    const escapedMarker = String.raw`\u0022\u007b\u007bcwd\u007d\u007d\u0022`
    const event = JSON.stringify(message('UNICODE_CWD {{cwd}}')).replace('UNICODE_CWD', escapedMarker)
    expect(() => parseSessionLog(prefix + event + '\n')).not.toThrow()
    expect(() => materializeSdkReplayFixtureCwd(prefix + event + '\n', 'C:\\SDK\\workspace'))
      .toThrow('cwd marker count changed during JSON decoding')
  })

  it('leaves Unicode-escaped marker text without a raw marker unchanged', () => {
    const prefix = JSON.stringify({ type: 'session', ...header }) + '\n'
    const escapedMarker = String.raw`\u007b\u007bcwd\u007d\u007d`
    const event = JSON.stringify(message('UNICODE_CWD')).replace('UNICODE_CWD', escapedMarker)
    const actual = materializeSdkReplayFixtureCwd(prefix + event + '\n', '/tmp/sdk')
    expect(actual).toBe(prefix.replaceAll('{{cwd}}', '/tmp/sdk') + event + '\n')
  })

  it('rejects invalid JSON and Session data before SDK boot', () => {
    const prefix = JSON.stringify({ type: 'session', ...header }) + '\n'
    expect(() => materializeSdkReplayFixtureCwd(prefix + '{bad}\n', '/tmp/sdk')).toThrow('invalid JSON')
    expect(() => materializeSdkReplayFixtureCwd(prefix + '{"type":"unknown","data":{}}\n', '/tmp/sdk')).toThrow()
  })
})
