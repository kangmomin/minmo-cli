// 터미널 탭 — 리소스 정리(CR-01~03)·접근성(AX-02). xterm 은 jsdom 에서 렌더할 수 없어 가짜로 대체한다.
import { act, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { TauriApi } from '../../lib/tauri'
import { createFakeTauri, deferred, flush } from '../../test/fakes'
import { makeDeps, renderWithDeps } from '../../test/render'
import { TERMINAL_EXIT_HINT, createTerminalKeyHandler } from './keys'
import { TerminalTab } from './TerminalTab'
import type { TerminalSessionSpec } from './TerminalTab'

const xterm = vi.hoisted(() => ({
  instances: [] as {
    focus: ReturnType<typeof vi.fn>
    options: Record<string, unknown>
    keyHandler: ((e: KeyboardEvent) => boolean) | null
  }[],
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    options: Record<string, unknown>
    focus = vi.fn()
    keyHandler: ((e: KeyboardEvent) => boolean) | null = null
    constructor(options: Record<string, unknown>) {
      this.options = options
      xterm.instances.push(this)
    }
    loadAddon() {}
    open() {}
    write() {}
    onData() {
      return { dispose() {} }
    }
    attachCustomKeyEventHandler(h: (e: KeyboardEvent) => boolean) {
      this.keyHandler = h
    }
    dispose() {}
  },
}))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}))

const A: TerminalSessionSpec = { issueId: 'o/r#1', cwd: '/w/1' }

beforeEach(() => {
  xterm.instances.length = 0
})

function setup(tauriOverrides: Partial<TauriApi> = {}) {
  const fake = createFakeTauri(tauriOverrides)
  const deps = makeDeps({ tauri: fake.tauri })
  const r = renderWithDeps(<TerminalTab sessions={[A]} activeId={A.issueId} visible />, deps)
  return { ...r, tauri: fake.tauri, deps }
}

describe('CR-01 onPtyData 구독 해제', () => {
  it('구독이 resolve 되기 전에 unmount 되면 resolve 직후 즉시 unlisten, PTY 도 만들지 않는다', async () => {
    const sub = deferred<() => void>()
    const unlisten = vi.fn()
    const t = setup({ onPtyData: () => sub.promise })
    await flush()
    t.unmount()
    await act(async () => {
      sub.resolve(unlisten)
      await flush()
    })
    expect(unlisten).toHaveBeenCalledTimes(1)
    expect(t.tauri.ptySpawn).not.toHaveBeenCalled()
  })
})

describe('CR-03 세션이 사라지면 started 에서 제거', () => {
  it('세션 제거 후 다시 나타나도 터미널 탭을 보기 전에는 PTY 를 만들지 않는다', async () => {
    const t = setup()
    await vi.waitFor(() => expect(t.tauri.ptySpawn).toHaveBeenCalledTimes(1))
    t.rerender(<TerminalTab sessions={[]} activeId={A.issueId} visible={false} />)
    await flush()
    expect(t.tauri.ptyKill).toHaveBeenCalled()
    t.rerender(<TerminalTab sessions={[A]} activeId={A.issueId} visible={false} />)
    await flush()
    expect(t.tauri.ptySpawn).toHaveBeenCalledTimes(1)
  })
})

describe('AX-02 터미널 포커스·탈출', () => {
  it('표시돼도 xterm 에 자동 focus() 하지 않는다(포커스 강탈 금지)', async () => {
    const t = setup()
    await vi.waitFor(() => expect(t.tauri.ptySpawn).toHaveBeenCalled())
    expect(xterm.instances).toHaveLength(1)
    expect(xterm.instances[0].focus).not.toHaveBeenCalled()
  })

  it('터미널 영역은 role=region + 탈출 방법을 담은 aria-label, screenReaderMode 켬', async () => {
    setup()
    expect(screen.getByRole('region', { name: `터미널 (${TERMINAL_EXIT_HINT} 으로 나가기)` })).toBeInTheDocument()
    expect(xterm.instances[0].options.screenReaderMode).toBe(true)
    expect(xterm.instances[0].keyHandler).toBeTypeOf('function')
  })

  it('Ctrl+Shift+M 키 핸들러 → onExit 호출 + xterm 입력 차단(false), 그 외 키는 통과(true)', () => {
    const onExit = vi.fn()
    const h = createTerminalKeyHandler(onExit)
    const key = (init: KeyboardEventInit, type = 'keydown') => new KeyboardEvent(type, init)
    expect(h(key({ key: 'M', code: 'KeyM', ctrlKey: true, shiftKey: true }))).toBe(false)
    expect(onExit).toHaveBeenCalledTimes(1)
    // keyup 은 차단만 하고 다시 호출하지 않는다
    expect(h(key({ key: 'M', code: 'KeyM', ctrlKey: true, shiftKey: true }, 'keyup'))).toBe(false)
    expect(onExit).toHaveBeenCalledTimes(1)
    expect(h(key({ key: 'm', code: 'KeyM', ctrlKey: true }))).toBe(true)
    expect(h(key({ key: 'Escape', code: 'Escape' }))).toBe(true)
    expect(h(key({ key: 'a', code: 'KeyA' }))).toBe(true)
    expect(onExit).toHaveBeenCalledTimes(1)
  })

  it('xterm 에 연결된 핸들러가 Ctrl+Shift+M 에서 onExit 를 부른다', async () => {
    const fake = createFakeTauri()
    const onExit = vi.fn()
    renderWithDeps(<TerminalTab sessions={[A]} activeId={A.issueId} visible onExit={onExit} />, makeDeps({ tauri: fake.tauri }))
    const h = xterm.instances[0].keyHandler
    expect(h).not.toBeNull()
    h?.(new KeyboardEvent('keydown', { key: 'M', code: 'KeyM', ctrlKey: true, shiftKey: true }))
    expect(onExit).toHaveBeenCalledTimes(1)
  })
})
