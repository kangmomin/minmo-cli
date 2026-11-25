import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useRemoteBridge } from '../features/remote/useRemoteHost'
import { createFakeTauri } from '../test/fakes'

import { decodeScope, encodeScope, isPrimaryWindow, ownsAppTasks, perWindowStorage, windowScope } from './windowScope'
import type { WindowScope } from './windowScope'

describe('창 정체성·범위', () => {
  it('window=ws 가 없으면 주 창이다', () => {
    expect(isPrimaryWindow('')).toBe(true)
    expect(isPrimaryWindow('?scope=org%3Aacme')).toBe(true)
    expect(isPrimaryWindow('?window=ws')).toBe(false)
  })

  it.each<WindowScope>([
    { kind: 'org', owner: 'acme' },
    { kind: 'repo', owner: 'acme', repo: 'api.v2' },
    { kind: 'repo', owner: '_local', repo: "it's (mine)!" },
    { kind: 'group', id: 'g-1' },
  ])('인코딩한 범위를 되읽는다: %o', (scope) => {
    const encoded = encodeScope(scope)
    // 네이티브 쪽(shell.rs valid_scope)이 받는 문자만 쓴다
    expect(encoded).toMatch(/^[A-Za-z0-9%\-_.~]+$/)
    expect(windowScope(`?window=ws&scope=${encoded}`)).toEqual(scope)
  })

  it('모양이 틀린 범위는 무시한다', () => {
    expect(windowScope('?window=ws')).toBeNull()
    for (const raw of ['', 'org', 'org:', 'repo:acme', 'repo:/x', 'repo:acme/', 'team:x']) expect(decodeScope(raw)).toBeNull()
  })
})

describe('perWindowStorage', () => {
  afterEach(() => localStorage.clear())
  const blob = (state: Record<string, unknown>) => JSON.stringify({ state, version: 1 })
  const stored = () => JSON.parse(localStorage.getItem('k') ?? 'null') as { state: Record<string, unknown>; version: number }

  it('주 창은 그대로 읽고 쓴다', () => {
    const s = perWindowStorage(['sel'], ['sel'], true)
    s.setItem('k', blob({ sel: 'a', theme: 'light' }))
    expect(s.getItem('k')).toBe(blob({ sel: 'a', theme: 'light' }))
  })

  it('보조 창은 fresh 키 없이 읽는다', () => {
    localStorage.setItem('k', blob({ sel: 'a', exp: { x: true }, theme: 'light' }))
    const s = perWindowStorage(['sel', 'exp'], ['sel'], false)
    expect(JSON.parse(s.getItem('k') as string)).toEqual({ state: { exp: { x: true }, theme: 'light' }, version: 1 })
  })

  it('보조 창이 써도 주 창의 own 값은 남고 나머지는 바뀐다', () => {
    localStorage.setItem('k', blob({ sel: 'main-issue', theme: 'light' }))
    const s = perWindowStorage(['sel', 'exp'], ['sel'], false)
    s.setItem('k', blob({ sel: 'ws-issue', exp: { y: true }, theme: 'black' }))
    expect(stored()).toEqual({ state: { sel: 'main-issue', theme: 'black' }, version: 1 })
  })

  it.each([true, false])('다른 창이 바꾼 키를 옛 값으로 덮지 않는다(주 창=%s)', (primary) => {
    localStorage.setItem('k', blob({ theme: 'ghostty', font: 13 }))
    const s = perWindowStorage(['sel'], ['sel'], primary)
    s.getItem('k')
    // 다른 창이 테마를 바꿨다
    localStorage.setItem('k', blob({ theme: 'light', font: 13 }))
    // 이 창은 글자 크기만 바꿨지만 persist 는 읽어 둔 테마까지 통째로 쓴다
    s.setItem('k', blob({ theme: 'ghostty', font: 15 }))
    expect(stored().state).toEqual({ theme: 'light', font: 15 })
  })

  it('보조 창은 다시 읽을 때 own 키를 모두 빼고(시작 뒤 이 창의 값을 지킨다), 주 창은 그대로 읽는다', () => {
    localStorage.setItem('k', blob({ sel: 'a', exp: { x: true }, theme: 'light' }))
    const ws = perWindowStorage(['sel', 'exp'], ['sel'], false)
    ws.getItem('k')
    expect(JSON.parse(ws.getItem('k') as string).state).toEqual({ theme: 'light' })
    const main = perWindowStorage(['sel', 'exp'], ['sel'], true)
    main.getItem('k')
    expect(JSON.parse(main.getItem('k') as string).state).toEqual({ sel: 'a', exp: { x: true }, theme: 'light' })
  })

  it('같은 값이면 다시 쓰지 않는다(창끼리 storage 이벤트가 오가지 않게)', () => {
    localStorage.setItem('k', blob({ theme: 'light' }))
    const s = perWindowStorage([], [], true)
    s.getItem('k')
    const spy = vi.spyOn(Storage.prototype, 'setItem')
    s.setItem('k', blob({ theme: 'light' }))
    expect(spy).not.toHaveBeenCalled()
  })

  // #111 CT-04 — 지운 기능이 남긴 키는 읽을 때 빼고, 쓸 때 저장소에서도 지운다
  it.each([true, false])('retired 키는 읽은 값에 없고, 쓰면 저장소에서도 지워진다(주 창=%s)', (primary) => {
    localStorage.setItem('k', blob({ old: { a: 1 }, theme: 'light' }))
    const s = perWindowStorage([], [], primary, { retired: ['old'] })
    expect(JSON.parse(s.getItem('k') as string).state).toEqual({ theme: 'light' })
    s.setItem('k', blob({ theme: 'light', font: 15 }))
    expect(stored().state).toEqual({ theme: 'light', font: 15 })
  })

  it('보조 창은 저장소를 지우지 않는다', () => {
    localStorage.setItem('k', blob({ sel: 'a' }))
    perWindowStorage(['sel'], [], false).removeItem('k')
    expect(stored().state.sel).toBe('a')
  })
})

describe('한 번만 돌아야 하는 일은 주 창만', () => {
  afterEach(() => window.history.replaceState(null, '', '/'))

  it('네이티브 주 창만 맡는다', () => {
    expect(ownsAppTasks({ runtime: 'native' })).toBe(true)
    expect(ownsAppTasks({ runtime: 'remote' })).toBe(false)
    window.history.replaceState(null, '', '/?window=ws')
    expect(ownsAppTasks({ runtime: 'native' })).toBe(false)
  })

  it('보조 창은 붙은 기기의 호출을 받지 않는다(주 창이 한 번만 실행한다)', () => {
    const onRemoteRpc = vi.fn(async () => () => {})
    const { tauri } = createFakeTauri({ runtime: 'native', onRemoteRpc })
    renderHook(() => useRemoteBridge(tauri)).unmount()
    expect(onRemoteRpc).toHaveBeenCalledTimes(1)
    window.history.replaceState(null, '', '/?window=ws')
    renderHook(() => useRemoteBridge(tauri)).unmount()
    expect(onRemoteRpc).toHaveBeenCalledTimes(1)
  })
})
