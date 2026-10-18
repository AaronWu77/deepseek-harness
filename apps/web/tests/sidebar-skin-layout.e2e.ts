/** Real-profile sidebar paint and viewport coverage with the optional personal skin. */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const skinPath = process.env.DSH_SKIN_PATH
const sidebarPath = process.env.DSH_SIDEBAR_PATH

async function exercise(skin: boolean, check: (page: Page, evidence: string) => Promise<void>): Promise<void> {
  if (skin && skinPath === undefined) throw new Error('DSH_SKIN_PATH is required for the personal-skin integration test')
  const packages = skinPath === undefined ? [] : [{ dir: resolve(skinPath), enabled: skin }]
  if (sidebarPath !== undefined) packages.push({ dir: resolve(sidebarPath), enabled: true })
  const scaffold = await launchWebScaffold({ profile: { hmr: false, packages } })
  let browser: Browser | undefined
  let page: Page | undefined
  try {
    const evidence = await mkdtemp(join(tmpdir(), 'dsh-sidebar-layout-'))
    browser = await chromium.launch({ headless: true })
    page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    const brand = page.locator('[data-dsh-brand="studio"]')
    await expect.poll(() => brand.count()).toBe(skin ? 1 : 0)
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    const agent = scaffold.ctx.agents.list()[0]
    if (agent === undefined) throw new Error('workspace did not create an Agent')
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Inspect the right sidebar layout.' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await scaffold.ctx.sessions.flush(agent.session)
    await page.locator('[data-sidebar-right-expand]').waitFor({ timeout: 15_000 })
    await check(page, evidence)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    console.log('Sidebar layout evidence: ' + evidence)
  } catch (error) {
    if (page !== undefined) await saveFailureShot(page, 'web-e2e-sidebar-skin-layout')
    throw error
  } finally {
    try { await browser?.close() } finally { await scaffold.close() }
  }
}

async function fullscreenPaint(page: Page): Promise<void> {
  const panel = page.locator('[data-sidebar-right-panel]')
  await expect.poll(() => panel.getAttribute('data-sidebar-right-panel')).toBe('fullscreen')
  const readPaint = () => panel.evaluate((node) => {
    const r = node.getBoundingClientRect()
    const points = [{ x: 6, y: 6 }, { x: innerWidth - 6, y: 6 }, { x: 6, y: innerHeight - 6 }, { x: innerWidth - 6, y: innerHeight - 6 }]
    // Interior samples include the underlying chat header and composer, not just empty corners.
    for (const x of [0.25, 0.5, 0.75]) {
      for (const y of [0.075, 0.5, 0.925]) points.push({ x: innerWidth * x, y: innerHeight * y })
    }
    return { x: r.x, y: r.y, w: r.width, h: r.height, vw: innerWidth, vh: innerHeight,
      backing: getComputedStyle(node).backgroundColor,
      hit: points.map(({ x, y }) => { const hit = document.elementFromPoint(x, y); return hit !== null && node.contains(hit) }) }
  })
  await expect.poll(async () => (await readPaint()).hit).toEqual(Array<boolean>(13).fill(true))
  const paint = await readPaint()
  expect(Math.abs(paint.x)).toBeLessThan(1)
  expect(Math.abs(paint.y)).toBeLessThan(1)
  expect(Math.abs(paint.w - paint.vw)).toBeLessThan(1)
  expect(Math.abs(paint.h - paint.vh)).toBeLessThan(1)
  expect(paint.hit).toEqual(Array<boolean>(13).fill(true))
  expect(paint.backing).toMatch(/^rgb\(/)
}

async function closingFrames(page: Page): Promise<void> {
  const panel = page.locator('[data-sidebar-right-panel]')
  // Sample the first closed paint, not a poll that can pass after a delayed scrim disappears.
  const frames = await panel.evaluate(async (node) => {
    const toggle = node.querySelector<HTMLButtonElement>('[data-sidebar-right-toggle]')
    if (toggle === null) throw new Error('collapse control not mounted')
    toggle.click()
    const samples: { open: boolean; opacity: number; pointer: string; backing: string }[] = []
    const end = performance.now() + 400
    do {
      await new Promise<void>((done) => { requestAnimationFrame(() => { done() }) })
      const scrim = getComputedStyle(node, '::before')
      samples.push({ open: node.hasAttribute('data-sidebar-right-open'), opacity: Number(scrim.opacity), pointer: scrim.pointerEvents,
        backing: getComputedStyle(node).backgroundColor })
    } while (performance.now() < end || samples.length < 3)
    return samples
  })
  const closed = frames.filter(frame => !frame.open)
  expect(closed.length).toBeGreaterThan(2)
  expect(closed.every(frame => frame.opacity === 0 && frame.pointer === 'none' && frame.backing === 'rgba(0, 0, 0, 0)')).toBe(true)
  await expect.poll(() => page.locator('[data-rightbar-col]').evaluate(node => node.getBoundingClientRect().width)).toBe(0)
  const offsets = await page.locator('[data-dsh-surface=frame]').evaluate((node) => {
    const shell = node.querySelector('[data-shell-window]')
    if (shell === null) throw new Error('shell window not mounted')
    return [node.scrollLeft, node.scrollTop, shell.scrollLeft, shell.scrollTop]
  })
  expect(offsets).toEqual([0, 0, 0, 0])
}

for (const skin of [false, true]) {
  const label = skin ? 'personal skin' : 'upstream appearance'
  it.skipIf(skin && skinPath === undefined)('covers viewport corners and removes the closing scrim with ' + label, async () => {
    await exercise(skin, async (page, evidence) => {
      const panel = page.locator('[data-sidebar-right-panel]')
      for (const width of [1680, 900, 390]) {
        await page.setViewportSize({ width, height: 1000 })
        for (const colorScheme of ['light', 'dark'] as const) {
          for (const reducedMotion of ['no-preference', 'reduce'] as const) {
            await page.emulateMedia({ colorScheme, reducedMotion })
            await page.locator('[data-sidebar-right-expand]').click()
            if (width >= 768) {
              await expect.poll(() => panel.getAttribute('data-sidebar-right-panel')).toBe('push')
              await closingFrames(page)
              await page.locator('[data-sidebar-right-expand]').click()
              await panel.locator('[data-sidebar-right-mode]').click()
            }
            await fullscreenPaint(page)
            if (reducedMotion === 'no-preference') {
              await page.screenshot({ path: join(evidence, 'fullscreen-' + String(width) + '-' + colorScheme + '.png') })
            }
            await closingFrames(page)
            // A narrow exit closes; a wide exit restores the ordinary panel without remounting its tab.
            await page.locator('[data-sidebar-right-expand]').click()
            await panel.locator('[data-sidebar-right-mode]').click()
            if (width >= 768) {
              await expect.poll(() => panel.getAttribute('data-sidebar-right-panel')).toBe('push')
              await closingFrames(page)
            } else {
              await page.locator('[data-sidebar-right-expand]').waitFor()
            }
          }
        }
      }
      await page.screenshot({ path: join(evidence, 'collapsed.png') })
    })
  }, 120_000)

  it.skipIf(skin && skinPath === undefined)('keeps independent floating panes visible after collapse with ' + label, async () => {
    await exercise(skin, async (page, evidence) => {
      await page.locator('[data-sidebar-right-expand]').click()
      const panel = page.locator('[data-sidebar-right-panel]')
      await panel.locator('[data-sidebar-right-guide-entry="files"]').click()
      const tab = panel.locator('[data-dockkit-tab]').first()
      const from = await tab.boundingBox()
      const surface = await page.locator('[data-dockkit-surface]').first().boundingBox()
      if (from === null || surface === null) throw new Error('dock not rendered')
      await page.mouse.move(from.x + 6, from.y + from.height / 2)
      await page.mouse.down()
      try { await page.mouse.move(surface.x - 240, surface.y + surface.height / 2, { steps: 8 }) }
      finally { await page.mouse.up() }
      const floating = page.locator('[data-dockkit-float]').first()
      await floating.waitFor({ state: 'visible' })
      const identity = await floating.elementHandle()
      if (identity === null) throw new Error('floating pane not mounted')
      const measure = () => floating.evaluate((node) => {
        const r = node.getBoundingClientRect()
        const target = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
        return { visible: getComputedStyle(node).visibility, x: r.x, y: r.y, w: r.width, h: r.height,
          hit: target !== null && node.contains(target) }
      })
      const original = await measure()
      const assertFloat = async () => {
        const hit = await measure()
        expect(hit.visible).toBe('visible')
        expect(hit.h).toBeGreaterThan(100)
        expect(hit.hit).toBe(true)
        for (const key of ['x', 'y', 'w', 'h'] as const) expect(Math.abs(hit[key] - original[key])).toBeLessThan(1)
        expect(await identity.evaluate(node => node.isConnected)).toBe(true)
      }
      await closingFrames(page)
      await assertFloat()
      await page.locator('[data-sidebar-right-expand]').click()
      await panel.locator('[data-sidebar-right-mode]').click()
      await fullscreenPaint(page)
      await assertFloat()
      await panel.locator('[data-sidebar-right-mode]').click()
      await expect.poll(() => panel.getAttribute('data-sidebar-right-panel')).toBe('push')
      await assertFloat()
      await panel.locator('[data-sidebar-right-mode]').click()
      await fullscreenPaint(page)
      await closingFrames(page)
      await assertFloat()
      await page.screenshot({ path: join(evidence, 'collapsed-with-float.png') })
    })
  }, 120_000)
}
