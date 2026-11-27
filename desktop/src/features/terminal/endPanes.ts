// [Red 스텁 #120] 닫은 탭·패널의 PTY·원격 tmux 세션 정리(화면 밖 부작용) — Phase 5.2 에서 구현한다
import type { PtyTmux, TauriApi } from '../../lib/tauri'
import type { TerminalSessionSpec } from './TerminalTab'

/** 패널 id `<이슈id>::<seq>` 의 seq */
export function paneSeq(_paneId: string): number {
  return 0
}

export function killPaneTerminal(
  _tauri: Pick<TauriApi, 'ptyKill' | 'sshExec'>,
  _ptyId: string,
  _remoteHost: string | undefined,
  _tmux: PtyTmux | null | Promise<PtyTmux | null>,
): Promise<void> {
  return Promise.resolve()
}

export function endPanes(
  _tauri: Pick<TauriApi, 'ptyFind' | 'ptyKill' | 'sshExec'>,
  _spec: TerminalSessionSpec,
  _paneIds: string[],
  _first: string | undefined,
  _probeTmux: boolean,
): Promise<void> {
  return Promise.resolve()
}
