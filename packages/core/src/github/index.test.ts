// GitHubClient — gh 우선 / REST 폴백 (F-02, D-22)
// 근거: EC-01, EC-02, EC-18, AC-03(개인 계정 첫 노드·closed+worktree 보충), UI State "GitHub 목록 상한", 비즈니스 규칙 "이슈 = Issue(PR 제외)"
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createFakeHost, fail, ok } from '../testing'
import type { GhHost } from '../host'
import { GitHubError, createGitHubClient } from './index'

const API = 'https://api.github.com'

type FetchCall = { url: string; method: string; headers: Record<string, string> }

function restFetch(route: (url: URL, call: FetchCall) => Response | Promise<Response>) {
  const calls: FetchCall[] = []
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((v, k) => {
      headers[k.toLowerCase()] = v
    })
    const call = { url, method: (init?.method ?? 'GET').toUpperCase(), headers }
    calls.push(call)
    return route(new URL(url), call)
  })
  return { calls, fetch: fn as unknown as typeof fetch, fn }
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } })

const issue = (n: number, state: 'open' | 'closed' = 'open', extra: Record<string, unknown> = {}) => ({
  number: n,
  title: `Issue ${n}`,
  state,
  html_url: `https://github.com/o/r/issues/${n}`,
  ...extra,
})

function setup(opts: { ghAvailable?: boolean; ghRun?: GhHost['ghRun']; route?: (url: URL, call: FetchCall) => Response | Promise<Response> } = {}) {
  const tauri = createFakeHost({
    ghAvailable: async () => opts.ghAvailable ?? false,
    ...(opts.ghRun ? { ghRun: opts.ghRun } : {}),
  })
  const rest = restFetch(opts.route ?? (() => json([])))
  const onUnauthorized = vi.fn()
  const getToken = vi.fn(async () => 'gho_server')
  const gh = createGitHubClient({ tauri, fetch: rest.fetch, getToken, onUnauthorized })
  return { gh, tauri, rest, onUnauthorized, getToken }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('EC-01 gh 미설치/인증 실패 → REST 폴백', () => {
  it('ghAvailable=false → REST 로 동일 결과, source()=rest, gh 호출 없음', async () => {
    const t = setup({
      ghAvailable: false,
      route: (u) => (u.pathname === '/user' ? json({ login: 'me', avatar_url: null }) : u.pathname === '/user/orgs' ? json([{ login: 'my-org', avatar_url: null }]) : json([])),
    })
    await expect(t.gh.source()).resolves.toBe('rest')
    const owners = await t.gh.listOwners()
    expect(owners.map((o) => o.login)).toEqual(['me', 'my-org'])
    expect(t.tauri.ghRun).not.toHaveBeenCalled()
    expect(t.rest.calls.every((c) => c.url.startsWith(API))).toBe(true)
    expect(t.rest.calls[0].headers.authorization).toMatch(/^(Bearer|token) gho_server$/)
  })

  it('ghAvailable=true 이고 gh 호출 성공 → REST 미사용, source()=gh', async () => {
    const t = setup({
      ghAvailable: true,
      ghRun: async (args) => (args.some((a) => a.includes('user/orgs')) ? ok(JSON.stringify([{ login: 'my-org', avatar_url: null }])) : ok(JSON.stringify({ login: 'me', avatar_url: null }))),
    })
    await expect(t.gh.source()).resolves.toBe('gh')
    const owners = await t.gh.listOwners()
    expect(owners.map((o) => o.login)).toEqual(['me', 'my-org'])
    expect(t.rest.fn).not.toHaveBeenCalled()
  })

  it('gh 가 인증 실패로 종료하면 REST 로 폴백해 같은 결과', async () => {
    const t = setup({
      ghAvailable: true,
      ghRun: async () => fail('gh: To get started with GitHub CLI, please run:  gh auth login', 4),
      route: (u) => (u.pathname === '/user' ? json({ login: 'me', avatar_url: null }) : json([{ login: 'my-org', avatar_url: null }])),
    })
    const owners = await t.gh.listOwners()
    expect(owners.map((o) => o.login)).toEqual(['me', 'my-org'])
    expect(t.rest.fn).toHaveBeenCalled()
  })
})

describe('AC-03 조직 목록', () => {
  it('개인 계정이 첫 노드(kind=user), 이어서 조직들(kind=org)', async () => {
    const t = setup({
      route: (u) =>
        u.pathname === '/user'
          ? json({ login: 'octocat', avatar_url: 'https://a/1' })
          : json([
              { login: 'org-a', avatar_url: null },
              { login: 'org-b', avatar_url: null },
            ]),
    })
    const owners = await t.gh.listOwners()
    expect(owners).toEqual([
      { login: 'octocat', kind: 'user', avatarUrl: 'https://a/1' },
      { login: 'org-a', kind: 'org', avatarUrl: null },
      { login: 'org-b', kind: 'org', avatarUrl: null },
    ])
  })
})

describe('EC-02 REST 401 → 로그인 화면·세션 폐기', () => {
  it('onUnauthorized 호출 + GitHubError(unauthorized)', async () => {
    const t = setup({ route: () => json({ message: 'Bad credentials' }, { status: 401 }) })
    const err = await t.gh.listOwners().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GitHubError)
    expect((err as GitHubError).code).toBe('unauthorized')
    expect(t.onUnauthorized).toHaveBeenCalledTimes(1)
  })
})

describe('EC-18 rate limit → 재시도 가능 시각, 자동 재시도 없음', () => {
  it('REST 403 + x-ratelimit-remaining 0 → retryAt = x-ratelimit-reset(epoch)', async () => {
    const reset = 1_762_700_000
    const t = setup({
      route: () =>
        json({ message: 'API rate limit exceeded' }, { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) } }),
    })
    const err = (await t.gh.listIssues('o', 'r').catch((e: unknown) => e)) as GitHubError
    expect(err).toBeInstanceOf(GitHubError)
    expect(err.code).toBe('rate_limited')
    expect(err.retryAt?.getTime()).toBe(reset * 1000)
    expect(t.rest.fn).toHaveBeenCalledTimes(1)
    expect(t.onUnauthorized).not.toHaveBeenCalled()
  })

  it('REST 429 + retry-after(초) → retryAt = now + 초', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-09T12:00:00.000Z'))
    const t = setup({ route: () => json({ message: 'slow down' }, { status: 429, headers: { 'retry-after': '120' } }) })
    const err = (await t.gh.listIssues('o', 'r').catch((e: unknown) => e)) as GitHubError
    expect(err.code).toBe('rate_limited')
    expect(err.retryAt?.toISOString()).toBe('2026-11-09T12:02:00.000Z')
    expect(t.rest.fn).toHaveBeenCalledTimes(1)
  })

  it('gh stderr 에 "rate limit" → rate_limited, retryAt=null, REST 재시도도 하지 않음', async () => {
    const t = setup({ ghAvailable: true, ghRun: async () => fail('gh: API rate limit exceeded for user ID 1. (HTTP 403)', 1) })
    const err = (await t.gh.listIssues('o', 'r').catch((e: unknown) => e)) as GitHubError
    expect(err).toBeInstanceOf(GitHubError)
    expect(err.code).toBe('rate_limited')
    expect(err.retryAt).toBeNull()
    expect(t.rest.fn).not.toHaveBeenCalled()
    expect(t.tauri.ghRun).toHaveBeenCalledTimes(1)
  })
})

describe('이슈 목록 — state=all · per_page=100 · ≤5페이지 · PR 제외 · 개별 보충', () => {
  it('state=all&per_page=100 으로 조회하고, PR(pull_request 키)은 제외', async () => {
    const t = setup({ route: () => json([issue(1), issue(2, 'closed'), issue(3, 'open', { pull_request: { url: 'x' } })]) })
    const list = await t.gh.listIssues('o', 'r')
    expect(list.map((i) => i.number)).toEqual([1, 2])
    expect(list[1]).toEqual({ number: 2, title: 'Issue 2', state: 'closed', htmlUrl: 'https://github.com/o/r/issues/2' })
    const u = new URL(t.rest.calls[0].url)
    expect(u.pathname).toBe('/repos/o/r/issues')
    expect(u.searchParams.get('state')).toBe('all')
    expect(u.searchParams.get('per_page')).toBe('100')
  })

  it('다음 페이지가 계속 있어도 최대 5페이지까지만 조회', async () => {
    let page = 0
    const t = setup({
      route: (u) => {
        page++
        const p = Number(u.searchParams.get('page') ?? page)
        const items = Array.from({ length: 100 }, (_, i) => issue((p - 1) * 100 + i + 1))
        return json(items, { headers: { link: `<${API}/repos/o/r/issues?state=all&per_page=100&page=${p + 1}>; rel="next"` } })
      },
    })
    const list = await t.gh.listIssues('o', 'r')
    expect(t.rest.fn).toHaveBeenCalledTimes(5)
    expect(list).toHaveLength(500)
  })

  it('worktreePathMap 에 있는데 목록에 없는 이슈 번호는 개별 조회로 보충 (closed + worktree 보장)', async () => {
    const t = setup({
      route: (u) => (u.pathname === '/repos/o/r/issues/777' ? json(issue(777, 'closed')) : json([issue(1), issue(2)])),
    })
    const list = await t.gh.listIssues('o', 'r', { ensureNumbers: [2, 777] })
    expect(list.map((i) => i.number).sort((a, b) => a - b)).toEqual([1, 2, 777])
    expect(list.find((i) => i.number === 777)?.state).toBe('closed')
    const singles = t.rest.calls.filter((c) => /\/repos\/o\/r\/issues\/\d+$/.test(new URL(c.url).pathname))
    expect(singles.map((c) => new URL(c.url).pathname)).toEqual(['/repos/o/r/issues/777'])
  })
})

describe('PF-01 개별 보충 중 삭제·이전된 이슈(404/410) → 그 번호만 건너뜀', () => {
  it.each([404, 410])('REST %i → 나머지 목록 성공, onUnauthorized 없음', async (status) => {
    const t = setup({
      route: (u) => {
        if (u.pathname === '/repos/o/r/issues/777') return json({ message: 'gone' }, { status })
        if (u.pathname === '/repos/o/r/issues/888') return json(issue(888, 'closed'))
        return json([issue(1)])
      },
    })
    const list = await t.gh.listIssues('o', 'r', { ensureNumbers: [777, 888] })
    expect(list.map((i) => i.number).sort((a, b) => a - b)).toEqual([1, 888])
    expect(t.onUnauthorized).not.toHaveBeenCalled()
  })

  it.each([
    ['HTTP 404', 'gh: Not Found (HTTP 404)'],
    ['HTTP 410', 'gh: This issue was deleted (HTTP 410)'],
  ])('gh stderr %s → not_found 로 건너뛰고 REST 재조회 없음', async (_l, stderr) => {
    const ghRun = vi.fn<GhHost['ghRun']>(async (args) => {
      const path = args[args.length - 1]
      if (path === 'repos/o/r/issues/777') return fail(stderr)
      if (path === 'repos/o/r/issues/888') return ok(JSON.stringify(issue(888, 'closed')))
      return ok(JSON.stringify([issue(1)]))
    })
    const t = setup({ ghAvailable: true, ghRun })
    const list = await t.gh.listIssues('o', 'r', { ensureNumbers: [777, 888] })
    expect(list.map((i) => i.number).sort((a, b) => a - b)).toEqual([1, 888])
    expect(t.rest.fn).not.toHaveBeenCalled()
    expect(t.onUnauthorized).not.toHaveBeenCalled()
    await expect(t.gh.source()).resolves.toBe('gh')
  })

  it('gh 404 는 목록 조회 자체에서도 not_found(GitHubError) — REST 폴백하지 않음', async () => {
    const t = setup({ ghAvailable: true, ghRun: async () => fail('gh: Not Found (HTTP 404)') })
    const err = await t.gh.defaultBranch('o', 'missing').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GitHubError)
    expect((err as GitHubError).code).toBe('not_found')
    expect(t.rest.fn).not.toHaveBeenCalled()
  })
})

describe('getRepo · getIssue (원격 CLI 의 이슈 지정용)', () => {
  it('getRepo 는 GitHub 표기(대소문자)로, getIssue 는 PR 이면 not_found', async () => {
    const t = setup({
      route: (u) =>
        u.pathname === '/repos/acme/widgets'
          ? json({ name: 'Widgets', owner: { login: 'Acme' }, default_branch: 'main' })
          : u.pathname === '/repos/acme/widgets/issues/7'
            ? json({ number: 7, title: 'Seven', state: 'open', html_url: 'u7' })
            : u.pathname === '/repos/acme/widgets/issues/8'
              ? json({ number: 8, title: 'PR', state: 'open', html_url: 'u8', pull_request: {} })
              : json({}, { status: 404 }),
    })
    await expect(t.gh.getRepo('acme', 'widgets')).resolves.toEqual({ owner: 'Acme', name: 'Widgets', defaultBranch: 'main' })
    await expect(t.gh.getIssue('acme', 'widgets', 7)).resolves.toEqual({ number: 7, title: 'Seven', state: 'open', htmlUrl: 'u7' })
    await expect(t.gh.getIssue('acme', 'widgets', 8)).rejects.toMatchObject({ code: 'not_found' })
  })
})
