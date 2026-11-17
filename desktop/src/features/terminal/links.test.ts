// 터미널 링크 열기(#76) — Ctrl(Cmd)+클릭, http·https 만
import type { ILinkHandler, Terminal } from '@xterm/xterm'
import { describe, expect, it, vi } from 'vitest'

import { attachLinks, isWebUrl } from './links'

vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class {
    kind = 'web-links'
    constructor(public handler: (e: MouseEvent, uri: string) => void) {}
  },
}))

function setup() {
  const addons: { kind?: string; handler?: (e: MouseEvent, uri: string) => void }[] = []
  const t = { options: {} as { linkHandler?: ILinkHandler | null }, loadAddon: (a: (typeof addons)[number]) => addons.push(a) }
  const open = vi.fn()
  attachLinks(t as unknown as Terminal, open)
  const webLinks = addons.find((a) => a.kind === 'web-links')?.handler
  const osc8 = t.options.linkHandler
  if (!webLinks || !osc8) throw new Error('링크 처리가 붙지 않았다')
  return { open, webLinks, osc8 }
}

const click = (mods: MouseEventInit = {}) => new MouseEvent('mouseup', mods)

describe('attachLinks', () => {
  it('일반 URL: Ctrl+클릭·Cmd+클릭만 연다', () => {
    const { open, webLinks } = setup()
    webLinks(click(), 'https://example.com')
    expect(open).not.toHaveBeenCalled()
    webLinks(click({ ctrlKey: true }), 'https://example.com/a?b=1')
    webLinks(click({ metaKey: true }), 'http://127.0.0.1:8787/')
    expect(open.mock.calls).toEqual([['https://example.com/a?b=1'], ['http://127.0.0.1:8787/']])
  })

  it('OSC 8 링크: xterm 기본 처리(confirm·window.open) 대신 같은 규칙으로 열고, http·https 외 스킴은 xterm 이 막게 둔다', () => {
    const { open, osc8 } = setup()
    expect(osc8.allowNonHttpProtocols).toBe(false)
    const range = { start: { x: 1, y: 1 }, end: { x: 5, y: 1 } }
    osc8.activate(click(), 'https://github.com/o/r/pull/1', range)
    expect(open).not.toHaveBeenCalled()
    osc8.activate(click({ ctrlKey: true }), 'https://github.com/o/r/pull/1', range)
    expect(open).toHaveBeenCalledWith('https://github.com/o/r/pull/1')
  })

  it('웹 주소가 아니면 Ctrl+클릭이어도 열지 않는다', () => {
    const { open, webLinks, osc8 } = setup()
    const range = { start: { x: 1, y: 1 }, end: { x: 5, y: 1 } }
    webLinks(click({ ctrlKey: true }), 'file:///C:/Windows/System32/calc.exe')
    osc8.activate(click({ ctrlKey: true }), 'javascript:alert(1)', range)
    expect(open).not.toHaveBeenCalled()
  })
})

describe('isWebUrl', () => {
  it('http·https 만', () => {
    expect(isWebUrl('https://a.b/c')).toBe(true)
    expect(isWebUrl('HTTP://A.B')).toBe(true)
    expect(isWebUrl('ftp://a.b')).toBe(false)
    expect(isWebUrl('mailto:a@b.c')).toBe(false)
    expect(isWebUrl('not a url')).toBe(false)
  })
})
