// 사이드바 폭 저장 값 (#70) — store 만 쓴다
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'

import { clampSidebarWidth, useUiStore } from './ui'

let setItemSpy: MockInstance<Storage['setItem']>
/** minmo-ui 에 쓴 횟수 */
const saves = () => setItemSpy.mock.calls.filter(([key]) => key === 'minmo-ui').length
const savedWidth = () => JSON.parse(localStorage.getItem('minmo-ui') ?? '{}').state?.sidebarWidth as unknown

beforeEach(() => {
  localStorage.clear()
  useUiStore.setState({ sidebarWidth: 288 })
  // setState 도 localStorage 에 쓴다 — 기준점은 그 뒤
  setItemSpy = vi.spyOn(Storage.prototype, 'setItem')
})

describe('저장 값', () => {
  // AC-06
  it('AC-06 이 PC(minmo-ui)에 저장되고 다시 켜도 같은 폭 · 같은 값이면 다시 쓰지 않는다', async () => {
    useUiStore.getState().setSidebarWidth(320)
    expect(useUiStore.getState().sidebarWidth).toBe(320)
    expect(savedWidth()).toBe(320)
    expect(saves()).toBe(1)
    useUiStore.getState().setSidebarWidth(320)
    expect(saves()).toBe(1)

    // 다시 켜기: 메모리 값을 기본값으로 되돌린 뒤 저장 값을 읽는다
    const raw = localStorage.getItem('minmo-ui')!
    useUiStore.setState({ sidebarWidth: 288 })
    localStorage.setItem('minmo-ui', raw)
    await useUiStore.persist.rehydrate()
    expect(useUiStore.getState().sidebarWidth).toBe(320)
  })

  // EC-01
  it('EC-01 범위(240~480)로 맞추고 정수로 만든다 · 숫자가 아니면 기본값 · 손상·범위 밖 저장 값도 범위 안으로 읽는다', async () => {
    expect([239, 481, 300.6, '300', null, NaN].map(clampSidebarWidth)).toEqual([240, 480, 301, 288, 288, 288])

    localStorage.setItem('minmo-ui', JSON.stringify({ state: { sidebarWidth: 1000 }, version: 1 }))
    await useUiStore.persist.rehydrate()
    expect(useUiStore.getState().sidebarWidth).toBe(480)
    localStorage.setItem('minmo-ui', JSON.stringify({ state: { sidebarWidth: 100 }, version: 1 }))
    await useUiStore.persist.rehydrate()
    expect(useUiStore.getState().sidebarWidth).toBe(240)
    localStorage.setItem('minmo-ui', JSON.stringify({ state: { sidebarWidth: '300' }, version: 1 }))
    await useUiStore.persist.rehydrate()
    expect(useUiStore.getState().sidebarWidth).toBe(288)
  })

  // EC-02
  it('EC-02 저장 값이 없으면(이전 버전) 288', async () => {
    useUiStore.setState({ sidebarWidth: 288 })
    localStorage.setItem('minmo-ui', JSON.stringify({ state: { theme: 'black' }, version: 1 }))
    await useUiStore.persist.rehydrate()
    expect(useUiStore.getState().sidebarWidth).toBe(288)
  })
})
