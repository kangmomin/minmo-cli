// 터미널(PTY) 출력에서 에이전트 감지에 쓰는 신호만 뽑는다: 창 제목(OSC 0/2), 벨, 화면에 보이는 출력이 있었는지.
// 출력은 임의의 위치에서 잘려 오므로, 끝나지 않은 제어 문자열은 다음 조각과 이어서 본다.

export type StreamSignals = {
  /** 이 조각에서 정해진 창 제목들(순서대로) */
  titles: string[]
  bells: number
  /** 제어 문자열·공백이 아닌 글자가 있었는가 */
  visible: boolean
}

const ESC = '\x1b'
const BEL = '\x07'
/** 끝나지 않은 제어 문자열을 다음 조각까지 들고 있을 상한 — 넘으면 깨진 것으로 보고 버린다 */
const MAX_CARRY = 4096

export class PtyStreamParser {
  private carry = ''

  feed(chunk: string): StreamSignals {
    const s = this.carry + chunk
    this.carry = ''
    const out: StreamSignals = { titles: [], bells: 0, visible: false }
    let i = 0
    while (i < s.length) {
      const c = s[i]
      if (c === BEL) {
        out.bells++
        i++
        continue
      }
      if (c !== ESC) {
        if (c > ' ') out.visible = true
        i++
        continue
      }
      const next = s[i + 1]
      if (next === undefined) return this.hold(s, i, out)
      if (next === ']') {
        // OSC: ESC ] … (BEL | ESC \)
        const end = oscEnd(s, i + 2)
        if (end === null) return this.hold(s, i, out)
        const body = s.slice(i + 2, end.at)
        const semi = body.indexOf(';')
        const kind = semi < 0 ? body : body.slice(0, semi)
        if (kind === '0' || kind === '2') out.titles.push(semi < 0 ? '' : body.slice(semi + 1))
        i = end.next
      } else if (next === '[') {
        // CSI: ESC [ 매개변수… 마지막 글자(@~)
        let j = i + 2
        while (j < s.length && (s.charCodeAt(j) < 0x40 || s.charCodeAt(j) > 0x7e)) j++
        if (j >= s.length) return this.hold(s, i, out)
        i = j + 1
      } else if (next === 'P' || next === '_' || next === '^' || next === 'X') {
        // DCS·APC·PM·SOS: ESC \ 로 끝난다
        const end = s.indexOf(`${ESC}\\`, i + 2)
        if (end < 0) return this.hold(s, i, out)
        i = end + 2
      } else {
        i += 2
      }
    }
    return out
  }

  private hold(s: string, from: number, out: StreamSignals): StreamSignals {
    const rest = s.slice(from)
    this.carry = rest.length <= MAX_CARRY ? rest : ''
    return out
  }
}

/** OSC 본문의 끝(BEL 또는 ESC \) — at = 본문 끝, next = 그 다음 위치. 아직 안 끝났으면 null */
function oscEnd(s: string, from: number): { at: number; next: number } | null {
  for (let i = from; i < s.length; i++) {
    if (s[i] === BEL) return { at: i, next: i + 1 }
    if (s[i] === ESC) {
      if (i + 1 >= s.length) return null
      // ESC \ 가 아니면 깨진 OSC — 여기서 끊고 그 ESC 부터 다시 본다
      return s[i + 1] === '\\' ? { at: i, next: i + 2 } : { at: i, next: i }
    }
  }
  return null
}
