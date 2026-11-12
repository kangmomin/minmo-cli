// F-01 로그인(GitHub 기기 코드) — 코드 표시·승인 대기·거부·취소 (mock tauri + 계약 fixture)
import { expect, test } from '@playwright/test'

import { USER_CODE, VERIFY_URL, login, routeGitHub, routeServer } from './fixtures'

test.beforeEach(async ({ page }) => {
  await routeGitHub(page)
})

test('로그인 버튼 → 코드 표시·브라우저 열기 → 승인 확인 → /me·/me/github-token 확인 후 메인 화면', async ({ page }) => {
  const { calls } = await routeServer(page)
  await login(page)
  expect(calls.some((c) => c.method === 'POST' && c.path === '/auth/github/device/start')).toBe(true)
  expect(calls.find((c) => c.path === '/auth/github/device/poll')?.body).toEqual({ deviceId: 'e2e-device' })
  expect(calls.some((c) => c.path === '/me')).toBe(true)
  expect(calls.some((c) => c.path === '/me/github-token')).toBe(true)
  await expect(page.getByRole('button', { name: '전역 설정' })).toBeVisible()
})

test('승인 전에는 코드를 보이며 기다리고, 승인되면 자동으로 로그인된다 · 코드 복사·브라우저 다시 열기', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  let polls = 0
  const { calls } = await routeServer(page, (_req, path) => {
    if (path !== '/auth/github/device/poll') return undefined
    polls++
    return polls < 3 ? { status: 200, body: { status: 'pending', interval: 1 } } : { status: 200, body: { status: 'ok', session: 'e2e-session' } }
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'GitHub로 로그인' }).click()
  const box = page.getByTestId('device-login')
  await expect(box.getByTestId('device-user-code')).toHaveText(USER_CODE)
  await expect(box).toContainText('GitHub 승인을 기다리는 중')
  await expect(box).toContainText(VERIFY_URL)
  await box.getByRole('button', { name: '복사' }).click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(USER_CODE)
  await box.getByRole('button', { name: '브라우저 다시 열기' }).click()
  await expect.poll(() => page.evaluate(() => window.__MINMO_MOCK__?.openedUrls)).toEqual([VERIFY_URL, VERIFY_URL])
  // 아직 승인 전: /me 를 부르지 않는다
  expect(calls.some((c) => c.path === '/me')).toBe(false)
  await expect(page.getByRole('button', { name: '전역 설정' })).toBeVisible({ timeout: 10_000 })
  expect(polls).toBe(3)
})

test('GitHub 에서 거부하면 안내하고 로그인 화면으로 돌아온다', async ({ page }) => {
  await routeServer(page, (_req, path) => (path === '/auth/github/device/poll' ? { status: 400, body: { error: 'access_denied' } } : undefined))
  await page.goto('/')
  await page.getByRole('button', { name: 'GitHub로 로그인' }).click()
  await expect(page.getByRole('alert')).toContainText('GitHub 에서 승인을 거부했습니다')
  await expect(page.getByRole('button', { name: 'GitHub로 로그인' })).toBeVisible()
  await expect(page).toHaveURL(/\/login$/)
})

test('취소하면 더 확인하지 않는다', async ({ page }) => {
  const { calls } = await routeServer(page, (_req, path) => (path === '/auth/github/device/poll' ? { status: 200, body: { status: 'pending', interval: 1 } } : undefined))
  await page.goto('/')
  await page.getByRole('button', { name: 'GitHub로 로그인' }).click()
  await expect(page.getByTestId('device-user-code')).toBeVisible()
  await page.getByRole('button', { name: '취소' }).click()
  await expect(page.getByRole('button', { name: 'GitHub로 로그인' })).toBeVisible()
  const before = calls.filter((c) => c.path === '/auth/github/device/poll').length
  await page.waitForTimeout(2500)
  expect(calls.filter((c) => c.path === '/auth/github/device/poll').length).toBe(before)
})

test('E1 503(Client ID 없음·Device Flow 꺼짐) → 안내만 보이고, 서버 설정에는 OAuth App 항목이 없다', async ({ page }) => {
  await routeServer(page, (_req, path) => (path === '/auth/github/device/start' ? { status: 503, body: { error: 'github_oauth_not_configured' } } : undefined))
  await page.goto('/')
  await page.getByRole('button', { name: 'GitHub로 로그인' }).click()
  await expect(page.getByRole('alert')).toContainText('GitHub 로그인 설정(Client ID·Device Flow)이 올바르지 않습니다')
  await page.getByRole('button', { name: '서버 설정' }).click()
  const dialog = page.getByRole('dialog', { name: '서버 설정' })
  await expect(dialog.getByLabel('포트')).toBeVisible()
  await expect(dialog.getByText('Client Secret')).toHaveCount(0)
  await expect(dialog.getByText(/OAuth App/)).toHaveCount(0)
})

test('창 닫기 → 트레이로 최소화(다음부터 묻지 않기)', async ({ page }) => {
  await routeServer(page)
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'GitHub로 로그인' })).toBeVisible()
  await page.evaluate(() => window.__MINMO_MOCK__?.emitCloseRequested())
  const dialog = page.getByRole('dialog', { name: '창을 닫을까요?' })
  await dialog.getByLabel('다음부터 묻지 않기', { exact: false }).check()
  await dialog.getByRole('button', { name: '트레이로 최소화' }).click()
  await expect(dialog).toBeHidden()
  expect(await page.evaluate(() => window.__MINMO_MOCK__?.closeCalls)).toEqual([{ action: 'tray', remember: true }])
})

test('로그아웃 → /login', async ({ page }) => {
  const { calls } = await routeServer(page)
  await login(page)
  await page.getByRole('button', { name: '로그아웃' }).click()
  await expect(page).toHaveURL(/\/login$/)
  expect(calls.some((c) => c.method === 'DELETE' && c.path === '/auth/session')).toBe(true)
})
