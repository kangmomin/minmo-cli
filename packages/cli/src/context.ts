// 명령·TUI 가 함께 쓰는 실행 컨텍스트: 모드별 데이터 출처(ctx.data), 서버(역터널) API, GitHub(gh 우선), worktree 서비스, 로컬 상태.
import { homedir, platform as osPlatform } from 'node:os'

import type { ApiClient, Me, Platform } from '@minmo/api-client'
import { createGitHubClient, createWorktreeService } from '@minmo/core'
import type { GitHubClient, SetupLogEvent, WorktreeService } from '@minmo/core'

import { checkLogin, localBackend, serverBackend } from './backend'
import type { Backend } from './backend'
import { CliError } from './errors'
import { createNodeHost } from './host/node'
import type { NodeHost } from './host/node'
import { createServerApi, resolveServer } from './server'
import type { ServerTarget } from './server'
import { defaultPaths, loadConfig, loadCredentials, loadState, statePathStore } from './store'
import type { Config, Credentials, Mode, Paths, State } from './store'

export { CliError, serverErrorMessage, toCliError } from './errors'

export type Out = { log(s: string): void; error(s: string): void }

export type Ctx = {
  paths: Paths
  /** server: PC 의 minmo 서버(역터널) · local: 서버 없이 이 기기의 설정·사본 */
  mode: Mode
  config: Config
  /** 모드별 데이터 출처 — 보일 저장소·설정 */
  data: Backend
  server: ServerTarget
  api: ApiClient
  creds: Credentials | null
  state: State
  github: GitHubClient
  worktree: WorktreeService
  host: NodeHost
  platform: Platform
  home: string
  out: Out
  /** 준비 로그를 받을 곳(명령은 출력, TUI 는 화면) */
  onLog(cb: ((e: SetupLogEvent) => void) | null): void
}

export function toPlatform(p: NodeJS.Platform): Platform {
  return p === 'win32' ? 'win32' : p === 'darwin' ? 'darwin' : 'linux'
}

export type CreateContextOptions = {
  env?: NodeJS.ProcessEnv
  paths?: Paths
  host?: NodeHost
  out?: Out
  fetch?: typeof fetch
  api?: ApiClient
  github?: GitHubClient
  /** 테스트용: 서버 연결 대상(기본은 OS·env 로 결정) */
  serverTarget?: ServerTarget
}

export const GITHUB_AUTH_REQUIRED = 'GitHub 인증이 필요합니다 — `gh auth login` 후 `gh auth setup-git`(권장) 또는 GITHUB_TOKEN 환경 변수'

export async function createContext(o: CreateContextOptions = {}): Promise<Ctx> {
  const env = o.env ?? process.env
  const paths = o.paths ?? defaultPaths(env)
  const creds = await loadCredentials(paths)
  const state = await loadState(paths)
  const config = await loadConfig(paths)
  const mode = config.mode
  const server = o.serverTarget ?? resolveServer(paths.socket, env)
  const session = creds?.session ?? null
  const api = o.api ?? createServerApi(server, () => session)
  const host = o.host ?? createNodeHost(env)
  const platform = toPlatform(osPlatform())
  const home = homedir()
  const out = o.out ?? { log: (s) => console.log(s), error: (s) => console.error(s) }
  const data = mode === 'local' ? localBackend({ paths, state, config }) : serverBackend({ api, server, creds, paths, state })

  // GitHub REST 폴백 토큰: 환경 변수 → 서버(E4, 서버 모드만). 서버 토큰은 메모리에만 둔다
  let serverToken: Promise<string> | null = null
  const github = o.github ?? createGitHubClient({
    tauri: host,
    fetch: o.fetch ?? ((input, init) => globalThis.fetch(input, init)),
    getToken: async () => {
      const fromEnv = env.GITHUB_TOKEN || env.GH_TOKEN
      if (fromEnv) return fromEnv
      if (mode === 'local') throw new CliError(GITHUB_AUTH_REQUIRED)
      // 실패한 조회는 캐시하지 않는다 — 터널이 잠깐 끊겼다고 REST 폴백이 계속 막히지 않게
      serverToken ??= api.getGithubToken().then(
        (t) => t.accessToken,
        (e: unknown) => {
          serverToken = null
          throw e
        },
      )
      return serverToken
    },
    onUnauthorized: () => {
      serverToken = null
    },
    apiBase: env.MINMO_GITHUB_API_BASE,
  })

  let logger: ((e: SetupLogEvent) => void) | null = null
  const worktree = createWorktreeService({
    tauri: host,
    getEffective: (owner, repo) => data.getEffective(owner, repo),
    defaultBranch: (owner, repo) => github.defaultBranch(owner, repo),
    pathStore: statePathStore(paths, state),
    home,
    platform,
    onLog: (e) => logger?.(e),
  })

  return {
    paths,
    mode,
    config,
    data,
    server,
    api,
    creds,
    state,
    github,
    worktree,
    host,
    platform,
    home,
    out,
    onLog: (cb) => {
      logger = cb
    },
  }
}

/** 서버 로그인·계정 확인(계정 명령용 — 모드와 상관없이 서버를 쓴다) */
export function requireLogin(ctx: Ctx): Promise<Me> {
  return checkLogin(ctx.api, ctx.creds, ctx.server)
}
