import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'

import { applyTheme, terminalBackground, useApplyTheme } from '../lib/theme'
import { useUiStore } from '../store/ui'
import { ThemeToggle } from './ThemeToggle'

function Harness() {
  useApplyTheme()
  return <ThemeToggle />
}

describe('블랙 테마', () => {
  beforeEach(() => {
    useUiStore.setState({ theme: 'black' })
    document.documentElement.className = ''
  })

  it('기본은 블랙 — <html> 에 dark class 를 적용한다', () => {
    render(<Harness />)
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(screen.getByRole('button', { name: '블랙 테마' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('전환하면 라이트로 바뀌고 store 에 남는다', async () => {
    render(<Harness />)
    await userEvent.click(screen.getByRole('button', { name: '블랙 테마' }))
    expect(useUiStore.getState().theme).toBe('light')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(screen.getByRole('button', { name: '블랙 테마' })).toHaveAttribute('aria-pressed', 'false')
    expect(JSON.parse(localStorage.getItem('minmo-ui') ?? '{}').state.theme).toBe('light')
  })

  it('applyTheme·터미널 배경', () => {
    const el = document.createElement('html')
    applyTheme('light', el)
    expect(el.classList.contains('dark')).toBe(false)
    applyTheme('black', el)
    expect(el.classList.contains('dark')).toBe(true)
    expect(terminalBackground('black')).toBe('#000000')
    expect(terminalBackground('light')).toBe('#1e1e1e')
  })
})
