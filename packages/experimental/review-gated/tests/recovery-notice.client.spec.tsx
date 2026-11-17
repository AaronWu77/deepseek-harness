// @vitest-environment jsdom
/** Recovery prompts retain uncertainty without exposing technical records by default. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { afterEach, describe, expect, it } from 'vitest'
import { RgRecoveryNotice } from '../src/client/RgRecoveryNotice.tsx'
import { en } from '../src/client/locales.ts'
import type { RgView } from '../src/types.ts'

afterEach(cleanup)
const t = makeTranslate(en)
function claim(phase: NonNullable<RgView['claim']>['phase']): NonNullable<RgView['claim']> {
  return { phase, text: '<script>original input</script>', truncated: false, otherContent: false }
}

describe('RG recovery notice', () => {
  it('keeps ordinary processing to one line without technical explanations', () => {
    render(<RgRecoveryNotice status="saving" claim={null} t={t} />)
    expect(screen.getByRole('status').textContent).toBe(en.recoveryProcessing)
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByText(en.saving)).toBeNull()
    expect(screen.queryByText(en.statusProcessingHint)).toBeNull()
  })

  it.each(['unsettled', 'entered'] as const)('lets the user inspect a %s input without duplicating processing states', (phase) => {
    render(<RgRecoveryNotice status="saving" claim={claim(phase)} t={t} />)
    expect(screen.getByRole('status').textContent).toBe(en.recoveryProcessing)
    const button = screen.getByRole('button', { name: en.showInputDetails })
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('region')).toBeNull()
    expect(document.querySelector('details')).toBeNull()
    fireEvent.click(button)
    const region = screen.getByRole('region', { name: en.inputDetails })
    expect(region.id).toBe(button.getAttribute('aria-controls'))
    expect(region.textContent).toContain('<script>original input</script>')
    expect(region.textContent).toContain(en.recoveryInspectHint)
    expect(region.querySelector('script')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.hideInputDetails }))
    expect(screen.queryByRole('region')).toBeNull()
  })

  it.each(['rejected', 'empty'] as const)('surfaces a %s message as a clear failure rather than ordinary processing', (phase) => {
    render(<RgRecoveryNotice status="saving" claim={claim(phase)} t={t} />)
    expect(screen.getByRole('status').textContent).toContain(en.recoveryNotEntered)
    expect(screen.getByRole('status').textContent).toContain(en.recoveryNotEnteredHint)
    expect(screen.queryByText(en.recoveryProcessing)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.showInputDetails }))
    expect(screen.getByRole('region').textContent).toContain(en.recoveryRetryHint)
  })

  it.each(['ready', 'unknown'] as const)('does not present an unresolved %s input as a safe retry', (status) => {
    render(<RgRecoveryNotice status={status} claim={claim('entered')} t={t} />)
    expect(screen.getByRole('status').textContent).toContain(en.recoveryUnconfirmed)
    expect(screen.getByRole('status').textContent).toContain(en.recoveryCheckHint)
    expect(screen.queryByRole('button', { name: en.retry })).toBeNull()
  })

  it('makes unavailable task state and a safe next step visible', () => {
    render(<RgRecoveryNotice status="unknown" claim={null} t={t} />)
    expect(screen.getByRole('status').textContent).toContain(en.recoveryUnavailable)
    expect(screen.getByRole('status').textContent).toContain(en.recoveryCheckHint)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('keeps truncation and attachments in inspectable details, not the status headline', () => {
    render(<RgRecoveryNotice status="unknown" claim={{ ...claim('unsettled'), truncated: true, otherContent: true }} t={t} />)
    expect(screen.getByRole('status').textContent).not.toContain(en.claimTruncated)
    fireEvent.click(screen.getByRole('button', { name: en.showInputDetails }))
    const region = screen.getByRole('region')
    expect(region.textContent).toContain(en.claimTruncated)
    expect(region.textContent).toContain(en.recoveryAttachmentsHint)
  })

  it('withdraws the preview when its retained claim disappears', () => {
    const view = render(<RgRecoveryNotice status="unknown" claim={claim('unsettled')} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: en.showInputDetails }))
    view.rerender(<RgRecoveryNotice status="unknown" claim={null} t={t} />)
    expect(screen.queryByRole('region')).toBeNull()
    expect(screen.queryByText('<script>original input</script>')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })
})
