// GitHubClient — gh(우선) / REST(폴백). 서버 캐시 없음(D-22).
import type { GhHost } from '../host'
import { GhFailure, createGhTransport } from './ghCli'
import { createRestTransport } from './rest'
import type { GitHubTransport } from './transport'
import { GitHubError } from './types'
import type {
  CreatePrInput,
  CreateRepoInput,
  GitHubIssue,
  GitHubIssueDetail,
  GitHubOwner,
  GitHubPr,
  GitHubRepo,
  IssueCloseReason,
  RecentIssue,
  UpdateIssueInput,
} from './types'

export * from './types'

export const GITHUB_API_BASE = 'https://api.github.com'
export const PER_PAGE = 100
export const MAX_PAGES = 5
/** GitHub 검색 한 번의 결과 수 상한 */
export const SEARCH_PER_PAGE = 30

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
  /**
   * 열린 이슈를 GitHub 에서 찾는다(PR 제외, 최대 30개) — listIssues 의 상한 밖에 있는 이슈를 찾을 때 쓴다.
   * 제목은 GitHub 검색(단어 단위)으로, 검색어가 번호 하나(`42`·`#42`)면 그 번호의 이슈도 함께 조회한다
   */
  searchIssues(owner: string, repo: string, query: string): Promise<GitHubIssue[]>
  defaultBranch(owner: string, repo: string): Promise<string>
  /** 저장소 하나 — 대소문자를 GitHub 표기(canonical)로 맞출 때 쓴다 */
  getRepo(owner: string, repo: string): Promise<GitHubRepo>
  listRecentIssues(owner: string, repo: string, opts?: { creator?: string }): Promise<RecentIssue[]>
  latestNumber(owner: string, repo: string): Promise<number>
  /** 이슈 하나(PR 이면 not_found). 본문 줄바꿈은 \n 으로 맞춘다 */
  getIssue(owner: string, repo: string, number: number): Promise<GitHubIssueDetail>
  openPrForBranch(owner: string, repo: string, branch: string): Promise<GitHubPr | null>
  createPr(input: CreatePrInput): Promise<GitHubPr>
  /** 빈 저장소를 만든다(README 등 첫 커밋 없이 — 로컬 저장소를 그대로 push 할 수 있게) */
  createRepo(input: CreateRepoInput): Promise<GitHubRepo>
  /** body 가 비어 있으면 보내지 않는다(본문 없는 이슈) */
  createIssue(owner: string, repo: string, title: string, body?: string): Promise<GitHubIssue>
  /** input 에 있는 필드만 보낸다 */
  updateIssue(owner: string, repo: string, number: number, input: UpdateIssueInput): Promise<GitHubIssue>
  /** reason 이 없으면 state_reason 을 보내지 않는다(GitHub 기본값). 닫은 뒤의 이슈를 돌려준다 */
  closeIssue(owner: string, repo: string, number: number, reason?: IssueCloseReason): Promise<GitHubIssue>
  /**
   * login 을 담당자에 더한다. 바뀐 뒤의 이슈를 돌려준다.
   * GitHub 은 권한이 없는 요청을 오류 없이 무시한다 — 호출자가 결과의 assignees 로 확인한다
   */
  assignIssue(owner: string, repo: string, number: number, login: string): Promise<GitHubIssue>
  /** login 을 담당자에서 뺀다. 바뀐 뒤의 이슈를 돌려준다 */
  unassignIssue(owner: string, repo: string, number: number, login: string): Promise<GitHubIssue>
}

type RawOwner = { login: string; avatar_url?: string | null }
type RawRepo = { name: string; owner: { login: string }; default_branch?: string | null }
type RawIssue = {
  number: number
  title: string
  state: string
  html_url: string
  body?: string | null
  pull_request?: unknown
  assignees?: { login: string }[] | null
  user?: { login: string } | null
  author_association?: string | null
}
type RawPr = { number: number; html_url: string }

const enc = encodeURIComponent

const toIssue = (r: RawIssue): GitHubIssue => ({
  number: r.number,
  title: r.title,
  state: r.state === 'closed' ? 'closed' : 'open',
  htmlUrl: r.html_url,
  assignees: (r.assignees ?? []).map((a) => a.login),
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

    searchIssues: (owner, repo, query) =>
      withTransport(async (t) => {
        // 한정자 문자(: ")를 뺀다 — 검색어로 repo: 같은 한정자를 넣어 다른 저장소를 찾지 못하게
        const words = query.replace(/[:"]/g, ' ').split(/\s+/).filter(Boolean)
        if (words.length === 0) return []
        const q = `${words.join(' ')} repo:${owner}/${repo} is:issue is:open in:title`
        const byTitle = async () => {
          const data = (await t.get(`search/issues?q=${enc(q)}&per_page=${SEARCH_PER_PAGE}`)).data as { items?: RawIssue[] } | null
          return Array.isArray(data?.items) ? data.items : []
        }
        // GitHub 검색은 번호로 찾지 못한다 → 번호 하나만 친 경우 그 이슈를 직접 조회한다
        const byNumber = async (): Promise<RawIssue[]> => {
          const m = words.length === 1 ? /^#?(\d+)$/.exec(words[0]) : null
          if (!m) return []
          try {
            const r = (await t.get(`repos/${enc(owner)}/${enc(repo)}/issues/${Number(m[1])}`)).data as RawIssue | null
            return r ? [r] : []
          } catch (e) {
            if (e instanceof GitHubError && e.code === 'not_found') return []
            throw e
          }
        }
        const [numbered, titled] = await Promise.all([byNumber(), byTitle()])
        const seen = new Set<number>()
        return [...numbered, ...titled]
          .filter((r) => r.pull_request === undefined && r.state !== 'closed' && !seen.has(r.number) && !!seen.add(r.number))
          .map(toIssue)
      }),

    defaultBranch: (owner, repo) =>
      withTransport(async (t) => toRepo((await t.get(`repos/${enc(owner)}/${enc(repo)}`)).data as RawRepo).defaultBranch),

    getRepo: (owner, repo) => withTransport(async (t) => toRepo((await t.get(`repos/${enc(owner)}/${enc(repo)}`)).data as RawRepo)),

    listRecentIssues: (owner, repo, opts) =>
      withTransport(async (t) => {
        const creator = opts?.creator ? `&creator=${enc(opts.creator)}` : ''
        const res = await t.get(`repos/${enc(owner)}/${enc(repo)}/issues?state=open&sort=created&direction=desc&per_page=50${creator}`)
        const raw = Array.isArray(res.data) ? (res.data as RawIssue[]) : []
        return raw
          .filter((r) => r.pull_request === undefined)
          .map((r) => ({ ...toIssue(r), author: r.user?.login ?? null, authorAssociation: r.author_association ?? null }))
      }),

    latestNumber: (owner, repo) =>
      withTransport(async (t) => {
        const res = await t.get(`repos/${enc(owner)}/${enc(repo)}/issues?state=all&sort=created&direction=desc&per_page=1`)
        const raw = Array.isArray(res.data) ? (res.data as RawIssue[]) : []
        return raw.reduce((max, r) => Math.max(max, r.number), 0)
      }),

    getIssue: (owner, repo, number) =>
      withTransport(async (t) => {
        const r = (await t.get(`repos/${enc(owner)}/${enc(repo)}/issues/${number}`)).data as RawIssue
        if (r.pull_request !== undefined) throw new GitHubError('not_found', { message: `#${number} 은 PR 입니다` })
        // GitHub 웹에서 쓴 본문은 \r\n 이다 — textarea 는 \n 으로 바꾸므로 맞춰 두어야 "안 바뀐 본문"을 바뀐 것으로 보지 않는다
        return { ...toIssue(r), body: (r.body ?? '').replace(/\r\n/g, '\n') }
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

    createIssue: (owner, repo, title, body) =>
      withTransport(async (t) => toIssue((await t.post(`repos/${enc(owner)}/${enc(repo)}/issues`, body ? { title, body } : { title })).data as RawIssue)),

    updateIssue: (owner, repo, number, input) =>
      withTransport(async (t) => {
        const patch: UpdateIssueInput = {}
        if (input.title !== undefined) patch.title = input.title
        if (input.body !== undefined) patch.body = input.body
        return toIssue((await t.patch(`repos/${enc(owner)}/${enc(repo)}/issues/${number}`, patch)).data as RawIssue)
      }),

    closeIssue: (owner, repo, number, reason) =>
      withTransport(async (t) => {
        const body = reason ? { state: 'closed', state_reason: reason } : { state: 'closed' }
        return toIssue((await t.patch(`repos/${enc(owner)}/${enc(repo)}/issues/${number}`, body)).data as RawIssue)
      }),

    // 목록 전체를 PATCH 로 덮어쓰지 않는다 — 그 사이에 다른 사람이 한 assign 을 지우지 않게 한 명만 더하고 뺀다
    assignIssue: (owner, repo, number, login) =>
      withTransport(async (t) => toIssue((await t.post(`repos/${enc(owner)}/${enc(repo)}/issues/${number}/assignees`, { assignees: [login] })).data as RawIssue)),

    unassignIssue: (owner, repo, number, login) =>
      withTransport(async (t) => toIssue((await t.delete(`repos/${enc(owner)}/${enc(repo)}/issues/${number}/assignees`, { assignees: [login] })).data as RawIssue)),
  }
}
