// 터미널 키보드 탈출(AX-02) — 컴포넌트 파일과 분리(react-refresh 규칙)
import { useEffect } from 'react'

import { fontSizeAction } from '../../lib/fontSize'
import { useSetupStore } from '../../store/setup'
import { useUiStore } from '../../store/ui'

/** 터미널은 Tab 키를 셸로 보내므로 키보드 사용자가 빠져나갈 단축키가 필요하다 (WCAG 2.1.2) */
export const TERMINAL_EXIT_HINT = 'Ctrl+Shift+M'

/** 패널 단축키 — 앱이 우선 처리하므로 셸의 Ctrl+D(EOF)·Ctrl+W(단어 지우기)는 이 키로 보낼 수 없다(사용자 결정) */
export const PANE_KEYS = { open: 'Ctrl+T', splitRight: 'Ctrl+D', splitDown: 'Ctrl+Shift+D', close: 'Ctrl+W' } as const

/** 터미널 열기 단축키(Ctrl+T)인가. Ctrl 만 누른 조합만 본다(Ctrl+Shift+T·AltGr 조합은 건드리지 않는다) */
export function isTerminalOpenKey(e: KeyboardEvent): boolean {
  return e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && isKey(e, 't')
}

/** 새 창 단축키(#105) */
export const NEW_WINDOW_KEY = 'Ctrl+Shift+N'

/** 새 창 열기(Ctrl+Shift+N)인가 */
export function isNewWindowKey(e: KeyboardEvent): boolean {
  return e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && isKey(e, 'n')
}

/** 복사·붙여넣기 — Windows Terminal 과 같게: 선택이 있으면 Ctrl+C 는 복사, Ctrl+V 는 붙여넣기 */
export const CLIPBOARD_KEYS = { copy: 'Ctrl+C', paste: 'Ctrl+V' } as const

/**
 * 마우스 — 링크는 Ctrl+클릭으로 연다(links.ts). 프로그램(ssh 의 tmux·에이전트 CLI 등)이 마우스를 쓰면 드래그가 그 프로그램으로 가므로,
 * Shift 를 누른 채 드래그해야 터미널이 선택한다(xterm 기본 동작)
 */
export const MOUSE_KEYS = { openLink: 'Ctrl+클릭', forceSelect: 'Shift+드래그' } as const

/**
 * 편집 키 — xterm 은 Ctrl+Backspace 를 ^H(한 글자 지우기), Shift+Enter 를 Enter 와 같은 \r 로 보낸다.
 * 셸(PSReadLine·bash)과 에이전트 CLI(Claude Code·Codex·Gemini)가 알아듣는 글자로 바꿔 보낸다:
 * ^W = 앞 단어 지우기, ESC+\r(Alt+Enter) = 전송하지 않는 줄바꿈.
 * 줄바꿈으로 \n(Ctrl+J)을 쓰지 않는 이유: Windows 의 Codex 가 무시한다(실제 CLI 로 확인 — Claude Code·Codex 는 ESC+\r 을 줄바꿈으로 읽는다).
 */
export const EDIT_KEYS = { deleteWord: 'Ctrl+Backspace', newline: 'Shift+Enter' } as const
export const EDIT_KEY_DATA = { deleteWord: '\x17', newline: '\x1b\r' } as const

/**
 * Ctrl+T: 지금 고른 이슈의 터미널을 연다(없으면 시작, 있으면 새 패널). 포커스가 어디에 있든 동작하게 window 에서 받는다.
 * 작업 폴더가 준비되지 않았거나 대화상자·메뉴가 열려 있으면 아무것도 하지 않는다.
 */
export function useTerminalOpenShortcut() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 다른 곳(편집기 등)이 이미 처리한 키는 건드리지 않는다
      if (!isTerminalOpenKey(e) || e.repeat || e.defaultPrevented) return
      const ui = useUiStore.getState()
      const id = ui.selectedIssueId
      if (!id || useSetupStore.getState().open[id]?.phase !== 'ready') return
      if (document.querySelector('[role="dialog"],[role="alertdialog"],[role="menu"]')) return
      e.preventDefault()
      ui.openTerminal(id)
      ui.setTab('terminal')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

/**
 * Ctrl+Shift+N: 범위 없는 새 창을 연다. open 이 null(원격 화면)이면 아무것도 하지 않는다.
 * 대화상자·메뉴가 열려 있으면 하지 않는다(그 안의 입력을 가로채지 않게)
 */
export function useNewWindowShortcut(open: (() => void) | null) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (!isNewWindowKey(e) || e.repeat || e.defaultPrevented) return
      if (document.querySelector('[role="dialog"],[role="alertdialog"],[role="menu"]')) return
      e.preventDefault()
      open()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])
}

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
export function createTerminalKeyHandler(
  onExit: () => void,
  panes?: PaneKeyActions,
  clipboard?: TerminalClipboard,
  /** 터미널(셸)로 글자를 보낸다 — 있으면 편집 키(EDIT_KEYS)를 바꿔 보낸다 */
  send?: (data: string) => void,
): (e: KeyboardEvent) => boolean {
  // 복사한 Ctrl+C 를 누르고 있는 동안에는 셸로 보내지 않는다 — 복사로 선택이 풀리면, 키 반복이 "선택 없음 = 중단"으로
  // 읽혀 실행 중인 명령을 끊게 된다
  let copying = false
  return (e) => {
    // 한글 등 조합 중의 Enter·Backspace 는 조합을 끝내거나 지우는 키다 — 가로채지 않는다
    if (send && !e.altKey && !e.metaKey && !e.isComposing) {
      const data =
        e.key === 'Backspace' && e.ctrlKey && !e.shiftKey ? EDIT_KEY_DATA.deleteWord : e.key === 'Enter' && e.shiftKey && !e.ctrlKey ? EDIT_KEY_DATA.newline : undefined
      if (data !== undefined) {
        // 누르고 있으면 반복된다(keydown 마다). keypress·keyup 은 셸로 새지 않게 막기만 한다
        if (e.type === 'keydown') {
          e.preventDefault()
          send(data)
        }
        return false
      }
    }
    if (!e.ctrlKey || e.altKey || e.metaKey) return true
    // 글자 크기 단축키(Ctrl + / - / 0)는 앱이 처리한다(lib/fontSize.ts 의 window 단축키) — 셸로 보내지 않는다
    if (fontSizeAction(e)) return false
    // 터미널 열기(Ctrl+T)도 앱이 처리한다(useTerminalOpenShortcut 의 window 단축키) — 셸로 ^T 를 보내지 않는다
    if (isTerminalOpenKey(e)) return false
    // 새 창(Ctrl+Shift+N)도 앱이 처리한다(useNewWindowShortcut) — 셸로 ^N 을 보내지 않는다
    if (isNewWindowKey(e)) return false
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
