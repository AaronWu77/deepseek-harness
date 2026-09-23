/** Footer contribution geometry against the emitted sidebar CSS; requires the Web build. */
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'

it('stacks footer contributions above settings in expanded and collapsed sidebars', async () => {
  const bundle = await readFile(new URL('../../../packages/client/ui-sidebar/lib/client.js', import.meta.url), 'utf8')
  const cssLiteral = bundle.match(/const css = ("(?:[^"\\]|\\.)*");/)
  if (!cssLiteral) throw new Error('Emitted sidebar CSS was not found; rebuild ui-sidebar')
  const css = JSON.parse(cssLiteral[1]!) as string
  const className = (name: string): string => {
    const match = bundle.match(new RegExp('"' + name + '": "([^"]+)"'))
    if (!match) throw new Error('Missing emitted sidebar class: ' + name)
    return match[1]!
  }
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    for (const collapsed of [false, true]) {
      await page.setContent('<style>' + css + '</style><div style="width:' + (collapsed ? 56 : 300) + 'px;height:600px"><div class="' + className('root') + (collapsed ? ' ' + className('collapsed') : '') + '"><div style="flex:1"></div><div class="' + className('footArea') + '"><div class="' + className('footerActions') + '"><button id="planner" style="box-sizing:border-box;width:' + (collapsed ? '36px' : '100%') + ';height:40px;flex-shrink:1">Plan</button><div id="quota" style="box-sizing:border-box;min-width:0;width:' + (collapsed ? '36px' : '100%') + ';height:' + (collapsed ? 36 : 160) + 'px">Quota</div></div><div class="' + className('settingsArea') + '"><button id="settings" style="height:36px">Settings</button></div></div></div></div>')
      const metrics = await page.evaluate(() => {
        const planner = document.getElementById('planner')!.getBoundingClientRect()
        const quota = document.getElementById('quota')!.getBoundingClientRect()
        const settings = document.getElementById('settings')!.getBoundingClientRect()
        return {
          plannerAboveQuota: planner.bottom <= quota.top,
          quotaAboveSettings: quota.bottom <= settings.top,
          sameLeft: planner.left === quota.left,
          plannerWidth: planner.width,
          quotaWidth: quota.width,
        }
      })
      expect({ mode: collapsed ? 'collapsed' : 'expanded', ...metrics }).toMatchSnapshot()
      const negative = await page.addStyleTag({ content: '.' + className('footerActions') + '{flex-direction:row}' })
      expect(await page.evaluate(() => document.getElementById('planner')!.getBoundingClientRect().bottom <= document.getElementById('quota')!.getBoundingClientRect().top)).toBe(false)
      await negative.evaluate(node => node.remove())
    }
  } finally {
    await browser.close()
  }
})
