// REST 전송 계층 (gh 폴백). 서버 E4 로 받은 GitHub 토큰 사용.
import { GitHubError } from './types'
import type { GitHubTransport, TransportResponse } from './transport'

export interface RestDeps {
  fetch: typeof fetch
  getToken(): Promise<string>
  onUnauthorized(): void
  apiBase: string
}

/** EC-18: 403 + x-ratelimit-remaining:0 또는 429 → rate limit. 재시도 시각은 reset(epoch) 또는 retry-after(초) */
function rateLimitError(res: Response): GitHubError | null {
  const remaining = res.headers.get('x-ratelimit-remaining')
  const isLimited = res.status === 429 || (res.status === 403 && remaining === '0')
  if (!isLimited) return null
  const retryAfter = res.headers.get('retry-after')
  const reset = res.headers.get('x-ratelimit-reset')
  let retryAt: Date | null = null
  if (retryAfter && /^\d+$/.test(retryAfter)) retryAt = new Date(Date.now() + Number(retryAfter) * 1000)
  else if (reset && /^\d+$/.test(reset)) retryAt = new Date(Number(reset) * 1000)
  return new GitHubError('rate_limited', { status: res.status, retryAt, message: 'GitHub API rate limit' })
}

async function messageOf(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { message?: unknown }
    return typeof body.message === 'string' ? body.message : undefined
  } catch {
    return undefined
  }
}

const hasNextLink = (link: string | null) => !!link && /rel="next"/.test(link)

export function createRestTransport(deps: RestDeps): GitHubTransport {
  const base = deps.apiBase.replace(/\/+$/, '')

  async function request(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<TransportResponse> {
    const token = await deps.getToken()
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    let res: Response
    try {
      res = await deps.fetch(`${base}/${path.replace(/^\/+/, '')}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    } catch (e) {
      throw new GitHubError('network', { message: e instanceof Error ? e.message : String(e) })
    }
    if (res.ok) {
      const data: unknown = res.status === 204 ? null : await res.json()
      return { data, hasNext: hasNextLink(res.headers.get('link')) }
    }
    if (res.status === 401) {
      // EC-02: 서버가 준 토큰도 거부 → 로그인 화면
      deps.onUnauthorized()
      throw new GitHubError('unauthorized', { status: 401, message: await messageOf(res) })
    }
    const limited = rateLimitError(res)
    if (limited) throw limited
    const message = await messageOf(res)
    if (res.status === 403) throw new GitHubError('forbidden', { status: 403, message })
    // 410 = 삭제된 이슈 — 404 와 같이 취급(PF-01)
    if (res.status === 404 || res.status === 410) throw new GitHubError('not_found', { status: res.status, message })
    throw new GitHubError('unknown', { status: res.status, message })
  }

  return {
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, body),
    patch: (path, body) => request('PATCH', path, body),
  }
}
