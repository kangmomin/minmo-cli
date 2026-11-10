// 공용 계약 테스트 — 오케스트레이터 소유. FE 구현 에이전트는 이 파일을 수정하지 않는다.
// Integration Contract v2.4: contracts/fixtures ↔ api-client 타입·클라이언트 동형성 (CT-21 외).
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { ApiError, createApiClient } from './index'
import type { Effective, Me, Notes, SettingsInput, SettingsRecord } from './index'

const FIXTURES = resolve(__dirname, '../../../contracts/fixtures')
const fx = <T = unknown>(name: string): T => JSON.parse(readFileSync(resolve(FIXTURES, name), 'utf8')) as T

const BASE = 'http://127.0.0.1:8787'

type Call = { method: string; url: string; headers: Record<string, string>; body?: string }

function mockFetch(responder: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = []
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((v, k) => {
      headers[k.toLowerCase()] = v
    })
    const call: Call = {
      method: (init?.method ?? 'GET').toUpperCase(),
      url,
      headers,
      body: typeof init?.body === 'string' ? init.body : undefined,
    }
    calls.push(call)
    return responder(call)
  }
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch }
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } })

function client(responder: (call: Call) => Response | Promise<Response>, token: string | null = 'tok') {
  const m = mockFetch(responder)
  const api = createApiClient({ baseUrl: BASE, getToken: () => token, fetch: m.fetchImpl })
  return { ...m, api }
}

// 컴파일 타임 동형성: fixture 가 계약 타입에 대입 가능해야 한다
const _me: Me = fx<Me>('me.json')
const _global: SettingsRecord = fx<SettingsRecord>('settings-global-default.json')
const _empty: SettingsRecord = fx<SettingsRecord>('settings-scope-empty.json')
const _eff: Effective = fx<Effective>('effective-project-override.json')
const _notes: Notes = fx<Notes>('notes-empty.json')
void [_me, _global, _empty, _eff, _notes]

describe('contract: 성공 응답 ↔ fixture (CT-05, 07, 09, 13, 14, 22)', () => {
  it('GET /me → Me (CT-05)', async () => {
    const me = fx('me.json')
    const { api, calls } = client(() => json(200, me))
    await expect(api.me()).resolves.toEqual(me)
    expect(calls[0]).toMatchObject({ method: 'GET', url: `${BASE}/me` })
    expect(calls[0].headers.authorization).toBe('Bearer tok')
  })

  it('GET /settings → SettingsRecord 기본값 (CT-07)', async () => {
    const rec = fx('settings-global-default.json')
    const { api, calls } = client(() => json(200, rec))
    await expect(api.getSettings({ kind: 'global' })).resolves.toEqual(rec)
    expect(calls[0]).toMatchObject({ method: 'GET', url: `${BASE}/settings` })
  })

  it('GET /orgs/{owner}/settings · /projects/{owner}/{repo}/settings → 빈 레코드 (CT-22)', async () => {
    const rec = fx('settings-scope-empty.json')
    const { api, calls } = client(() => json(200, rec))
    await expect(api.getSettings({ kind: 'org', owner: 'acme' })).resolves.toEqual(rec)
    await expect(api.getSettings({ kind: 'project', owner: 'acme', repo: 'widgets' })).resolves.toEqual(rec)
    expect(calls[0].url).toBe(`${BASE}/orgs/acme/settings`)
    expect(calls[1].url).toBe(`${BASE}/projects/acme/widgets/settings`)
  })

  it('GET effective → values + sources 6키 (CT-09)', async () => {
    const eff = fx<Effective>('effective-project-override.json')
    const { api, calls } = client(() => json(200, eff))
    const got = await api.getEffective('acme', 'widgets')
    expect(got).toEqual(eff)
    expect(Object.keys(got.sources).sort()).toEqual(
      ['branchTemplate', 'etcBranchName', 'mainClonePath', 'postCreateScript', 'sparsePaths', 'worktreePath'].sort(),
    )
    expect(calls[0].url).toBe(`${BASE}/projects/acme/widgets/settings/effective`)
  })

  it('GET notes 없음 → {body:"", updatedAt:null} (CT-13)', async () => {
    const n = fx('notes-empty.json')
    const { api, calls } = client(() => json(200, n))
    await expect(api.getNotes('acme', 'widgets', 'etc')).resolves.toEqual(n)
    expect(calls[0].url).toBe(`${BASE}/projects/acme/widgets/issues/etc/notes`)
  })

  it('PUT notes → body·baseUpdatedAt 그대로 전송, 응답 Notes (CT-14)', async () => {
    const n = fx('notes-saved.json')
    const { api, calls } = client(() => json(200, n))
    await expect(api.putNotes('acme', 'widgets', '42', { body: 'x', baseUpdatedAt: '2026-11-09T12:00:00.000Z' })).resolves.toEqual(n)
    expect(calls[0]).toMatchObject({ method: 'PUT', url: `${BASE}/projects/acme/widgets/issues/42/notes` })
    expect(JSON.parse(calls[0].body ?? '{}')).toEqual({ body: 'x', baseUpdatedAt: '2026-11-09T12:00:00.000Z' })
    expect(calls[0].headers['content-type']).toMatch(/^application\/json/)
  })

  it('PUT notes baseUpdatedAt:null 은 null 로 전송 (CT-30)', async () => {
    const { api, calls } = client(() => json(200, fx('notes-saved.json')))
    await api.putNotes('acme', 'widgets', '42', { body: 'x', baseUpdatedAt: null })
    expect(JSON.parse(calls[0].body ?? '{}')).toEqual({ body: 'x', baseUpdatedAt: null })
  })
})

describe('contract: 설정 PUT 전송 형식 (E7/E9/E11)', () => {
  it('전역 PUT 은 6필드 string 전부 전송', async () => {
    const input: SettingsInput = {
      branchTemplate: 'issue/{number}-{slug}',
      etcBranchName: 'etc',
      worktreePath: '~/minmo-workspaces/{owner}/{repo}/{branch}',
      mainClonePath: '~/minmo-workspaces/{owner}/{repo}/_main',
      postCreateScript: '',
      sparsePaths: '',
    }
    const { api, calls } = client(() => json(200, fx('settings-global-default.json')))
    await api.putSettings({ kind: 'global' }, input)
    expect(calls[0]).toMatchObject({ method: 'PUT', url: `${BASE}/settings` })
    expect(JSON.parse(calls[0].body ?? '{}')).toEqual(input)
  })

  it('org/project PUT 은 값·null 을 그대로 전송 (null = 상속, "" = override)', async () => {
    const { api, calls } = client(() => json(200, fx('settings-scope-empty.json')))
    await api.putSettings({ kind: 'org', owner: 'acme' }, { branchTemplate: 'feat/{number}', worktreePath: null, postCreateScript: '' })
    expect(calls[0]).toMatchObject({ method: 'PUT', url: `${BASE}/orgs/acme/settings` })
    const sent = JSON.parse(calls[0].body ?? '{}')
    expect(sent.branchTemplate).toBe('feat/{number}')
    expect(sent.worktreePath).toBeNull()
    expect(sent.postCreateScript).toBe('')
    await api.putSettings({ kind: 'project', owner: 'acme', repo: 'widgets' }, { branchTemplate: 'feat/{number}' })
    expect(calls[1].url).toBe(`${BASE}/projects/acme/widgets/settings`)
  })
})

describe('contract: 에러 → ApiError (CT-21)', () => {
  const errors = fx<Record<string, { error: string; field?: string }>>('errors.json')

  it('400 invalid_template → code·field', async () => {
    const { api } = client(() => json(400, errors.invalid_template_branch))
    const err = await api.putSettings({ kind: 'global' }, {}).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err as ApiError).toMatchObject({ status: 400, code: 'invalid_template', field: 'branchTemplate' })
  })

  it('400 global_requires_all_fields → field', async () => {
    const { api } = client(() => json(400, errors.global_requires_all_fields))
    const err = (await api.putSettings({ kind: 'global' }, {}).catch((e: unknown) => e)) as ApiError
    expect(err).toMatchObject({ status: 400, code: 'global_requires_all_fields', field: 'worktreePath' })
  })

  it('400 invalid_sparse_paths → code·field (v2.6)', async () => {
    const { api } = client(() => json(400, errors.invalid_sparse_paths))
    const err = (await api.putSettings({ kind: 'org', owner: 'acme' }, { sparsePaths: 'a/../b' }).catch((e: unknown) => e)) as ApiError
    expect(err).toMatchObject({ status: 400, code: 'invalid_sparse_paths', field: 'sparsePaths' })
  })

  it('401 unauthorized', async () => {
    const { api } = client(() => json(401, errors.unauthorized))
    const err = (await api.me().catch((e: unknown) => e)) as ApiError
    expect(err).toMatchObject({ status: 401, code: 'unauthorized' })
  })

  it('409 conflict → current {body, updatedAt} (CT-15)', async () => {
    const conflict = { error: 'conflict', body: 'server body', updatedAt: '2026-11-09T12:00:01.000Z' }
    const { api } = client(() => json(409, conflict))
    const err = (await api.putNotes('a', 'r', '42', { body: 'mine', baseUpdatedAt: '2026-11-09T12:00:00.000Z' }).catch((e: unknown) => e)) as ApiError
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ status: 409, code: 'conflict' })
    expect(err.current).toEqual({ body: 'server body', updatedAt: '2026-11-09T12:00:01.000Z' })
  })

  it('404 not_found · 405 method_not_allowed · 502 github_unavailable 코드 전달', async () => {
    for (const [status, body] of [[404, errors.not_found], [405, errors.method_not_allowed], [502, { error: 'github_unavailable' }]] as const) {
      const { api } = client(() => json(status, body))
      const err = (await api.me().catch((e: unknown) => e)) as ApiError
      expect(err).toMatchObject({ status, code: body.error })
    }
  })

  it('5xx 비JSON → server_error', async () => {
    const { api } = client(() => new Response('<html>bad gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } }))
    const err = (await api.me().catch((e: unknown) => e)) as ApiError
    expect(err).toMatchObject({ status: 502, code: 'server_error' })
  })

  it('fetch 실패(TypeError) → network_error', async () => {
    const { api } = client(() => {
      throw new TypeError('Failed to fetch')
    })
    const err = (await api.healthz().catch((e: unknown) => e)) as ApiError
    expect(err).toBeInstanceOf(ApiError)
    expect(err.code).toBe('network_error')
  })

  // v2.5: 미지 코드·비JSON 4xx 는 http_error — server_error(=offline 후보)로 분류하지 않는다
  it('미지 코드 4xx → http_error (CT-21 v2.5)', async () => {
    const { api } = client(() => json(400, { error: 'some_future_code' }))
    const err = (await api.me().catch((e: unknown) => e)) as ApiError
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ status: 400, code: 'http_error' })
  })

  it('비JSON 4xx(프록시 429 등) → http_error (CT-21 v2.5)', async () => {
    const { api } = client(() => new Response('<html>too many</html>', { status: 429, headers: { 'content-type': 'text/html' } }))
    const err = (await api.me().catch((e: unknown) => e)) as ApiError
    expect(err).toMatchObject({ status: 429, code: 'http_error' })
  })

  it('E1 503 github_oauth_not_configured 는 코드 그대로 전달 (CT-38 전제)', async () => {
    const { api } = client(() => json(503, { error: 'github_oauth_not_configured' }), null)
    const err = (await api.startLogin().catch((e: unknown) => e)) as ApiError
    expect(err).toMatchObject({ status: 503, code: 'github_oauth_not_configured' })
  })
})

describe('contract: 인증 헤더·토큰 override·무인증 경로', () => {
  it('healthz 는 Authorization 없이 GET /healthz (CT-33)', async () => {
    const { api, calls } = client(() => json(200, { status: 'ok' }), null)
    await expect(api.healthz()).resolves.toEqual({ status: 'ok' })
    expect(calls[0]).toMatchObject({ method: 'GET', url: `${BASE}/healthz` })
    expect(calls[0].headers.authorization).toBeUndefined()
  })

  it('startLogin 은 POST /auth/github/start (CT-01)', async () => {
    const { api, calls } = client(() => json(200, { authorizeUrl: 'https://github.com/login/oauth/authorize?x=1', state: 's' }), null)
    await expect(api.startLogin()).resolves.toEqual({ authorizeUrl: 'https://github.com/login/oauth/authorize?x=1', state: 's' })
    expect(calls[0]).toMatchObject({ method: 'POST', url: `${BASE}/auth/github/start` })
  })

  it('me/getGithubToken/logout 은 token override 를 Bearer 로 전송 (CT-35 지원)', async () => {
    const { api, calls } = client((c) => (c.method === 'DELETE' ? new Response(null, { status: 204 }) : json(200, c.url.endsWith('/me') ? fx('me.json') : { accessToken: 'gho_x' })))
    await api.me({ token: 'cand' })
    await api.getGithubToken({ token: 'cand' })
    await api.logout({ token: 'cand' })
    expect(calls.map((c) => c.headers.authorization)).toEqual(['Bearer cand', 'Bearer cand', 'Bearer cand'])
    expect(calls[1]).toMatchObject({ method: 'GET', url: `${BASE}/me/github-token` })
    expect(calls[2]).toMatchObject({ method: 'DELETE', url: `${BASE}/auth/session` })
  })

  it('logout 204 → resolve, 401 도 로그아웃 성공으로 처리 (E5)', async () => {
    const ok = client(() => new Response(null, { status: 204 }))
    await expect(ok.api.logout()).resolves.toBeUndefined()
    const gone = client(() => json(401, { error: 'unauthorized' }))
    await expect(gone.api.logout()).resolves.toBeUndefined()
  })
})
