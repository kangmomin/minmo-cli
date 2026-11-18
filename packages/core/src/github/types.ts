export type GitHubOwner = { login: string; kind: 'user' | 'org'; avatarUrl: string | null }
export type GitHubRepo = { owner: string; name: string; defaultBranch: string }
/** assignees = 담당자의 login 목록(없으면 빈 배열) */
export type GitHubIssue = { number: number; title: string; state: 'open' | 'closed'; htmlUrl: string; assignees: string[] }
/** 이슈 하나를 조회할 때만 본문을 받는다(목록 캐시에는 본문을 두지 않음) */
export type GitHubIssueDetail = GitHubIssue & { body: string }
/** 보낼 필드만 넣는다 — 넣지 않은 필드는 GitHub 값을 그대로 둔다 */
export type UpdateIssueInput = { title?: string; body?: string }
/** GitHub state_reason: 완료 / 계획 없음 */
export type IssueCloseReason = 'completed' | 'not_planned'
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
