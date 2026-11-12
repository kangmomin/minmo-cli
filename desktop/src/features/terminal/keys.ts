// 터미널 키보드 탈출(AX-02) — 컴포넌트 파일과 분리(react-refresh 규칙)
import { fontSizeAction } from '../../lib/fontSize'

/** 터미널은 Tab 키를 셸로 보내므로 키보드 사용자가 빠져나갈 단축키가 필요하다 (WCAG 2.1.2) */
export const TERMINAL_EXIT_HINT = 'Ctrl+Shift+M'

/** 패널 단축키 — 앱이 우선 처리하므로 셸의 Ctrl+D(EOF)·Ctrl+W(단어 지우기)는 이 키로 보낼 수 없다(사용자 결정) */
export const PANE_KEYS = { splitRight: 'Ctrl+D', splitDown: 'Ctrl+Shift+D', close: 'Ctrl+W' } as const

/** 복사·붙여넣기 — Windows Terminal 과 같게: 선택이 있으면 Ctrl+C 는 복사, Ctrl+V 는 붙여넣기 */
export const CLIPBOARD_KEYS = { copy: 'Ctrl+C', paste: 'Ctrl+V' } as const

export interface TerminalClipboard {
  /** 선택한 영역이 있는가 — 빈칸만 고르면 글자는 비어 있어도 선택은 있다 */
  hasSelection(): boolean
  /** 터미널에서 선택한 글자 */
  selection(): string
  copy(text: string): void
  clearSelection(): void
}

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
export function createTerminalKeyHandler(onExit: () => void, panes?: PaneKeyActions, clipboard?: TerminalClipboard): (e: KeyboardEvent) => boolean {
  // 복사한 Ctrl+C 를 누르고 있는 동안에는 셸로 보내지 않는다 — 복사로 선택이 풀리면, 키 반복이 "선택 없음 = 중단"으로
  // 읽혀 실행 중인 명령을 끊게 된다
  let copying = false
  return (e) => {
    if (!e.ctrlKey || e.altKey || e.metaKey) return true
    // 글자 크기 단축키(Ctrl + / - / 0)는 앱이 처리한다(lib/fontSize.ts 의 window 단축키) — 셸로 보내지 않는다
    if (fontSizeAction(e)) return false
    if (clipboard && isKey(e, 'c')) {
      if (e.type === 'keyup') {
        const was = copying
        copying = false
        if (was) return false
      } else if (copying && e.repeat) {
        return false
      } else if (e.type === 'keydown') {
        copying = false
      }
      const selected = clipboard.hasSelection()
      // 선택이 없는 Ctrl+C 는 셸로 보낸다(실행 중인 명령 중단). Ctrl+Shift+C 는 복사 전용이라 보내지 않는다
      if (!selected && !e.shiftKey) return true
      if (e.type === 'keydown') {
        e.preventDefault()
        if (selected) {
          // 빈칸만 고른 선택은 글자가 없다 — 빈 문자열로 클립보드를 덮어쓰지 않는다
          const text = clipboard.selection()
          if (text !== '') clipboard.copy(text)
          clipboard.clearSelection()
          copying = true
        }
      }
      return false
    }
    // 붙여넣기: 셸로 ^V 를 보내지 않게만 하고 기본 동작은 막지 않는다 — 브라우저의 붙여넣기 이벤트를 xterm 이 받아
    // 붙여 넣는다(클립보드 읽기 권한 없이 동작하고, 여러 줄은 셸의 붙여넣기 모드로 들어간다)
    if (clipboard && isKey(e, 'v')) return false
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
