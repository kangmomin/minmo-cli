// 글자 크기 단축키·저장 값·설정 화면
import { render, renderHook, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'

import { ServerSettingsDialog } from '../features/server/ServerSettingsDialog'
import { useServerStore } from '../store/server'
import { FONT_SIZE, clampFontSize, useUiStore } from '../store/ui'
import { createFakeTauri } from '../test/fakes'
import { fontSizeAction, useFontSizeShortcuts } from './fontSize'

const ev = (init: Partial<KeyboardEvent>) => ({ ctrlKey: true, altKey: false, metaKey: false, shiftKey: false, key: '', code: '', ...init })

beforeEach(() => {
  localStorage.clear()
  useUiStore.setState({ fontSize: FONT_SIZE.default })
})

describe('fontSizeAction', () => {
  it('Ctrl + = / + / 키패드 + 는 키우기, Ctrl - 는 줄이기, Ctrl 0 은 기본값', () => {
    expect(fontSizeAction(ev({ key: '=' }))).toBe('in')
    expect(fontSizeAction(ev({ key: '+', shiftKey: true }))).toBe('in')
    expect(fontSizeAction(ev({ key: '+', code: 'NumpadAdd' }))).toBe('in')
    expect(fontSizeAction(ev({ key: '-' }))).toBe('out')
    expect(fontSizeAction(ev({ key: '-', code: 'NumpadSubtract' }))).toBe('out')
    expect(fontSizeAction(ev({ key: '0' }))).toBe('reset')
    expect(fontSizeAction(ev({ key: '0', code: 'Numpad0' }))).toBe('reset')
  })

  it('Ctrl 없이·Alt(AltGr)·Meta 와 함께·다른 키는 아니다', () => {
    expect(fontSizeAction(ev({ key: '=', ctrlKey: false }))).toBeNull()
    expect(fontSizeAction(ev({ key: '-', altKey: true }))).toBeNull()
    expect(fontSizeAction(ev({ key: '0', metaKey: true }))).toBeNull()
    expect(fontSizeAction(ev({ key: '_', shiftKey: true }))).toBeNull()
    expect(fontSizeAction(ev({ key: ')', shiftKey: true }))).toBeNull()
    expect(fontSizeAction(ev({ key: '1' }))).toBeNull()
  })
})

describe('저장 값', () => {
  it('범위(9~28)로 맞추고 정수로 만든다 · 숫자가 아니면 기본값', () => {
    expect([clampFontSize(3), clampFontSize(40), clampFontSize(14.6), clampFontSize('x'), clampFontSize(NaN)]).toEqual([9, 28, 15, 13, 13])
    useUiStore.getState().setFontSize(100)
    expect(useUiStore.getState().fontSize).toBe(28)
  })

  it('이 PC 에 저장되고, 손상된 저장 값은 범위 안으로 읽는다', async () => {
    useUiStore.getState().setFontSize(17)
    expect(JSON.parse(localStorage.getItem('minmo-ui') ?? '{}').state.fontSize).toBe(17)
    localStorage.setItem('minmo-ui', JSON.stringify({ state: { fontSize: 'huge', theme: 'light' }, version: 1 }))
    await useUiStore.persist.rehydrate()
    expect(useUiStore.getState().fontSize).toBe(13)
    localStorage.setItem('minmo-ui', JSON.stringify({ state: { fontSize: 500 }, version: 1 }))
    await useUiStore.persist.rehydrate()
    expect(useUiStore.getState().fontSize).toBe(28)
    // 예전 버전의 저장 값(크기 없음)은 기본값
    useUiStore.setState({ fontSize: 13 })
    localStorage.setItem('minmo-ui', JSON.stringify({ state: { theme: 'black' }, version: 1 }))
    await useUiStore.persist.rehydrate()
    expect(useUiStore.getState().fontSize).toBe(13)
  })
})

describe('단축키', () => {
  it('포커스 위치와 무관하게 동작하고 기본 동작(화면 확대)을 막는다 · 범위 끝에서 멈춘다', async () => {
    renderHook(() => useFontSizeShortcuts())
    const user = userEvent.setup()
    await user.keyboard('{Control>}={/Control}')
    await user.keyboard('{Control>}={/Control}')
    expect(useUiStore.getState().fontSize).toBe(15)
    await user.keyboard('{Control>}-{/Control}')
    expect(useUiStore.getState().fontSize).toBe(14)
    await user.keyboard('{Control>}0{/Control}')
    expect(useUiStore.getState().fontSize).toBe(13)
    const e = new KeyboardEvent('keydown', { key: '=', ctrlKey: true, cancelable: true })
    window.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(true)
    useUiStore.setState({ fontSize: FONT_SIZE.min })
    await user.keyboard('{Control>}-{/Control}')
    expect(useUiStore.getState().fontSize).toBe(FONT_SIZE.min)
    // 단축키가 아닌 입력은 건드리지 않는다
    const plain = new KeyboardEvent('keydown', { key: '=', cancelable: true })
    window.dispatchEvent(plain)
    expect(plain.defaultPrevented).toBe(false)
  })
})

describe('설정 화면', () => {
  it('글자 크기를 입력하면 바로 적용되고, 범위 밖의 입력 중간 값은 적용하지 않는다 · [기본값]', async () => {
    useServerStore.setState({ settingsOpen: true })
    const { tauri } = createFakeTauri()
    render(<ServerSettingsDialog tauri={tauri} />)
    const user = userEvent.setup()
    const input = await screen.findByRole('spinbutton', { name: '글자 크기(터미널·파일 편집기)' })
    expect(input).toHaveValue(13)
    await user.clear(input)
    // "1" 을 치는 순간에는 바뀌지 않는다(9 미만)
    await user.type(input, '1')
    expect(useUiStore.getState().fontSize).toBe(13)
    await user.type(input, '8')
    expect(useUiStore.getState().fontSize).toBe(18)
    await user.click(screen.getByRole('button', { name: '기본값' }))
    expect(useUiStore.getState().fontSize).toBe(13)
    expect(input).toHaveValue(13)
    expect(screen.getByRole('button', { name: '기본값' })).toBeDisabled()
  })
})
