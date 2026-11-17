/** Scope entry and immutable Git identifiers stay usable in narrow and touch layouts. */
import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'

it('keeps multi-line scope entry bounded and readable for coarse pointers', async () => {
  const css = await readFile(new URL('../src/client/rg.module.css', import.meta.url), 'utf8')
  expect(css).toMatch(/[.]taskInput,\s*[.]scopeInput\s*[{][^}]*box-sizing: border-box;[^}]*width: 100%;[^}]*min-width: 0;/)
  expect(css).toMatch(/[.]scopeInput\s*[{][^}]*resize: vertical;/)
  expect(css).toMatch(/@media [(]pointer: coarse[)]\s*[{][^}]*[.]scopeInput\s*[{]\s*font-size: 16px;/)
  expect(css).not.toMatch(/overflow-x:\s*hidden|text-overflow:\s*ellipsis/)
})

it('aligns the task entry with the composer and preserves button and touch geometry', async () => {
  const css = await readFile(new URL('../src/client/rg.module.css', import.meta.url), 'utf8')
  expect(css).toMatch(/[.]taskEntry\s*[{][^}]*display: flex;[^}]*flex-wrap: wrap;/)
  expect(css).toContain('max-width: var(--dsh-composer-card-max-width, 100%);')
  expect(css).toContain('var(--dsh-composer-side-clearance, 12px)')
  expect(css).toMatch(/[.]taskButton\s*[{][^}]*flex: none;/)
  expect(css).toMatch(/[.]taskButton,[^}]*min-height: 36px;/)
})

it('wraps complete Git facts and validation claims without introducing literal colors', async () => {
  const css = await readFile(new URL('../src/client/rg.module.css', import.meta.url), 'utf8')
  expect(css).toMatch(/[.]fact\s*[{][^}]*flex-wrap: wrap;[^}]*overflow-wrap: anywhere;/)
  expect(css).toMatch(/[.]gitValidation\s*[{][^}]*overflow-wrap: anywhere;/)
  expect(css).toMatch(/[.]reportList\s*[{][^}]*overflow-wrap: anywhere;/)
  expect(css).toMatch(/[.]report\s*[{][^}]*white-space: pre-wrap;[^}]*overflow-wrap: anywhere;/)
  expect(css).toMatch(/[.]summaryTitle\s*[{][^}]*-webkit-line-clamp: 2;[^}]*overflow: hidden;/)
  expect(css).toMatch(/[.]dockBody\s*[{][^}]*max-height: min[(]50dvh, 28rem[)];[^}]*overflow-y: auto;/)
  expect(css).toMatch(/[.]taskForm\s*[{][^}]*min-width: 0;/)
  expect(css).toMatch(/[.]sidebar\s*[{][^}]*height: 100%;[^}]*min-height: 0;[^}]*overflow: auto;/)
  expect(css).toMatch(/[.]sidebarBody\s*[{][^}]*min-width: 0;/)
  // Child-run connectors hang off the card itself, so no wrapper element owns them.
  expect(css).toMatch(/[.]runCard\[data-child="true"\]::after\s*[{][^}]*border-inline-start: 0.5px solid var[(]--dsw-alias-border-l4[)];/)
  expect(css).toMatch(/[.]runCard\[data-child="true"\]::before\s*[{][^}]*border-top: 0.5px solid var[(]--dsw-alias-border-l4[)];/)
  expect(css).toMatch(/[.]runStatus\s*[{][^}]*align-items: center;/)
  expect(css).not.toMatch(/#[a-f\d]{3,8}\b|rgba?[(]|font-weight:\s*[6-9]00/)
})
