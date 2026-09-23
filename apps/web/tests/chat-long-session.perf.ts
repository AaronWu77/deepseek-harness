// Manual browser diagnostic for long-session rendering. This file is included only by
// vitest.web.perf.config.ts; it records measurements and does not impose a CI timing budget.
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { createChatScrollFixture } from './chat-scroll-fixture.ts'
import { launchWebScaffold, seedSession, watchConsole, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const FIXTURE_TURNS = 500
const SESSION_ID = 'chat-long-session-performance'
const FIXTURE = createChatScrollFixture({
  markerPrefix: 'PERF',
  title: 'CHAT_PERF long session',
  turns: FIXTURE_TURNS,
})

interface RenderMetrics {
  readonly label: string
  readonly elapsedMs: number
  readonly anchorNodes: number
  readonly flowNodes: number
  readonly turnNodes: number
  readonly visibleTextChars: number
  readonly paintEntries: readonly { name: string; startTime: number; duration: number }[]
}

async function nextPaint(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready
    await new Promise<void>(resolve => requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve())
    }))
  })
}

async function measure(page: Page, label: string, startedAt: number): Promise<RenderMetrics> {
  return await page.evaluate(({ label, startedAt }) => ({
    label,
    elapsedMs: performance.now() - startedAt,
    anchorNodes: document.querySelectorAll('[data-chat-anchor-key]').length,
    flowNodes: document.querySelectorAll('[data-chat-flow-key]').length,
    turnNodes: document.querySelectorAll('[data-chat-turn]').length,
    visibleTextChars: document.querySelector('[data-chat-flow]')?.textContent?.length ?? 0,
    paintEntries: performance.getEntriesByType('paint').map(entry => ({
      name: entry.name,
      startTime: entry.startTime,
      duration: entry.duration,
    })),
  }), { label, startedAt })
}

describe('manual browser performance: long Chat session', () => {
  let browser: Browser
  let page: Page
  let scaffold: WebScaffold
  let consoleTripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    await seedSession(scaffold, FIXTURE.log, SESSION_ID)
    browser = await chromium.launch()
    page = await newEnglishPage(browser, 900)
    consoleTripwire = watchConsole(page)
  }, 120_000)

  afterAll(async () => {
    await browser?.close().catch(() => {})
    await scaffold?.close().catch(() => {})
  })

  it('records initial and full-history render cost for 1000+ messages with tool steps', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-perf-chat-long-session'))
    const navigationStarted = await page.evaluate(() => performance.now())
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    const shellReady = await measure(page, 'shell-ready', navigationStarted)

    const searchButton = page.getByRole('button', { name: 'Search sessions' })
    if (await searchButton.getAttribute('aria-expanded') !== 'true') await searchButton.click()
    const search = page.getByRole('textbox', { name: 'Search sessions...', exact: true })
    await search.fill(FIXTURE.markers.user(1))
    const result = page.getByRole('tree', { name: 'Search results' }).getByRole('treeitem')
    await result.first().waitFor({ timeout: 60_000 })
    await result.first().click()
    await page.getByText(FIXTURE.markers.assistant(FIXTURE_TURNS), { exact: false }).last().waitFor({ timeout: 60_000 })
    await nextPaint(page)
    const tailReady = await measure(page, 'tail-ready', navigationStarted)

    const pages: RenderMetrics[] = [shellReady, tailReady]
    const loadEarlier = page.getByRole('button', { name: 'Load earlier', exact: true })
    const startedPaging = await page.evaluate(() => performance.now())
    let pageCount = 0
    while (await loadEarlier.isVisible().catch(() => false)) {
      pageCount += 1
      await loadEarlier.click()
      await nextPaint(page)
      pages.push(await measure(page, 'history-page-' + String(pageCount), startedPaging))
      if (pageCount >= 30) throw new Error('long-session diagnostic exceeded its 30-page safety bound')
    }

    const messageCount = (FIXTURE.log.match(new RegExp('"type":"(?:user/message|assistant/message)"', 'g')) ?? []).length
    console.log(JSON.stringify({
      fixtureTurns: FIXTURE_TURNS,
      fixtureMessageEvents: messageCount,
      fixtureChars: FIXTURE.log.length,
      toolTurns: Math.floor(FIXTURE_TURNS / 8),
      codeTurns: Math.floor(FIXTURE_TURNS / 11),
      loadedPages: pageCount,
      consoleWarnings: consoleTripwire.warnings.length,
      pageErrors: consoleTripwire.pageErrors,
      pages,
    }, null, 2))

    expect(messageCount).toBeGreaterThan(1000)
    expect(await page.getByText(FIXTURE.markers.assistant(FIXTURE_TURNS), { exact: false }).count()).toBeGreaterThan(0)
    expect(consoleTripwire.pageErrors).toEqual([])
  })
})
