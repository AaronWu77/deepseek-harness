/** Node SSR checks for the same saving and unknown frames used by Host durability barriers. */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { RgStatus } from '../src/client/RgDock.tsx'
import { en } from '../src/client/locales.ts'
import { rgState } from './task-fixture.client.ts'

function renderStatus(trust: 'ready' | 'saving' | 'unknown') {
  return renderToStaticMarkup(createElement(RgStatus, { state: rgState(), trust, git: null, model: undefined, roleModel: undefined,
    busy: false, canNewTask: true, canRecheck: true, canAuthorizeLocalGit: true, canLeaveLocalGit: true,
    newTask: async () => {}, recheck: async () => {}, authorizeLocalGit: async () => {}, leaveLocalGit: async () => {},
    t: makeTranslate(en) }))
}

describe('RG status server rendering', () => {
  it('hides ready and pass facts while a Host result is saving', () => {
    expect(typeof window).toBe('undefined')
    const html = renderStatus('saving')
    expect(html).toContain(en.saving)
    expect(html).not.toContain(en.reportedPass)
    expect(html).not.toContain('<button')
  })

  it('hides task facts when the Host outcome is unknown', () => {
    const html = renderStatus('unknown')
    expect(html).toContain(en.statusUnknown)
    expect(html).not.toContain(en.reportedPass)
    expect(html).not.toContain('<button')
    expect(renderStatus('ready')).toContain(en.reportedPass)
  })
})
