// CT-21 보강(FE 로컬): 메서드별 method·URL·인증 헤더·본문 직렬화, ApiError 변환 세부.
// 공용 계약 테스트(contract.test.ts)와 겹치지 않는 부분만 다룬다.
import { describe, expect, it } from 'vitest'

import { ApiError, createApiClient } from './index'
import type { ApiClient } from './index'

const BASE = 'http://127.0.0.1:8787'

type Call = { method: string; url: string; headers: Record<string, string>; body?: string }

function setup(responder: (c: Call) => Response | Promise<Response>, getToken: () => string | null = () => 'tok') {
  const calls: Call[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((v, k) => {
      headers[k.toLowerCase()] = v
    })
    const call: Call = { method: (init?.method ?? 'GET').toUpperCase(), url, headers, body: typeof init?.body === 'string' ? init.body : undefined }
    calls.push(call)
    return responder(call)
  }) as unknown as typeof fetch
  return { calls, api: createApiClient({ baseUrl: BASE, getToken, fetch: fetchImpl }) }
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } })

const SETTINGS = {
  branchTemplate: null,
  etcBranchName: null,
  worktreePath: null,
  mainClonePath: null,
  postCreateScript: null,
  sparsePaths: null,
  postCreateScriptPosix: null,
  ignoredCopyExclude: null,
  updatedAt: null,
}

describe('CT-21 메서드별 method · URL · Authorization', () => {
  const cases: [string, (api: ApiClient) => Promise<unknown>, string, string, unknown][] = [
    ['me', (a) => a.me(), 'GET', '/me', { id: 'usr_x', githubLogin: 'o', avatarUrl: null }],
    ['getGithubToken', (a) => a.getGithubToken(), 'GET', '/me/github-token', { accessToken: 'gho_x' }],
    ['getSettings global', (a) => a.getSettings({ kind: 'global' }), 'GET', '/settings', SETTINGS],
    ['getSettings org', (a) => a.getSettings({ kind: 'org', owner: 'MyOrg' }), 'GET', '/orgs/MyOrg/settings', SETTINGS],
    ['getSettings project', (a) => a.getSettings({ kind: 'project', owner: 'MyOrg', repo: 'Repo-A' }), 'GET', '/projects/MyOrg/Repo-A/settings', SETTINGS],
    ['putSettings global', (a) => a.putSettings({ kind: 'global' }, {}), 'PUT', '/settings', SETTINGS],
    ['putSettings org', (a) => a.putSettings({ kind: 'org', owner: 'MyOrg' }, {}), 'PUT', '/orgs/MyOrg/settings', SETTINGS],
    ['putSettings project', (a) => a.putSettings({ kind: 'project', owner: 'MyOrg', repo: 'Repo-A' }, {}), 'PUT', '/projects/MyOrg/Repo-A/settings', SETTINGS],
    ['getEffective', (a) => a.getEffective('MyOrg', 'Repo-A'), 'GET', '/projects/MyOrg/Repo-A/settings/effective', { values: {}, sources: {} }],
    ['getNotes', (a) => a.getNotes('MyOrg', 'Repo-A', '42'), 'GET', '/projects/MyOrg/Repo-A/issues/42/notes', { body: '', updatedAt: null }],
    ['putNotes', (a) => a.putNotes('MyOrg', 'Repo-A', 'etc', { body: 'x' }), 'PUT', '/projects/MyOrg/Repo-A/issues/etc/notes', { body: 'x', updatedAt: '2026-11-09T12:00:00.000Z' }],
  ]

  it.each(cases)('%s → %s %s 에 Bearer 토큰 전송', async (_n, call, method, path, resBody) => {
    const { api, calls } = setup(() => json(200, resBody))
    await expect(call(api)).resolves.toEqual(resBody)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ method, url: `${BASE}${path}` })
    expect(calls[0].headers.authorization).toBe('Bearer tok')
  })

  it('logout → DELETE /auth/session, Bearer 전송, 204 → undefined', async () => {
    const { api, calls } = setup(() => new Response(null, { status: 204 }))
    await expect(api.logout()).resolves.toBeUndefined()
    expect(calls[0]).toMatchObject({ method: 'DELETE', url: `${BASE}/auth/session` })
    expect(calls[0].headers.authorization).toBe('Bearer tok')
  })

  it('기기 코드 로그인(E1·E2)은 토큰이 있어도 Authorization 을 보내지 않는다 (무인증)', async () => {
    const { api, calls } = setup(() => json(200, { status: 'pending', interval: 5 }))
    await api.startDeviceLogin()
    await api.pollDeviceLogin('dev-1')
    expect(calls[0].headers.authorization).toBeUndefined()
    expect(calls[1].headers.authorization).toBeUndefined()
  })

  it('healthz 는 토큰이 있어도 Authorization 을 보내지 않는다 (E0 무인증)', async () => {
    const { api, calls } = setup(() => json(200, { status: 'ok' }))
    await api.healthz()
    expect(calls[0].headers.authorization).toBeUndefined()
  })

  it('getToken 은 요청 시점마다 다시 읽는다 (로그인/로그아웃 후 즉시 반영)', async () => {
    let token: string | null = 'first'
    const { api, calls } = setup(() => json(200, { body: '', updatedAt: null }), () => token)
    await api.getNotes('o', 'r', '1')
    token = 'second'
    await api.getNotes('o', 'r', '1')
    token = null
    await api.getNotes('o', 'r', '1')
    expect(calls.map((c) => c.headers.authorization)).toEqual(['Bearer first', 'Bearer second', undefined])
  })

  it('token override 는 getToken() 보다 우선한다 (CT-35 후보 세션 검증)', async () => {
    const { api, calls } = setup(() => json(200, { id: 'usr_x', githubLogin: 'o', avatarUrl: null }), () => 'stored')
    await api.me({ token: 'candidate' })
    expect(calls[0].headers.authorization).toBe('Bearer candidate')
  })
})

describe('CT-21 요청 본문 직렬화', () => {
  it('PUT 요청은 Content-Type application/json', async () => {
    const { api, calls } = setup(() => json(200, SETTINGS))
    await api.putSettings({ kind: 'org', owner: 'o' }, { branchTemplate: 'feat/{number}' })
    expect(calls[0].headers['content-type']).toMatch(/^application\/json/)
  })

  it('putNotes 에서 baseUpdatedAt 생략은 키 자체를 보내지 않는다 (생략=무조건 덮어쓰기 ≠ null)', async () => {
    const { api, calls } = setup(() => json(200, { body: 'x', updatedAt: '2026-11-09T12:00:00.000Z' }))
    await api.putNotes('o', 'r', '1', { body: 'x' })
    const sent = JSON.parse(calls[0].body ?? '{}') as Record<string, unknown>
    expect(sent).toEqual({ body: 'x' })
    expect('baseUpdatedAt' in sent).toBe(false)
  })

  it('GET 요청은 본문을 보내지 않는다', async () => {
    const { api, calls } = setup(() => json(200, { body: '', updatedAt: null }))
    await api.getNotes('o', 'r', 'etc')
    expect(calls[0].body).toBeUndefined()
  })
})

describe('CT-21 비2xx → ApiError 변환 세부', () => {
  it('ApiError 는 Error 의 인스턴스', async () => {
    const { api } = setup(() => json(400, { error: 'invalid_issue_key' }))
    const err = await api.getNotes('o', 'r', 'abc').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toBeInstanceOf(Error)
    expect(err).toMatchObject({ status: 400, code: 'invalid_issue_key' })
    expect((err as ApiError).field).toBeUndefined()
  })

  it('400 invalid_path_param field=repo 전달', async () => {
    const { api } = setup(() => json(400, { error: 'invalid_path_param', field: 'repo' }))
    const err = (await api.getEffective('o', '..').catch((e: unknown) => e)) as ApiError
    expect(err).toMatchObject({ status: 400, code: 'invalid_path_param', field: 'repo' })
  })

  it('500 {error:"internal"} 은 union 에 속하므로 code=internal', async () => {
    const { api } = setup(() => json(500, { error: 'internal' }))
    const err = (await api.getSettings({ kind: 'global' }).catch((e: unknown) => e)) as ApiError
    expect(err).toMatchObject({ status: 500, code: 'internal' })
  })

  it('503 github_oauth_not_configured (E1)', async () => {
    const { api } = setup(() => json(503, { error: 'github_oauth_not_configured' }))
    const err = (await api.startDeviceLogin().catch((e: unknown) => e)) as ApiError
    expect(err).toMatchObject({ status: 503, code: 'github_oauth_not_configured' })
  })

  it('5xx 에 미지 코드 → server_error', async () => {
    const { api } = setup(() => json(500, { error: 'something_new' }))
    const err = (await api.me().catch((e: unknown) => e)) as ApiError
    expect(err).toMatchObject({ status: 500, code: 'server_error' })
  })

  // v2.5 ApiError.code 규칙: 비JSON 401/404/405/413 은 status 로 추정, 그 외 4xx 는 http_error, 5xx 는 server_error
  it.each([
    [401, 'unauthorized'],
    [404, 'not_found'],
    [405, 'method_not_allowed'],
    [413, 'payload_too_large'],
  ] as const)('비JSON %i → %s 로 추정 (v2.5)', async (status, code) => {
    const { api } = setup(() => new Response('<html>x</html>', { status, headers: { 'content-type': 'text/html' } }))
    const err = (await api.me().catch((e: unknown) => e)) as ApiError
    expect(err).toMatchObject({ status, code })
  })

  it.each([400, 403, 409, 422, 429])('미지 코드 JSON %i → http_error (v2.5)', async (status) => {
    const { api } = setup(() => json(status, { error: 'future_code' }))
    const err = (await api.me().catch((e: unknown) => e)) as ApiError
    expect(err).toMatchObject({ status, code: 'http_error' })
  })

  it('비JSON 502 → server_error (v2.5)', async () => {
    const { api } = setup(() => new Response('bad gateway', { status: 502 }))
    const err = (await api.me().catch((e: unknown) => e)) as ApiError
    expect(err).toMatchObject({ status: 502, code: 'server_error' })
  })

  it('409 conflict 의 current 는 flat body·updatedAt 에서 만든다 (행 없음: "" / null)', async () => {
    const { api } = setup(() => json(409, { error: 'conflict', body: '', updatedAt: null }))
    const err = (await api.putNotes('o', 'r', '1', { body: 'x', baseUpdatedAt: '2026-11-09T12:00:00.000Z' }).catch((e: unknown) => e)) as ApiError
    expect(err).toMatchObject({ status: 409, code: 'conflict' })
    expect(err.current).toEqual({ body: '', updatedAt: null })
  })

  it('409 가 아닌 에러에는 current 가 없다', async () => {
    const { api } = setup(() => json(400, { error: 'body_too_large' }))
    const err = (await api.putNotes('o', 'r', '1', { body: 'x' }).catch((e: unknown) => e)) as ApiError
    expect(err.code).toBe('body_too_large')
    expect(err.current).toBeUndefined()
  })

  it('getSettings 도 fetch 실패(TypeError) → network_error', async () => {
    const { api } = setup(() => {
      throw new TypeError('Failed to fetch')
    })
    const err = await api.getSettings({ kind: 'global' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).code).toBe('network_error')
  })
})
