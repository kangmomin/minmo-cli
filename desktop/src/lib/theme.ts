import { useEffect } from 'react'

import { type Theme, useUiStore } from '../store/ui'

/** 블랙 테마는 shadcn 의 .dark 토큰을 쓴다 */
export function applyTheme(theme: Theme, root: HTMLElement = document.documentElement) {
  root.classList.toggle('dark', theme === 'black')
  root.style.colorScheme = theme === 'black' ? 'dark' : 'light'
}

/** store 의 테마를 <html> 에 반영한다 (persist 복원 직후 포함) */
export function useApplyTheme() {
  const theme = useUiStore((s) => s.theme)
  useEffect(() => applyTheme(theme), [theme])
}

/** xterm 배경: 블랙 테마는 앱 배경과 같은 검정, 라이트에서도 터미널은 어둡게 둔다 */
export function terminalBackground(theme: Theme) {
  return theme === 'black' ? '#000000' : '#1e1e1e'
}
