// 창 사이의 "지금 보는 이슈"(#105) — 보조 창에서 보는 이슈는 주 창이 알리지 않는다
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useUiStore } from '../../store/ui'
import { leaf } from '../terminal/panes'
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

// #120 고른 터미널 탭은 창마다 따로다(EC-12) — 다른 창이 보는 탭의 패널만 "그 창이 보는 중"이다
describe('windowView — 터미널 탭 (#120)', () => {
  const ETC = 'a/b#etc'
  const TWO = { kind: 'tabs' as const, tabs: [{ id: 't0', no: 1, node: leaf(`${ETC}::1`) }, { id: 't2', no: 2, node: leaf(`${ETC}::2`) }] }

  it('EC-12 다른 창이 적은 탭과 같은 탭일 때만 그 창이 보는 것으로 친다 · 탭을 주지 않으면 지금처럼 이슈만 본다', () => {
    localStorage.setItem('minmo-window-view', JSON.stringify({ by: 'other', issueId: ETC, terminal: true, tab: 't2' }))
    expect(viewedInOtherWindow(ETC, 't2')).toBe(true)
    expect(viewedInOtherWindow(ETC, 't0')).toBe(false)
    expect(viewedInOtherWindow(ETC)).toBe(true)
  })

  it('EC-12 이 창은 보는 이슈의 고른 탭(값이 없으면 첫 탭, 탭 없는 트리는 t0)을 함께 적고, 탭을 바꾸면 다시 적는다', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    useUiStore.setState({ selectedIssueId: ETC, tab: 'terminal', panes: { [ETC]: { tree: TWO, focused: null, seq: 2, tabSeq: 2 } } })
    renderHook(() => useWindowViewBroadcast())
    expect(JSON.parse(localStorage.getItem('minmo-window-view')!)).toMatchObject({ issueId: ETC, terminal: true, tab: 't0' })
    act(() => useUiStore.setState({ panes: { [ETC]: { tree: TWO, focused: null, seq: 2, tabSeq: 2, tab: 't2' } } }))
    expect(JSON.parse(localStorage.getItem('minmo-window-view')!)).toMatchObject({ tab: 't2' })
    act(() => useUiStore.setState({ selectedIssueId: 'a/b#1', panes: { 'a/b#1': { tree: leaf('a/b#1::1'), focused: null, seq: 1 } } }))
    expect(JSON.parse(localStorage.getItem('minmo-window-view')!)).toMatchObject({ issueId: 'a/b#1', tab: 't0' })
  })
})
