// 명령이 함께 쓰는 실행 컨텍스트: 데스크탑의 minmo 서버(역터널) API 와 그 위의 공유 데이터(ctx.data), 로그인 정보.
import type { ApiClient, Me } from '@minmo/api-client'

import { checkLogin, serverBackend } from './backend'
import type { Backend } from './backend'
import { createServerApi, resolveServer } from './server'
import type { ServerTarget } from './server'
import { defaultPaths, loadCredentials } from './store'
import type { Credentials, Paths } from './store'

export { CliError, serverErrorMessage, toCliError } from './errors'

export type Out = { log(s: string): void; error(s: string): void }

export type Ctx = {
  paths: Paths
  /** 데스크탑과 공유하는 데이터 — 보일 저장소·설정 */
  data: Backend
  server: ServerTarget
  api: ApiClient
  creds: Credentials | null
  out: Out
}

export type CreateContextOptions = {
  env?: NodeJS.ProcessEnv
  paths?: Paths
  out?: Out
  api?: ApiClient
  /** 테스트용: 서버 연결 대상(기본은 OS·env 로 결정) */
  serverTarget?: ServerTarget
}

export async function createContext(o: CreateContextOptions = {}): Promise<Ctx> {
  const env = o.env ?? process.env
  const paths = o.paths ?? defaultPaths(env)
  const creds = await loadCredentials(paths)
  const server = o.serverTarget ?? resolveServer(paths.socket, env)
  const session = creds?.session ?? null
  const api = o.api ?? createServerApi(server, () => session)
  const out = o.out ?? { log: (s) => console.log(s), error: (s) => console.error(s) }
  return { paths, data: serverBackend({ api, server, creds }), server, api, creds, out }
}

/** 서버 로그인·계정 확인 */
export function requireLogin(ctx: Ctx): Promise<Me> {
  return checkLogin(ctx.api, ctx.creds, ctx.server)
}
