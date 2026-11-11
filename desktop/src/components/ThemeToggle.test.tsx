import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'

import { GHOSTTY, GHOSTTY_TERMINAL, GHOSTTY_UI } from '../lib/ghostty'
import { applyTheme, isDark, nextTheme, terminalBackground, terminalTheme, useApplyTheme } from '../lib/theme'
import { useUiStore } from '../store/ui'
import { ThemeToggle } from './ThemeToggle'

function Harness() {
  useApplyTheme()
  return <ThemeToggle />
}

const root = () => document.documentElement

/** WCAG 대비(#rrggbb 두 색) */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl
  }
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

describe('테마', () => {
  beforeEach(() => {
    localStorage.clear()
    useUiStore.setState({ theme: 'ghostty' })
    root().className = ''
  })

  it('기본은 Ghostty — <html> 에 dark 와 ghostty class 를 함께 적용한다', () => {
    expect(useUiStore.getInitialState().theme).toBe('ghostty')
    render(<Harness />)
    expect(root().classList.contains('dark')).toBe(true)
    expect(root().classList.contains('ghostty')).toBe(true)
    expect(screen.getByRole('button', { name: '테마: Ghostty' })).toHaveAttribute('title', '블랙 테마로 전환')
  })

  it('누를 때마다 Ghostty → 블랙 → 라이트 → Ghostty 로 바뀌고 store 에 남는다', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByRole('button', { name: '테마: Ghostty' }))
    expect(useUiStore.getState().theme).toBe('black')
    expect([root().classList.contains('dark'), root().classList.contains('ghostty')]).toEqual([true, false])
    await user.click(screen.getByRole('button', { name: '테마: 블랙' }))
    expect(useUiStore.getState().theme).toBe('light')
    expect([root().classList.contains('dark'), root().classList.contains('ghostty')]).toEqual([false, false])
    expect(JSON.parse(localStorage.getItem('minmo-ui') ?? '{}').state.theme).toBe('light')
    await user.click(screen.getByRole('button', { name: '테마: 라이트' }))
    expect(useUiStore.getState().theme).toBe('ghostty')
    expect(nextTheme('light')).toBe('ghostty')
  })

  it('applyTheme: color-scheme 과 class', () => {
    const el = document.createElement('html')
    applyTheme('light', el)
    expect([el.className, el.style.colorScheme]).toEqual(['', 'light'])
    applyTheme('black', el)
    expect([el.className, el.style.colorScheme]).toEqual(['dark', 'dark'])
    applyTheme('ghostty', el)
    expect([el.classList.contains('dark'), el.classList.contains('ghostty'), el.style.colorScheme]).toEqual([true, true, 'dark'])
    expect([isDark('ghostty'), isDark('black'), isDark('light')]).toEqual([true, true, false])
  })

  it('터미널: Ghostty 는 배경·글자·16색 전체, 블랙·라이트는 배경만', () => {
    expect(terminalBackground('ghostty')).toBe('#282c34')
    expect(terminalBackground('black')).toBe('#000000')
    expect(terminalBackground('light')).toBe('#1e1e1e')
    expect(terminalTheme('black')).toEqual({ background: '#000000' })
    const g = terminalTheme('ghostty')
    expect(g).toBe(GHOSTTY_TERMINAL)
    expect([g.background, g.foreground]).toEqual(['#282c34', '#ffffff'])
    // Ghostty 소스(src/terminal/color.zig Name.default)의 16색
    expect([g.black, g.red, g.green, g.yellow, g.blue, g.magenta, g.cyan, g.white]).toEqual(['#1d1f21', '#cc6666', '#b5bd68', '#f0c674', '#81a2be', '#b294bb', '#8abeb7', '#c5c8c6'])
    expect([g.brightBlack, g.brightRed, g.brightGreen, g.brightYellow, g.brightBlue, g.brightMagenta, g.brightCyan, g.brightWhite]).toEqual([
      '#666666',
      '#d54e53',
      '#b9ca4a',
      '#e7c547',
      '#7aa6da',
      '#c397d8',
      '#70c0b1',
      '#eaeaea',
    ])
    // 커서는 글자색, 선택은 글자·배경 반전
    expect([g.cursor, g.selectionBackground, g.selectionForeground]).toEqual(['#ffffff', '#ffffff', '#282c34'])
  })
})

describe('저장된 테마(업데이트·잘못된 값)', () => {
  // zustand persist 는 항상 version 을 함께 저장한다(예전 버전은 0)
  const stored = (state: unknown, version: number) => localStorage.setItem('minmo-ui', JSON.stringify({ state, version }))
  const rehydrate = async () => {
    await useUiStore.persist.rehydrate()
    return useUiStore.getState().theme
  }

  beforeEach(() => {
    localStorage.clear()
    useUiStore.setState({ theme: 'ghostty' })
  })

  it('예전 버전이 남긴 black(고르지 않아도 저장되던 기본값)은 한 번 Ghostty 로 옮긴다', async () => {
    stored({ theme: 'black', expanded: { a: true } }, 0)
    expect(await rehydrate()).toBe('ghostty')
    // 다른 저장 값은 그대로
    expect(useUiStore.getState().expanded).toEqual({ a: true })
  })

  it('직접 고른 light 는 유지한다', async () => {
    stored({ theme: 'light' }, 0)
    expect(await rehydrate()).toBe('light')
  })

  it('옮긴 뒤에 고른 블랙은 유지한다', async () => {
    stored({ theme: 'black' }, 1)
    expect(await rehydrate()).toBe('black')
  })

  it('알 수 없는 값은 기본 테마로 — 버튼이 깨지지 않는다', async () => {
    stored({ theme: 'neon' }, 1)
    expect(await rehydrate()).toBe('ghostty')
    stored({ theme: null }, 1)
    expect(await rehydrate()).toBe('ghostty')
    render(<ThemeToggle />)
    expect(screen.getByRole('button', { name: '테마: Ghostty' })).toBeInTheDocument()
  })
})

describe('Ghostty 화면 토큰(index.css)', () => {
  const css = readFileSync(join(process.cwd(), 'src', 'index.css'), 'utf8')
  const block = /\.dark\.ghostty\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
  const token = (name: string) => new RegExp(`--${name}:\\s*([^;]+);`).exec(block)?.[1].trim()

  it('lib/ghostty.ts 의 색과 같다', () => {
    expect(token('background')).toBe(GHOSTTY.background)
    expect(token('foreground')).toBe(GHOSTTY.foreground)
    expect(token('card')).toBe(GHOSTTY_UI.surface)
    expect(token('popover')).toBe(GHOSTTY_UI.surface)
    expect(token('muted')).toBe(GHOSTTY_UI.raised)
    expect(token('muted-foreground')).toBe(GHOSTTY_UI.mutedForeground)
    expect(token('primary')).toBe(GHOSTTY_UI.accent)
    expect(token('primary-foreground')).toBe(GHOSTTY_UI.accentForeground)
    expect(token('ring')).toBe(GHOSTTY_UI.accent)
    expect(token('destructive')).toBe(GHOSTTY_UI.error)
    for (const name of ['secondary', 'accent']) expect(token(name)).toBe(GHOSTTY_UI.raised)
    expect(token('warning')).toBe('#f0c674')
  })

  it('글자·배경 대비가 WCAG AA(4.5:1) 이상이다', () => {
    const pairs: [string, string, string][] = [
      ['본문', GHOSTTY.foreground, GHOSTTY.background],
      ['면 위 본문', GHOSTTY.foreground, GHOSTTY_UI.raised],
      ['보조 글자', GHOSTTY_UI.mutedForeground, GHOSTTY.background],
      ['면 위 보조 글자', GHOSTTY_UI.mutedForeground, GHOSTTY_UI.raised],
      ['강조 버튼', GHOSTTY_UI.accentForeground, GHOSTTY_UI.accent],
      ['오류 글자', GHOSTTY_UI.error, GHOSTTY.background],
      ['편집기 주석', GHOSTTY_UI.comment, GHOSTTY.background],
      ['포커스 링(글자 아님, 3:1 이상이면 됨)', GHOSTTY_UI.accent, GHOSTTY_UI.raised],
    ]
    for (const [name, fg, bg] of pairs) expect(contrast(fg, bg), name).toBeGreaterThanOrEqual(name.startsWith('포커스 링') ? 3 : 4.5)
  })
})
