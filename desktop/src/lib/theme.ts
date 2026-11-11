import type { ITheme } from '@xterm/xterm'
import { useEffect } from 'react'

import { type Theme, useUiStore } from '../store/ui'
import { GHOSTTY, GHOSTTY_TERMINAL } from './ghostty'

/** 테마 버튼이 도는 순서와 표시 이름 */
export const THEMES: readonly Theme[] = ['ghostty', 'black', 'light']
export const THEME_LABEL: Record<Theme, string> = { ghostty: 'Ghostty', black: '블랙', light: '라이트' }
export const nextTheme = (theme: Theme): Theme => THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length]

/** 어두운 테마인가(편집기·`dark:` 스타일 기준) */
export const isDark = (theme: Theme) => theme !== 'light'

/**
 * 어두운 테마는 shadcn 의 .dark 토큰을 쓴다. Ghostty 는 .dark 위에 .ghostty 를 더해 색 토큰만 바꾼다
 * (그래서 기존 `dark:` 스타일이 Ghostty 에서도 그대로 적용된다).
 */
export function applyTheme(theme: Theme, root: HTMLElement = document.documentElement) {
  root.classList.toggle('dark', isDark(theme))
  root.classList.toggle('ghostty', theme === 'ghostty')
  root.style.colorScheme = isDark(theme) ? 'dark' : 'light'
}

/** store 의 테마를 <html> 에 반영한다 (persist 복원 직후 포함) */
export function useApplyTheme() {
  const theme = useUiStore((s) => s.theme)
  useEffect(() => applyTheme(theme), [theme])
}

/** 터미널 배경: Ghostty 는 그 배경, 블랙은 앱 배경과 같은 검정, 라이트에서도 터미널은 어둡게 둔다 */
export function terminalBackground(theme: Theme) {
  return theme === 'ghostty' ? GHOSTTY.background : theme === 'black' ? '#000000' : '#1e1e1e'
}

/** xterm 테마: Ghostty 는 배경·글자·16색 전체, 나머지는 배경만(색은 xterm 기본값) */
export function terminalTheme(theme: Theme): ITheme {
  return theme === 'ghostty' ? GHOSTTY_TERMINAL : { background: terminalBackground(theme) }
}
