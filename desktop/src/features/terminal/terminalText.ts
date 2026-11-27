// 패널의 터미널 화면 글자 읽기(#122 Jev 판정) — TerminalTab 이 패널마다 그 xterm 의 버퍼를 등록한다.

export interface TerminalTextBuffer {
  readonly length: number
  getLine(y: number): { readonly isWrapped: boolean; translateToString(trimRight?: boolean): string } | undefined
}

const buffers = new Map<string, () => TerminalTextBuffer | undefined>()

/** buffer 는 부를 때의 버퍼를 돌려준다(TerminalTab 이 정한다) */
export function registerTerminalText(paneId: string, buffer: () => TerminalTextBuffer | undefined): () => void {
  buffers.set(paneId, buffer)
  return () => {
    if (buffers.get(paneId) === buffer) buffers.delete(paneId)
  }
}

/** 그 패널 화면의 마지막 maxLines 줄 — 끝의 빈 줄은 버리고, 줄바꿈된(isWrapped) 줄은 잇는다. 패널이 없으면 '' */
export function readTerminalText(paneId: string, maxLines: number): string {
  const b = buffers.get(paneId)?.()
  if (!b) return ''
  const lines: string[] = []
  for (let y = 0; y < b.length; y++) {
    const line = b.getLine(y)
    if (!line) continue
    // Why: 다음 줄로 이어지는 줄의 오른쪽 공백은 글의 일부다(줄 끝에서 단어가 나뉜 자리)
    const text = line.translateToString(!b.getLine(y + 1)?.isWrapped)
    if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += text
    else lines.push(text)
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.slice(Math.max(0, lines.length - maxLines)).join('\n')
}
