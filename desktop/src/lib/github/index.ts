// GitHubClient — gh(우선) / REST(폴백). 서버 캐시 없음(D-22).
import type { TauriApi } from '../tauri'
import type { CreatePrInput, GitHubIssue, GitHubOwner, GitHubPr, GitHubRepo } from './types'

export * from './types'

export const GITHUB_API_BASE = 'https://api.github.com'
export const PER_PAGE = 100
export const MAX_PAGES = 5

export interface GitHubClientDeps {
  tauri: Pick<TauriApi, 'ghAvailable' | 'ghRun'>
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
  openPrForBranch(owner: string, repo: string, branch: string): Promise<GitHubPr | null>
  createPr(input: CreatePrInput): Promise<GitHubPr>
}

// STUB (Phase 6.1 Red)
export function createGitHubClient(_deps: GitHubClientDeps): GitHubClient {
  const notImplemented = async (): Promise<never> => {
    throw new Error('not implemented')
  }
  return {
    source: notImplemented,
    listOwners: notImplemented,
    listRepos: notImplemented,
    listIssues: notImplemented,
    defaultBranch: notImplemented,
    openPrForBranch: notImplemented,
    createPr: notImplemented,
  }
}
