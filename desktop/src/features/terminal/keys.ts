// 터미널 키보드 탈출(AX-02) — 컴포넌트 파일과 분리(react-refresh 규칙)

/** 터미널은 Tab 키를 셸로 보내므로 키보드 사용자가 빠져나갈 단축키가 필요하다 (WCAG 2.1.2) */
export const TERMINAL_EXIT_HINT = 'Ctrl+Shift+M'

/** 패널 단축키 — 앱이 우선 처리하므로 셸의 Ctrl+D(EOF)·Ctrl+W(단어 지우기)는 이 키로 보낼 수 없다(사용자 결정) */
export const PANE_KEYS = { splitRight: 'Ctrl+D', splitDown: 'Ctrl+Shift+D', close: 'Ctrl+W' } as const

export interface PaneKeyActions {
  splitRight(): void
  splitDown(): void
  close(): void
}

/** 입력된 문자(e.key)를 우선한다 — Dvorak 등에서 물리 키(e.code)로 비교하면 다른 단축키(Ctrl+E 등)를 가로챈다.
 *  한글 IME 처럼 e.key 가 라틴 문자가 아닐 때만 물리 키로 판단한다 */
function isKey(e: KeyboardEvent, letter: string): boolean {
  const k = e.key.length === 1 ? e.key.toLowerCase() : ''
  return /^[a-z]$/.test(k) ? k === letter : e.code === `Key${letter.toUpperCase()}`
}

/**
 * xterm attachCustomKeyEventHandler 용. false 를 돌려주면 xterm 이 키를 처리(셸 전송)하지 않는다.
 * 앱 단축키는 keydown 에서 1회 실행하고, keypress/keyup 도 셸로 새지 않게 막는다.
 */
export function createTerminalKeyHandler(onExit: () => void, panes?: PaneKeyActions): (e: KeyboardEvent) => boolean {
  return (e) => {
    if (!e.ctrlKey || e.altKey || e.metaKey) return true
    let action: (() => void) | undefined
    if (e.shiftKey && isKey(e, 'm')) action = onExit
    else if (panes && e.shiftKey && isKey(e, 'd')) action = panes.splitDown
    else if (panes && !e.shiftKey && isKey(e, 'd')) action = panes.splitRight
    else if (panes && !e.shiftKey && isKey(e, 'w')) action = panes.close
    if (!action) return true
    if (e.type === 'keydown') {
      e.preventDefault()
      action()
    }
    return false
  }
}
