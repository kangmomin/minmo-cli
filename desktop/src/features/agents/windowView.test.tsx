// 창 사이의 "지금 보는 이슈"(#105) — 보조 창에서 보는 이슈는 주 창이 알리지 않는다
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useUiStore } from '../../store/ui'
import { useWindowViewBroadcast, viewedInOtherWindow } from './windowView'

afterEach(() => localStorage.clear())

describe('windowView', () => {
  it('다른 창이 적은 이슈의 터미널만 본 것으로 친다', () => {
    localStorage.setItem('minmo-window-view', JSON.stringify({ by: 'other', issueId: 'a', terminal: true }))
    expect(viewedInOtherWindow('a', 'a::1')).toBe(true)
    expect(viewedInOtherWindow('b', 'b::1')).toBe(false)
    localStorage.setItem('minmo-window-view', JSON.stringify({ by: 'other', issueId: 'a', terminal: false }))
    expect(viewedInOtherWindow('a', 'a::1')).toBe(false)
    localStorage.setItem('minmo-window-view', 'not json')
    expect(viewedInOtherWindow('a', 'a::1')).toBe(false)
  })

  it('이 창이 적은 값은 다른 창의 것이 아니고, 포커스를 잃으면 지운다', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    useUiStore.setState({ selectedIssueId: 'a', tab: 'terminal' })
    renderHook(() => useWindowViewBroadcast())
    expect(JSON.parse(localStorage.getItem('minmo-window-view')!)).toMatchObject({ issueId: 'a', terminal: true })
    expect(viewedInOtherWindow('a', 'a::1')).toBe(false)
    window.dispatchEvent(new Event('blur'))
    expect(localStorage.getItem('minmo-window-view')).toBeNull()
  })
})

// #122: 답변 모드 창은 이슈가 아니라 보이는 패널 하나만 본다(A-6)
describe('#122 windowView — 패널 단위로 보기', () => {
  it('EC-03 답변 모드 창이 적은 패널만 본 것이고, 기본 보기 창(패널 없음)은 그 이슈의 모든 패널을 본 것이다', () => {
    localStorage.setItem('minmo-window-view', JSON.stringify({ by: 'other', issueId: 'a', terminal: true, paneId: 'a::2' }))
    expect(viewedInOtherWindow('a', 'a::2')).toBe(true)
    expect(viewedInOtherWindow('a', 'a::1')).toBe(false)
    localStorage.setItem('minmo-window-view', JSON.stringify({ by: 'other', issueId: 'a', terminal: true, paneId: null }))
    expect(viewedInOtherWindow('a', 'a::1')).toBe(true)
  })

  it('EC-03 답변 모드면 이 창이 보는 패널(지금 보이는 패널)을 함께 적고, 기본 보기면 패널을 적지 않는다', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    const tree = { kind: 'split' as const, dir: 'row' as const, a: { kind: 'leaf' as const, id: 'a::1' }, b: { kind: 'leaf' as const, id: 'a::2' } }
    useUiStore.setState({ selectedIssueId: 'a', tab: 'terminal', viewMode: 'answer', panes: { a: { tree, focused: 'a::2', seq: 2 } } })
    const r = renderHook(() => useWindowViewBroadcast())
    expect(JSON.parse(localStorage.getItem('minmo-window-view')!)).toMatchObject({ issueId: 'a', terminal: true, paneId: 'a::2' })
    act(() => useUiStore.setState({ viewMode: 'normal' }))
    expect(JSON.parse(localStorage.getItem('minmo-window-view')!)).toMatchObject({ issueId: 'a', paneId: null })
    r.unmount()
    useUiStore.setState({ viewMode: 'normal', panes: {} })
  })
})
