// Why: 닫은 탭·패널의 PTY·원격 tmux 정리는 화면 밖 부작용이라 UI 에서 떼고, store 를 읽지 않고 인자만 받는다
import { remotePty } from '../../lib/sshHost'
import type { PtyTmux, TauriApi } from '../../lib/tauri'
import type { TerminalSessionSpec } from './TerminalTab'

export function paneSeq(paneId: string): number {
  return Number(paneId.slice(paneId.lastIndexOf('::') + 2)) || 1
}

const killTmuxSession = (tauri: Pick<TauriApi, 'sshExec'>, host: string, session: string) =>
  tauri.sshExec(host, ['tmux', '-L', 'minmo', 'kill-session', '-t', `=${session}`])

// Why: tmux 는 ptyKill 전에 물어 둔 값이다(그 뒤에는 Rust 가 모른다). 실패는 무시한다 —
// 남은 세션은 작업 폴더를 지울 때 KILL_TMUX 가 정리한다
export function killPaneTerminal(
  tauri: Pick<TauriApi, 'ptyKill' | 'sshExec'>,
  ptyId: string,
  remoteHost: string | undefined,
  tmux: PtyTmux | null | Promise<PtyTmux | null>,
): Promise<void> {
  const killed = tauri.ptyKill(ptyId).catch(() => undefined)
  if (remoteHost === undefined) return killed
  return Promise.all([tmux, killed])
    .then(async ([info]) => {
      if (info?.ephemeral) await killTmuxSession(tauri, remoteHost, info.session)
    })
    .catch(() => undefined)
}

// Why: 마운트되지 않은 패널(다른 창의 PTY 포함)도 끝낸다. terminalIds 는 poll 로 채워져 마운트 판정에 못 쓰고,
// 마운트된 TerminalSession 정리와 겹쳐 두 번 끝내도 실패는 무시한다
export async function endPanes(
  tauri: Pick<TauriApi, 'ptyFind' | 'ptyKill' | 'sshExec'>,
  spec: TerminalSessionSpec,
  paneIds: string[],
  first: string | undefined,
  probeTmux: boolean,
): Promise<void> {
  const host = spec.remote?.host
  await Promise.allSettled(
    paneIds.map(async (paneId) => {
      const found = await tauri.ptyFind(paneId)
      if (found) return killPaneTerminal(tauri, found.id, host, found.tmux ?? null)
      if (host === undefined || !probeTmux || paneId === first) return
      await killTmuxSession(tauri, host, remotePty(host, true, spec.cwd, { primary: false, seq: paneSeq(paneId) }).session!)
    }),
  )
}
