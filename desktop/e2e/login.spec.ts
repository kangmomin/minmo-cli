// F-01 로그인 (AC-01·AC-02, CT-35) — mock tauri 딥링크 + 계약 fixture
import { expect, test } from '@playwright/test'

import { STATE, login, routeGitHub, routeServer } from './fixtures'

test.beforeEach(async ({ page }) => {
  await routeGitHub(page)
})

test('로그인 버튼 → 딥링크(state 일치) → /me·/me/github-token 확인 후 메인 화면', async ({ page }) => {
  const { calls } = await routeServer(page)
  await login(page)
  expect(calls.some((c) => c.method === 'POST' && c.path === '/auth/github/start')).toBe(true)
  expect(calls.some((c) => c.path === '/me')).toBe(true)
  expect(calls.some((c) => c.path === '/me/github-token')).toBe(true)
  await expect(page.getByRole('button', { name: '전역 설정' })).toBeVisible()
})

test('state 불일치 딥링크는 무시한다 (login-CSRF 방어)', async ({ page }) => {
  const { calls } = await routeServer(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'GitHub로 로그인' }).click()
  await expect(page.getByText('브라우저에서 GitHub 승인 중')).toBeVisible()
  await page.evaluate(() => window.__MINMO_MOCK__?.emitDeepLink('minmo://auth?session=evil&state=attacker'))
  await page.waitForTimeout(300)
  expect(calls.some((c) => c.path === '/me')).toBe(false)
  await expect(page).toHaveURL(/\/login$/)
})

test('딥링크 error=access_denied → "승인 취소됨"', async ({ page }) => {
  await routeServer(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'GitHub로 로그인' }).click()
  // pendingLogin 이 켜진 뒤에 딥링크를 보낸다(그 전이면 콜드 스타트로 무시되는 것이 정상 동작)
  await expect(page.getByText('브라우저에서 GitHub 승인 중')).toBeVisible()
  await page.evaluate((s) => window.__MINMO_MOCK__?.emitDeepLink(`minmo://auth?error=access_denied&state=${s}`), STATE)
  await expect(page.getByRole('alert')).toContainText('승인 취소됨')
})

test('E1 503 → MINMO_GITHUB_CLIENT_ID 안내', async ({ page }) => {
  await routeServer(page, (_req, path) => (path === '/auth/github/start' ? { status: 503, body: { error: 'github_oauth_not_configured' } } : undefined))
  await page.goto('/')
  await page.getByRole('button', { name: 'GitHub로 로그인' }).click()
  await expect(page.getByRole('alert')).toContainText('MINMO_GITHUB_CLIENT_ID')
})

test('로그아웃 → /login', async ({ page }) => {
  const { calls } = await routeServer(page)
  await login(page)
  await page.getByRole('button', { name: '로그아웃' }).click()
  await expect(page).toHaveURL(/\/login$/)
  expect(calls.some((c) => c.method === 'DELETE' && c.path === '/auth/session')).toBe(true)
})
