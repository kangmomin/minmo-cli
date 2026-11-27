// 패널의 터미널 화면 글자 읽기(#122 Jev 판정) — TerminalTab 이 패널마다 등록한다. 스텁: Phase 5.2(U4)에서 구현한다.

/** read 는 그 패널의 xterm 화면을 읽는 함수(TerminalTab 이 정한다) */
export function registerTerminalText(_paneId: string, _read: (maxLines: number) => string): () => void {
  return () => {}
}

/** 그 패널 화면의 마지막 maxLines 줄 — 끝의 빈 줄은 버리고, 줄바꿈된(isWrapped) 줄은 잇는다. 패널이 없으면 '' */
export function readTerminalText(_paneId: string, _maxLines: number): string {
  return ''
}
