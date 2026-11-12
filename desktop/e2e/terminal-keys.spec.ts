// 터미널 복사·붙여넣기 — Ctrl+V 붙여넣기, 선택 후 Ctrl+C 복사(Windows Terminal 방식). 실제 xterm + mock PTY(에코)
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

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

/** 터미널(PTY)로 간 입력 전체 */
const sent = (page: Page) => page.evaluate(() => window.__MINMO_MOCK__!.ptyWrites)
const clipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText())

test('Ctrl+V · Ctrl+Shift+V 로 클립보드 내용을 한 번만 붙여 넣는다(^V 는 보내지 않는다)', async ({ page }) => {
  await page.evaluate(() => navigator.clipboard.writeText('echo pasted-by-ctrl-v'))
  await page.getByLabel('터미널 입력').focus()
  await page.keyboard.press('Control+V')
  await expect(page.getByTestId('terminal-pane')).toContainText('echo pasted-by-ctrl-v')
  expect(await sent(page)).toEqual(['echo pasted-by-ctrl-v'])

  await page.evaluate(() => navigator.clipboard.writeText('second-paste'))
  await page.keyboard.press('Control+Shift+V')
  await expect(page.getByTestId('terminal-pane')).toContainText('second-paste')
  expect(await sent(page)).toEqual(['echo pasted-by-ctrl-v', 'second-paste'])
})

test('글자를 선택하고 Ctrl+C 를 누르면 복사된다 · 선택이 없으면 셸로 중단 신호를 보낸다', async ({ page }) => {
  await page.evaluate(() => navigator.clipboard.writeText('before'))
  await page.getByLabel('터미널 입력').focus()
  // 선택 없음: 중단 신호(^C)가 셸로 가고 클립보드는 그대로
  await page.keyboard.press('Control+C')
  await expect.poll(() => sent(page)).toEqual(['\x03'])
  expect(await clipboard(page)).toBe('before')

  // 첫 줄의 첫 낱말("minmo")을 두 번 눌러 선택한다 → 복사만 하고 셸로는 보내지 않는다
  await page.locator('[data-testid="terminal-pane"] .xterm-screen').dblclick({ position: { x: 16, y: 8 } })
  await page.keyboard.press('Control+C')
  await expect.poll(() => clipboard(page)).toBe('minmo')
  expect(await sent(page)).toEqual(['\x03'])
  // 복사한 뒤에는 선택이 풀려, 다음 Ctrl+C 는 다시 셸로 간다
  await page.keyboard.press('Control+C')
  await expect.poll(() => sent(page)).toEqual(['\x03', '\x03'])
  expect(await clipboard(page)).toBe('minmo')
})

test('Ctrl + / Ctrl - / Ctrl 0 으로 터미널과 파일 편집기의 글자 크기를 바꾼다 — 다시 열어도 유지', async ({ page }) => {
  const termSize = () => page.locator('[data-testid="terminal-pane"] .xterm-rows').evaluate((el) => getComputedStyle(el).fontSize)
  expect(await termSize()).toBe('13px')
  await page.getByLabel('터미널 입력').focus()
  await page.keyboard.press('Control+=')
  await page.keyboard.press('Control+=')
  await expect.poll(termSize).toBe('15px')
  // 셸로는 아무것도 보내지 않는다
  expect(await sent(page)).toEqual([])

  // 파일 편집기에도 같은 크기
  await page.getByRole('tab', { name: '파일' }).click()
  await page.getByText('README.md').click()
  const editorSize = () => page.locator('[data-testid="code-editor"] .cm-editor').evaluate((el) => getComputedStyle(el).fontSize)
  await expect.poll(editorSize).toBe('15px')
  // 편집기에 포커스가 있을 때도 동작하고, 편집 내용은 그대로다
  await page.locator('[data-testid="code-editor"] .cm-content').click()
  await page.keyboard.type('X')
  await page.keyboard.press('Control+-')
  await expect.poll(editorSize).toBe('14px')
  await expect(page.locator('[data-testid="code-editor"] .cm-content')).toContainText('X')

  await page.reload()
  await page.getByTestId('issue-row-42').click()
  await page.getByRole('tab', { name: '터미널' }).click()
  await expect(page.getByTestId('terminal-pane')).toContainText('minmo mock terminal')
  await expect.poll(termSize).toBe('14px')
  await page.getByLabel('터미널 입력').focus()
  await page.keyboard.press('Control+0')
  await expect.poll(termSize).toBe('13px')
})
