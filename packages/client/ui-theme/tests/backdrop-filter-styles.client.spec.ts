/**
 * Backdrop-filter prefix-pair contract, asserted against the CSS text on disk.
 *
 * The client bundle runs component sheets through a CSS minifier that collapses
 * a `-webkit-backdrop-filter` / `backdrop-filter` pair into the LAST
 * declaration. Writing the standard property first therefore ships only the
 * prefixed one, which Chromium reports as unsupported
 * (`CSS.supports('-webkit-backdrop-filter', 'blur(10px)') === false`), so the
 * declaration is inert and the surface silently loses its blur. Prefixed first,
 * standard last is the order that survives.
 */
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { describe, expect, it } from 'vitest'
import { packageStylesheets, parseRules } from './stylesheet-scan.ts'

const STANDARD = 'backdrop-filter'
const PREFIXED = '-webkit-backdrop-filter'

/**
 * Rules whose declarations put the standard property before a prefixed one.
 * @param css - stylesheet text.
 * @returns the offending selectors, in source order.
 */
function standardBeforePrefixed(css: string): string[] {
  return parseRules(css)
    .filter((rule) => {
      const properties = rule.declarations.map(([property]) => property)
      const standard = properties.indexOf(STANDARD)
      const prefixed = properties.indexOf(PREFIXED)
      return standard !== -1 && prefixed !== -1 && standard < prefixed
    })
    .map(rule => rule.selectors.join(', '))
}

describe('backdrop-filter prefix pairs', () => {
  it('rejects a pair that puts the standard property first', () => {
    expect(standardBeforePrefixed('.a { backdrop-filter: blur(2px); -webkit-backdrop-filter: blur(2px); }'))
      .toEqual(['.a'])
    expect(standardBeforePrefixed('.a { -webkit-backdrop-filter: blur(2px); backdrop-filter: blur(2px); }'))
      .toEqual([])
    expect(standardBeforePrefixed('.a { backdrop-filter: blur(2px); }')).toEqual([])
  })

  it('orders every prefix pair in the package stylesheets prefixed-first', () => {
    const offenders = packageStylesheets().flatMap(file =>
      standardBeforePrefixed(readFileSync(file, 'utf8')).map(selectors => `${basename(file)} ${selectors}`))
    expect(offenders).toEqual([])
  })
})
