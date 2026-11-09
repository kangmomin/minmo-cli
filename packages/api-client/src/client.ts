import type {
  Effective,
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

const notImplemented = (): never => {
  throw new Error('not implemented')
}

// STUB (Phase 6.1 Red): 6.2 구현자가 계약대로 채운다.
export function createApiClient(_opts: ApiClientOptions): ApiClient {
  return {
    healthz: async () => notImplemented(),
    startLogin: async () => notImplemented(),
    me: async () => notImplemented(),
    getGithubToken: async () => notImplemented(),
    logout: async () => notImplemented(),
    getSettings: async () => notImplemented(),
    putSettings: async () => notImplemented(),
    getEffective: async () => notImplemented(),
    getNotes: async () => notImplemented(),
    putNotes: async () => notImplemented(),
  }
}
