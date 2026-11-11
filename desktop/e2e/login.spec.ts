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

test('E1 503 → 서버 설정이 열리고 OAuth App 값을 저장한다', async ({ page }) => {
  await routeServer(page, (_req, path) => (path === '/auth/github/start' ? { status: 503, body: { error: 'github_oauth_not_configured' } } : undefined))
  await page.goto('/')
  await page.getByRole('button', { name: 'GitHub로 로그인' }).click()
  // 대화상자가 열리면 바깥은 aria-hidden 이 되므로 문구는 텍스트로 확인한다
  await expect(page.getByText('서버 설정에서 Client ID·Secret 을 입력하세요')).toBeVisible()
  const dialog = page.getByRole('dialog', { name: '서버 설정' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByTestId('callback-url')).toHaveText(/^http:\/\/127\.0\.0\.1:\d+\/auth\/github\/callback$/)
  await dialog.getByLabel('Client ID').fill('Iv1.e2e')
  await dialog.getByLabel('Client Secret').fill('s3cret')
  await dialog.getByRole('button', { name: '저장' }).click()
  await expect(dialog).toBeHidden()
  const saved = await page.evaluate(() => window.__MINMO_MOCK__?.serverSettings)
  expect(saved).toMatchObject({ githubClientId: 'Iv1.e2e', clientSecret: 's3cret', hasClientSecret: true })
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
