export type GitHubOwner = { login: string; kind: 'user' | 'org'; avatarUrl: string | null }
export type GitHubRepo = { owner: string; name: string; defaultBranch: string }
export type GitHubIssue = { number: number; title: string; state: 'open' | 'closed'; htmlUrl: string }
export type CreateRepoInput = {
  /** 내 계정이면 null, 조직이면 그 login */
  org: string | null
  name: string
  private: boolean
}
export type GitHubPr = { number: number; url: string }
export type CreatePrInput = {
  owner: string
  repo: string
  base: string
  head: string
  title: string
  body: string
  draft: boolean
}

export type GitHubErrorCode = 'unauthorized' | 'rate_limited' | 'forbidden' | 'not_found' | 'network' | 'unknown'

export class GitHubError extends Error {
  code: GitHubErrorCode
  status?: number
  /** EC-18: 재시도 가능 시각. gh stderr 기반이면 null(시각 불명) */
  retryAt: Date | null
  constructor(code: GitHubErrorCode, init?: { message?: string; status?: number; retryAt?: Date | null }) {
    super(init?.message ?? code)
    this.name = 'GitHubError'
    this.code = code
    if (init?.status !== undefined) this.status = init.status
    this.retryAt = init?.retryAt ?? null
  }
}
