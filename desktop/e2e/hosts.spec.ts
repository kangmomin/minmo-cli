// 원격 호스트(SSH 프로필) — 호스트 추가·전환, 원격에서 이슈 열기(mock ssh), 호스트별 ● 표시
import { expect, test } from '@playwright/test'

import { expandWidgets, login, routeGitHub, routeServer } from './fixtures'

test.beforeEach(async ({ page }) => {
  await routeServer(page)
  await routeGitHub(page)
  await login(page)
})

test('호스트를 추가해 전환하고 원격에서 이슈를 연다 — worktree 표시는 호스트마다 따로', async ({ page }) => {
  await page.getByRole('button', { name: '원격 호스트 관리' }).click()
  const row = page.getByTestId('ssh-host-mock-server')
  await expect(row).toContainText('dev@10.0.0.5')
  await row.getByRole('button', { name: '연결 확인' }).click()
  await expect(row.getByRole('status')).toHaveText('연결됨 — Linux · git 2.43.0 · tmux 있음')
  await row.getByRole('button', { name: '추가' }).click()
  await page.keyboard.press('Escape')

  await page.getByRole('combobox', { name: '작업 호스트' }).selectOption('mock-server')
  await expandWidgets(page)
  await page.getByTestId('issue-row-42').click()
  await expect(page.getByTestId('issue-host')).toHaveText('mock-server')
  await expect(page.getByTestId('issue-branch')).toHaveText('feat/42')
  await expect(page.getByTestId('issue-row-42').getByLabel('worktree 있음')).toBeVisible()
  // 원격 터미널은 그 호스트의 worktree 전용 tmux 세션으로 연다
  await expect(page.getByTestId('terminal-pane')).toContainText(/mock-server:.*\[tmux minmo-[0-9a-f]{10}\]/)

  // 이 PC 로 바꾸면 원격 worktree 는 표시되지 않고, 열어 둔 원격 이슈는 그대로 남는다
  await page.getByRole('combobox', { name: '작업 호스트' }).selectOption('')
  await expect(page.getByTestId('issue-row-42')).toBeVisible()
  await expect(page.getByTestId('issue-row-42').getByLabel('worktree 있음')).toHaveCount(0)
  await expect(page.getByTestId('issue-host')).toHaveText('mock-server')
})

test('연결할 수 없는 호스트 → 원인 안내와 [이 PC 로 전환]', async ({ page }) => {
  await page.evaluate(() => localStorage.setItem('minmo-hosts', JSON.stringify({ state: { aliases: ['down'], selected: null }, version: 0 })))
  await page.reload()
  await page.getByRole('combobox', { name: '작업 호스트' }).selectOption('down')
  await expect(page.getByTestId('host-unavailable').getByRole('alert')).toContainText('호스트에 연결할 수 없습니다')
  await page.getByRole('button', { name: '이 PC 로 전환' }).click()
  await expect(page.getByTestId('host-unavailable')).toHaveCount(0)
  await expect(page.locator('[data-testid^="org-node-"]').first()).toBeVisible()
})
