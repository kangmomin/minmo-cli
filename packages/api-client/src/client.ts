import { ApiError } from './errors'
import type {
  ApiErrorCode,
  Effective,
  ErrorCode,
  GithubToken,
  Health,
  LoginStart,
  Me,
  Notes,
  NotesInput,
  SettingsInput,
  SettingsRecord,
  SettingsScope,
  TokenOverride,
} from './types'

export type ApiClientOptions = {
  baseUrl: string
  /** 요청 시점마다 호출된다. null 이면 Authorization 헤더 생략 */
  getToken: () => string | null
  fetch?: typeof fetch
}

export interface ApiClient {
  healthz(): Promise<Health>
  startLogin(): Promise<LoginStart>
  me(opts?: TokenOverride): Promise<Me>
  getGithubToken(opts?: TokenOverride): Promise<GithubToken>
  /** 204·401 모두 resolve(undefined) */
  logout(opts?: TokenOverride): Promise<void>
  getSettings(scope: SettingsScope): Promise<SettingsRecord>
  putSettings(scope: SettingsScope, input: SettingsInput): Promise<SettingsRecord>
  getEffective(owner: string, repo: string): Promise<Effective>
  getNotes(owner: string, repo: string, key: string): Promise<Notes>
  putNotes(owner: string, repo: string, key: string, input: NotesInput): Promise<Notes>
}

// 계약 ErrorCode union 과 1:1. 응답 body.error 가 여기에 속할 때만 그대로 쓴다.
const ERROR_CODES: ReadonlySet<string> = new Set<ErrorCode>([
  'unauthorized',
  'not_found',
  'method_not_allowed',
  'internal',
  'payload_too_large',
  'invalid_json',
  'invalid_path_param',
  'github_oauth_not_configured',
  'invalid_state',
  'missing_code',
  'access_denied',
  'invalid_code',
  'github_unavailable',
  'global_requires_all_fields',
  'invalid_template',
  'invalid_path_template',
  'script_too_large',
  'invalid_issue_key',
  'body_too_large',
  'invalid_base_updated_at',
  'conflict',
])

// body.error 가 ErrorCode 가 아닐 때(계약 v2.5 ApiError.code 규칙).
// 코드가 아예 없는(비JSON 등) 401/404/405/413 만 status 로 추정한다 — 세션 만료 판정·라우터 오류용.
// 5xx → server_error, 나머지 4xx(미지 코드·프록시 429 등) → http_error. offline 판정은 code 가 아닌 status 기준이다.
function fallbackCode(status: number, hasCode: boolean): ApiErrorCode {
  if (status >= 500) return 'server_error'
  if (!hasCode) {
    if (status === 401) return 'unauthorized'
    if (status === 404) return 'not_found'
    if (status === 405) return 'method_not_allowed'
    if (status === 413) return 'payload_too_large'
  }
  return 'http_error'
}

async function toApiError(res: Response): Promise<ApiError> {
  let body: unknown = undefined
  try {
    const text = await res.text()
    body = text ? JSON.parse(text) : undefined
  } catch {
    body = undefined
  }
  const obj = body && typeof body === 'object' ? (body as Record<string, unknown>) : undefined
  const raw = typeof obj?.error === 'string' ? obj.error : undefined
  const code: ApiErrorCode = raw !== undefined && ERROR_CODES.has(raw) ? (raw as ErrorCode) : fallbackCode(res.status, raw !== undefined)
  const field = typeof obj?.field === 'string' ? obj.field : undefined
  const message = typeof obj?.message === 'string' ? obj.message : undefined
  let current: Notes | undefined
  if (res.status === 409 && code === 'conflict' && obj) {
    // 409 는 flat {error, body, updatedAt} — 서버 현재값
    current = {
      body: typeof obj.body === 'string' ? obj.body : '',
      updatedAt: typeof obj.updatedAt === 'string' ? obj.updatedAt : null,
    }
  }
  return new ApiError({ status: res.status, code, field, current, message })
}

const seg = (s: string) => encodeURIComponent(s)

function scopePath(scope: SettingsScope): string {
  switch (scope.kind) {
    case 'global':
      return '/settings'
    case 'org':
      return `/orgs/${seg(scope.owner)}/settings`
    case 'project':
      return `/projects/${seg(scope.owner)}/${seg(scope.repo)}/settings`
  }
}

type RequestOpts = {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  body?: unknown
  /** false 면 Authorization 생략(E0·E1 무인증) */
  auth?: boolean
  token?: string
}

export function createApiClient(opts: ApiClientOptions): ApiClient {
  const baseUrl = opts.baseUrl.replace(/\/+$/, '')
  const doFetch: typeof fetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init))

  async function send(path: string, r: RequestOpts = {}): Promise<Response> {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (r.auth !== false) {
      const token = r.token ?? opts.getToken()
      if (token) headers.Authorization = `Bearer ${token}`
    }
    const init: RequestInit = { method: r.method ?? 'GET', headers }
    if (r.body !== undefined) {
      headers['Content-Type'] = 'application/json; charset=utf-8'
      init.body = JSON.stringify(r.body)
    }
    try {
      return await doFetch(`${baseUrl}${path}`, init)
    } catch (e) {
      throw new ApiError({ status: 0, code: 'network_error', message: e instanceof Error ? e.message : String(e) })
    }
  }

  async function request<T>(path: string, r: RequestOpts = {}): Promise<T> {
    const res = await send(path, r)
    if (!res.ok) throw await toApiError(res)
    if (res.status === 204) return undefined as T
    return (await res.json()) as T
  }

  const notesPath = (owner: string, repo: string, key: string) =>
    `/projects/${seg(owner)}/${seg(repo)}/issues/${seg(key)}/notes`

  return {
    healthz: () => request<Health>('/healthz', { auth: false }),
    startLogin: () => request<LoginStart>('/auth/github/start', { method: 'POST', auth: false }),
    me: (o) => request<Me>('/me', { token: o?.token }),
    getGithubToken: (o) => request<GithubToken>('/me/github-token', { token: o?.token }),
    logout: async (o) => {
      const res = await send('/auth/session', { method: 'DELETE', token: o?.token })
      // E5: 401 도 로그아웃 성공으로 취급
      if (res.ok || res.status === 401) return undefined
      throw await toApiError(res)
    },
    getSettings: (scope) => request<SettingsRecord>(scopePath(scope)),
    putSettings: (scope, input) => request<SettingsRecord>(scopePath(scope), { method: 'PUT', body: input }),
    getEffective: (owner, repo) => request<Effective>(`/projects/${seg(owner)}/${seg(repo)}/settings/effective`),
    getNotes: (owner, repo, key) => request<Notes>(notesPath(owner, repo, key)),
    putNotes: (owner, repo, key, input) => {
      // baseUpdatedAt 생략(무조건 덮어쓰기)과 null("행이 없어야 함")을 구분 — 생략이면 키 자체를 보내지 않는다
      const body: NotesInput = { body: input.body }
      if (input.baseUpdatedAt !== undefined) body.baseUpdatedAt = input.baseUpdatedAt
      return request<Notes>(notesPath(owner, repo, key), { method: 'PUT', body })
    },
  }
}
