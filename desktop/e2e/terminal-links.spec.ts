// ssh 원격 프로그램의 링크·복사(#76) — 링크는 Ctrl+클릭으로 열고, 프로그램의 복사(OSC 52)는 클립보드에 쓴다. 실제 xterm + mock PTY
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

import { expandWidgets, login, openTerminal, routeGitHub, routeServer } from './fixtures'

test.use({ permissions: ['clipboard-read', 'clipboard-write'] })

test.beforeEach(async ({ page }) => {
  await routeServer(page)
  await routeGitHub(page)
  await login(page)
  await expandWidgets(page)
  await page.getByTestId('issue-row-42').click()
  await openTerminal(page)
  await expect(page.getByTestId('terminal-pane')).toContainText('minmo mock terminal')
  // 로그인 때 연 주소(github.com/login/device)는 빼고 본다
  await page.evaluate(() => (window.__MINMO_MOCK__!.openedUrls.length = 0))
})

/** 원격 프로그램이 터미널에 출력한 것처럼 보낸다(첫 터미널) */
const output = (page: Page, data: string) => page.evaluate((d) => window.__MINMO_MOCK__!.emitPty(1, d), data)
const sent = (page: Page) => page.evaluate(() => window.__MINMO_MOCK__!.ptyWrites)
const opened = (page: Page) => page.evaluate(() => window.__MINMO_MOCK__!.openedUrls)
const clipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText())
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')

test('프로그램의 복사(OSC 52)가 클립보드에 들어간다 · 클립보드를 읽는 요청에는 답하지 않는다', async ({ page }) => {
  await page.evaluate(() => navigator.clipboard.writeText('비밀번호'))
  await output(page, `\x1b]52;c;?\x07`)
  await output(page, `\x1b]52;c;${b64('git push origin 이슈-76')}\x07`)
  await expect.poll(() => clipboard(page)).toBe('git push origin 이슈-76')
  // 읽기 요청에 답했다면 클립보드 내용이 PTY 입력으로 갔을 것이다
  expect(await sent(page)).toEqual([])
})

test('링크는 Ctrl+클릭으로만 연다 — 일반 URL 과 OSC 8 링크', async ({ page }) => {
  const screen = page.locator('[data-testid="terminal-pane"] .xterm-screen')
  // 화면을 지우고 첫 줄에 URL, 둘째 줄에 OSC 8 링크(보이는 글자는 URL 이 아니다)를 둔다
  await output(page, '\x1b[2J\x1b[Hhttps://example.com/docs\r\n\x1b]8;;https://github.com/my-org/widgets/pull/7\x07PR-link-text\x1b]8;;\x07\r\n')
  // 한 줄 높이 — 화면 높이 / 줄 수(패널 크기에 맞춘 줄 수는 접근성 층의 줄 수로 센다)
  const box = await screen.boundingBox()
  const lineCount = await page.locator('[data-testid="terminal-pane"] .xterm-accessibility-tree > div').count()
  const lineH = box!.height / lineCount
  const row = (n: number) => ({ x: 24, y: lineH * n + lineH / 2 })

  // 그냥 클릭은 열지 않는다(선택하려는 클릭)
  await screen.hover({ position: row(0) })
  await screen.click({ position: row(0) })
  await screen.hover({ position: row(1) })
  await screen.click({ position: row(1) })
  expect(await opened(page)).toEqual([])

  await screen.hover({ position: row(0), modifiers: ['Control'] })
  await screen.click({ position: row(0), modifiers: ['Control'] })
  await expect.poll(() => opened(page)).toEqual(['https://example.com/docs'])
  await screen.hover({ position: row(1), modifiers: ['Control'] })
  await screen.click({ position: row(1), modifiers: ['Control'] })
  await expect.poll(() => opened(page)).toEqual(['https://example.com/docs', 'https://github.com/my-org/widgets/pull/7'])
  // 링크 클릭은 셸로 아무것도 보내지 않는다
  expect(await sent(page)).toEqual([])
})

test('프로그램이 마우스를 써도(마우스 모드) Ctrl+클릭으로 링크를 연다', async ({ page }) => {
  const screen = page.locator('[data-testid="terminal-pane"] .xterm-screen')
  // 마우스 보고(1000 + SGR 1006)를 켠 프로그램 — tmux(mouse on)·전체 화면 에이전트 CLI 처럼
  await output(page, '\x1b[?1000h\x1b[?1006h\x1b[2J\x1b[Hhttps://example.com/mouse\r\n')
  const box = await screen.boundingBox()
  const lineCount = await page.locator('[data-testid="terminal-pane"] .xterm-accessibility-tree > div').count()
  const pos = { x: 24, y: box!.height / lineCount / 2 }
  await screen.hover({ position: pos, modifiers: ['Control'] })
  await screen.click({ position: pos, modifiers: ['Control'] })
  await expect.poll(() => opened(page)).toEqual(['https://example.com/mouse'])
})
