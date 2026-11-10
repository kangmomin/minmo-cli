import { MoonIcon, SunIcon } from 'lucide-react'

import { useUiStore } from '../store/ui'
import { Button } from './ui/button'

/** 블랙(기본) ↔ 라이트 전환. 상태는 ui store 에 persist 된다 */
export function ThemeToggle() {
  const theme = useUiStore((s) => s.theme)
  const setTheme = useUiStore((s) => s.setTheme)
  const black = theme === 'black'
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label="블랙 테마"
      aria-pressed={black}
      title={black ? '라이트 테마로 전환' : '블랙 테마로 전환'}
      onClick={() => setTheme(black ? 'light' : 'black')}
    >
      {black ? <MoonIcon /> : <SunIcon />}
    </Button>
  )
}
