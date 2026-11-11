// gh CLI 전송 계층 (우선 경로). `gh api` 로 REST 와 같은 경로를 호출한다.
import type { GhHost } from '../host'
import { GitHubError } from './types'
import type { GitHubTransport, TransportResponse } from './transport'

/** gh 실패 중 REST 폴백 대상(인증 실패 등). rate limit 은 폴백하지 않으므로 GitHubError 로 따로 던진다 */
export class GhFailure extends Error {
  stderr: string
  /** 인증 문제로 보이면 true → 이후 source() 를 'rest' 로 본다 */
  auth: boolean
  constructor(stderr: string) {
    super(stderr || 'gh failed')
    this.name = 'GhFailure'
    this.stderr = stderr
    this.auth = /auth login|authentication|not logged in|HTTP 401|bad credentials/i.test(stderr)
  }
}

export function createGhTransport(tauri: Pick<GhHost, 'ghRun'>): GitHubTransport {
  async function run(args: string[], stdin?: string): Promise<TransportResponse> {
    const res = await tauri.ghRun(args, stdin === undefined ? undefined : { stdin })
    if (res.code !== 0) {
      // EC-18: gh 는 재시도 시각을 알 수 없다 → retryAt null, REST 재시도도 하지 않음
      if (/rate limit/i.test(res.stderr)) {
        throw new GitHubError('rate_limited', { message: res.stderr.trim(), retryAt: null })
      }
      // PF-01: 삭제·이전된 리소스(404/410)는 REST 로 다시 물어도 같다 → 폴백하지 않고 not_found
      const gone = /\bHTTP (404|410)\b/.exec(res.stderr)
      if (gone) throw new GitHubError('not_found', { status: Number(gone[1]), message: res.stderr.trim() })
      throw new GhFailure(res.stderr)
    }
    const text = res.stdout.trim()
    return { data: text ? (JSON.parse(text) as unknown) : null }
  }

  return {
    get: (path) => run(['api', path]),
    post: (path, body) => run(['api', '-X', 'POST', path, '--input', '-'], JSON.stringify(body)),
    patch: (path, body) => run(['api', '-X', 'PATCH', path, '--input', '-'], JSON.stringify(body)),
  }
}
