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
/** 끝나지 않은 제어 문자열을 다음 조각까지 들고 있을 상한 — 넘으면 내용은 버리고 끝(종결자)만 찾는다 */
const MAX_CARRY = 4096

const code = (s: string, i: number) => s.charCodeAt(i)
/** 화면에 찍히는 글자인가 — 공백·제어 문자(C0)·DEL·C1 은 아니다 */
const printable = (c: number) => c > 0x20 && c !== 0x7f && !(c >= 0x80 && c <= 0x9f)

export class PtyStreamParser {
  private carry = ''
  /** 너무 긴 제어 문자열(클립보드·이미지 데이터 등)의 안쪽을 지나는 중 — 종결자가 나올 때까지 글자·벨로 세지 않는다 */
  private skipping = false

  feed(chunk: string): StreamSignals {
    const out: StreamSignals = { titles: [], bells: 0, visible: false }
    const s = this.carry + chunk
    this.carry = ''
    let i = 0
    if (this.skipping) {
      const end = stringEnd(s, 0)
      if (end === null) {
        // 종결자의 앞 절반(ESC)에서 끊겼을 수 있다
        this.carry = s.endsWith(ESC) ? ESC : ''
        return out
      }
      this.skipping = false
      i = end.next
    }
    while (i < s.length) {
      const c = s[i]
      if (c === BEL) {
        out.bells++
        i++
        continue
      }
      if (c !== ESC) {
        if (printable(code(s, i))) out.visible = true
        i++
        continue
      }
      const next = s[i + 1]
      if (next === undefined) return this.hold(s, i, out)
      if (next === ']' || next === 'P' || next === '_' || next === '^' || next === 'X') {
        // 문자열 제어열: OSC(ESC ]) · DCS · APC · PM · SOS — BEL(OSC) 또는 ESC \ 로 끝난다
        const end = stringEnd(s, i + 2)
        if (end === null) return this.hold(s, i, out)
        if (next === ']' && end.clean) {
          const body = s.slice(i + 2, end.at)
          const semi = body.indexOf(';')
          const kind = semi < 0 ? body : body.slice(0, semi)
          if (kind === '0' || kind === '2') out.titles.push(semi < 0 ? '' : body.slice(semi + 1))
        }
        i = end.next
      } else if (next === '[') {
        // CSI: ESC [ 매개변수(0x30–0x3f)… 중간(0x20–0x2f)… 마지막(0x40–0x7e). 그 밖의 글자가 나오면 깨진 것 — 거기서 끊는다
        let j = i + 2
        while (j < s.length && code(s, j) >= 0x20 && code(s, j) <= 0x3f) j++
        if (j >= s.length) return this.hold(s, i, out)
        i = code(s, j) >= 0x40 && code(s, j) <= 0x7e ? j + 1 : j
      } else {
        // 그 밖의 ESC 열: 중간 글자(0x20–0x2f)들 뒤에 마지막 글자 하나 (예: ESC ( B = 문자 집합 지정)
        let j = i + 1
        while (j < s.length && code(s, j) >= 0x20 && code(s, j) <= 0x2f) j++
        if (j >= s.length) return this.hold(s, i, out)
        i = j + 1
      }
    }
    return out
  }

  private hold(s: string, from: number, out: StreamSignals): StreamSignals {
    const rest = s.slice(from)
    if (rest.length <= MAX_CARRY) {
      this.carry = rest
    } else {
      // 문자열 제어열이 너무 길다 — 내용을 들고 있지 않고, 끝날 때까지 건너뛴다
      this.skipping = true
      this.carry = rest.endsWith(ESC) ? ESC : ''
    }
    return out
  }
}

/**
 * 문자열 제어열의 끝(BEL 또는 ESC \) — at = 본문 끝, next = 그 다음 위치. 아직 안 끝났으면 null.
 * ESC 뒤에 \ 가 아닌 글자가 오면 깨진 것이라 그 ESC 에서 끊는다(clean = false — 본문을 제목으로 쓰지 않는다).
 */
function stringEnd(s: string, from: number): { at: number; next: number; clean: boolean } | null {
  for (let i = from; i < s.length; i++) {
    if (s[i] === BEL) return { at: i, next: i + 1, clean: true }
    if (s[i] === ESC) {
      if (i + 1 >= s.length) return null
      return s[i + 1] === '\\' ? { at: i, next: i + 2, clean: true } : { at: i, next: i, clean: false }
    }
  }
  return null
}
