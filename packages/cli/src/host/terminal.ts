// worktree 터미널 — OS 차이를 감춘다.
// - Linux·macOS: 전용 tmux 서버의 세션(접속이 끊겨도 유지, detach 하면 돌아온다)
// - Windows: tmux 가 없어 worktree 에서 새 PowerShell 을 연다(exit 하면 돌아온다, 세션 유지 없음)
import { spawnSync } from 'node:child_process'

import { attach, ensureSession, tmuxAvailable } from './tmux'

export type TerminalDeps = {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  spawn?: typeof spawnSync
}

/** pwsh(PowerShell 7) 가 있으면 그것, 없으면 Windows 기본 powershell.exe */
export function windowsShell(spawn: typeof spawnSync = spawnSync): string {
  const r = spawn('pwsh', ['-NoLogo', '-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore', windowsHide: true })
  return r.status === 0 ? 'pwsh' : 'powershell.exe'
}

export async function terminalAvailable(platform: NodeJS.Platform = process.platform): Promise<boolean> {
  return platform === 'win32' ? true : tmuxAvailable()
}

/** 사용자가 쓰는 말로 — TUI 안내·doctor 용 */
export const terminalLabel = (platform: NodeJS.Platform = process.platform) => (platform === 'win32' ? 'PowerShell(exit 로 돌아옴)' : 'tmux')

/** 터미널을 worktree 에 붙이고, 사용자가 나오면 종료 코드를 돌려준다 */
export async function openTerminal(path: string, title: string, d: TerminalDeps = {}): Promise<number> {
  const platform = d.platform ?? process.platform
  const env = d.env ?? process.env
  const spawn = d.spawn ?? spawnSync
  if (platform !== 'win32') return attach(await ensureSession(path, title), env)
  // 터미널 안의 프로세스가 어느 worktree 소속인지 알 수 있게 남긴다
  const r = spawn(windowsShell(spawn), ['-NoLogo'], { cwd: path, stdio: 'inherit', env: { ...env, MINMO_WORKTREE: path } })
  return r.status ?? 1
}
