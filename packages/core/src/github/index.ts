// GitHubClient — gh(우선) / REST(폴백). 서버 캐시 없음(D-22).
import type { GhHost } from '../host'
import { GhFailure, createGhTransport } from './ghCli'
import { createRestTransport } from './rest'
import type { GitHubTransport } from './transport'
import { GitHubError } from './types'
import type { CreatePrInput, CreateRepoInput, GitHubIssue, GitHubOwner, GitHubPr, GitHubRepo } from './types'

export * from './types'

export const GITHUB_API_BASE = 'https://api.github.com'
export const PER_PAGE = 100
export const MAX_PAGES = 5

export interface GitHubClientDeps {
  tauri: Pick<GhHost, 'ghAvailable' | 'ghRun'>
  fetch: typeof fetch
  /** 서버 E4 로 받은 GitHub 토큰 (REST 폴백용) */
  getToken(): Promise<string>
  /** REST 401 → 로그인 화면 이동·세션 폐기 (EC-02) */
  onUnauthorized(): void
  apiBase?: string
}

export interface GitHubClient {
  /** 현재 사용 경로 — 'rest' 면 트리 상단 "gh 미사용(REST)" (EC-01) */
  source(): Promise<'gh' | 'rest'>
  /** 개인 계정(첫 번째) + /user/orgs */
  listOwners(): Promise<GitHubOwner[]>
  listRepos(owner: GitHubOwner): Promise<GitHubRepo[]>
  /** state=all, per_page=100, ≤5페이지, PR 제외. ensureNumbers 중 목록에 없는 번호는 개별 조회로 보충 */
  listIssues(owner: string, repo: string, opts?: { ensureNumbers?: number[] }): Promise<GitHubIssue[]>
  defaultBranch(owner: string, repo: string): Promise<string>
  /** 저장소 하나 — 대소문자를 GitHub 표기(canonical)로 맞출 때 쓴다 */
  getRepo(owner: string, repo: string): Promise<GitHubRepo>
  /** 이슈 하나(PR 이면 not_found) */
  getIssue(owner: string, repo: string, number: number): Promise<GitHubIssue>
  openPrForBranch(owner: string, repo: string, branch: string): Promise<GitHubPr | null>
  createPr(input: CreatePrInput): Promise<GitHubPr>
  /** 빈 저장소를 만든다(README 등 첫 커밋 없이 — 로컬 저장소를 그대로 push 할 수 있게) */
  createRepo(input: CreateRepoInput): Promise<GitHubRepo>
  createIssue(owner: string, repo: string, title: string): Promise<GitHubIssue>
  closeIssue(owner: string, repo: string, number: number): Promise<void>
}

type RawOwner = { login: string; avatar_url?: string | null }
type RawRepo = { name: string; owner: { login: string }; default_branch?: string | null }
type RawIssue = { number: number; title: string; state: string; html_url: string; pull_request?: unknown }
type RawPr = { number: number; html_url: string }

const enc = encodeURIComponent

const toIssue = (r: RawIssue): GitHubIssue => ({
  number: r.number,
  title: r.title,
  state: r.state === 'closed' ? 'closed' : 'open',
  htmlUrl: r.html_url,
})

const toRepo = (r: RawRepo): GitHubRepo => ({ owner: r.owner.login, name: r.name, defaultBranch: r.default_branch || 'main' })

export function createGitHubClient(deps: GitHubClientDeps): GitHubClient {
  const gh = createGhTransport(deps.tauri)
  const rest = createRestTransport({
    fetch: deps.fetch,
    getToken: deps.getToken,
    onUnauthorized: deps.onUnauthorized,
    apiBase: deps.apiBase ?? GITHUB_API_BASE,
  })

  let ghAvailable: Promise<boolean> | null = null
  /** gh 인증 실패를 한 번 보면 이후 REST 로 고정 (EC-01) */
  let ghBroken = false

  const checkGh = () => {
    ghAvailable ??= deps.tauri.ghAvailable().catch(() => false)
    return ghAvailable
  }

  async function source(): Promise<'gh' | 'rest'> {
    return !ghBroken && (await checkGh()) ? 'gh' : 'rest'
  }

  /** gh 로 시도하고, gh 가 실패(rate limit 제외)하면 같은 동작을 REST 로 다시 수행 */
  async function withTransport<T>(fn: (t: GitHubTransport) => Promise<T>): Promise<T> {
    if ((await source()) === 'gh') {
      try {
        return await fn(gh)
      } catch (e) {
        if (!(e instanceof GhFailure)) throw e
        if (e.auth) ghBroken = true
      }
    }
    return fn(rest)
  }

  /** per_page=100, 최대 5페이지 */
  async function paged<T>(t: GitHubTransport, path: string): Promise<T[]> {
    const out: T[] = []
    const sep = path.includes('?') ? '&' : '?'
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await t.get(`${path}${sep}per_page=${PER_PAGE}&page=${page}`)
      const items = Array.isArray(res.data) ? (res.data as T[]) : []
      out.push(...items)
      const more = res.hasNext ?? items.length >= PER_PAGE
      if (!more) break
    }
    return out
  }

  return {
    source,

    listOwners: () =>
      withTransport(async (t) => {
        const user = (await t.get('user')).data as RawOwner
        const orgs = await paged<RawOwner>(t, 'user/orgs')
        return [
          { login: user.login, kind: 'user' as const, avatarUrl: user.avatar_url ?? null },
          ...orgs.map((o) => ({ login: o.login, kind: 'org' as const, avatarUrl: o.avatar_url ?? null })),
        ]
      }),

    listRepos: (owner) =>
      withTransport(async (t) => {
        const path =
          owner.kind === 'user' ? 'user/repos?affiliation=owner&sort=full_name' : `orgs/${enc(owner.login)}/repos?type=all&sort=full_name`
        return (await paged<RawRepo>(t, path)).map(toRepo)
      }),

    listIssues: (owner, repo, opts) =>
      withTransport(async (t) => {
        const raw = await paged<RawIssue>(t, `repos/${enc(owner)}/${enc(repo)}/issues?state=all`)
        const seen = new Set(raw.map((r) => r.number))
        const issues = raw.filter((r) => r.pull_request === undefined).map(toIssue)
        // AC-03: worktree 가 있는 이슈는 상한 밖·closed 여도 보이도록 개별 보충
        for (const n of opts?.ensureNumbers ?? []) {
          if (seen.has(n)) continue
          seen.add(n)
          try {
            const r = (await t.get(`repos/${enc(owner)}/${enc(repo)}/issues/${n}`)).data as RawIssue
            if (r && r.pull_request === undefined) issues.push(toIssue(r))
          } catch (e) {
            if (e instanceof GitHubError && e.code === 'not_found') continue
            throw e
          }
        }
        return issues
      }),

    defaultBranch: (owner, repo) =>
      withTransport(async (t) => toRepo((await t.get(`repos/${enc(owner)}/${enc(repo)}`)).data as RawRepo).defaultBranch),

    getRepo: (owner, repo) => withTransport(async (t) => toRepo((await t.get(`repos/${enc(owner)}/${enc(repo)}`)).data as RawRepo)),

    getIssue: (owner, repo, number) =>
      withTransport(async (t) => {
        const r = (await t.get(`repos/${enc(owner)}/${enc(repo)}/issues/${number}`)).data as RawIssue
        if (r.pull_request !== undefined) throw new GitHubError('not_found', { message: `#${number} 은 PR 입니다` })
        return toIssue(r)
      }),

    openPrForBranch: (owner, repo, branch) =>
      withTransport(async (t) => {
        const head = enc(`${owner}:${branch}`)
        const res = await t.get(`repos/${enc(owner)}/${enc(repo)}/pulls?state=open&head=${head}&per_page=1`)
        const list = Array.isArray(res.data) ? (res.data as RawPr[]) : []
        return list.length > 0 ? { number: list[0].number, url: list[0].html_url } : null
      }),

    createPr: (input) =>
      withTransport(async (t) => {
        const res = await t.post(`repos/${enc(input.owner)}/${enc(input.repo)}/pulls`, {
          title: input.title,
          body: input.body,
          head: input.head,
          base: input.base,
          draft: input.draft,
        })
        const pr = res.data as RawPr
        return { number: pr.number, url: pr.html_url }
      }),

    createRepo: (input) =>
      withTransport(async (t) => {
        const path = input.org === null ? 'user/repos' : `orgs/${enc(input.org)}/repos`
        return toRepo((await t.post(path, { name: input.name, private: input.private, auto_init: false })).data as RawRepo)
      }),

    createIssue: (owner, repo, title) =>
      withTransport(async (t) => toIssue((await t.post(`repos/${enc(owner)}/${enc(repo)}/issues`, { title })).data as RawIssue)),

    closeIssue: (owner, repo, number) =>
      withTransport(async (t) => {
        await t.patch(`repos/${enc(owner)}/${enc(repo)}/issues/${number}`, { state: 'closed' })
      }),
  }
}
