// 터미널·파일 편집기의 글자 크기 단축키 — Ctrl + / Ctrl - / Ctrl 0 (Windows 앱과 같게)
import { useEffect } from 'react'

import { FONT_SIZE, useUiStore } from '../store/ui'

export type FontSizeAction = 'in' | 'out' | 'reset'

/** 글자 크기 단축키면 그 동작. Ctrl 만 누른 조합만 본다(Ctrl+Alt 는 AltGr 글자 입력일 수 있다) */
export function fontSizeAction(e: Pick<KeyboardEvent, 'ctrlKey' | 'altKey' | 'metaKey' | 'shiftKey' | 'key' | 'code'>): FontSizeAction | null {
  if (!e.ctrlKey || e.altKey || e.metaKey) return null
  // + 는 자판에 따라 Shift+= 로 입력하므로 Shift 여부를 가리지 않는다
  if (e.key === '+' || e.key === '=' || e.code === 'NumpadAdd') return 'in'
  if (e.shiftKey) return null
  if (e.key === '-' || e.code === 'NumpadSubtract') return 'out'
  if (e.key === '0' || e.code === 'Numpad0') return 'reset'
  return null
}

export function applyFontSizeAction(action: FontSizeAction) {
  const { fontSize, setFontSize } = useUiStore.getState()
  setFontSize(action === 'reset' ? FONT_SIZE.default : fontSize + (action === 'in' ? 1 : -1))
}

/** 포커스가 어디에 있든 동작하게 window 에서 받는다. 기본 동작(WebView 의 화면 확대)은 막는다 */
export function useFontSizeShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = fontSizeAction(e)
      if (!action) return
      e.preventDefault()
      applyFontSizeAction(action)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
