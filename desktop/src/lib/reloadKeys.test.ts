// 새로고침 단축키 차단(#99)
import { describe, expect, it } from 'vitest'

import { blockReloadKeys, isReloadKey } from './reloadKeys'

const ev = (init: Partial<KeyboardEvent>) => ({ ctrlKey: false, altKey: false, metaKey: false, key: '', code: '', ...init })

describe('isReloadKey', () => {
  it('Ctrl+R · Ctrl+Shift+R · 한글 IME 의 Ctrl+R · F5 · Ctrl+F5 · Shift+F5 는 새로고침 키', () => {
    expect(isReloadKey(ev({ ctrlKey: true, key: 'r', code: 'KeyR' }))).toBe(true)
    expect(isReloadKey(ev({ ctrlKey: true, shiftKey: true, key: 'R', code: 'KeyR' }))).toBe(true)
    expect(isReloadKey(ev({ ctrlKey: true, key: 'ㄱ', code: 'KeyR' }))).toBe(true)
    expect(isReloadKey(ev({ key: 'F5', code: 'F5' }))).toBe(true)
    expect(isReloadKey(ev({ ctrlKey: true, key: 'F5', code: 'F5' }))).toBe(true)
    expect(isReloadKey(ev({ shiftKey: true, key: 'F5', code: 'F5' }))).toBe(true)
    expect(isReloadKey(ev({ key: 'BrowserRefresh', code: 'BrowserRefresh' }))).toBe(true)
  })

  it('R 단독 · Alt(AltGr)·Meta 조합 · 다른 키 · Dvorak 의 KeyR 위치(p)는 아니다', () => {
    expect(isReloadKey(ev({ key: 'r', code: 'KeyR' }))).toBe(false)
    expect(isReloadKey(ev({ ctrlKey: true, altKey: true, key: 'r', code: 'KeyR' }))).toBe(false)
    expect(isReloadKey(ev({ metaKey: true, key: 'r', code: 'KeyR' }))).toBe(false)
    expect(isReloadKey(ev({ altKey: true, key: 'F5', code: 'F5' }))).toBe(false)
    expect(isReloadKey(ev({ ctrlKey: true, key: 't', code: 'KeyT' }))).toBe(false)
    expect(isReloadKey(ev({ ctrlKey: true, key: 'p', code: 'KeyR' }))).toBe(false)
  })
})

describe('blockReloadKeys', () => {
  const press = (init: KeyboardEventInit) => {
    const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
    document.body.dispatchEvent(e)
    return e.defaultPrevented
  }

  it('새로고침 키의 기본 동작만 막고, 해제하면 막지 않는다', () => {
    const release = blockReloadKeys()
    try {
      expect(press({ ctrlKey: true, key: 'r', code: 'KeyR' })).toBe(true)
      expect(press({ key: 'F5', code: 'F5' })).toBe(true)
      expect(press({ ctrlKey: true, key: 'c', code: 'KeyC' })).toBe(false)
    } finally {
      release()
    }
    expect(press({ ctrlKey: true, key: 'r', code: 'KeyR' })).toBe(false)
  })

  it('하위 요소가 전파를 멈춰도 막는다(capture 단계)', () => {
    const release = blockReloadKeys()
    const stop = (e: Event) => e.stopPropagation()
    document.body.addEventListener('keydown', stop)
    try {
      expect(press({ ctrlKey: true, key: 'r', code: 'KeyR' })).toBe(true)
    } finally {
      document.body.removeEventListener('keydown', stop)
      release()
    }
  })
})
