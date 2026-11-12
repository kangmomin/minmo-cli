// Tauri invoke 래퍼 인터페이스. UI·도메인 코드는 이 인터페이스에만 의존하고
// 실제 구현(invoke)과 tauri.mock.ts(dev·Playwright) 를 getTauri() 로 고른다.
import type { Platform } from '@minmo/api-client'
import type { CmdResult, GhHost, RunOptions, ScriptLogEvent, ScriptRunRequest, ScriptRunResult, Unlisten, WorktreeHost } from '@minmo/core'

import { createTauriMock } from './tauri.mock'

export type { Platform }
// 호스트 공통 타입은 원격 CLI 와 함께 쓰도록 @minmo/core 에 있다
export type { CmdResult, RunOptions, ScriptLogEvent, ScriptRunRequest, ScriptRunResult, Unlisten } from '@minmo/core'

/** ~/.ssh/config 의 Host 항목(src-tauri/src/commands/ssh.rs SshHost) */
export type SshHostInfo = {
  alias: string
  hostName: string | null
  user: string | null
  /** config = ~/.ssh/config 의 Host, app = 앱에 직접 등록한 호스트 */
  source: 'config' | 'app'
  port: number | null
  identityFile: string | null
}
/** 앱에 등록하는 호스트 — 비밀번호는 저장하지 않는다(키 파일 또는 ssh-agent) */
export type SshHostInput = { alias: string; hostName: string; user: string; port: number; identityFile: string | null }
/** 파일 탭의 폴더 항목 */
export type DirEntry = { name: string; kind: 'dir' | 'file' | 'link' }
/** version 은 저장할 때 그 사이 바뀌었는지 비교하는 값 */
export type TextFile = { content: string; version: string }
/** 원격 호스트 확인 결과 — POSIX(Linux·macOS)만 지원한다 */
export type SshProbe = { platform: 'linux' | 'darwin'; home: string; git: string; tmux: boolean }
export type SshErrorKind = 'host_key' | 'auth' | 'unreachable' | 'unsupported_os' | 'no_git' | 'unknown_host' | 'failed'
export type SshError = { kind: SshErrorKind; message: string }
/** 원격 터미널 — session 이 있으면 전용 tmux 세션에 붙고(ephemeral 은 떼면 사라짐), null 이면 로그인 셸 */
export type RemotePty = { host: string; session: string | null; ephemeral: boolean }

export type PtySpawnRequest = { cwd: string; cols: number; rows: number; remote?: RemotePty }
export type PtyDataEvent = { id: string; data: string }

/** 내장 서버 상태(src-tauri/src/server.rs Status) — external 은 debug 실행에서 외부 서버를 쓸 때 */
export type ServerState = 'starting' | 'running' | 'failed' | 'stopped' | 'external'
export type ServerStatus = { state: ServerState; port: number; message: string | null }
/** 창을 닫을 때: 매번 묻기 · 트레이로 숨기기(서버 유지) · 종료 */
export type CloseAction = 'ask' | 'tray' | 'quit'
/** 서버 설정(포트·창 닫기 동작) */
export type ServerSettings = {
  port: number
  closeAction: CloseAction
  /** 설정 파일이 깨져 기본값으로 시작한 경우 등 */
  warning: string | null
}
/** 바꿀 값만 */
export type ServerSettingsInput = Partial<Pick<ServerSettings, 'port' | 'closeAction'>>

/** 새 버전 정보(src-tauri/src/update.rs UpdateInfo) */
export type UpdateInfo = { version: string; currentVersion: string; notes: string | null; date: string | null }
export type UpdateProgress = { downloaded: number; total: number | null }

export const KEYCHAIN_KEYS = {
  session: 'minmo.session',
  githubToken: 'minmo.github-token',
} as const

/** 데스크탑 전용 기능(PTY·키체인 등)을 더한 Tauri 호스트 — worktree·GitHub 공용 인터페이스를 모두 만족한다 */
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
  ptyKillByCwd(path: string, host?: string): Promise<number>
  onPtyData(cb: (e: PtyDataEvent) => void): Promise<Unlisten>

  scriptRun(req: ScriptRunRequest): Promise<ScriptRunResult>
  scriptCancel(runId: string): Promise<void>
  onScriptLog(cb: (e: ScriptLogEvent) => void): Promise<Unlisten>

  /** 원격 호스트(SSH 프로필) — 이 PC 의 ssh 로 접속한다. 실패는 SshError 로 reject */
  sshHosts(): Promise<SshHostInfo[]>
  /** trustNew: 처음 보는 호스트 키를 known_hosts 에 등록하고 연결한다(사용자가 고른 경우만) */
  sshProbe(host: string, trustNew?: boolean): Promise<SshProbe>
  /** 호스트를 앱에 등록(같은 이름이면 수정)하고 전체 목록을 돌려준다 */
  sshHostSave(host: SshHostInput): Promise<SshHostInfo[]>
  sshHostRemove(alias: string): Promise<SshHostInfo[]>
  /** 원격에서 argv 실행. 원격 명령의 non-zero 는 code 로, ssh 자체의 실패(연결·인증)는 reject */
  sshExec(host: string, argv: string[], opts?: RunOptions & { stdin?: string }): Promise<CmdResult>
  sshScriptRun(host: string, req: ScriptRunRequest): Promise<ScriptRunResult>
  sshScriptCancel(runId: string): Promise<void>

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

  /** 파일 탭 — root(worktree) 아래의 상대 경로('/' 구분)만 다룬다. 실패 사유는 file_too_large 같은 코드로 시작한다 */
  listDir(root: string, rel: string): Promise<DirEntry[]>
  readTextFile(root: string, rel: string): Promise<TextFile>
  /** expected 가 있으면 읽은 뒤 바뀌지 않았을 때만 저장(file_changed), create 면 새 파일만(file_exists). 새 version 을 돌려준다 */
  writeTextFile(root: string, rel: string, content: string, opts?: { expected?: string; create?: boolean }): Promise<string>
  createDir(root: string, rel: string): Promise<void>
  renamePath(root: string, from: string, to: string): Promise<void>
  removePath(root: string, rel: string): Promise<void>

  /** 이 터미널의 셸 아래에서 도는 프로세스 이름들(원격 세션은 빈 목록) — 에이전트 감지용 */
  ptyProcesses(id: string): Promise<string[]>
  /** OS 알림을 띄운다(권한이 없으면 조용히 넘어간다) */
  notify(title: string, body: string): Promise<void>
  /** opener: 외부 브라우저로 URL 열기 */
  openUrl(url: string): Promise<void>
  /** 이 PC 의 폴더 선택 창. 취소하면 null (원격 호스트의 폴더는 고를 수 없다) */
  pickFolder(defaultPath?: string): Promise<string | null>

  /** 내장 서버 — 앱과 함께 실행되며 설정은 Rust 쪽(server.json·키체인)이 갖는다 */
  serverStatus(): Promise<ServerStatus>
  onServerStatus(cb: (s: ServerStatus) => void): Promise<Unlisten>
  serverSettingsGet(): Promise<ServerSettings>
  /** 저장 후 포트가 바뀌었으면 서버를 다시 시작한다 */
  serverSettingsSave(input: ServerSettingsInput): Promise<ServerSettings>
  serverRestart(): Promise<void>
  serverOpenLogDir(): Promise<void>

  /** 창 닫기 요청(closeAction 이 ask 일 때) */
  onCloseRequested(cb: () => void): Promise<Unlisten>
  /** 닫기 선택 — remember 면 다음부터 묻지 않는다 */
  appClose(action: Exclude<CloseAction, 'ask'>, remember: boolean): Promise<void>

  /** 앱 버전(tauri.conf.json) */
  appVersion(): Promise<string>
  /** 새 버전이 있으면 그 정보, 없으면 null */
  appUpdateCheck(): Promise<UpdateInfo | null>
  /** 확인한 업데이트를 받아 설치하고 다시 시작한다(서버는 먼저 정상 종료). 돌아오면 실패 */
  appUpdateInstall(): Promise<void>
  onUpdateProgress(cb: (p: UpdateProgress) => void): Promise<Unlisten>
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
  ptyProcesses: 'pty_processes',
  scriptRun: 'script_run',
  scriptCancel: 'script_cancel',
  sshHosts: 'ssh_hosts',
  sshProbe: 'ssh_probe',
  sshHostSave: 'ssh_host_save',
  sshHostRemove: 'ssh_host_remove',
  sshExec: 'ssh_exec',
  sshScriptRun: 'ssh_script_run',
  sshScriptCancel: 'ssh_script_cancel',
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
  listDir: 'fs_list_dir',
  readTextFile: 'fs_read_text',
  writeTextFile: 'fs_write_text',
  createDir: 'fs_create_dir',
  renamePath: 'fs_rename',
  removePath: 'fs_remove',
  serverStatus: 'server_status',
  serverSettingsGet: 'server_settings_get',
  serverSettingsSave: 'server_settings_save',
  serverRestart: 'server_restart',
  serverOpenLogDir: 'server_open_log_dir',
  appClose: 'app_close',
  appUpdateCheck: 'app_update_check',
  appUpdateInstall: 'app_update_install',
} as const

export const TAURI_EVENTS = { ptyData: 'pty-data', scriptLog: 'script-log', serverStatus: 'server-status', closeRequested: 'close-requested', updateProgress: 'update-progress' } as const

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

    ptySpawn: (req) => call(C.ptySpawn, { cwd: req.cwd, cols: req.cols, rows: req.rows, remote: req.remote ?? null }),
    ptyWrite: (id, data) => call(C.ptyWrite, { id, data }),
    ptyResize: (id, cols, rows) => call(C.ptyResize, { id, cols, rows }),
    ptyKill: (id) => call(C.ptyKill, { id }),
    ptyKillByCwd: (path, host) => call(C.ptyKillByCwd, { path, host: host ?? null }),
    onPtyData: async (cb) => (await event()).listen<PtyDataEvent>(TAURI_EVENTS.ptyData, (e) => cb(e.payload)),

    scriptRun: (req) => call(C.scriptRun, { runId: req.runId, cwd: req.cwd, script: req.script, env: req.env }),
    scriptCancel: (runId) => call(C.scriptCancel, { runId }),
    onScriptLog: async (cb) => (await event()).listen<ScriptLogEvent>(TAURI_EVENTS.scriptLog, (e) => cb(e.payload)),

    sshHosts: () => call(C.sshHosts),
    sshProbe: (host, trustNew) => call(C.sshProbe, { host, trustNew: trustNew ?? false }),
    sshHostSave: (host) => call(C.sshHostSave, { host }),
    sshHostRemove: (alias) => call(C.sshHostRemove, { alias }),
    sshExec: (host, argv, opts) => call(C.sshExec, { host, argv, cwd: opts?.cwd ?? null, env: opts?.env ?? null, stdin: opts?.stdin ?? null }),
    sshScriptRun: (host, req) => call(C.sshScriptRun, { host, runId: req.runId, cwd: req.cwd, script: req.script, env: req.env }),
    sshScriptCancel: (runId) => call(C.sshScriptCancel, { runId }),

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
    listDir: (root, rel) => call(C.listDir, { root, rel }),
    readTextFile: (root, rel) => call(C.readTextFile, { root, rel }),
    writeTextFile: (root, rel, content, opts) => call(C.writeTextFile, { root, rel, content, expected: opts?.expected ?? null, create: opts?.create ?? false }),
    createDir: (root, rel) => call(C.createDir, { root, rel }),
    renamePath: (root, from, to) => call(C.renamePath, { root, from, to }),
    removePath: (root, rel) => call(C.removePath, { root, rel }),

    ptyProcesses: (id) => call(C.ptyProcesses, { id }),
    notify: async (title, body) => {
      const n = await import('@tauri-apps/plugin-notification')
      let granted = await n.isPermissionGranted()
      if (!granted) granted = (await n.requestPermission()) === 'granted'
      if (granted) n.sendNotification({ title, body })
    },
    openUrl: async (url) => (await import('@tauri-apps/plugin-opener')).openUrl(url),
    pickFolder: async (defaultPath) => {
      const picked = await (await import('@tauri-apps/plugin-dialog')).open({ directory: true, multiple: false, ...(defaultPath ? { defaultPath } : {}) })
      return typeof picked === 'string' ? picked : null
    },
    serverStatus: () => call(C.serverStatus),
    onServerStatus: async (cb) => (await event()).listen<ServerStatus>(TAURI_EVENTS.serverStatus, (e) => cb(e.payload)),
    serverSettingsGet: () => call(C.serverSettingsGet),
    serverSettingsSave: (input) => call(C.serverSettingsSave, { input }),
    serverRestart: () => call(C.serverRestart),
    serverOpenLogDir: () => call(C.serverOpenLogDir),
    onCloseRequested: async (cb) => (await event()).listen(TAURI_EVENTS.closeRequested, () => cb()),
    appClose: (action, remember) => call(C.appClose, { action, remember }),

    appVersion: async () => (await import('@tauri-apps/api/app')).getVersion(),
    appUpdateCheck: () => call(C.appUpdateCheck),
    appUpdateInstall: () => call(C.appUpdateInstall),
    onUpdateProgress: async (cb) => (await event()).listen<UpdateProgress>(TAURI_EVENTS.updateProgress, (e) => cb(e.payload)),
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
