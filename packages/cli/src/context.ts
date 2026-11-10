// 명령·TUI 가 함께 쓰는 실행 컨텍스트: 서버(역터널) API, GitHub(gh 우선), worktree 서비스, 로컬 상태.
import { homedir, platform as osPlatform } from 'node:os'

import { ApiError } from '@minmo/api-client'
import type { ApiClient, Effective, Me, Platform } from '@minmo/api-client'
import { createGitHubClient, createWorktreeService, isOfflineError, isUnauthorized } from '@minmo/core'
import type { GitHubClient, SetupLogEvent, WorktreeService } from '@minmo/core'

import { createNodeHost } from './host/node'
import type { NodeHost } from './host/node'
import { createServerApi, describeServer, resolveServer } from './server'
import type { ServerTarget } from './server'
import { defaultPaths, loadCredentials, loadState, statePathStore, updateState } from './store'
import type { Credentials, Paths, State } from './store'

/** 사용자에게 보여 줄 오류 — 스택 없이 메시지만 출력하고 종료 코드를 정한다 */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message)
    this.name = 'CliError'
  }
}

export type Out = { log(s: string): void; error(s: string): void }

export type Ctx = {
  paths: Paths
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
}

export async function createContext(o: CreateContextOptions = {}): Promise<Ctx> {
  const env = o.env ?? process.env
  const paths = o.paths ?? defaultPaths(env)
  const creds = await loadCredentials(paths)
  const state = await loadState(paths)
  const server = resolveServer(paths.socket, env)
  const session = creds?.session ?? null
  const api = o.api ?? createServerApi(server, () => session)
  const host = o.host ?? createNodeHost(env)
  const platform = toPlatform(osPlatform())
  const home = homedir()
  const out = o.out ?? { log: (s) => console.log(s), error: (s) => console.error(s) }

  // GitHub REST 폴백 토큰: 환경 변수 → 서버(E4). 서버 토큰은 메모리에만 둔다
  let serverToken: Promise<string> | null = null
  const github = o.github ?? createGitHubClient({
    tauri: host,
    fetch: o.fetch ?? ((input, init) => globalThis.fetch(input, init)),
    getToken: async () => {
      const fromEnv = env.GITHUB_TOKEN || env.GH_TOKEN
      if (fromEnv) return fromEnv
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
  const effKey = (owner: string, repo: string) => `${owner}/${repo}`.toLowerCase()
  const worktree = createWorktreeService({
    tauri: host,
    getEffective: async (owner, repo) => {
      try {
        const eff: Effective = await api.getEffective(owner, repo)
        await updateState(paths, state, (s) => {
          s.effective[effKey(owner, repo)] = eff
        }).catch(() => undefined)
        return eff
      } catch (e) {
        // 터널이 끊겨도 한 번 받아 둔 설정으로는 열 수 있게
        const cached = state.effective[effKey(owner, repo)]
        if (cached && isOfflineError(e)) return cached
        throw e
      }
    },
    defaultBranch: (owner, repo) => github.defaultBranch(owner, repo),
    pathStore: statePathStore(paths, state),
    home,
    platform,
    onLog: (e) => logger?.(e),
  })

  return {
    paths,
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

/** 서버 오류 → 사용자 안내 */
export function serverErrorMessage(e: unknown, server: ServerTarget): string {
  if (isUnauthorized(e)) return '세션이 만료되었거나 끊겼습니다 — 데스크탑의 "원격 CLI 접속"에서 새 코드를 발급해 `minmo login <코드>` 하세요'
  if (isOfflineError(e))
    return `minmo 서버에 연결할 수 없습니다(${describeServer(server)}) — SSH 역터널(RemoteForward)로 접속했는지, PC 의 minmo 서버가 켜져 있는지 확인하세요. \`minmo doctor\``
  if (e instanceof ApiError) return `서버 오류(${e.code})`
  return e instanceof Error ? e.message : String(e)
}

/**
 * 로그인 확인 + 서버 계정 확인. 소켓·포트가 다른 서버로 연결돼 있으면(다른 사용자의 터널 등) 저장된 로그인과 달라 막는다.
 */
export async function requireLogin(ctx: Ctx): Promise<Me> {
  if (!ctx.creds?.session) throw new CliError('로그인이 필요합니다 — 데스크탑의 "원격 CLI 접속"에서 코드를 발급해 `minmo login <코드>` 하세요')
  let me: Me
  try {
    me = await ctx.api.me()
  } catch (e) {
    throw new CliError(serverErrorMessage(e, ctx.server))
  }
  if (me.githubLogin !== ctx.creds.login) {
    throw new CliError(`연결된 서버의 계정(${me.githubLogin})이 로그인한 계정(${ctx.creds.login})과 다릅니다 — SSH 터널이 다른 서버로 연결됐을 수 있습니다`)
  }
  return me
}
