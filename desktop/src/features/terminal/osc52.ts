// 프로그램의 클립보드 쓰기(OSC 52, #76) — `ESC ] 52 ; <선택> ; <base64> BEL`.
// SSH 원격의 프로그램(tmux 복사 모드, Claude Code 의 드래그 복사 등)은 이 PC 의 클립보드를 직접 쓸 수 없어 이 신호로 터미널에 맡긴다.
// @xterm/addon-clipboard 를 쓰지 않는 이유: 그 애드온은 읽기 요청(`?`)에 이 PC 의 클립보드 내용을 돌려준다 —
// 원격 서버가 클립보드(비밀번호 등)를 읽을 수 있게 된다. 여기서는 쓰기만 받는다(Windows Terminal 과 같다).
import type { IDisposable, Terminal } from '@xterm/xterm'

/**
 * OSC 52 의 데이터(`<선택>;<base64>`)에서 클립보드에 쓸 글자를 꺼낸다. 쓸 것이 없으면 null.
 * 선택 값(c·p·s·빈 값 등)은 가리지 않고 이 PC 의 클립보드로 본다. 읽기 요청(`?`)·잘못된 base64·UTF-8 이 아닌 값·빈 값은 무시한다 —
 * 빈 글자로 클립보드를 덮어쓰지 않는다(Ctrl+C 복사와 같은 규칙)
 */
export function decodeOsc52(data: string): string | null {
  const sep = data.indexOf(';')
  if (sep < 0) return null
  const payload = data.slice(sep + 1)
  if (payload === '' || payload === '?') return null
  try {
    const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0))
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return text === '' ? null : text
  } catch {
    return null
  }
}

/** OSC 52 쓰기를 copy 로 보낸다. 읽기 요청에는 답하지 않는다 */
export function attachOsc52(t: Terminal, copy: (text: string) => void): IDisposable {
  return t.parser.registerOscHandler(52, (data) => {
    const text = decodeOsc52(data)
    if (text !== null) copy(text)
    return true
  })
}
