/** Complete, bounded role-result text and the matching retained report outcome. */
import type { RgReport, RgRun, RgTask } from './types.ts'

interface Completion {
  readonly role: 'worker' | 'reviewer'
  readonly status: RgRun['status']
  readonly report: RgReport | null
  readonly diagnostic: string | null
  readonly reviewStatus: RgTask['reviewStatus']
}

/** Bound the complete role result without truncating a successful report.
 * @param value - validated outcome and derived review status.
 * @param maxChars - frozen character limit for the entire notification text.
 * @returns bounded text and the same retained outcome; overflow is an explicit non-pass.
 */
export function boundCompletion(value: Completion, maxChars: number): Completion & { readonly text: string } {
  const normalized = { ...value, diagnostic: value.diagnostic?.trim() || null }
  const text = JSON.stringify(normalized)
  if (text.length <= maxChars) return { ...normalized, text }
  const summary = 'RG_INVALID_REPORT: The complete role result exceeds its configured limit. Narrow the report before another attempt.'
  const failure: Completion = { ...normalized, status: value.status === 'cancelled' ? 'cancelled' : 'failed', report: null,
    diagnostic: summary,
    reviewStatus: value.role === 'reviewer' ? 'inconclusive' : value.reviewStatus }
  const overhead = JSON.stringify({ ...failure, diagnostic: '' }).length
  if (overhead < maxChars) {
    const diagnostic = summary.slice(0, maxChars - overhead).trimEnd()
    const bounded = { ...failure, diagnostic }
    return { ...bounded, text: JSON.stringify(bounded) }
  }
  const diagnostic = 'RG_INVALID_REPORT'.slice(0, maxChars)
  return { ...failure, diagnostic, text: diagnostic }
}
