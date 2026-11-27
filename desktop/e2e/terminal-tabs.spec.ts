// 기본 작업 공간과 터미널 탭 (#120) — 트리 맨 위 "기본" 은 그 호스트의 홈에서 터미널만 쓴다. 기본·★기타의 터미널에는 탭 줄이 있다.
// 실제 xterm + mock PTY(에코). mock 홈은 /home/minmo, 출력 첫 줄은 "minmo mock terminal - <cwd>"(lib/tauri.mock.ts).
// 이름 찾기는 exact — 작업 탭 "터미널" 이 터미널 탭 "터미널 1" 과 겹친다
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

import { expandWidgets, login, openTerminal, routeGitHub, routeServer } from './fixtures'

const title = (t: string) => `\x1b]0;${t}\x07`
/** n 번째로 만든 터미널(mock-pty-n)에 출력을 흘린다 */
const emit = (page: Page, n: number, data: string) => page.evaluate(([i, d]) => window.__MINMO_MOCK__!.emitPty(i as number, d as string), [n, data] as const)

const termTab = (page: Page, name: string) => page.getByRole('tab', { name: `터미널 ${name}`, exact: true })
const visiblePanes = (page: Page) => page.locator('[data-testid="terminal-pane"]:visible')

test.beforeEach(async ({ page }) => {
  await routeServer(page)
  await routeGitHub(page)
  await login(page)
})

test('AC-02 AC-03 기본을 누르면 worktree 없이 홈 폴더의 터미널 화면 — 작업 탭 줄 없이 머리줄(⌂ 기본 · 경로 · 에이전트 실행)과 탭 "1"', async ({ page }) => {
  await page.getByTestId('default-row').click()
  const header = page.getByTestId('issue-header')
  await expect(header).toContainText('기본')
  await expect(header).toContainText('/home/minmo')
  await expect(header.getByRole('button', { name: /에이전트 실행/ })).toBeVisible()
  await expect(page.getByRole('tab', { name: '변경', exact: true })).toHaveCount(0)
  await openTerminal(page)
  await expect(visiblePanes(page)).toContainText('minmo mock terminal - /home/minmo')
  await expect(termTab(page, '1')).toHaveAttribute('aria-selected', 'true')
})

test('AC-04 AC-05 AC-06 Ctrl+T·[+] 로 새 탭 — 탭마다 따로 패널, 다른 탭을 보고 와도 터미널(입력한 글자)이 그대로', async ({ page }) => {
  await page.getByTestId('default-row').click()
  await openTerminal(page)
  await expect(visiblePanes(page)).toContainText('minmo mock terminal')
  // 탭 1 에 글자를 친다 — 다시 마운트되면 옛 xterm 이 사라지고 새 배너만 남는다
  await visiblePanes(page).getByLabel('터미널 입력').focus()
  await page.keyboard.type('abc')
  await expect(visiblePanes(page)).toContainText('abc')

  // AC-04: 터미널이 떠 있을 때 Ctrl+T 는 새 탭(패널 1개)
  await page.keyboard.press('Control+t')
  await expect(termTab(page, '2')).toHaveAttribute('aria-selected', 'true')
  await expect(visiblePanes(page)).toHaveCount(1)
  // AC-05: [+] 도 같다
  await page.getByRole('button', { name: '새 터미널 탭', exact: true }).click()
  await expect(termTab(page, '3')).toHaveAttribute('aria-selected', 'true')
  await expect(visiblePanes(page)).toHaveCount(1)

  // AC-06: 탭 1 로 돌아오면 친 글자가 그대로다
  await termTab(page, '1').click()
  await expect(visiblePanes(page)).toHaveCount(1)
  await expect(visiblePanes(page)).toContainText('abc')
})

test('AC-08 탭 이름: 더블클릭 → 새 이름 + Enter, 우클릭 메뉴 [이름 바꾸기] 는 입력란에 포커스', async ({ page }) => {
  await page.getByTestId('default-row').click()
  await openTerminal(page)
  await termTab(page, '1').dblclick()
  const input = page.getByRole('textbox', { name: '탭 이름', exact: true })
  await expect(input).toBeFocused()
  await input.fill('빌드')
  await input.press('Enter')
  await expect(termTab(page, '빌드')).toBeVisible()

  await termTab(page, '빌드').click({ button: 'right' })
  await page.getByRole('menuitem', { name: /이름 바꾸기/ }).click()
  await expect(page.getByRole('textbox', { name: '탭 이름', exact: true })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(termTab(page, '빌드')).toBeVisible()
})

test('AC-10 패널 2개인 탭의 [×] 는 확인 대화상자 — [닫기] 면 그 탭을 닫는다', async ({ page }) => {
  await page.getByTestId('default-row').click()
  await openTerminal(page)
  await page.getByRole('button', { name: '새 터미널 탭', exact: true }).click()
  await termTab(page, '1').click()
  await visiblePanes(page).getByLabel('터미널 입력').focus()
  await page.keyboard.press('Control+d')
  await expect(visiblePanes(page)).toHaveCount(2)

  await termTab(page, '1').getByText('×').click()
  const dialog = page.getByRole('dialog', { name: '터미널 탭 닫기' })
  await expect(dialog).toContainText('터미널 2개를 모두 닫습니다')
  await dialog.getByRole('button', { name: '닫기', exact: true }).click()
  await expect(termTab(page, '1')).toHaveCount(0)
  await expect(termTab(page, '2')).toHaveAttribute('aria-selected', 'true')
})

test('AC-13 ★기타는 작업 탭 줄·머리줄이 그대로이고, 터미널 작업 탭 안에 터미널 탭 줄이 있다', async ({ page }) => {
  await expandWidgets(page)
  await page.getByTestId('issue-row-etc').click()
  await expect(page.getByTestId('issue-branch')).toBeVisible()
  for (const name of ['터미널', '변경', '파일', '메모']) await expect(page.getByRole('tab', { name, exact: true })).toBeVisible()
  await openTerminal(page)
  const bar = page.getByRole('tablist', { name: '터미널 탭', exact: true })
  await expect(bar).toBeVisible()
  await expect(termTab(page, '1')).toHaveAttribute('aria-selected', 'true')
})

test('AC-18 숨은 탭의 에이전트가 끝나면 알리고, 알림을 누르면 그 탭으로 간다 — 보고 있는 탭이면 알리지 않는다', async ({ page }) => {
  await page.getByTestId('default-row').click()
  // 늦게 마운트라 mock-pty 번호는 만든 순서다: 탭 1 = mock-pty-1, 탭 2 = mock-pty-2
  await openTerminal(page)
  await expect(visiblePanes(page)).toContainText('minmo mock terminal')
  await page.getByRole('button', { name: '새 터미널 탭', exact: true }).click()
  await expect(visiblePanes(page)).toContainText('minmo mock terminal')
  await page.evaluate(() => window.__MINMO_MOCK__!.setPtyProcesses(2, ['claude.exe']))

  // 대조: 그 패널의 탭(2)을 보고 있으면 끝나도 알리지 않는다
  await emit(page, 2, title('◐ 빌드'))
  await emit(page, 2, title('✳ 빌드'))
  // 숨은 탭도 마운트돼 있다 — 보이는 패널의 상태로 좁힌다
  await expect(page.locator('[data-testid="pane-agent"]:visible')).toHaveText('Claude Code · 대기 중 — 빌드')
  expect(await page.evaluate(() => window.__MINMO_MOCK__!.notifications)).toEqual([])

  // 탭 1 로 옮긴 뒤 탭 2 의 에이전트가 끝나면 알린다
  await termTab(page, '1').click()
  await emit(page, 2, title('◐ 빌드'))
  await emit(page, 2, title('✳ 빌드'))
  await expect.poll(() => page.evaluate(() => window.__MINMO_MOCK__!.notifications)).toEqual([{ title: 'Claude Code — 끝남', body: '기본' }])
  await page.evaluate(() => window.__MINMO_MOCK__!.clickNotification(1))
  await expect(termTab(page, '2')).toHaveAttribute('aria-selected', 'true')
})

test('EC-18 기본을 고른 채 다시 켜면(새로 고침) 기본 화면을 바로 다시 연다', async ({ page }) => {
  await page.getByTestId('default-row').click()
  await expect(page.getByTestId('issue-header')).toContainText('/home/minmo')
  await page.reload()
  await expect(page.getByTestId('issue-header')).toContainText('기본')
  await expect(page.getByTestId('issue-header')).toContainText('/home/minmo')
  await expect(page.getByRole('button', { name: '터미널 열기' })).toBeVisible()
})
