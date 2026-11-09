// 터미널 탭 — 리소스 정리(CR-01~03)·초기 출력/종료 처리(CR-07·08)·접근성(AX-02·18). xterm 은 jsdom 에서 렌더할 수 없어 가짜로 대체한다.
import { act, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'


import type { PtyDataEvent, TauriApi } from '../../lib/tauri'
import { createFakeTauri, deferred, flush } from '../../test/fakes'
import { makeDeps, renderWithDeps } from '../../test/render'
import { TERMINAL_EXIT_HINT, createTerminalKeyHandler } from './keys'
import { MAX_PENDING_PTY_CHARS, TerminalTab } from './TerminalTab'
import type { TerminalSessionSpec } from './TerminalTab'

const xterm = vi.hoisted(() => ({
  instances: [] as {
    focus: ReturnType<typeof vi.fn>
    options: Record<string, unknown>
    keyHandler: ((e: KeyboardEvent) => boolean) | null
    written: string[]
    dataHandler: ((d: string) => void) | null
  }[],
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    options: Record<string, unknown>
    focus = vi.fn()
    keyHandler: ((e: KeyboardEvent) => boolean) | null = null
    written: string[] = []
    dataHandler: ((d: string) => void) | null = null
    constructor(options: Record<string, unknown>) {
      this.options = options
      xterm.instances.push(this)
    }
    loadAddon() {}
    open() {}
    write(d: string) {
      this.written.push(d)
    }
    onData(cb: (d: string) => void) {
      this.dataHandler = cb
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

  it('screenReaderMode 켬 + 키 핸들러 연결', () => {
    setup()
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

describe('AX-18 터미널 region 이름은 짧게, 탈출 안내는 보이는 한 줄 + aria-describedby', () => {
  it('region 이름 "터미널", 설명 = 화면에 보이는 안내 문구(이름에 섞이지 않는다)', () => {
    setup()
    const region = screen.getByRole('region', { name: '터미널' })
    const hint = within(region).getByText(`${TERMINAL_EXIT_HINT}: 터미널 밖으로 이동`)
    expect(hint).toBeVisible()
    expect(region.getAttribute('aria-describedby')).toBe(hint.id)
    expect(region).toHaveAccessibleDescription(`${TERMINAL_EXIT_HINT}: 터미널 밖으로 이동`)
  })

  it('세션이 없으면 안내를 두지 않고 aria-describedby 도 없다', () => {
    const fake = createFakeTauri()
    renderWithDeps(<TerminalTab sessions={[]} activeId={A.issueId} visible />, makeDeps({ tauri: fake.tauri }))
    const region = screen.getByRole('region', { name: '터미널' })
    expect(region).not.toHaveAttribute('aria-describedby')
    expect(screen.queryByText(/터미널 밖으로 이동/)).toBeNull()
  })
})

describe('CR-07 ptySpawn 응답 전에 도착한 pty-data 는 id 확정 후 flush', () => {
  function captureListener() {
    let cb: ((e: PtyDataEvent) => void) | null = null
    const onPtyData: TauriApi['onPtyData'] = async (c) => {
      cb = c
      return () => {}
    }
    return { onPtyData, emit: (e: PtyDataEvent) => act(() => cb?.(e)) }
  }

  it('자기 id 의 선도착분은 xterm 에 순서대로 쓰고, 다른 세션 id 의 출력은 버린다', async () => {
    const spawn = deferred<string>()
    const l = captureListener()
    const t = setup({ onPtyData: l.onPtyData, ptySpawn: () => spawn.promise })
    await vi.waitFor(() => expect(t.tauri.ptySpawn).toHaveBeenCalled())
    l.emit({ id: 'pty-9', data: 'user@host:~$ ' })
    l.emit({ id: 'pty-other', data: 'other session output' })
    l.emit({ id: 'pty-9', data: 'ls\r\n' })
    expect(xterm.instances[0].written).toEqual([])

    await act(async () => {
      spawn.resolve('pty-9')
      await flush()
    })
    expect(xterm.instances[0].written).toEqual(['user@host:~$ ls\r\n'])

    // 확정 이후: 자기 id 는 즉시 쓰고 다른 id 는 계속 무시
    l.emit({ id: 'pty-9', data: 'next' })
    l.emit({ id: 'pty-other', data: 'noise' })
    expect(xterm.instances[0].written).toEqual(['user@host:~$ ls\r\n', 'next'])
  })

  it(`id 별 보관 상한(${MAX_PENDING_PTY_CHARS / 1024}KB)을 넘는 선도착분은 잘라낸다(앞부분 유지)`, async () => {
    const spawn = deferred<string>()
    const l = captureListener()
    const t = setup({ onPtyData: l.onPtyData, ptySpawn: () => spawn.promise })
    await vi.waitFor(() => expect(t.tauri.ptySpawn).toHaveBeenCalled())
    l.emit({ id: 'pty-9', data: 'a'.repeat(MAX_PENDING_PTY_CHARS - 10) })
    l.emit({ id: 'pty-9', data: 'b'.repeat(100) })
    l.emit({ id: 'pty-9', data: 'c'.repeat(100) })
    await act(async () => {
      spawn.resolve('pty-9')
      await flush()
    })
    const [flushed] = xterm.instances[0].written
    expect(xterm.instances[0].written).toHaveLength(1)
    expect(flushed).toHaveLength(MAX_PENDING_PTY_CHARS)
    expect(flushed.endsWith('b'.repeat(10))).toBe(true)
  })

  it('spawn 이 실패하면 선도착분은 버리고 오류를 보인다', async () => {
    const spawn = deferred<string>()
    const l = captureListener()
    const t = setup({ onPtyData: l.onPtyData, ptySpawn: () => spawn.promise })
    await vi.waitFor(() => expect(t.tauri.ptySpawn).toHaveBeenCalled())
    l.emit({ id: 'pty-9', data: 'orphan' })
    await act(async () => {
      spawn.reject(new Error('boom'))
      await flush()
    })
    expect(xterm.instances[0].written).toEqual([])
    expect(screen.getByRole('alert')).toHaveTextContent('boom')
  })
})

describe('CR-08 PTY write/resize reject → 세션 종료 안내 + [다시 시작]', () => {
  const ENDED = '터미널 세션이 종료되었습니다'
  const resizeObservers: { cb: () => void }[] = []

  beforeEach(() => {
    resizeObservers.length = 0
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: () => void) {
          resizeObservers.push({ cb })
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    )
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('ptyWrite 가 reject 되면 종료 문구와 [다시 시작] 을 보이고, 다시 시작하면 새 PTY 를 spawn 한다', async () => {
    let n = 0
    const t = setup({
      ptySpawn: async () => `pty-${++n}`,
      ptyWrite: async () => {
        throw new Error('pty gone')
      },
    })
    await vi.waitFor(() => expect(xterm.instances[0].dataHandler).not.toBeNull())
    expect(screen.queryByText(ENDED)).toBeNull()

    await act(async () => {
      xterm.instances[0].dataHandler?.('ls')
      await flush()
    })
    expect(screen.getByRole('alert')).toHaveTextContent(ENDED)
    // 종료 후 입력은 더 보내지 않는다
    await act(async () => {
      xterm.instances[0].dataHandler?.('again')
      await flush()
    })
    expect(t.tauri.ptyWrite).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: '다시 시작' }))
    await vi.waitFor(() => expect(t.tauri.ptySpawn).toHaveBeenCalledTimes(2))
    // 이전 PTY 정리 + 새 xterm 생성, 안내 제거, 사용자가 누른 재시작이라 새 터미널로 포커스 이동
    expect(t.tauri.ptyKill).toHaveBeenCalledWith('pty-1')
    expect(xterm.instances).toHaveLength(2)
    expect(xterm.instances[1].focus).toHaveBeenCalledTimes(1)
    expect(screen.queryByText(ENDED)).toBeNull()
    expect(screen.queryByRole('button', { name: '다시 시작' })).toBeNull()
  })

  it('ptyResize 가 reject 되어도 종료로 표시한다', async () => {
    const t = setup({
      ptyResize: async () => {
        throw new Error('pty gone')
      },
    })
    await vi.waitFor(() => expect(t.tauri.ptySpawn).toHaveBeenCalled())
    await flush()
    await act(async () => {
      for (const o of resizeObservers) o.cb()
      await flush()
    })
    expect(t.tauri.ptyResize).toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent(ENDED)
  })

  it('ptyKill 의 reject 는 무시한다(언마운트 경로) — unhandled rejection 없음', async () => {
    const t = setup({
      ptyKill: async () => {
        throw new Error('already dead')
      },
    })
    await vi.waitFor(() => expect(t.tauri.ptySpawn).toHaveBeenCalled())
    await flush()
    t.unmount()
    await flush()
    expect(t.tauri.ptyKill).toHaveBeenCalledWith('pty-1')
  })
})
