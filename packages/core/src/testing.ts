// 테스트 전용 fake 호스트. 모든 메서드는 vi.fn 이라 호출 검사가 가능하다(데스크탑·CLI 테스트 공용).
import { vi } from 'vitest'
import type { Mock } from 'vitest'

import type { CmdResult, GhHost, WorktreeHost } from './host'

export type Mocked<T> = { [K in keyof T]: T[K] extends (...args: infer A) => infer R ? Mock<(...args: A) => R> : T[K] }

export const ok = (stdout = ''): CmdResult => ({ code: 0, stdout, stderr: '' })
export const fail = (stderr: string, code = 1): CmdResult => ({ code, stdout: '', stderr })

export type FakeHost = WorktreeHost & GhHost

/** base 를 overrides 로 덮고 모든 메서드를 vi.fn 으로 감싼다 */
function mockAll<T extends object>(base: T, overrides: Partial<T>): Mocked<T> {
  const merged = { ...base, ...overrides }
  return Object.fromEntries(Object.entries(merged).map(([k, fn]) => [k, vi.fn(fn as (...a: unknown[]) => unknown)])) as unknown as Mocked<T>
}

export function createFakeHost(overrides: Partial<FakeHost> = {}): Mocked<FakeHost> {
  const base: FakeHost = {
    gitRun: async () => ok(),
    ghRun: async () => ok(),
    ghAvailable: async () => false,
    pathExists: async () => false,
    removeDir: async () => {},
    copyTree: async () => 0,
    scriptRun: async () => ({ exitCode: 0, cancelled: false }),
    scriptCancel: async () => {},
    onScriptLog: async () => () => {},
    ptyKillByCwd: async () => 0,
  }
  return mockAll(base, overrides)
}

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
