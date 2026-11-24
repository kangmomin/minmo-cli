// 창 사이의 "지금 보는 이슈"(#105) — 보조 창에서 보는 이슈는 주 창이 알리지 않는다
import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useUiStore } from '../../store/ui'
import { useWindowViewBroadcast, viewedInOtherWindow } from './windowView'

afterEach(() => localStorage.clear())

describe('windowView', () => {
  it('다른 창이 적은 이슈의 터미널만 본 것으로 친다', () => {
    localStorage.setItem('minmo-window-view', JSON.stringify({ by: 'other', issueId: 'a', terminal: true }))
    expect(viewedInOtherWindow('a')).toBe(true)
    expect(viewedInOtherWindow('b')).toBe(false)
    localStorage.setItem('minmo-window-view', JSON.stringify({ by: 'other', issueId: 'a', terminal: false }))
    expect(viewedInOtherWindow('a')).toBe(false)
    localStorage.setItem('minmo-window-view', 'not json')
    expect(viewedInOtherWindow('a')).toBe(false)
  })

  it('이 창이 적은 값은 다른 창의 것이 아니고, 포커스를 잃으면 지운다', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    useUiStore.setState({ selectedIssueId: 'a', tab: 'terminal' })
    renderHook(() => useWindowViewBroadcast())
    expect(JSON.parse(localStorage.getItem('minmo-window-view')!)).toMatchObject({ issueId: 'a', terminal: true })
    expect(viewedInOtherWindow('a')).toBe(false)
    window.dispatchEvent(new Event('blur'))
    expect(localStorage.getItem('minmo-window-view')).toBeNull()
  })
})
