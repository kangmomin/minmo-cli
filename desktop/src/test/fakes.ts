// 테스트 전용 fake (TauriApi · ApiClient · GitHubClient). 모든 메서드는 vi.fn 이라 호출 검사가 가능하다.
import { vi } from 'vitest'
import type { Mock } from 'vitest'

import { ApiError } from '@minmo/api-client'
import type { ApiClient, ApiErrorCode, Notes } from '@minmo/api-client'

import type { GitHubClient } from '@minmo/core'
import type { ServerSettings, ServerStatus, TauriApi } from '../lib/tauri'
import { ok } from '../lib/tauri.mock'

export type Mocked<T> = { [K in keyof T]: T[K] extends (...args: infer A) => infer R ? Mock<(...args: A) => R> : T[K] }

export { fail, ok } from '../lib/tauri.mock'

/** base 를 overrides 로 덮고 모든 메서드를 vi.fn 으로 감싼다 */
function mockAll<T extends object>(base: T, overrides: Partial<T>): Mocked<T> {
  const merged = { ...base, ...overrides }
  return Object.fromEntries(Object.entries(merged).map(([k, fn]) => [k, vi.fn(fn as (...a: unknown[]) => unknown)])) as unknown as Mocked<T>
}

export function createFakeTauri(overrides: Partial<TauriApi> = {}) {
  const keychain = new Map<string, string>()
  const deepLinkListeners = new Set<(urls: string[]) => void>()
  const serverListeners = new Set<(s: ServerStatus) => void>()
  const closeListeners = new Set<() => void>()
  const base: TauriApi = {
    gitRun: async () => ok(),
    ghRun: async () => ok(),
    ghAvailable: async () => false,
    ptySpawn: async () => 'pty-1',
    ptyWrite: async () => {},
    ptyResize: async () => {},
    ptyKill: async () => {},
    ptyKillByCwd: async () => 0,
    onPtyData: async () => () => {},
    scriptRun: async () => ({ exitCode: 0, cancelled: false }),
    scriptCancel: async () => {},
    onScriptLog: async () => () => {},
    keychainGet: async (k) => keychain.get(k) ?? null,
    keychainSet: async (k, v) => {
      keychain.set(k, v)
    },
    keychainDelete: async (k) => {
      keychain.delete(k)
    },
    homeDir: async () => '/home/u',
    platform: async () => 'linux',
    pathExists: async () => false,
    removeDir: async () => {},
    copyTree: async () => 0,
    listFiles: async () => [],
    copyFileInto: async () => {},
    removeFileIn: async () => {},
    openDir: async () => {},
    openUrl: async () => {},
    onDeepLink: async (cb) => {
      deepLinkListeners.add(cb)
      return () => {
        deepLinkListeners.delete(cb)
      }
    },
    serverStatus: async () => ({ state: 'running', port: 8787, message: null }),
    onServerStatus: async (cb) => {
      serverListeners.add(cb)
      return () => {
        serverListeners.delete(cb)
      }
    },
    serverSettingsGet: async () => SERVER_SETTINGS,
    serverSettingsSave: async () => SERVER_SETTINGS,
    serverRestart: async () => {},
    serverOpenLogDir: async () => {},
    onCloseRequested: async (cb) => {
      closeListeners.add(cb)
      return () => {
        closeListeners.delete(cb)
      }
    },
    appClose: async () => {},
  }
  const tauri = mockAll(base, overrides)
  return {
    tauri,
    keychain,
    emitDeepLink(...urls: string[]) {
      for (const l of [...deepLinkListeners]) l(urls)
    },
    deepLinkListenerCount: () => deepLinkListeners.size,
    emitServerStatus(s: ServerStatus) {
      for (const l of [...serverListeners]) l(s)
    },
    emitCloseRequested() {
      for (const l of [...closeListeners]) l()
    },
  }
}

export const SERVER_SETTINGS: ServerSettings = {
  port: 8787,
  githubClientId: '',
  hasClientSecret: false,
  closeAction: 'ask',
  callbackUrl: 'http://127.0.0.1:8787/auth/github/callback',
  warning: null,
}

const unexpected = (name: string) => async () => {
  throw new Error(`unexpected api call: ${name}`)
}

export function createFakeApi(overrides: Partial<ApiClient> = {}): Mocked<ApiClient> {
  const base: ApiClient = {
    healthz: unexpected('healthz'),
    startLogin: unexpected('startLogin'),
    me: unexpected('me'),
    getGithubToken: unexpected('getGithubToken'),
    logout: unexpected('logout'),
    getSettings: unexpected('getSettings'),
    putSettings: unexpected('putSettings'),
    getEffective: unexpected('getEffective'),
    getNotes: unexpected('getNotes'),
    putNotes: unexpected('putNotes'),
    // 트리는 항상 보일 저장소를 조회하므로 기본은 "선택 없음 = 전체 표시"
    getVisibleRepos: async () => ({ repos: null, updatedAt: null }),
    putVisibleRepos: unexpected('putVisibleRepos'),
    issueCliCode: unexpected('issueCliCode'),
    exchangeCliCode: unexpected('exchangeCliCode'),
    listSessions: unexpected('listSessions'),
    revokeSession: unexpected('revokeSession'),
  }
  return mockAll(base, overrides)
}

export function createFakeGitHub(overrides: Partial<GitHubClient> = {}): Mocked<GitHubClient> {
  const base: GitHubClient = {
    source: async () => 'gh',
    listOwners: async () => [],
    listRepos: async () => [],
    listIssues: async () => [],
    defaultBranch: async () => 'main',
    getRepo: async (owner, name) => ({ owner, name, defaultBranch: 'main' }),
    getIssue: async (_o, _r, number) => ({ number, title: `issue ${number}`, state: 'open', htmlUrl: '' }),
    openPrForBranch: async () => null,
    createPr: async () => ({ number: 1, url: 'https://github.com/o/r/pull/1' }),
  }
  return mockAll(base, overrides)
}

export const apiError = (status: number, code: ApiErrorCode, extra: { field?: string; current?: Notes } = {}) =>
  new ApiError({ status, code, ...extra })

/** 수동 resolve 가능한 promise */
export function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** 대기 중인 microtask/타이머 0 을 비운다 */
export const flush = async (times = 5) => {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0))
}
