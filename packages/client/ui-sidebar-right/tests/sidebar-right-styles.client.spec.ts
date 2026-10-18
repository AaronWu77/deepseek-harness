/** Sidebar-right style contracts keep the docked scrim separate from fixed floating panes. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/shell/SidebarRight.module.css', import.meta.url)), 'utf8')

function declarations(selector: string): Map<string, string> | undefined {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, ' ')
  for (const [, selectorList = '', body = ''] of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selectorList.split(',').map(value => value.trim()).includes(selector)) continue
    const found = new Map<string, string>()
    for (const part of body.split(';')) {
      const colon = part.indexOf(':')
      if (colon === -1) continue
      found.set(part.slice(0, colon).trim(), part.slice(colon + 1).trim().replace(/\s+/g, ' '))
    }
    return found
  }
  return undefined
}

describe('SidebarRight.module.css floating pane visibility', () => {
  it('keeps the panel ancestor visible while moving the collapsed scrim to a pseudo-element', () => {
    expect(declarations('.panel')?.get('background')).toBe('transparent')
    expect(declarations('.panel')?.has('opacity')).toBe(false)
    expect(declarations('.panel')?.has('visibility')).toBe(false)
    expect(declarations('.panel::before')).toBeDefined()
    expect(declarations('.panel::before')?.get('opacity')).toBe('0')
    expect(declarations('.panel[data-sidebar-right-open]::before')?.get('opacity')).toBe('1')
    expect(declarations('.panel::before')?.get('transition')).toBe('none')
  })

  it('adds a solid ground only while fullscreen is open', () => {
    expect(declarations(".panel[data-sidebar-right-panel='fullscreen'][data-sidebar-right-open]")?.get('background')).toBe('var(--dsw-alias-bg-base)')
    expect(declarations(".panel[data-sidebar-right-panel='fullscreen']")?.has('background')).toBe(false)
    expect(declarations(".panel[data-sidebar-right-panel='fullscreen']")?.get('z-index')).toBe('40')
  })

  it('continues to hide only docked hosts and dividers while collapsed', () => {
    expect(declarations(".panel :global([data-dockkit-host='dock'])")?.get('visibility')).toBe('hidden')
    expect(declarations('.panel :global([data-dockkit-empty])')?.get('visibility')).toBe('hidden')
    expect(declarations('.panel :global([data-dockkit-divider])')?.get('visibility')).toBe('hidden')
    expect(declarations(".panel[data-sidebar-right-open] :global([data-dockkit-host='dock'])")?.get('visibility')).toBe('visible')
    expect(css).not.toMatch(/\.panel\s*\{[^}]*\b(?:opacity|visibility)\s*:/s)
  })
})
