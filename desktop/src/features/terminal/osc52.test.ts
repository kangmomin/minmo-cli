// 프로그램의 클립보드 쓰기(OSC 52, #76) — 쓰기만 받고 읽기 요청에는 답하지 않는다
import type { Terminal } from '@xterm/xterm'
import { describe, expect, it, vi } from 'vitest'

import { attachOsc52, decodeOsc52 } from './osc52'

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')

describe('decodeOsc52', () => {
  it('base64(UTF-8) 를 글자로 — 한글·줄바꿈 포함', () => {
    expect(decodeOsc52(`c;${b64('복사 테스트\nhttps://example.com')}`)).toBe('복사 테스트\nhttps://example.com')
  })

  it('선택 값은 가리지 않는다(빈 값·p·s 등 — tmux 는 빈 값을 보낸다)', () => {
    for (const sel of ['', 'p', 's', 'c0']) expect(decodeOsc52(`${sel};${b64('x')}`)).toBe('x')
  })

  it('패딩(=)이 없는 base64 도 받는다', () => {
    expect(decodeOsc52('c;YQ')).toBe('a')
  })

  it('읽기 요청(?)에는 답하지 않는다', () => {
    expect(decodeOsc52('c;?')).toBeNull()
  })

  it('잘못된 값은 무시한다 — 빈 글자로 클립보드를 덮어쓰지 않는다', () => {
    expect(decodeOsc52('c;')).toBeNull() // 지우기 요청
    expect(decodeOsc52(`c;${b64('')}`)).toBeNull()
    expect(decodeOsc52('c;@@@')).toBeNull() // base64 아님
    expect(decodeOsc52('c;/w==')).toBeNull() // UTF-8 아님(0xFF)
    expect(decodeOsc52(b64('x'))).toBeNull() // ; 없음
  })
})

describe('attachOsc52', () => {
  function fakeTerminal() {
    const handlers = new Map<number, (data: string) => boolean | Promise<boolean>>()
    const dispose = vi.fn()
    const t = {
      parser: {
        registerOscHandler: (id: number, cb: (data: string) => boolean | Promise<boolean>) => {
          handlers.set(id, cb)
          return { dispose }
        },
      },
    } as unknown as Terminal
    return { t, handlers, dispose }
  }

  it('OSC 52 쓰기를 copy 로 보내고, 처리했다고(true) 답한다', () => {
    const { t, handlers } = fakeTerminal()
    const copy = vi.fn()
    attachOsc52(t, copy)
    expect(handlers.get(52)?.(`c;${b64('안녕')}`)).toBe(true)
    expect(copy).toHaveBeenCalledWith('안녕')
  })

  it('읽기 요청·잘못된 값은 copy 를 부르지 않는다(그래도 처리한 것으로 본다)', () => {
    const { t, handlers } = fakeTerminal()
    const copy = vi.fn()
    attachOsc52(t, copy)
    expect(handlers.get(52)?.('c;?')).toBe(true)
    expect(handlers.get(52)?.('c;@@@')).toBe(true)
    expect(copy).not.toHaveBeenCalled()
  })

  it('돌려준 dispose 로 처리기를 푼다', () => {
    const { t, dispose } = fakeTerminal()
    attachOsc52(t, vi.fn()).dispose()
    expect(dispose).toHaveBeenCalledTimes(1)
  })
})
