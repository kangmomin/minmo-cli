// 터미널 링크 열기(#76) — 일반 URL 과 링크 표시(OSC 8)를 Ctrl+클릭으로 연다.
// SSH 원격의 프로그램은 이 PC 의 브라우저를 열 수 없으므로 터미널이 대신 연다.
import { WebLinksAddon } from '@xterm/addon-web-links'
import type { Terminal } from '@xterm/xterm'

/** Ctrl(macOS 는 Cmd)을 누른 클릭만 연다 — 선택하려고 누른 클릭으로 열지 않게(Windows Terminal·VS Code 와 같다) */
export function wantsOpen(e: MouseEvent): boolean {
  return e.ctrlKey || e.metaKey
}

/** 웹 주소(http·https)만 연다 — file: 등 다른 스킴은 연결된 프로그램을 실행할 수 있다 */
export function isWebUrl(uri: string): boolean {
  try {
    const { protocol } = new URL(uri)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/** 일반 URL 은 WebLinksAddon 으로 찾고, OSC 8 링크는 xterm 기본 처리(confirm + window.open — 앱에서 열리지 않는다)를 바꾼다 */
export function attachLinks(t: Terminal, open: (url: string) => void): void {
  const activate = (e: MouseEvent, uri: string) => {
    if (wantsOpen(e) && isWebUrl(uri)) open(uri)
  }
  t.loadAddon(new WebLinksAddon(activate))
  t.options.linkHandler = { activate, allowNonHttpProtocols: false }
}
