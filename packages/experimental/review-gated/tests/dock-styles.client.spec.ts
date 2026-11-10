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

it('wraps complete Git facts and validation claims without introducing literal colors', async () => {
  const css = await readFile(new URL('../src/client/rg.module.css', import.meta.url), 'utf8')
  expect(css).toMatch(/[.]fact\s*[{][^}]*flex-wrap: wrap;[^}]*overflow-wrap: anywhere;/)
  expect(css).toMatch(/[.]gitValidation\s*[{][^}]*overflow-wrap: anywhere;/)
  expect(css).toMatch(/[.]reportList\s*[{][^}]*overflow-wrap: anywhere;/)
  expect(css).toMatch(/[.]report\s*[{][^}]*white-space: pre-wrap;[^}]*overflow-wrap: anywhere;/)
  expect(css).toMatch(/[.]summaryTitle\s*[{][^}]*-webkit-line-clamp: 2;[^}]*overflow: hidden;/)
  expect(css).toMatch(/[.]dockBody\s*[{][^}]*max-height: min[(]50dvh, 28rem[)];[^}]*overflow-y: auto;/)
  expect(css).toMatch(/[.]taskForm\s*[{][^}]*min-width: 0;/)
  expect(css).not.toMatch(/#[a-f\d]{3,8}\b|rgba?[(]|font-weight:\s*[6-9]00/)
})
