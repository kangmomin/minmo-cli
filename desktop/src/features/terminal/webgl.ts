// 터미널을 WebGL 로 그린다. DOM 렌더러는 블록·박스 문자(Claude Code 의 clawd 등)를 글꼴로 그려서, 글꼴에 없는 글자는
// 대체 글꼴로 어긋나고 칸 사이에 세로 줄이 생긴다. WebGL 렌더러는 이 문자들을 칸에 맞춰 직접 그린다(customGlyphs).
import { WebglAddon } from '@xterm/addon-webgl'
import type { Terminal } from '@xterm/xterm'

/**
 * WebGL 렌더러를 붙이고, 떼는 함수를 돌려준다. 떼면 DOM 렌더러로 돌아간다.
 * WebGL2 를 쓸 수 없거나(오래된 GPU·일부 휴대폰) context 를 잃으면 바로 떼서 DOM 렌더러로 계속 그린다.
 */
export function attachWebgl(t: Terminal): () => void {
  let addon: WebglAddon | null = null
  const detach = () => {
    const a = addon
    addon = null
    try {
      a?.dispose()
    } catch {
      // 터미널과 함께 이미 정리됐다
    }
  }
  try {
    // 만들기부터 실패할 수 있다(Safari 16 미만은 생성자에서 throw)
    addon = new WebglAddon()
    addon.onContextLoss(detach)
    t.loadAddon(addon)
  } catch {
    detach()
  }
  return detach
}
