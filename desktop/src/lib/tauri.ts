// Tauri invoke 래퍼 인터페이스. UI·도메인 코드는 이 인터페이스에만 의존하고
// 실제 구현(invoke)과 tauri.mock.ts(dev·Playwright) 를 getTauri() 로 고른다.
import type { Platform } from '@minmo/api-client'

export type { Platform }

export type CmdResult = { code: number; stdout: string; stderr: string }
export type RunOptions = { cwd?: string; env?: Record<string, string> }
export type Unlisten = () => void

export type PtySpawnRequest = { cwd: string; cols: number; rows: number }
export type PtyDataEvent = { id: string; data: string }

/** runId 는 호출자가 만든다(취소를 위해 완료 전에 알아야 함) */
export type ScriptRunRequest = { runId: string; cwd: string; script: string; env: Record<string, string> }
/** 프로세스 종료 시 resolve. 취소되면 cancelled=true, exitCode=null */
export type ScriptRunResult = { exitCode: number | null; cancelled: boolean }
export type ScriptLogEvent = { runId: string; stream: 'stdout' | 'stderr'; line: string }

export const KEYCHAIN_KEYS = {
  session: 'minmo.session',
  githubToken: 'minmo.github-token',
} as const

export interface TauriApi {
  /** git <args> — non-zero 종료도 reject 하지 않고 code 로 돌려준다 */
  gitRun(args: string[], opts?: RunOptions): Promise<CmdResult>
  ghRun(args: string[], opts?: RunOptions & { stdin?: string }): Promise<CmdResult>
  /** gh 설치 + `gh auth status` 성공 여부 */
  ghAvailable(): Promise<boolean>

  ptySpawn(req: PtySpawnRequest): Promise<string>
  ptyWrite(id: string, data: string): Promise<void>
  ptyResize(id: string, cols: number, rows: number): Promise<void>
  ptyKill(id: string): Promise<void>
  /** cwd 가 path(또는 하위)인 PTY 를 모두 종료하고 종료 개수를 돌려준다 (worktree 삭제 전) */
  ptyKillByCwd(path: string): Promise<number>
  onPtyData(cb: (e: PtyDataEvent) => void): Promise<Unlisten>

  scriptRun(req: ScriptRunRequest): Promise<ScriptRunResult>
  scriptCancel(runId: string): Promise<void>
  onScriptLog(cb: (e: ScriptLogEvent) => void): Promise<Unlisten>

  keychainGet(key: string): Promise<string | null>
  keychainSet(key: string, value: string): Promise<void>
  keychainDelete(key: string): Promise<void>

  homeDir(): Promise<string>
  platform(): Promise<Platform>
  pathExists(path: string): Promise<boolean>
  /** 재귀 삭제 — EC-10 "이번 실행이 새로 만든 경로" 정리에만 사용 */
  removeDir(path: string): Promise<void>

  /** opener: 외부 브라우저로 URL 열기 */
  openUrl(url: string): Promise<void>
  /** deep-link onOpenUrl (single-instance 재전달 포함) */
  onDeepLink(cb: (urls: string[]) => void): Promise<Unlisten>
}

const notImplemented = (): never => {
  throw new Error('not implemented')
}

// STUB (Phase 6.1 Red)
/** @tauri-apps/api invoke 기반 실제 구현 */
export function createTauriApi(): TauriApi {
  return notImplemented()
}

/** `__TAURI_INTERNALS__` 가 없으면 tauri.mock.ts 의 인메모리 가짜를 돌려준다 */
export function getTauri(): TauriApi {
  return notImplemented()
}
