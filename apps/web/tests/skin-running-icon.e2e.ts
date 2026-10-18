/** Optional personal-skin acceptance over a real profile, Loader, Session and browser. */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { expect, it } from 'vitest'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { createUserMessage, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SKIN_PATH = process.env.DSH_SKIN_PATH
const PROVIDER = 'skin-running-icon-hold'
const MODEL = 'hold'
const TITLE = 'Skin running icon acceptance'
const ICON = '[data-slot="conversation.chat.flow.running.icon"]'

/** No network or synthetic status: the real Agent stays in its model call until cancelled. */
class HeldAdapter extends LlmAdapter {
  activeCalls = 0
  override async listModels(provider: string) { return [{ provider, id: MODEL, name: 'Held activity' }] }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const signal = options.signal
    if (signal === undefined) throw new Error('running-icon acceptance requires an abortable Agent call')
    this.activeCalls += 1
    try {
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
      signal.throwIfAborted()
    } finally { this.activeCalls -= 1 }
  }
}

/** Read the actual localized duration without depending on a particular second tick. */
async function elapsedSeconds(page: Page): Promise<number> {
  const text = await page.locator('[data-chat-running] [data-shimmer]').textContent() ?? ''
  const values = [...text.matchAll(/\d+/g)].map(match => Number(match[0]))
  if (values.length === 0) throw new Error('running status has no elapsed clock: ' + text)
  return values.reduce((seconds, value) => seconds * 60 + value, 0)
}

it.skipIf(SKIN_PATH === undefined)('replaces only the running glyph through real skin unload/removal while Chat keeps its live clock', async () => {
  if (SKIN_PATH === undefined) throw new Error('set DSH_SKIN_PATH to the built isolated skin checkout')
  // Exercise explicit Loader mutations, not the independent profile-file watcher that reapplies selected bundles.
  const scaffold = await launchWebScaffold({ profile: { hmr: false, packages: [{ dir: resolve(SKIN_PATH), enabled: true }] } })
  const adapter = new HeldAdapter()
  let browser: Browser | undefined
  let page: Page | undefined
  let handle: AgentHandle | undefined
  try {
    const evidence = await mkdtemp(join(tmpdir(), 'dsh-skin-running-icon-evidence-'))
    expect(new URL(scaffold.baseUrl).port).not.toBe('3080')
    scaffold.ctx.effect(() => scaffold.ctx.llm.registerAdapter([PROVIDER], adapter))
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    handle = await scaffold.ctx.agents.create({
      sessionId: SessionId('skin-running-icon-acceptance'),
      meta: { cwd: scaffold.workspaceCwd },
      agentOptions: { provider: PROVIDER, model: MODEL },
    })
    const agent = handle.agent
    await workspace.attachSession(agent.session.id)
    await scaffold.ctx.sessionController.rename({ sessionId: agent.session.id, title: TITLE })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Hold this activity until the test cancels it.' }], source: { kind: 'user' } }))
    await expect.poll(() => ({ calls: adapter.activeCalls, status: agent.status }), { timeout: 15_000 })
      .toEqual({ calls: 1, status: 'running' })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    const activePage = page
    const tripwire = watchConsole(page)
    const failedImageRequests: string[] = []
    page.on('response', (response) => {
      const path = new URL(response.url()).pathname
      if (response.status() >= 400 && ['.png', '.svg', '.webp'].some(extension => path.endsWith(extension))) {
        failedImageRequests.push(response.url())
      }
    })
    let navigations = 0
    page.on('framenavigated', (frame) => { if (frame === activePage.mainFrame()) navigations += 1 })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    const row = page.getByRole('treeitem').filter({ has: page.getByText(TITLE, { exact: true }) })
    await row.waitFor({ timeout: 30_000 })
    await row.click()
    const running = page.locator('[data-chat-running]')
    await running.waitFor({ timeout: 20_000 })
    const seat = running.locator(ICON)
    const status = running.locator('[role="status"]')
    await status.waitFor({ state: 'attached' })
    const runningNode = await running.elementHandle()
    const statusNode = await status.elementHandle()
    if (runningNode === null || statusNode === null) throw new Error('real running status did not mount')
    const announcement = await status.textContent()
    expect(announcement?.trim().length).toBeGreaterThan(0)
    expect(await status.getAttribute('aria-live')).toBe('polite')
    expect(await status.getAttribute('aria-atomic')).toBe('true')
    const navigationBaseline = navigations
    const initialElapsed = await elapsedSeconds(page)
    await expect.poll(() => elapsedSeconds(activePage), { timeout: 5_000 }).toBeGreaterThan(initialElapsed)

    const assertContinuous = async (): Promise<void> => {
      expect(await running.count()).toBe(1)
      expect(await status.count()).toBe(1)
      expect(await runningNode.evaluate(node => node.isConnected && node === document.querySelector('[data-chat-running]'))).toBe(true)
      expect(await statusNode.evaluate(node => node.isConnected && node === document.querySelector('[data-chat-running] [role="status"]'))).toBe(true)
      expect(await status.textContent()).toBe(announcement)
      expect(await elapsedSeconds(activePage)).toBeGreaterThanOrEqual(initialElapsed)
      expect(navigations).toBe(navigationBaseline)
      expect(agent.status).toBe('running')
      expect(adapter.activeCalls).toBe(1)
    }
    const assertGlyph = async (skin: boolean): Promise<void> => {
      await expect.poll(() => seat.locator('svg[data-state="ongoing"]').count(), { timeout: 15_000 }).toBe(skin ? 1 : 0)
      expect(await seat.locator(':scope > *').count()).toBe(1)
      expect(await seat.locator('svg').count()).toBe(1)
      expect(await seat.locator('svg[viewBox="0 0 16 16"]').count()).toBe(skin ? 0 : 1)
      expect(await activePage.locator('style[data-dsh-skin-style]').count()).toBe(skin ? 1 : 0)
      expect(await activePage.locator('html').getAttribute('data-dsh-skin')).toBe(skin ? 'aaron' : null)
      await assertContinuous()
    }
    const assertOfficialPaint = async (label: string): Promise<void> => {
      const whale = seat.locator(':scope > span[aria-hidden="true"]')
      const animated = whale.locator(':scope > span')
      const resting = whale.locator(':scope > svg')
      await activePage.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'none' })
      await expect.poll(() => resting.isVisible()).toBe(true)
      expect(await animated.isVisible()).toBe(false)
      const staticPaint = await resting.locator('path').evaluate((path) => {
        const style = getComputedStyle(path)
        const stroke = style.stroke.toLowerCase() === 'currentcolor' ? style.color : style.stroke
        return { stroke, opacity: Number(style.opacity), length: (path as SVGPathElement).getTotalLength() }
      })
      expect(staticPaint.length).toBeGreaterThan(0)
      expect(staticPaint.opacity).toBeGreaterThan(0)
      expect(staticPaint.stroke).not.toBe('none')
      expect(staticPaint.stroke).not.toBe('transparent')
      expect(staticPaint.stroke).not.toBe('rgba(0, 0, 0, 0)')
      await activePage.screenshot({ path: join(evidence, label + '-official-reduced-motion.png') })
      await assertContinuous()
      await activePage.emulateMedia({ reducedMotion: 'no-preference', forcedColors: 'none' })
      await expect.poll(() => animated.isVisible()).toBe(true)
      expect(await resting.isVisible()).toBe(false)
      const mask = await animated.evaluate(async (element) => {
        const style = getComputedStyle(element)
        if (!style.maskImage.startsWith('url(')) throw new Error('official whale mask has no URL')
        const source = style.maskImage.slice(4, -1).replaceAll('"', '')
        const url = new URL(source, document.baseURI)
        if (url.protocol !== 'data:' && url.origin !== location.origin) throw new Error('official whale mask escaped its Host')
        const image = new Image()
        image.src = url.href
        try { await image.decode() } catch (error) {
          throw new Error('official whale mask cannot decode: ' + url.href, { cause: error })
        }
        return { width: image.naturalWidth, height: image.naturalHeight, mode: style.maskMode, fill: style.backgroundColor }
      })
      expect(mask).toMatchObject({ width: 28, height: 28, mode: 'alpha' })
      expect(mask.fill).not.toBe('rgba(0, 0, 0, 0)')
      const firstFrame = await whale.screenshot({ animations: 'allow' })
      await expect.poll(async () => !(await whale.screenshot({ animations: 'allow' })).equals(firstFrame), { timeout: 5_000 }).toBe(true)
      await activePage.emulateMedia({ reducedMotion: 'no-preference' })
    }
    const skinEntries = [...scaffold.ctx.loader.entries()].filter(entry => entry.options.name === 'dsh-skin')
    expect(skinEntries).toHaveLength(1)
    const entry = skinEntries[0]
    if (entry === undefined) throw new Error('profile did not install the real dsh-skin entry')
    let skinId = entry.id
    const skinOptions = { ...entry.options, disabled: false }
    const removeSkin = (): void => {
      const current = [...scaffold.ctx.loader.entries()].find(candidate => candidate.id === skinId)
      if (current === undefined) throw new Error('skin entry disappeared before Loader removal')
      // A profile bundle entry lives in a nested tree; removal takes that tree's local id.
      current.parent.tree.remove(current.options.id)
    }
    await assertGlyph(true)
    await page.screenshot({ path: join(evidence, 'skin-enabled.png') })
    // update is the public Loader entry-patch API; no browser-side registry shortcut.
    for (let cycle = 0; cycle < 3; cycle += 1) {
      await scaffold.ctx.loader.update(skinId, { disabled: true })
      await scaffold.ctx.loader.await()
      await assertGlyph(false)
      if (cycle === 0) {
        await assertOfficialPaint('skin-disabled')
        await page.screenshot({ path: join(evidence, 'skin-disabled-official.png') })
      }
      await scaffold.ctx.loader.update(skinId, { disabled: false })
      await scaffold.ctx.loader.await()
      await assertGlyph(true)
    }
    removeSkin()
    await scaffold.ctx.loader.await()
    expect([...scaffold.ctx.loader.entries()].filter(candidate => candidate.options.name === 'dsh-skin')).toHaveLength(0)
    await assertGlyph(false)
    // Restore the same profile-owned entry identity, not a second root entry alongside its selected bundle.
    skinId = await entry.parent.tree.create(skinOptions)
    expect(scaffold.ctx.loader.resolve(skinId).disabled).toBe(false)
    await scaffold.ctx.loader.await()
    await assertGlyph(true)

    for (const preference of ['light', 'dark'] as const) {
      await scaffold.ctx.settings.update('ui-theme', { preference })
      await expect.poll(() => activePage.locator('body').getAttribute('data-ds-dark-theme')).toBe(preference === 'dark' ? '' : null)
      for (const fontSize of [10, 14, 22]) {
        await scaffold.ctx.settings.update('ui-theme', { fontSize })
        await expect.poll(() => activePage.evaluate(() => document.body.style.getPropertyValue('--dsh-content-font-size')))
          .toBe(String(fontSize) + 'px')
        const glyph = seat.locator('svg[data-state="ongoing"]')
        const paint = await glyph.evaluate((element) => {
          const bounds = element.getBoundingClientRect()
          const parent = element.parentElement?.parentElement
          if (parent === null || parent === undefined) throw new Error('glyph lost its owner')
          return {
            width: bounds.width, height: bounds.height,
            color: getComputedStyle(element).color, ownerColor: getComputedStyle(parent).color,
          }
        })
        expect(paint.width).toBe(fontSize)
        expect(paint.height).toBe(fontSize)
        expect(paint.color).toBe(paint.ownerColor)
        expect(paint.color).not.toBe('rgba(0, 0, 0, 0)')
        await assertContinuous()
      }
      for (const reducedMotion of ['no-preference', 'reduce'] as const) {
        await page.emulateMedia({ reducedMotion, forcedColors: 'none' })
        await expect.poll(() => seat.locator('svg[data-state="ongoing"]').evaluate(element => element.getAnimations({ subtree: true }).length))
          .toBe(reducedMotion === 'reduce' ? 0 : 2)
        await assertGlyph(true)
        if (reducedMotion === 'reduce') await page.screenshot({ path: join(evidence, 'skin-' + preference + '-reduced-motion.png') })
      }
    }
    const beforeRemoval = await elapsedSeconds(page)
    removeSkin()
    await scaffold.ctx.loader.await()
    expect([...scaffold.ctx.loader.entries()].filter(candidate => candidate.options.name === 'dsh-skin')).toHaveLength(0)
    await assertGlyph(false)
    await expect.poll(() => elapsedSeconds(activePage), { timeout: 5_000 }).toBeGreaterThan(beforeRemoval)
    await assertOfficialPaint('skin-removed')
    await page.screenshot({ path: join(evidence, 'skin-removed-official.png') })
    expect(failedImageRequests).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    console.log('Skin running-icon real-browser evidence: ' + evidence + ' (isolated ' + scaffold.baseUrl + ')')
    await runningNode.dispose()
    await statusNode.dispose()
  } catch (error) {
    if (page !== undefined) await saveFailureShot(page, 'web-e2e-skin-running-icon')
    throw error
  } finally {
    const failures: unknown[] = []
    if (handle !== undefined) {
      handle.agent.cancel({ kind: 'user' })
      await handle.agent.whenIdle().catch((error: unknown) => failures.push(error))
      if (adapter.activeCalls !== 0) failures.push(new Error('held adapter remained active after Agent cancellation'))
    }
    await browser?.close().catch((error: unknown) => failures.push(error))
    await handle?.dispose().catch((error: unknown) => failures.push(error))
    await scaffold.close().catch((error: unknown) => failures.push(error))
    if (failures.length > 0) throw new AggregateError(failures, 'skin running-icon acceptance teardown failed')
  }
}, 180_000)
