// worktree 터미널 — OS·설정 차이를 감춘다.
// - Linux·macOS(기본): worktree 에서 사용자 셸($SHELL)을 연다(exit 하면 돌아온다, 세션 유지 없음)
// - Linux·macOS(`minmo terminal tmux`): 전용 tmux 서버의 세션(접속이 끊겨도 유지, detach 하면 돌아온다)
// - Windows: worktree 에서 새 PowerShell 을 연다(exit 하면 돌아온다, 세션 유지 없음)
import { spawnSync } from 'node:child_process'

import { CliError } from '../errors'
import type { TerminalMode } from '../store'
import { attach, ensureSession, tmuxAvailable } from './tmux'

export type TerminalDeps = {
  /** 기본 shell */
  mode?: TerminalMode
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  spawn?: typeof spawnSync
}

let shellCache: string | null = null

/** pwsh(PowerShell 7) 가 있으면 그것, 없으면 Windows 기본 powershell.exe — 한 번만 확인한다 */
export function windowsShell(spawn: typeof spawnSync = spawnSync, cache = true): string {
  if (cache && shellCache) return shellCache
  const r = spawn('pwsh', ['-NoLogo', '-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore', windowsHide: true })
  const shell = r.status === 0 ? 'pwsh' : 'powershell.exe'
  if (cache) shellCache = shell
  return shell
}

/**
 * 셸 인자 — 경로를 명령줄에 남긴다. PowerShell 의 cd 는 프로세스 cwd 를 바꾸지 않아 셸이 폴더를 계속 잡고 있으므로,
 * worktree 를 지울 때 명령줄로 이 셸을 찾아(win.ts) 정리하거나, 이 셸 안에서 지우려 하면 막을 수 있게 한다.
 */
export const windowsShellArgs = (path: string) => ['-NoLogo', '-NoExit', '-Command', `Set-Location -LiteralPath '${path.replace(/'/g, "''")}'`]

/** Linux·macOS 의 일반 셸 — 사용자 셸($SHELL), 없으면 sh */
export const posixShell = (env: NodeJS.ProcessEnv = process.env) => env.SHELL || '/bin/sh'

/** tmux 를 쓰는가 — Windows 는 설정과 상관없이 PowerShell */
const usesTmux = (mode: TerminalMode, platform: NodeJS.Platform) => platform !== 'win32' && mode === 'tmux'

export async function terminalAvailable(mode: TerminalMode = 'shell', platform: NodeJS.Platform = process.platform): Promise<boolean> {
  return usesTmux(mode, platform) ? tmuxAvailable() : true
}

/** 사용자가 쓰는 말로 — TUI 안내·doctor 용 */
export const terminalLabel = (mode: TerminalMode = 'shell', platform: NodeJS.Platform = process.platform) =>
  platform === 'win32' ? 'PowerShell(exit 로 돌아옴)' : mode === 'tmux' ? 'tmux' : '셸(exit 로 돌아옴)'

/** 터미널을 worktree 에 붙이고, 사용자가 나오면 종료 코드를 돌려준다 */
export async function openTerminal(path: string, title: string, d: TerminalDeps = {}): Promise<number> {
  const platform = d.platform ?? process.platform
  const env = d.env ?? process.env
  const spawn = d.spawn ?? spawnSync
  if (usesTmux(d.mode ?? 'shell', platform)) return attach(await ensureSession(path, title), env)
  // 같은 콘솔이라 셸 안에서 Ctrl+C(예: npm run dev 멈추기)를 누르면 minmo 에도 전달된다 — 그동안 무시해 TUI 가 살아 있게
  const ignore = () => {}
  process.on('SIGINT', ignore)
  try {
    const opts = { cwd: path, stdio: 'inherit' as const, env: { ...env, MINMO_WORKTREE: path } }
    // 주입된 spawn(테스트)으로는 결과를 캐시하지 않는다
    const r = platform === 'win32' ? spawn(windowsShell(spawn, d.spawn === undefined), windowsShellArgs(path), opts) : spawn(posixShell(env), [], opts)
    // 예: $SHELL 이 없는 경로 — 스택 없이 안내만
    if (r.error) throw new CliError(`터미널을 열 수 없습니다: ${r.error.message}`)
    return r.status ?? 1
  } finally {
    process.off('SIGINT', ignore)
  }
}
