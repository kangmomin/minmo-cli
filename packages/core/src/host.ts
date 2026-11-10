// 데스크탑(Tauri)·원격 CLI(Node)가 각자 구현하는 OS 접근 인터페이스.
// 도메인 로직(worktree·GitHub)은 이 인터페이스에만 의존하므로 두 앱이 같은 코드를 쓴다.

export type CmdResult = { code: number; stdout: string; stderr: string }
export type RunOptions = { cwd?: string; env?: Record<string, string> }
export type Unlisten = () => void

/** runId 는 호출자가 만든다(취소를 위해 완료 전에 알아야 함) */
export type ScriptRunRequest = { runId: string; cwd: string; script: string; env: Record<string, string> }
/** 프로세스 종료 시 resolve. 취소되면 cancelled=true, exitCode=null */
export type ScriptRunResult = { exitCode: number | null; cancelled: boolean }
export type ScriptLogEvent = { runId: string; stream: 'stdout' | 'stderr'; line: string }

export interface GitHost {
  /** git <args> — non-zero 종료도 reject 하지 않고 code 로 돌려준다 */
  gitRun(args: string[], opts?: RunOptions): Promise<CmdResult>
}

export interface GhHost {
  ghRun(args: string[], opts?: RunOptions & { stdin?: string }): Promise<CmdResult>
  /** gh 설치 + `gh auth status` 성공 여부 */
  ghAvailable(): Promise<boolean>
}

export interface FsHost {
  pathExists(path: string): Promise<boolean>
  /** 재귀 삭제 — "이번 실행이 새로 만든 경로" 정리에만 사용 */
  removeDir(path: string): Promise<void>
  /** src 의 파일을 dst 의 같은 상대 경로로 복사(기존 파일은 유지)하고 복사한 개수를 돌려준다. src 가 없으면 0 */
  copyTree(src: string, dst: string): Promise<number>
}

export interface ScriptHost {
  scriptRun(req: ScriptRunRequest): Promise<ScriptRunResult>
  scriptCancel(runId: string): Promise<void>
  onScriptLog(cb: (e: ScriptLogEvent) => void): Promise<Unlisten>
}

export interface SessionKiller {
  /** cwd 가 path(또는 하위)인 터미널 세션과 그 프로세스를 모두 종료하고 종료 개수를 돌려준다 (worktree 삭제 전) */
  ptyKillByCwd(path: string): Promise<number>
}

/** worktree 서비스가 쓰는 호스트 기능 */
export type WorktreeHost = GitHost & FsHost & ScriptHost & SessionKiller
