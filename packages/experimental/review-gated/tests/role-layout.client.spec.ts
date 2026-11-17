// @vitest-environment jsdom
/** RG layouts are browser-local preferences, not task or model state. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRgRoleLayout, resolveRoleLayout } from '../src/client/role-layout.ts'

const key = 'dsh.rg.role-layout'
let previous: string | null
beforeEach(() => { previous = localStorage.getItem(key); localStorage.removeItem(key) })
afterEach(() => {
  if (previous === null) localStorage.removeItem(key)
  else localStorage.setItem(key, previous)
})

describe('RG role layout preference', () => {
  it('starts with the original presentation and remembers a choice across plugin lifetimes', () => {
    const first = createRgRoleLayout()
    expect(resolveRoleLayout(first.getSnapshot())).toBe('classic')
    first.set('focus')
    expect(localStorage.getItem(key)).toBe(JSON.stringify('focus'))
    expect(resolveRoleLayout(createRgRoleLayout().getSnapshot())).toBe('focus')
  })
  it.each(['classic', 'flow', 'focus', 'trace'] as const)('restores the supported %s view', (layout) => {
    localStorage.setItem(key, JSON.stringify(layout))
    expect(resolveRoleLayout(createRgRoleLayout().getSnapshot())).toBe(layout)
  })
  it('shows the original view for an unsupported stored choice', () => {
    localStorage.setItem(key, JSON.stringify('future-layout'))
    expect(resolveRoleLayout(createRgRoleLayout().getSnapshot())).toBe('classic')
  })
})
