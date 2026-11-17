// CLI 테스트용 가짜 서버 API·컨텍스트
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { vi } from 'vitest'

import type { ApiClient, Effective, SettingsRecord, VisibleRepos } from '@minmo/api-client'
import type { Mocked } from '@minmo/core/testing'

import { createContext } from '../context'
import type { Ctx, Out } from '../context'
import { saveCredentials } from '../store'
import type { Paths } from '../store'

function mockAll<T extends object>(base: T, overrides: Partial<T>): Mocked<T> {
  const merged = { ...base, ...overrides }
  return Object.fromEntries(Object.entries(merged).map(([k, fn]) => [k, vi.fn(fn as (...a: unknown[]) => unknown)])) as unknown as Mocked<T>
}

const unexpected = (name: string) => async () => {
  throw new Error(`unexpected api call: ${name}`)
}

export const EMPTY_RECORD: SettingsRecord = {
  branchTemplate: null,
  etcBranchName: null,
  worktreePath: null,
  mainClonePath: null,
  postCreateScript: null,
  sparsePaths: null,
  postCreateScriptPosix: null,
  ignoredCopyExclude: null,
  updatedAt: null,
}

export const EFFECTIVE: Effective = {
  values: {
    branchTemplate: 'issue/{number}-{slug}',
    etcBranchName: 'etc',
    worktreePath: '~/ws/{owner}/{repo}/{branch}',
    mainClonePath: '~/ws/{owner}/{repo}/_main',
    postCreateScript: '',
    sparsePaths: '',
    postCreateScriptPosix: '',
    ignoredCopyExclude: 'node_modules',
  },
  sources: {
    branchTemplate: 'global',
    etcBranchName: 'global',
    worktreePath: 'global',
    mainClonePath: 'global',
    postCreateScript: 'global',
    sparsePaths: 'global',
    postCreateScriptPosix: 'global',
    ignoredCopyExclude: 'global',
  },
}

export function createFakeApi(overrides: Partial<ApiClient> = {}): Mocked<ApiClient> {
  let vr: VisibleRepos = { repos: null, updatedAt: null }
  const base: ApiClient = {
    healthz: async () => ({ status: 'ok' }),
    startDeviceLogin: unexpected('startDeviceLogin'),
    pollDeviceLogin: unexpected('pollDeviceLogin'),
    me: async () => ({ id: 'usr_1', githubLogin: 'octocat', avatarUrl: null }),
    getGithubToken: unexpected('getGithubToken'),
    logout: async () => undefined,
    getSettings: async () => EMPTY_RECORD,
    putSettings: async (_s, input) => ({ ...EMPTY_RECORD, ...input, updatedAt: '2026-11-10T00:00:00.000Z' }) as SettingsRecord,
    getEffective: async () => EFFECTIVE,
    getNotes: async () => ({ body: '', updatedAt: null }),
    putNotes: async (_o, _r, _k, input) => ({ body: input.body, updatedAt: '2026-11-10T00:00:01.000Z' }),
    getVisibleRepos: async () => vr,
    putVisibleRepos: async (input) => {
      vr = { repos: input.repos, updatedAt: `2026-11-10T00:00:0${Math.floor(Math.random() * 9)}.000Z` }
      return vr
    },
    issueCliCode: unexpected('issueCliCode'),
    exchangeCliCode: async () => ({ session: 'sess_cli' }),
    listSessions: async () => ({ sessions: [] }),
    revokeSession: async () => undefined,
    syncExport: unexpected('syncExport'),
    syncImport: unexpected('syncImport'),
  }
  return mockAll(base, overrides)
}

export type TestCtx = Ctx & { api: Mocked<ApiClient>; logs: string[]; errors: string[] }

export async function tempPaths(): Promise<Paths> {
  const dir = await mkdtemp(join(tmpdir(), 'minmo-cli-test-'))
  return { configDir: dir, credentials: join(dir, 'credentials.json'), socket: join(dir, 'no.sock') }
}

export type TestCtxOptions = {
  api?: Partial<ApiClient>
  loggedIn?: boolean
  env?: NodeJS.ProcessEnv
}

/** 로그인된 상태의 테스트 컨텍스트(가짜 서버, 설정 폴더는 임시 폴더) */
export async function createTestCtx(o: TestCtxOptions = {}): Promise<TestCtx> {
  const paths = await tempPaths()
  if (o.loggedIn !== false) await saveCredentials(paths, { session: 'sess', login: 'octocat', savedAt: '2026-11-10T00:00:00.000Z' })
  const logs: string[] = []
  const errors: string[] = []
  const out: Out = { log: (s) => logs.push(s), error: (s) => errors.push(s) }
  const api = createFakeApi(o.api)
  // 어느 OS 에서 돌려도 같은 안내 문구가 나오게 서버 대상을 고정한다(Windows 기본은 MINMO_SERVER 필요)
  const ctx = await createContext({ env: o.env ?? {}, paths, serverTarget: { kind: 'socket', path: paths.socket }, api, out })
  return Object.assign(ctx, { logs, errors }) as TestCtx
}
