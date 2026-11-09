// 터미널 키보드 탈출(AX-02) — 컴포넌트 파일과 분리(react-refresh 규칙)

/** 터미널은 Tab 키를 셸로 보내므로 키보드 사용자가 빠져나갈 단축키가 필요하다 (WCAG 2.1.2) */
export const TERMINAL_EXIT_HINT = 'Ctrl+Shift+M'

/**
 * xterm attachCustomKeyEventHandler 용. false 를 돌려주면 xterm 이 키를 처리(셸 전송)하지 않는다.
 * Ctrl+Shift+M 은 keydown 에서 onExit 를 1회 부르고, keypress/keyup 도 셸로 새지 않게 막는다.
 */
export function createTerminalKeyHandler(onExit: () => void): (e: KeyboardEvent) => boolean {
  return (e) => {
    const isExit = e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && (e.code === 'KeyM' || e.key.toLowerCase() === 'm')
    if (!isExit) return true
    if (e.type === 'keydown') {
      e.preventDefault()
      onExit()
    }
    return false
  }
}
