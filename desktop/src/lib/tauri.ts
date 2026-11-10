// Tauri invoke 래퍼 인터페이스. UI·도메인 코드는 이 인터페이스에만 의존하고
// 실제 구현(invoke)과 tauri.mock.ts(dev·Playwright) 를 getTauri() 로 고른다.
import type { Platform } from '@minmo/api-client'
import type { CmdResult, GhHost, RunOptions, ScriptLogEvent, ScriptRunRequest, ScriptRunResult, Unlisten, WorktreeHost } from '@minmo/core'

import { createTauriMock } from './tauri.mock'

export type { Platform }
// 호스트 공통 타입은 원격 CLI 와 함께 쓰도록 @minmo/core 에 있다
export type { CmdResult, RunOptions, ScriptLogEvent, ScriptRunRequest, ScriptRunResult, Unlisten } from '@minmo/core'

export type PtySpawnRequest = { cwd: string; cols: number; rows: number }
export type PtyDataEvent = { id: string; data: string }

export const KEYCHAIN_KEYS = {
  session: 'minmo.session',
  githubToken: 'minmo.github-token',
} as const

/** 데스크탑 전용 기능(PTY·키체인·딥링크 등)을 더한 Tauri 호스트 — worktree·GitHub 공용 인터페이스를 모두 만족한다 */
export interface TauriApi extends WorktreeHost, GhHost {
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
  /** src 의 파일을 dst 의 같은 상대 경로로 복사(기존 파일은 유지)하고 복사한 개수를 돌려준다. src 가 없으면 0 */
  copyTree(src: string, dst: string): Promise<number>
  /** root 아래 파일의 상대 경로('/' 구분, 정렬). root 가 없으면 [] */
  listFiles(root: string): Promise<string[]>
  /** srcRoot/rel → dstRoot/rel 복사(덮어씀). rel 은 상대 경로만 */
  copyFileInto(srcRoot: string, rel: string, dstRoot: string): Promise<void>
  removeFileIn(root: string, rel: string): Promise<void>
  /** 폴더를 OS 파일 탐색기로 연다(없으면 생성) */
  openDir(path: string): Promise<void>

  /** opener: 외부 브라우저로 URL 열기 */
  openUrl(url: string): Promise<void>
  /** deep-link onOpenUrl (single-instance 재전달 포함) */
  onDeepLink(cb: (urls: string[]) => void): Promise<Unlisten>
}

// Rust command 이름(src-tauri/src/commands/*.rs)과 1:1. 인자 키는 camelCase → Rust snake_case 로 자동 변환된다.
export const TAURI_COMMANDS = {
  gitRun: 'git_run',
  ghRun: 'gh_run',
  ghAvailable: 'gh_available',
  ptySpawn: 'pty_spawn',
  ptyWrite: 'pty_write',
  ptyResize: 'pty_resize',
  ptyKill: 'pty_kill',
  ptyKillByCwd: 'pty_kill_by_cwd',
  scriptRun: 'script_run',
  scriptCancel: 'script_cancel',
  keychainGet: 'keychain_get',
  keychainSet: 'keychain_set',
  keychainDelete: 'keychain_delete',
  homeDir: 'home_dir',
  platform: 'os_platform',
  pathExists: 'path_exists',
  removeDir: 'remove_dir',
  copyTree: 'copy_tree',
  listFiles: 'list_files',
  copyFileInto: 'copy_file_into',
  removeFileIn: 'remove_file_in',
  openDir: 'open_dir',
} as const

export const TAURI_EVENTS = { ptyData: 'pty-data', scriptLog: 'script-log' } as const

/** @tauri-apps/api invoke 기반 실제 구현 */
export function createTauriApi(): TauriApi {
  // 플러그인·core 모듈은 Tauri 런타임에서만 의미가 있으므로 지연 import 한다(웹 mock 번들 분리)
  const core = () => import('@tauri-apps/api/core')
  const event = () => import('@tauri-apps/api/event')
  const call = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => (await core()).invoke<T>(cmd, args)
  const C = TAURI_COMMANDS

  return {
    gitRun: (args, opts) => call(C.gitRun, { args, cwd: opts?.cwd ?? null, env: opts?.env ?? null }),
    ghRun: (args, opts) => call(C.ghRun, { args, cwd: opts?.cwd ?? null, env: opts?.env ?? null, stdin: opts?.stdin ?? null }),
    ghAvailable: () => call(C.ghAvailable),

    ptySpawn: (req) => call(C.ptySpawn, { cwd: req.cwd, cols: req.cols, rows: req.rows }),
    ptyWrite: (id, data) => call(C.ptyWrite, { id, data }),
    ptyResize: (id, cols, rows) => call(C.ptyResize, { id, cols, rows }),
    ptyKill: (id) => call(C.ptyKill, { id }),
    ptyKillByCwd: (path) => call(C.ptyKillByCwd, { path }),
    onPtyData: async (cb) => (await event()).listen<PtyDataEvent>(TAURI_EVENTS.ptyData, (e) => cb(e.payload)),

    scriptRun: (req) => call(C.scriptRun, { runId: req.runId, cwd: req.cwd, script: req.script, env: req.env }),
    scriptCancel: (runId) => call(C.scriptCancel, { runId }),
    onScriptLog: async (cb) => (await event()).listen<ScriptLogEvent>(TAURI_EVENTS.scriptLog, (e) => cb(e.payload)),

    keychainGet: (key) => call(C.keychainGet, { key }),
    keychainSet: (key, value) => call(C.keychainSet, { key, value }),
    keychainDelete: (key) => call(C.keychainDelete, { key }),

    homeDir: () => call(C.homeDir),
    platform: () => call(C.platform),
    pathExists: (path) => call(C.pathExists, { path }),
    removeDir: (path) => call(C.removeDir, { path }),
    copyTree: (src, dst) => call(C.copyTree, { src, dst }),
    listFiles: (root) => call(C.listFiles, { root }),
    copyFileInto: (srcRoot, rel, dstRoot) => call(C.copyFileInto, { srcRoot, rel, dstRoot }),
    removeFileIn: (root, rel) => call(C.removeFileIn, { root, rel }),
    openDir: (path) => call(C.openDir, { path }),

    openUrl: async (url) => (await import('@tauri-apps/plugin-opener')).openUrl(url),
    onDeepLink: async (cb) => {
      const dl = await import('@tauri-apps/plugin-deep-link')
      const unlisten = await dl.onOpenUrl(cb)
      // 콜드 스타트: 앱이 딥링크로 실행되었으면 그 URL 도 전달한다(pendingLogin 이 없으므로 안내만 뜬다)
      const initial = await dl.getCurrent().catch(() => null)
      if (initial && initial.length > 0) cb(initial)
      return unlisten
    },
  }
}

function hasTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

let instance: TauriApi | null = null

/** `__TAURI_INTERNALS__` 가 없으면(또는 VITE_TAURI_MOCK=1) tauri.mock.ts 의 인메모리 가짜를 돌려준다 */
export function getTauri(): TauriApi {
  if (instance) return instance
  instance = hasTauriRuntime() && import.meta.env.VITE_TAURI_MOCK !== '1' ? createTauriApi() : createTauriMock()
  return instance
}
