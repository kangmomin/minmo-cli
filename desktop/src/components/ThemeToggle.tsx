import { GhostIcon, MoonIcon, SunIcon } from 'lucide-react'

import { THEME_LABEL, nextTheme } from '../lib/theme'
import { useUiStore } from '../store/ui'
import type { Theme } from '../store/ui'
import { Button } from './ui/button'

const ICON: Record<Theme, typeof MoonIcon> = { ghostty: GhostIcon, black: MoonIcon, light: SunIcon }

/** 누를 때마다 Ghostty(기본) → 블랙 → 라이트 순으로 바꾼다. 상태는 ui store 에 persist 된다 */
export function ThemeToggle() {
  const theme = useUiStore((s) => s.theme)
  const setTheme = useUiStore((s) => s.setTheme)
  const next = nextTheme(theme)
  const Icon = ICON[theme]
  // 이름에 지금 테마를 넣어, 눌렀을 때 바뀐 이름이 읽히게 한다
  return (
    <Button variant="ghost" size="icon-sm" aria-label={`테마: ${THEME_LABEL[theme]}`} title={`${THEME_LABEL[next]} 테마로 전환`} onClick={() => setTheme(next)}>
      <Icon />
    </Button>
  )
}
