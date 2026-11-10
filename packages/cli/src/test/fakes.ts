// CLI 테스트용 가짜 서버 API·GitHub·컨텍스트
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { vi } from 'vitest'

import type { ApiClient, Effective, SettingsRecord, VisibleRepos } from '@minmo/api-client'
import type { GitHubClient, GitHubIssue, GitHubOwner, GitHubRepo } from '@minmo/core'
import { createFakeHost } from '@minmo/core/testing'
import type { Mocked } from '@minmo/core/testing'

import { createContext } from '../context'
import type { Ctx, Out } from '../context'
import type { NodeHost } from '../host/node'
import { saveCredentials } from '../store'
import type { Mode, Paths } from '../store'

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
  },
  sources: {
    branchTemplate: 'global',
    etcBranchName: 'global',
    worktreePath: 'global',
    mainClonePath: 'global',
    postCreateScript: 'global',
    sparsePaths: 'global',
    postCreateScriptPosix: 'global',
  },
}

export function createFakeApi(overrides: Partial<ApiClient> = {}): Mocked<ApiClient> {
  let vr: VisibleRepos = { repos: null, updatedAt: null }
  const base: ApiClient = {
    healthz: async () => ({ status: 'ok' }),
    startLogin: unexpected('startLogin'),
    me: async () => ({ id: 'usr_1', githubLogin: 'octocat', avatarUrl: null }),
    getGithubToken: async () => ({ accessToken: 'gho_server' }),
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
  }
  return mockAll(base, overrides)
}

export const OWNERS: GitHubOwner[] = [
  { login: 'octocat', kind: 'user', avatarUrl: null },
  { login: 'Acme', kind: 'org', avatarUrl: null },
]
export const REPOS: Record<string, GitHubRepo[]> = {
  octocat: [{ owner: 'octocat', name: 'dotfiles', defaultBranch: 'main' }],
  Acme: [
    { owner: 'Acme', name: 'Widgets', defaultBranch: 'main' },
    { owner: 'Acme', name: 'gadgets', defaultBranch: 'main' },
  ],
}
export const ISSUES: GitHubIssue[] = [
  { number: 7, title: 'Seven', state: 'open', htmlUrl: 'u7' },
  { number: 3, title: 'Old', state: 'closed', htmlUrl: 'u3' },
]

export function createFakeGitHub(overrides: Partial<GitHubClient> = {}): Mocked<GitHubClient> {
  const base: GitHubClient = {
    source: async () => 'gh',
    listOwners: async () => OWNERS,
    listRepos: async (o) => REPOS[o.login] ?? [],
    listIssues: async () => ISSUES,
    defaultBranch: async () => 'main',
    getRepo: async (owner, name) => {
      const r = Object.values(REPOS)
        .flat()
        .find((x) => x.owner.toLowerCase() === owner.toLowerCase() && x.name.toLowerCase() === name.toLowerCase())
      if (!r) throw Object.assign(new Error('not found'), { name: 'GitHubError', code: 'not_found' })
      return r
    },
    getIssue: async (_o, _r, n) => {
      const i = ISSUES.find((x) => x.number === n)
      if (!i) throw new Error('not found')
      return i
    },
    openPrForBranch: async () => null,
    createPr: async () => ({ number: 1, url: 'u' }),
  }
  return mockAll(base, overrides)
}

export type TestCtx = Ctx & { api: Mocked<ApiClient>; github: Mocked<GitHubClient>; logs: string[]; errors: string[] }

export async function tempPaths(): Promise<Paths> {
  const dir = await mkdtemp(join(tmpdir(), 'minmo-cli-test-'))
  return { configDir: dir, credentials: join(dir, 'credentials.json'), config: join(dir, 'config.json'), state: join(dir, 'state.json'), socket: join(dir, 'no.sock') }
}

export type TestCtxOptions = {
  api?: Partial<ApiClient>
  github?: Partial<GitHubClient>
  host?: Partial<NodeHost>
  loggedIn?: boolean
  /** config.json 의 모드(기본 server) */
  mode?: Mode
  env?: NodeJS.ProcessEnv
  /** 같은 설정 폴더로 다시 만들 때(모드 전환 뒤 새 실행 흉내) */
  paths?: Paths
}

/** 로그인된 상태의 테스트 컨텍스트(가짜 서버·GitHub·호스트, 설정 폴더는 임시 폴더) */
export async function createTestCtx(o: TestCtxOptions = {}): Promise<TestCtx> {
  const paths = o.paths ?? (await tempPaths())
  if (o.loggedIn !== false && !o.paths) await saveCredentials(paths, { session: 'sess', login: 'octocat', savedAt: '2026-11-10T00:00:00.000Z' })
  if (o.mode) await writeFile(paths.config, JSON.stringify({ mode: o.mode }))
  const logs: string[] = []
  const errors: string[] = []
  const out: Out = { log: (s) => logs.push(s), error: (s) => errors.push(s) }
  const api = createFakeApi(o.api)
  const github = createFakeGitHub(o.github)
  // 어느 OS 에서 돌려도 같은 안내 문구가 나오게 서버 대상을 고정한다(Windows 기본은 MINMO_SERVER 필요)
  const ctx = await createContext({ env: o.env ?? {}, paths, serverTarget: { kind: 'socket', path: paths.socket }, api, github, host: createFakeHost(o.host) as unknown as NodeHost, out })
  return Object.assign(ctx, { logs, errors }) as TestCtx
}
