// 원격(SSH) 터미널 끊김 자동 재접속 안내(#89) — ① 다시 접속하는 중 → [지금 재접속] → ③ 다시 접속했음(3초) → ② 다시 접속하지 못함 → [재접속].
// 실제 ssh 끊김은 수동으로 확인한다. 여기서는 mock 이 Rust 처럼 pty-link 를 보낸다(window.__MINMO_MOCK__.emitPtyLink)
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

import type { PtyLink } from '../src/lib/tauri'
import { expandWidgets, login, openTerminal, routeGitHub, routeServer } from './fixtures'

test.beforeEach(async ({ page }) => {
  await routeServer(page)
  await routeGitHub(page)
  await login(page)
  // 원격 호스트(mock-server)에서 이슈를 열고 터미널을 띄운다 — 이 페이지에서 처음 만든 터미널(mock-pty-1)
  await page.getByRole('button', { name: '원격 호스트 관리' }).click()
  const dialog = page.getByRole('dialog', { name: '설정', exact: true })
  await dialog.getByTestId('ssh-host-mock-server').getByRole('button', { name: '추가' }).click()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await page.getByRole('combobox', { name: '작업 호스트' }).selectOption('mock-server')
  await expandWidgets(page)
  await page.getByTestId('issue-row-42').click()
  await openTerminal(page)
  await expect(page.getByTestId('terminal-pane')).toContainText(/mock-server:/)
})

/** 첫 터미널의 연결 상태가 바뀐 것처럼 pty-link 를 보낸다 */
const emitLink = (page: Page, link: Partial<PtyLink> & Pick<PtyLink, 'phase' | 'seq'>) =>
  page.evaluate((l) => window.__MINMO_MOCK__!.emitPtyLink(1, l), { attempt: 0, max: 5, reason: null, at: null, ...link })
const reconnects = (page: Page) => page.evaluate(() => window.__MINMO_MOCK__!.ptyReconnects)

test('끊기면 ① 안내와 [지금 재접속], 다시 접속하면 ③ 이 3초 보였다 사라지고, 5번 실패하면 ② 와 [재접속]', async ({ page }) => {
  const pane = page.getByTestId('terminal-pane')
  const status = pane.getByRole('status')
  await expect(status).toHaveText('')

  // ① 끊김 → 기다리는 중(1/5). 상태 알림 영역에 재접속 시작을 알린다
  await emitLink(page, { phase: 'waiting', attempt: 1, seq: 1 })
  await expect(pane).toContainText('연결이 끊겼습니다. 다시 접속하는 중… (1/5)')
  await expect(status).toHaveText('연결이 끊겨 다시 접속하는 중입니다')
  // 이전 출력은 그대로 남는다
  await expect(pane).toContainText('minmo mock terminal')
  await pane.getByRole('button', { name: '지금 재접속' }).click()
  await expect.poll(() => reconnects(page)).toEqual(['mock-pty-1'])

  // 시도 중에는 [지금 재접속] 을 누를 수 없다(포커스는 남는다)
  await emitLink(page, { phase: 'connecting', attempt: 1, seq: 2 })
  const now = pane.getByRole('button', { name: '지금 재접속' })
  await expect(now).toHaveAttribute('aria-disabled', 'true')
  await expect(now).toBeFocused()
  // Playwright 는 aria-disabled 버튼을 누를 수 없는 것으로 보고 기다린다 — 실제로 눌러 보려고 확인을 건너뛴다
  await now.click({ force: true })
  expect(await reconnects(page)).toEqual(['mock-pty-1'])
  await expect(now).toBeFocused()

  // ③ 다시 접속함 — 안내 줄에 3초 보였다 사라진다. 누르던 버튼이 사라지면 포커스는 터미널로 돌아간다
  await emitLink(page, { phase: 'connected', attempt: 0, seq: 3, at: '14:02' })
  const done = pane.locator('p', { hasText: '다시 접속했습니다 (14:02)' })
  await expect(done).toBeVisible()
  await expect(status).toHaveText('다시 접속했습니다 (14:02)')
  await expect(pane.getByRole('button', { name: '지금 재접속' })).toHaveCount(0)
  await expect(pane.getByLabel('터미널 입력')).toBeFocused()
  await page.waitForTimeout(1500)
  await expect(done).toBeVisible()
  await expect(done).toBeHidden({ timeout: 3000 })

  // ② 다시 끊겨 5번 모두 실패 — 터미널을 쓰던 중이었으면 [재접속] 으로 포커스
  await emitLink(page, { phase: 'waiting', attempt: 1, seq: 4 })
  await emitLink(page, { phase: 'failed', attempt: 5, seq: 5 })
  await expect(pane.getByRole('alert')).toHaveText('연결이 끊겼습니다. 다시 접속하지 못했습니다(5번)')
  const again = pane.getByRole('button', { name: '재접속', exact: true })
  await expect(again).toBeFocused()
  await again.click()
  await expect.poll(() => reconnects(page)).toEqual(['mock-pty-1', 'mock-pty-1'])
  // 종료 안내([다시 시작])는 나오지 않는다
  await expect(pane.getByRole('button', { name: '다시 시작' })).toHaveCount(0)
})
