// @vitest-environment jsdom

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { RunningStatus } from '../src/client/chat/RunningStatus.tsx'
import { RunningWhaleTail } from '../src/client/chat/RunningWhaleTail.tsx'
import type { ChatFlowSlotProps } from '../src/client/contract/slots.ts'
import { zh } from '../src/client/locale.ts'

const t = makeTranslate(zh, commonZh)

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(5_000) })
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

const defaultIcon: ChatFlowSlotProps['renderSlot'] = (name: string) => {
  if (name !== 'conversation.chat.flow.running.icon') throw new Error(`Unexpected status slot: ${name}`)
  return <RunningWhaleTail />
}

function statusHarness(startTime?: number) {
  let renderSlot = defaultIcon
  const view = render(<RunningStatus startTime={startTime} t={t} renderSlot={renderSlot} />)
  return {
    ...view,
    content: () => view.container.querySelector('[data-chat-running] > :last-child'),
    set: (nextStartTime?: number) => {
      startTime = nextStartTime
      view.rerender(<RunningStatus startTime={startTime} t={t} renderSlot={renderSlot} />)
    },
    setIcon: (next: ChatFlowSlotProps['renderSlot']) => {
      renderSlot = next
      view.rerender(<RunningStatus startTime={startTime} t={t} renderSlot={renderSlot} />)
    },
  }
}

describe('RunningStatus', () => {
  it('renders the decorative default whale through its icon slot without an extra clock', () => {
    const view = statusHarness()
    const icon = view.content()?.querySelector('span[aria-hidden="true"]')
    expect(icon?.tagName).toBe('SPAN')
    expect(icon?.getAttribute('aria-hidden')).toBe('true')
    expect(icon?.querySelectorAll('svg path')).toHaveLength(1)
    expect(view.container.querySelector('img, animate, [style]')).toBeNull()
    expect(view.getByRole('status').textContent).toBe('深度求索中')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps the clock and accessible status when the icon contribution changes', () => {
    const view = statusHarness(1_000)
    const status = view.getByRole('status')
    const content = view.content()
    act(() => { vi.advanceTimersByTime(2_000) })
    const elapsed = content?.textContent
    view.setIcon(() => <svg data-custom-running-icon aria-hidden="true" />)
    expect(view.content()).toBe(content)
    expect(view.getByRole('status')).toBe(status)
    expect(content?.textContent).toBe(elapsed)
    expect(content?.querySelectorAll('[data-custom-running-icon]')).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(1)
    act(() => { vi.advanceTimersByTime(2_000) })
    expect(content?.textContent).not.toBe(elapsed)
    view.setIcon(defaultIcon)
    expect(content?.querySelector('[data-custom-running-icon]')).toBeNull()
    expect(content?.querySelectorAll('svg path')).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(1)
    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('waits for an open Turn start before allocating its clock', () => {
    const view = statusHarness()
    expect(view.content()?.textContent).toBe('深度求索中')
    expect(vi.getTimerCount()).toBe(0)
    view.set(1_000)
    expect(view.content()?.textContent).toMatch(/^深度求索中，用时 \d+秒 ···$/)
    expect(view.content()?.querySelectorAll('[data-shimmer="true"]')).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(1)
    view.set()
    expect(view.content()?.textContent).toBe('深度求索中')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps the indicator mounted while a continuous run moves to the next Turn', () => {
    const view = statusHarness(1_000)
    const content = view.content()
    const status = view.getByRole('status')
    const initialText = content?.textContent
    act(() => { vi.advanceTimersByTime(2_000) })
    expect(content?.textContent).toMatch(/^深度求索中，用时 \d+秒 ···$/)
    expect(content?.textContent).not.toBe(initialText)
    view.set(7_000)
    expect(view.content()).toBe(content)
    expect(content?.textContent).toMatch(/^深度求索中，用时 \d+秒 ···$/)
    expect(vi.getTimerCount()).toBe(1)
    const nextTurnText = content?.textContent
    act(() => { vi.advanceTimersByTime(2_000) })
    expect(content?.textContent).toMatch(/^深度求索中，用时 \d+秒 ···$/)
    expect(content?.textContent).not.toBe(nextTurnText)
    expect(view.getByRole('status')).toBe(status)
    expect(status.textContent).toBe('深度求索中')
    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps the duration nonnegative when the start is ahead of the local clock', () => {
    const view = statusHarness(6_000)
    expect(view.content()?.textContent).toMatch(/^深度求索中，用时 \d+秒 ···$/)
    expect(view.content()?.textContent).not.toContain('-')
    act(() => { vi.advanceTimersByTime(3_000) })
    expect(view.content()?.textContent).toMatch(/^深度求索中，用时 \d+秒 ···$/)
    expect(view.content()?.textContent).not.toContain('-')
  })

})
