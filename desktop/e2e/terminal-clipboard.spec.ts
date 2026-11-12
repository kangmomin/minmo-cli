// 터미널 복사·붙여넣기 — Ctrl+V 붙여넣기, 선택 후 Ctrl+C 복사(Windows Terminal 방식). 실제 xterm + mock PTY(에코)
import { expect, test } from '@playwright/test'

import { expandWidgets, login, routeGitHub, routeServer } from './fixtures'

test.use({ permissions: ['clipboard-read', 'clipboard-write'] })

test.beforeEach(async ({ page }) => {
  await routeServer(page)
  await routeGitHub(page)
  await login(page)
  await expandWidgets(page)
  await page.getByTestId('issue-row-42').click()
  await expect(page.getByTestId('terminal-pane')).toContainText('minmo mock terminal')
})

test('Ctrl+V · Ctrl+Shift+V 로 클립보드 내용을 붙여 넣는다', async ({ page }) => {
  const sent = await page.evaluateHandle(() => {
    const log: string[] = []
    // mock PTY 로 간 입력을 기록한다(터미널 화면에는 에코된다)
    const input = document.querySelector<HTMLTextAreaElement>('[data-testid="terminal-pane"] textarea')
    input?.addEventListener('paste', (e) => log.push(`paste:${e.clipboardData?.getData('text') ?? ''}`))
    return log
  })
  await page.evaluate(() => navigator.clipboard.writeText('echo pasted-by-ctrl-v'))
  await page.getByLabel('터미널 입력').focus()
  await page.keyboard.press('Control+V')
  await expect(page.getByTestId('terminal-pane')).toContainText('echo pasted-by-ctrl-v')
  expect(await sent.jsonValue()).toEqual(['paste:echo pasted-by-ctrl-v'])

  await page.evaluate(() => navigator.clipboard.writeText('second-paste'))
  await page.keyboard.press('Control+Shift+V')
  await expect(page.getByTestId('terminal-pane')).toContainText('second-paste')
})

test('글자를 선택하고 Ctrl+C 를 누르면 복사된다 · 선택이 없으면 복사하지 않는다(셸로 전달)', async ({ page }) => {
  await page.evaluate(() => navigator.clipboard.writeText('before'))
  await page.getByLabel('터미널 입력').focus()
  // 선택 없음: 클립보드는 그대로
  await page.keyboard.press('Control+C')
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('before')

  // 첫 줄의 첫 낱말("minmo")을 두 번 눌러 선택한다
  const screen = page.locator('[data-testid="terminal-pane"] .xterm-screen')
  await screen.dblclick({ position: { x: 16, y: 8 } })
  await page.keyboard.press('Control+C')
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('minmo')
  // 복사한 뒤에는 선택이 풀려, 다음 Ctrl+C 는 다시 셸로 간다(클립보드는 그대로)
  await page.evaluate(() => navigator.clipboard.writeText('after'))
  await page.keyboard.press('Control+C')
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('after')
})
