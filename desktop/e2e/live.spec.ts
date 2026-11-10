// 실연결 스모크 (Phase 8.2, Shared Plan 통합 순서) — 실제 minmo 서버 + githubmock + vite dev(VITE_TAURI_MOCK=1)
// 로그인(E1 실호출 → githubmock authorize 302 → 서버 콜백 302 의 딥링크 주입) → 트리 → 프로젝트 설정 저장(실 PUT)
// → 메모 저장 → 다른 기기(같은 세션 Node 요청) 수정 → 409 모달.
// 기본 `npm run e2e` 에는 포함되지 않는다(playwright.config.ts testIgnore). 서버 기동은 호출자 몫.
import { expect, test } from '@playwright/test'
import type { APIRequestContext, Page } from '@playwright/test'

import { routeGitHub } from './fixtures'

const LIVE_SERVER = (process.env.MINMO_LIVE_SERVER ?? 'http://127.0.0.1:8787').replace(/\/+$/, '')
const NOTES_PATH = '/projects/my-org/widgets/issues/42/notes'

/** 302 Location 을 따라가지 않고 그대로 읽는다 */
async function location(request: APIRequestContext, url: string): Promise<string> {
  const res = await request.get(url, { maxRedirects: 0 })
  expect(res.status(), `${url} → 302 기대`).toBe(302)
  const loc = res.headers()['location']
  expect(loc, `${url} 응답에 Location 없음`).toBeTruthy()
  return new URL(loc, url).toString()
}

/** E1 → (mock 브라우저) authorizeUrl → githubmock 302 → 서버 콜백 302 → minmo://auth?session&state 딥링크 주입 */
async function liveLogin(page: Page, request: APIRequestContext): Promise<string> {
  await page.goto('/')
  await expect(page).toHaveURL(/\/login$/)
  await page.getByRole('button', { name: 'GitHub로 로그인' }).click()
  await expect(page.getByText('브라우저에서 GitHub 승인 중')).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.__MINMO_MOCK__?.openedUrls.length ?? 0)).toBe(1)
  const authorizeUrl = await page.evaluate(() => window.__MINMO_MOCK__?.openedUrls[0] ?? '')

  const callback = await location(request, authorizeUrl)
  expect(callback.startsWith(`${LIVE_SERVER}/auth/github/callback`), `콜백 주소가 서버가 아님: ${callback}`).toBe(true)
  const deepLink = await location(request, callback)
  expect(deepLink).toMatch(/^minmo:\/\/auth\?/)
  const session = new URL(deepLink).searchParams.get('session')
  expect(session, '딥링크에 session 없음').toBeTruthy()

  await page.evaluate((url) => window.__MINMO_MOCK__?.emitDeepLink(url), deepLink)
  await expect(page.getByRole('button', { name: '전역 설정' })).toBeVisible()
  await expect(page).toHaveURL(/\/$/)
  return session!
}

test.beforeAll(async ({ request }) => {
  const res = await request.get(`${LIVE_SERVER}/healthz`).catch((e: unknown) => {
    throw new Error(`minmo 서버(${LIVE_SERVER})에 연결할 수 없습니다 — githubmock·서버를 먼저 기동하세요: ${String(e)}`)
  })
  expect(res.status(), 'healthz').toBe(200)
})

test('실서버: 로그인 → 트리 → 프로젝트 설정 저장 → 메모 저장 → 다른 기기 수정 → 409 모달', async ({ page, request }) => {
  // GitHub REST 만 fixture — minmo 서버 호출은 가로채지 않는다
  await routeGitHub(page)

  // 1) 로그인
  const session = await liveLogin(page, request)
  const auth = { Authorization: `Bearer ${session}` }

  // 2) 트리
  await page.getByTestId('org-node-my-org').click()
  await page.getByTestId('repo-node-my-org/widgets').click()
  await expect(page.getByTestId('issue-row-42')).toBeVisible()

  // 3) 프로젝트 설정 저장(실서버 PUT) — 키보드 접근 가능한 ⚙ 버튼 경로
  const template = `feat/{number}-live${Date.now() % 100000}`
  await page.getByRole('button', { name: 'widgets 프로젝트 설정' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('브랜치 템플릿').fill(template)
  await dialog.getByRole('button', { name: '저장' }).click()
  await expect(dialog).toBeHidden()
  const saved = await request.get(`${LIVE_SERVER}/projects/my-org/widgets/settings`, { headers: auth })
  expect(saved.status()).toBe(200)
  expect((await saved.json()) as Record<string, unknown>).toMatchObject({ branchTemplate: template })

  // 4) 메모 입력 → 저장
  await page.getByTestId('issue-row-42').click()
  await page.getByRole('tab', { name: '메모' }).click()
  const editor = page.getByRole('textbox', { name: '메모' })
  await expect(editor).toBeEnabled()
  await editor.fill('device A')
  await expect(page.getByTestId('notes-status')).toHaveAttribute('data-state', 'saved', { timeout: 10_000 })
  const afterA = await request.get(`${LIVE_SERVER}${NOTES_PATH}`, { headers: auth })
  expect(((await afterA.json()) as { body: string }).body).toBe('device A')

  // 5) 다른 기기: 같은 세션으로 baseUpdatedAt 없이 덮어쓰기
  const other = await request.put(`${LIVE_SERVER}${NOTES_PATH}`, { headers: auth, data: { body: 'device B' } })
  expect(other.status()).toBe(200)

  // 6) 이 기기에서 이어서 입력 → 직전 updatedAt 을 base 로 PUT → 409 → 모달
  await editor.fill('device A edit 2')
  await expect(page.getByText('다른 기기에서 수정됨')).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: '서버 내용 불러오기' }).click()
  await expect(editor).toHaveValue('device B')
})
