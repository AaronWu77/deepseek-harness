/** The installed RG bundle renders its recorded task and localized preset in the real Web composition. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { openSettings, saveFailureShot, ZH_BROWSER_LOCALE } from './support.ts'

const PATCH = fileURLToPath(new URL('../../../packages/experimental/review-gated/cordis.patch.yml', import.meta.url))
const ANCHOR = fileURLToPath(new URL('../../../packages/experimental/review-gated/package.json', import.meta.url))
const RECORDING = fileURLToPath(new URL('../../../snapshots/session/review-gated/session.v4.jsonl', import.meta.url))
const BUDGET_RECORDING = fileURLToPath(new URL('../../../snapshots/session/review-gated-review-budget/session.v4.jsonl', import.meta.url))
const EXPECTED = fileURLToPath(new URL('./expected/review-gated-sidebar', import.meta.url))
const MODE = webSnapshotMode()
const SESSION = 'review-gated-sidebar-web-e2e'

async function waitForSidebarVisible(page: Page): Promise<void> {
  const panel = page.locator('[data-sidebar-right-panel][data-sidebar-right-open]').first()
  await expect.poll(() => panel.evaluate((element) => {
    const body = element.querySelector('[data-rg-status]')
    if (body === null) return false
    const bounds = body.getBoundingClientRect()
    const x = Math.min(window.innerWidth - 2, Math.max(2, bounds.left + bounds.width / 2))
    const y = Math.min(window.innerHeight - 2, Math.max(2, bounds.top + 12))
    const hit = document.elementFromPoint(x, y)
    return bounds.width >= Math.min(300, window.innerWidth - 24) && bounds.left >= 0 && bounds.right <= window.innerWidth + 1
      && hit !== null && element.contains(hit)
      && !document.getAnimations().some(animation => animation instanceof CSSTransition && animation.playState === 'running')
  }), { timeout: 10_000 }).toBe(true)
}

describe.skipIf(MODE === 'record')('web e2e: RG sidebar and preset', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ extraOverlayPath: PATCH, extraInstallAnchors: [ANCHOR] })
    const raw = (await readFile(RECORDING, 'utf8'))
      .replaceAll('{{rg-task:1}}', 'rg-task-1').replaceAll('{{rg-run:1}}', 'rg-worker-1').replaceAll('{{rg-run:2}}', 'rg-review-1')
    await seedSession(scaffold, raw, SESSION, 'rg')
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1280, height: 800 }, locale: ZH_BROWSER_LOCALE, timezoneId: 'Asia/Shanghai' })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    try { await browser?.close() } finally { await scaffold?.close() }
  })

  it('shows the RG preset description in Chinese', async () => {
    onTestFailed(() => saveFailureShot(page, 'review-gated-preset'))
    await openSettings(page, 'zh')
    const settings = page.getByRole('dialog', { name: '设置' })
    const glyph = settings.getByRole('button', { name: 'RG 模型', exact: true }).locator('svg')
    expect(await glyph.getAttribute('data-icon')).toBe('dsw-icon-branch-outline-medium')
    expect(await glyph.getAttribute('width')).toBe('16')
    expect(await glyph.getAttribute('aria-hidden')).toBe('true')
    await settings.getByRole('button', { name: 'Agent 预设' }).click()
    const card = settings.locator('[data-agent-preset-id="rg"]')
    await card.getByText('在同一会话中处理任务，按需委派执行者，并由独立审查者检查结果。', { exact: true }).waitFor()
    await compareOrRefreshGolden(join(EXPECTED, 'preset.expected.md'), await captureStableAria(page, '[data-agent-preset-id="rg"]', scaffold.workspaceCwd), MODE)
    await settings.getByRole('button', { name: '关闭', exact: true }).last().click()
  })

  it('shows the recorded roles and report in a scrollable narrow sidebar', async () => {
    onTestFailed(() => saveFailureShot(page, 'review-gated-sidebar'))
    const group = page.locator('[role="treeitem"]').first()
    await group.waitFor({ timeout: 15_000 })
    await group.click()
    await page.locator('[role="treeitem"]').nth(1).click()
    await page.getByText('PARENT_DONE WORKER_OK REVIEW_OK', { exact: true }).waitFor({ timeout: 15_000 })
    const entry = page.locator('[data-rg-entry]')
    const taskButton = entry.getByRole('button', { name: '打开 RG 任务视图' })
    await taskButton.waitFor()
    expect(await taskButton.textContent()).toBe('RG 任务')
    expect(await entry.locator('details').count()).toBe(0)
    expect(await entry.getByText('保存中…', { exact: true }).count()).toBe(0)
    expect(await entry.getByText('等待确认的输入', { exact: true }).count()).toBe(0)
    await compareOrRefreshGolden(join(EXPECTED, 'entry.expected.md'), await captureStableAria(page, '[data-rg-entry]', scaffold.workspaceCwd), MODE)
    try {
      for (const colorScheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme })
        const buttonStyle = await taskButton.evaluate(button => ({
          width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height,
          stroke: getComputedStyle(button).boxShadow,
        }))
        expect(buttonStyle.width).toBeLessThan(180)
        expect(buttonStyle.height).toBeGreaterThanOrEqual(28)
        expect(buttonStyle.stroke).not.toBe('none')
        if (MODE === 'refresh') {
          const path = fileURLToPath(new URL(`../../../.artifacts/rg-entry-${process.pid}-${colorScheme}.png`, import.meta.url))
          await page.screenshot({ path, animations: 'disabled' })
          console.log(`RG entry screenshot: ${path}`)
        }
      }
    } finally { await page.emulateMedia({ colorScheme: null }) }
    await taskButton.focus()
    await page.keyboard.press('Enter')
    const status = page.locator('[data-rg-status]')
    await status.getByText('REVIEW_OK', { exact: true }).waitFor({ timeout: 15_000 })
    expect(await status.locator('article').count()).toBe(3)
    for (const text of ['主代理', '执行者', '审查者', 'REVIEW_OK']) {
      expect(await status.getByText(text, { exact: false }).count()).toBeGreaterThan(0)
    }
    const worker = status.locator('article').filter({ has: page.getByRole('heading', { name: /执行者/ }) })
    const workerDetails = worker.getByRole('button', { name: '尝试详情', exact: true })
    expect(await workerDetails.getAttribute('aria-expanded')).toBe('false')
    await workerDetails.click()
    expect(await workerDetails.getAttribute('aria-expanded')).toBe('true')
    expect(await worker.getByRole('region', { name: '尝试详情' }).getByText('运行 ID: rg-worker-1').isVisible()).toBe(true)
    await workerDetails.click()
    const taskDetails = status.getByRole('button', { name: '任务详情', exact: true })
    expect(await taskDetails.getAttribute('aria-expanded')).toBe('false')
    await taskDetails.focus()
    await page.keyboard.press('Enter')
    expect(await status.getByRole('region', { name: '任务详情' }).getByText('配置', { exact: true }).isVisible()).toBe(true)
    await taskDetails.click()
    expect(await status.locator('summary').count()).toBe(0)
    const switchTask = status.getByRole('button', { name: '切换到新任务', exact: true })
    expect(await switchTask.evaluate(button => getComputedStyle(button).boxShadow)).not.toBe('none')
    expect(await switchTask.getAttribute('aria-expanded')).toBe('false')
    await switchTask.click()
    expect(await switchTask.getAttribute('aria-expanded')).toBe('true')
    const confirm = status.getByRole('button', { name: '确认切换', exact: true })
    expect(await confirm.isDisabled()).toBe(true)
    await status.getByRole('textbox', { name: '新任务目标' }).fill('另一项独立任务')
    expect(await confirm.isEnabled()).toBe(true)
    await status.getByRole('button', { name: '取消', exact: true }).click()
    expect(await switchTask.getAttribute('aria-expanded')).toBe('false')
    expect(await status.getByRole('textbox', { name: '新任务目标' }).count()).toBe(0)
    await waitForSidebarVisible(page)
    await compareOrRefreshGolden(join(EXPECTED, 'sidebar.expected.md'), await captureStableAria(page, '[data-rg-status]', scaffold.workspaceCwd), MODE)
    try {
      for (const colorScheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme })
        expect(await taskDetails.evaluate(button => getComputedStyle(button).boxShadow)).not.toBe('none')
        if (MODE === 'refresh') {
          const path = fileURLToPath(new URL(`../../../.artifacts/rg-task-buttons-${process.pid}-${colorScheme}.png`, import.meta.url))
          await switchTask.scrollIntoViewIfNeeded()
          await page.screenshot({ path, animations: 'disabled' })
          console.log(`RG task buttons screenshot: ${path}`)
        }
      }
    } finally { await page.emulateMedia({ colorScheme: null }) }
    await page.setViewportSize({ width: 390, height: 600 })
    await waitForSidebarVisible(page)
    const scrollport = page.locator('[data-rg-sidebar]')
    await expect.poll(() => scrollport.evaluate(el => el.scrollHeight > el.clientHeight && getComputedStyle(el).overflowY === 'auto')).toBe(true)
    const report = status.getByText('REVIEW_OK', { exact: true })
    await report.scrollIntoViewIfNeeded()
    expect(await report.isVisible()).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    expect(tripwire.pageErrors).toEqual([])
  })

  it('switches between role views and remembers the browser-local choice after reload', async () => {
    onTestFailed(() => saveFailureShot(page, 'review-gated-layouts'))
    await page.setViewportSize({ width: 1280, height: 900 })
    await openSettings(page, 'zh')
    await page.keyboard.press('Escape')
    const group = page.getByRole('treeitem').first()
    await group.waitFor()
    if (await group.getAttribute('aria-expanded') !== 'true') await group.click()
    await page.getByRole('treeitem').nth(1).click()
    await page.getByText('PARENT_DONE WORKER_OK REVIEW_OK', { exact: true }).waitFor()
    await page.locator('[data-rg-entry]').getByRole('button', { name: '打开 RG 任务视图' }).click()
    await waitForSidebarVisible(page)
    const sidebar = page.locator('[data-rg-sidebar]')
    const facts = await sidebar.locator('dl').first().textContent()
    const layouts = [['classic', '原版'], ['flow', '流程'], ['focus', '焦点'], ['trace', '轨迹']] as const
    try {
      for (const [layout, label] of layouts) {
        const tab = sidebar.getByRole('tab', { name: label, exact: true })
        await tab.click()
        await expect.poll(() => tab.getAttribute('aria-selected')).toBe('true')
        expect(await sidebar.getAttribute('data-rg-layout')).toBe(layout)
        expect(await sidebar.locator('dl').first().textContent()).toBe(facts)
        expect(await sidebar.getByText('REVIEW_OK', { exact: true }).isVisible()).toBe(true)
        await compareOrRefreshGolden(join(EXPECTED, 'layout-' + layout + '.expected.md'),
          await captureStableAria(page, '[data-rg-sidebar]', scaffold.workspaceCwd), MODE)
        for (const colorScheme of ['light', 'dark'] as const) {
          await page.emulateMedia({ colorScheme })
          await sidebar.evaluate((element) => { element.scrollTop = 0 })
          const path = fileURLToPath(new URL('../../../.artifacts/rg-view-' + layout + '-' + colorScheme + '.png', import.meta.url))
          await sidebar.screenshot({ path, animations: 'disabled' })
        }
      }
      await page.reload({ waitUntil: 'load' })
      await sidebar.getByRole('tab', { name: '轨迹', exact: true }).waitFor()
      expect(await sidebar.getByRole('tab', { name: '轨迹', exact: true }).getAttribute('aria-selected')).toBe('true')
      expect(await sidebar.getAttribute('data-rg-layout')).toBe('trace')
      await page.setViewportSize({ width: 390, height: 600 })
      await sidebar.getByRole('tab', { name: '原版', exact: true }).focus()
      await page.keyboard.press('Home')
      await expect.poll(() => sidebar.getByRole('tab', { name: '原版', exact: true }).getAttribute('aria-selected')).toBe('true')
      await page.keyboard.press('ArrowRight')
      await expect.poll(() => sidebar.getByRole('tab', { name: '流程', exact: true }).getAttribute('aria-selected')).toBe('true')
      expect(await sidebar.getAttribute('data-rg-layout')).toBe('flow')
      const picker = sidebar.getByRole('tablist', { name: '角色视图' })
      expect(await picker.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await sidebar.getByRole('tab', { name: '焦点', exact: true }).click()
      expect(await sidebar.getAttribute('data-rg-layout')).toBe('focus')
      await sidebar.getByRole('tab', { name: '原版', exact: true }).click()
    } finally { await page.emulateMedia({ colorScheme: null, reducedMotion: 'no-preference' }) }
    expect(tripwire.pageErrors).toEqual([])
  })

  it('keeps unconfirmed input compact and opens recovery details only through a button', async () => {
    onTestFailed(() => saveFailureShot(page, 'review-gated-recovery'))
    const lines = (await readFile(RECORDING, 'utf8')).trimEnd().split('\n')
    const intent = lines.findIndex(line => line.startsWith('{"type":"agent/claim/intent"'))
    const end = lines.find(line => line.startsWith('{"type":"turn/end"'))
    if (intent < 0 || end === undefined) throw new Error('RG recording needs a claim intent and a closed turn')
    // A retained input without a settled claim remains uncertain on cold reads.
    await seedSession(scaffold, `${lines.slice(0, intent + 1).join('\n')}\n${end}\n`, 'rg-recovery-web-e2e', 'rg', { createdAt: Date.now() })
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.reload({ waitUntil: 'load' })
    await expect.poll(() => page.getByRole('treeitem').count()).toBeGreaterThanOrEqual(3)
    await page.getByRole('treeitem').nth(1).click()
    await page.getByRole('button', { name: '打开 RG 任务视图' }).click()
    const notice = page.locator('[data-rg-status]')
    await notice.getByText('这条消息的处理结果尚未确认', { exact: true }).waitFor()
    await waitForSidebarVisible(page)
    const inspect = notice.getByRole('button', { name: '查看输入', exact: true })
    expect(await inspect.getAttribute('aria-expanded')).toBe('false')
    expect(await notice.getByRole('region', { name: '原始消息' }).count()).toBe(0)
    expect(await notice.getByText('等待确认的输入', { exact: true }).count()).toBe(0)
    expect(await notice.getByText('保存中…', { exact: true }).count()).toBe(0)
    expect(await notice.getByRole('button', { name: '切换到新任务' }).count()).toBe(0)
    await compareOrRefreshGolden(join(EXPECTED, 'recovery.expected.md'), await captureStableAria(page, '[data-rg-status]', scaffold.workspaceCwd), MODE)
    await inspect.focus()
    await page.keyboard.press('Enter')
    const input = notice.getByRole('region', { name: '原始消息' })
    expect(await input.isVisible()).toBe(true)
    expect(await input.textContent()).toContain('Use rg_worker, then rg_reviewer')
    await compareOrRefreshGolden(join(EXPECTED, 'recovery-details.expected.md'), await captureStableAria(page, '[data-rg-status]', scaffold.workspaceCwd), MODE)
    await notice.getByRole('button', { name: '收起输入', exact: true }).click()
    expect(await input.count()).toBe(0)
    try {
      for (const colorScheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme })
        if (MODE === 'refresh') {
          const path = fileURLToPath(new URL(`../../../.artifacts/rg-recovery-${process.pid}-${colorScheme}.png`, import.meta.url))
          await page.screenshot({ path, animations: 'disabled' })
          console.log(`RG recovery screenshot: ${path}`)
        }
      }
    } finally { await page.emulateMedia({ colorScheme: null }) }
    await page.setViewportSize({ width: 390, height: 600 })
    await waitForSidebarVisible(page)
    await notice.getByRole('button', { name: '查看输入', exact: true }).click()
    expect(await input.isVisible()).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    expect(tripwire.pageErrors).toEqual([])
  })

  it('shows exhausted review capacity separately from missing acceptance evidence', async () => {
    onTestFailed(() => saveFailureShot(page, 'review-gated-budget'))
    const raw = (await readFile(BUDGET_RECORDING, 'utf8'))
      .replaceAll('{{rg-task:1}}', 'rg-budget-task').replaceAll('{{rg-run:1}}', 'rg-budget-review-1').replaceAll('{{rg-run:2}}', 'rg-budget-review-2')
    await seedSession(scaffold, raw, 'rg-budget-web-e2e', 'rg', { createdAt: Date.now() })
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.reload({ waitUntil: 'load' })
    await expect.poll(() => page.getByRole('treeitem').count()).toBeGreaterThanOrEqual(4)
    await page.getByRole('treeitem').nth(1).click()
    const entry = page.locator('[data-rg-entry]')
    await entry.getByText('审查次数已用完，需要你决定下一步', { exact: true }).waitFor()
    await entry.getByRole('button', { name: '打开 RG 任务视图' }).click()
    await waitForSidebarVisible(page)
    const status = page.locator('[data-rg-status]')
    expect(await status.getByText('本次因证据不足未能给出结论，未报告具体缺陷。这不代表通过，请查看未验证部分。', { exact: true }).isVisible()).toBe(true)
    expect(await status.getByText('Authenticated live-page acceptance is unavailable', { exact: true }).isVisible()).toBe(true)
    expect(await status.getByRole('status').textContent()).toContain('审查次数已用完')
    await compareOrRefreshGolden(join(EXPECTED, 'budget.expected.md'), await captureStableAria(page, '[data-rg-status]', scaffold.workspaceCwd), MODE)
    await page.setViewportSize({ width: 390, height: 600 })
    await waitForSidebarVisible(page)
    await status.getByRole('status').scrollIntoViewIfNeeded()
    expect(await status.getByRole('status').isVisible()).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    expect(tripwire.pageErrors).toEqual([])
  })
})
