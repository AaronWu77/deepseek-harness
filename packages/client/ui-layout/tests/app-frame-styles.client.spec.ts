/**
 * Shell-column stacking contract, asserted against AppFrame.module.css.
 *
 * No shell column may declare a z-index. A column with one creates a stacking
 * context, and every position: fixed overlay mounted inside that column is then
 * confined to it: the settings dialog lives in the sidebar footer and declares
 * z-index 1000, but inside a sidebar-column stacking context it lost to the
 * conversation column's own z-index, so the dialog painted under the transcript
 * and received no pointer events. Settings could not be clicked at all. The
 * columns are ordered against the ambient canvas by .window instead, and the
 * sidebar's glass layer is ordered against its content by tree order. A jsdom
 * render cannot see this: it has no layout and no paint.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const sheet = readFileSync(
  fileURLToPath(new URL('../src/client/AppFrame.module.css', import.meta.url)), 'utf8')

/** The frame's column containers, none of which may open a stacking context. */
const COLUMNS = ['.sidebarCol', '.centerCol', '.rightbarCol']

/**
 * Declarations of one flat rule, keyed by property.
 * @param css - Stylesheet text.
 * @param selector - Rule selector, matched at the start of a line.
 * @returns The rule's declarations.
 * @throws When the sheet has no such rule, which would make the check vacuous.
 */
function declarations(css: string, selector: string): Map<string, string> {
  const marker = '\n' + selector + ' {'
  const start = css.indexOf(marker)
  if (start === -1) throw new Error('missing rule: ' + selector)
  const open = css.indexOf('{', start)
  const close = css.indexOf('}', open)
  const entries: [string, string][] = []
  for (const part of css.slice(open + 1, close).split(';')) {
    const trimmed = part.trim()
    if (!trimmed.includes(':')) continue
    const colon = trimmed.indexOf(':')
    entries.push([trimmed.slice(0, colon).trim(), trimmed.slice(colon + 1).trim()])
  }
  return new Map(entries)
}

describe('shell columns carry no stacking context', () => {
  it.each(COLUMNS)('%s declares no z-index', (selector) => {
    expect(declarations(sheet, selector).has('z-index')).toBe(false)
  })

  it('reads a z-index when one is present', () => {
    const zIndexed = '\n.sidebarCol {\n  position: relative;\n  z-index: 1;\n}'
    expect(declarations(zIndexed, '.sidebarCol').get('z-index')).toBe('1')
  })
})
