/** Complete report-result limits include metadata and failure diagnostics, without partial passes. */
import { describe, expect, it } from 'vitest'
import { boundCompletion } from '../src/report-result.ts'
import type { RgReviewReport } from '../src/types.ts'

const report: RgReviewReport = { kind: 'reviewer', verdict: 'pass', summary: 'Meets the requested criteria',
  inspectedScope: ['probe.txt'], findings: [], validation: ['Read the scope'], unverified: [] }
const passed = { role: 'reviewer' as const, status: 'completed' as const, report, diagnostic: null,
  reviewStatus: 'reported-pass' as const }

describe('complete RG report results', () => {
  it('keeps exact-limit outcomes and their full report unchanged', () => {
    const text = JSON.stringify(passed)
    const result = boundCompletion(passed, text.length)
    expect(result.text).toBe(text)
    expect(result.report).toBe(report)
    expect(result.status).toBe('completed')
    expect(result.reviewStatus).toBe('reported-pass')
  })

  it('counts metadata rather than only the report body', () => {
    const limit = JSON.stringify(passed).length - 1
    expect(JSON.stringify(report).length).toBeLessThan(limit)
    const result = boundCompletion(passed, limit)
    expect(result.text.length).toBeLessThanOrEqual(limit)
    expect(result.status).toBe('failed')
    expect(result.report).toBeNull()
    expect(result.reviewStatus).toBe('inconclusive')
  })

  it.each([1, 2, 12, 64, 126, 127, 128, 129, 160, 200])('keeps a tiny %i-character result bounded and never reports pass', (limit) => {
    const result = boundCompletion(passed, limit)
    expect(result.text.length).toBeLessThanOrEqual(limit)
    expect(result.diagnostic?.length).toBeLessThanOrEqual(limit)
    expect(result.diagnostic).not.toBe('')
    expect(result.report).toBeNull()
    expect(result.reviewStatus).toBe('inconclusive')
    expect(result.status).toBe('failed')
  })

  it('bounds large and JSON-escaped failure diagnostics as well as reports', () => {
    const result = boundCompletion({ ...passed, status: 'failed', report: null, diagnostic: '\n\"\\'.repeat(10000) }, 256)
    expect(result.text.length).toBeLessThanOrEqual(256)
    expect(result.diagnostic?.length).toBeLessThanOrEqual(256)
    expect(JSON.parse(result.text)).toMatchObject({ status: 'failed', report: null, reviewStatus: 'inconclusive' })
  })

  it('never truncates findings into an apparent successful report', () => {
    const oversized = { ...report, summary: 'x'.repeat(20000), findings: [{ location: 'file:1', impact: 'Bug', evidence: 'Proof' }] }
    const result = boundCompletion({ ...passed, report: oversized }, 1024)
    expect(result.report).toBeNull()
    expect(result.text).not.toContain('findings')
    expect(result.status).toBe('failed')
  })

  it('preserves cancellation and an earlier stale worker review status on overflow', () => {
    const result = boundCompletion({ role: 'worker', status: 'cancelled', report: null, diagnostic: 'x'.repeat(20000),
      reviewStatus: 'stale' }, 128)
    expect(result.status).toBe('cancelled')
    expect(result.reviewStatus).toBe('stale')
    expect(result.report).toBeNull()
    expect(result.text.length).toBeLessThanOrEqual(128)
  })

  it('keeps emitted and retained diagnostics in the canonical trimmed form', () => {
    const normalized = boundCompletion({ ...passed, diagnostic: '  Checked  ' }, 1024)
    expect(normalized.diagnostic).toBe('Checked')
    expect(JSON.parse(normalized.text)).toMatchObject({ diagnostic: 'Checked' })
    expect(boundCompletion({ ...passed, diagnostic: '   ' }, 1024).diagnostic).toBeNull()
    for (let limit = 120; limit < 280; limit++) {
      const result = boundCompletion(passed, limit)
      if (result.diagnostic !== null) expect(result.diagnostic).toBe(result.diagnostic.trim())
    }
  })

  it('counts serialized multibyte text at the complete result limit', () => {
    const value = { ...passed, report: { ...report, summary: '汉🙂' } }
    const size = JSON.stringify(value).length
    expect(boundCompletion(value, size).report).toEqual(value.report)
    expect(boundCompletion(value, size - 1).report).toBeNull()
  })
})
