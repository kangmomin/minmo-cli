// E2E 공용: 계약 fixture 기반 서버·GitHub 응답 + mock tauri 딥링크 로그인
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect } from '@playwright/test'
import type { Page, Request, Route } from '@playwright/test'

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURES = resolve(here, '../../contracts/fixtures')

/** fixture placeholder("<id>", "<ts>")를 구체 값으로 치환해 읽는다 */
export function fixture<T = Record<string, unknown>>(name: string): T {
  const raw = readFileSync(resolve(FIXTURES, name), 'utf8')
    .replaceAll('"<id>"', '"usr_00000000-0000-0000-0000-000000000001"')
    .replaceAll('"<ts>"', '"2026-11-09T12:00:00.000Z"')
    .replaceAll('"<string>"', '"server body"')
  return JSON.parse(raw) as T
}

export const SERVER = 'http://127.0.0.1:8787'
export const GITHUB = 'https://api.github.com'
export const STATE = 'e2e-state'

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'Authorization, Content-Type, Accept, X-GitHub-Api-Version',
  'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'access-control-expose-headers': 'Link, X-RateLimit-Remaining, X-RateLimit-Reset, Retry-After',
}

export const json = (route: Route, status: number, body: unknown, headers: Record<string, string> = {}) =>
  route.fulfill({ status, headers: { ...CORS, 'content-type': 'application/json; charset=utf-8', ...headers }, body: JSON.stringify(body) })

export type ServerHandler = (req: Request, path: string) => { status: number; body?: unknown } | undefined

const SCOPE_EMPTY = fixture('settings-scope-empty.json')

/**
 * 서버 E0~E14 기본 응답. override 가 undefined 를 돌려주면 기본 응답을 쓴다.
 * 반환값의 calls 로 요청 본문을 검사할 수 있다.
 */
export async function routeServer(page: Page, override?: ServerHandler) {
  const calls: { method: string; path: string; body: unknown }[] = []
  await page.route(`${SERVER}/**`, async (route) => {
    const req = route.request()
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
    const path = new URL(req.url()).pathname
    const body = req.postData() ? (JSON.parse(req.postData() ?? 'null') as unknown) : undefined
    calls.push({ method: req.method(), path, body })
    const o = override?.(req, path)
    if (o) return o.status === 204 ? route.fulfill({ status: 204, headers: CORS }) : json(route, o.status, o.body)

    if (path === '/healthz') return json(route, 200, { status: 'ok' })
    if (path === '/auth/github/start') {
      return json(route, 200, { authorizeUrl: `https://github.com/login/oauth/authorize?client_id=e2e&state=${STATE}`, state: STATE })
    }
    if (path === '/me') return json(route, 200, fixture('me.json'))
    if (path === '/me/github-token') return json(route, 200, { accessToken: 'gho_e2e' })
    if (path === '/auth/session') return route.fulfill({ status: 204, headers: CORS })
    if (path === '/settings') return json(route, 200, req.method() === 'PUT' ? { ...(body as object), updatedAt: '2026-11-09T12:00:01.000Z' } : fixture('settings-global-default.json'))
    if (path.endsWith('/settings/effective')) return json(route, 200, fixture('effective-project-override.json'))
    if (path.endsWith('/settings')) {
      return json(route, 200, req.method() === 'PUT' ? { ...SCOPE_EMPTY, ...(body as object), updatedAt: '2026-11-09T12:00:01.000Z' } : SCOPE_EMPTY)
    }
    if (path.endsWith('/notes')) {
      if (req.method() === 'PUT') return json(route, 200, { body: (body as { body: string }).body, updatedAt: '2026-11-09T12:00:05.000Z' })
      return json(route, 200, fixture('notes-empty.json'))
    }
    return json(route, 404, { error: 'not_found' })
  })
  return { calls }
}

const issue = (n: number, title: string, state = 'open') => ({ number: n, title, state, html_url: `https://github.com/my-org/widgets/issues/${n}` })

/** GitHub REST(gh 미사용 폴백 경로) 응답 */
export async function routeGitHub(page: Page) {
  await page.route(`${GITHUB}/**`, async (route) => {
    const req = route.request()
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
    const path = new URL(req.url()).pathname
    if (path === '/user') return json(route, 200, { login: 'octocat', avatar_url: null })
    if (path === '/user/orgs') return json(route, 200, [{ login: 'my-org', avatar_url: null }])
    if (path === '/user/repos') return json(route, 200, [])
    if (path === '/orgs/my-org/repos') return json(route, 200, [{ name: 'widgets', owner: { login: 'my-org' }, default_branch: 'main' }])
    if (path === '/repos/my-org/widgets') return json(route, 200, { name: 'widgets', owner: { login: 'my-org' }, default_branch: 'main' })
    if (path === '/repos/my-org/widgets/issues') return json(route, 200, [issue(42, 'Add login'), issue(7, 'Old bug', 'closed')])
    if (path.startsWith('/repos/my-org/widgets/pulls')) return json(route, 200, [])
    return json(route, 404, { message: 'Not Found' })
  })
}

/** 로그인 버튼 → (mock) 브라우저 열림 → 딥링크 수신 → 메인 화면 */
export async function login(page: Page) {
  await page.goto('/')
  await expect(page).toHaveURL(/\/login$/)
  await page.getByRole('button', { name: 'GitHub로 로그인' }).click()
  await expect(page.getByText('브라우저에서 GitHub 승인 중')).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.__MINMO_MOCK__?.openedUrls.length ?? 0)).toBe(1)
  await page.evaluate((state) => window.__MINMO_MOCK__?.emitDeepLink(`minmo://auth?session=e2e-session&state=${state}`), STATE)
  await expect(page.getByText('octocat').first()).toBeVisible()
  await expect(page).toHaveURL(/\/$/)
}

/** 트리에서 my-org → widgets 펼치기 */
export async function expandWidgets(page: Page) {
  await page.getByTestId('org-node-my-org').click()
  await page.getByTestId('repo-node-my-org/widgets').click()
  await expect(page.getByTestId('issue-row-etc')).toBeVisible()
}
