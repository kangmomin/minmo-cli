// 터미널 탭 — 리소스 정리(CR-01~03)·초기 출력/종료 처리(CR-07·08·18·19)·접근성(AX-02·18·34·35·39). xterm 은 jsdom 에서 렌더할 수 없어 가짜로 대체한다.
import { act, fireEvent, screen, within } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'


import type { PtyDataEvent, TauriApi } from '../../lib/tauri'
import { createFakeTauri, deferred, flush } from '../../test/fakes'
import { useUiStore } from '../../store/ui'
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
    host: HTMLElement | null
    textarea: HTMLTextAreaElement | undefined
    selection: string
  }[],
  // 정적 Terminal.strings — 실제 xterm 처럼 open() 이전에 바꿔야 입력 textarea 라벨에 반영된다
  strings: { promptLabel: 'Terminal input', tooMuchOutput: '' },
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
    host: HTMLElement | null = null
    textarea: HTMLTextAreaElement | undefined
    static strings = xterm.strings
    constructor(options: Record<string, unknown>) {
      this.options = options
      xterm.instances.push(this)
    }
    loadAddon() {}
    // 실제 xterm 처럼 host 안에 입력 textarea 를 만든다
    open(el: HTMLElement) {
      this.host = el
      this.textarea = document.createElement('textarea')
      this.textarea.setAttribute('aria-label', xterm.strings.promptLabel)
      el.appendChild(this.textarea)
    }
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
    selection = ''
    getSelection() {
      return this.selection
    }
    hasSelection() {
      return this.selection !== ''
    }
    clearSelection() {
      this.selection = ''
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
  xterm.strings.promptLabel = 'Terminal input'
  useUiStore.setState({ panes: {}, focusRequest: null, terminalIds: {}, theme: 'black' })
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

describe('CR-08 PTY write reject → 세션 종료 안내 + [다시 시작]', () => {
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

  it('CR-19 ptyResize reject 는 종료로 보지 않고 무시한다 — 이후 ptyWrite reject 에서만 종료 배너', async () => {
    const t = setup({
      ptyResize: async () => {
        throw new Error('transient')
      },
      ptyWrite: async () => {
        throw new Error('pty gone')
      },
    })
    await vi.waitFor(() => expect(xterm.instances[0]?.dataHandler).not.toBeNull())
    await flush()
    await act(async () => {
      for (const o of resizeObservers) o.cb()
      await flush()
    })
    expect(t.tauri.ptyResize).toHaveBeenCalled()
    expect(screen.queryByText(ENDED)).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    // 입력은 계속 PTY 로 보낸다(종료로 오탐하지 않았다는 증거)
    await act(async () => {
      xterm.instances[0].dataHandler?.('ls')
      await flush()
    })
    expect(t.tauri.ptyWrite).toHaveBeenCalledTimes(1)
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

describe('AX-34 / CR-18 / AX-35 종료 배너 — 키보드 도달·포커스 이동·alert 분리', () => {
  const ENDED = '터미널 세션이 종료되었습니다'

  async function endedSession() {
    const t = setup({
      ptyWrite: async () => {
        throw new Error('pty gone')
      },
    })
    await vi.waitFor(() => expect(xterm.instances[0]?.dataHandler).not.toBeNull())
    const end = () =>
      act(async () => {
        xterm.instances[0].dataHandler?.('ls')
        await flush()
      })
    return { ...t, end }
  }

  it('[다시 시작] 은 DOM 순서상 xterm host 보다 앞에 있다(Tab 순서)', async () => {
    const t = await endedSession()
    await t.end()
    const button = screen.getByRole('button', { name: '다시 시작' })
    const host = xterm.instances[0].host
    expect(host).not.toBeNull()
    expect(button.compareDocumentPosition(host as HTMLElement) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('종료 시 포커스가 터미널(host) 안에 있었다면 [다시 시작] 으로 옮긴다', async () => {
    const t = await endedSession()
    const input = xterm.instances[0].textarea as HTMLTextAreaElement
    input.focus()
    expect(input).toHaveFocus()
    await t.end()
    expect(screen.getByRole('button', { name: '다시 시작' })).toHaveFocus()
  })

  it('포커스가 터미널 밖(다른 탭·이슈 등)에 있으면 옮기지 않는다', async () => {
    const t = await endedSession()
    const other = document.createElement('button')
    document.body.append(other)
    try {
      other.focus()
      await t.end()
      expect(screen.getByRole('alert')).toHaveTextContent(ENDED)
      expect(other).toHaveFocus()
      expect(screen.getByRole('button', { name: '다시 시작' })).not.toHaveFocus()
    } finally {
      other.remove()
    }
  })

  it('role=alert 는 문구 요소에만 두고 버튼은 형제로 분리한다', async () => {
    const t = await endedSession()
    await t.end()
    const alert = screen.getByRole('alert')
    const button = screen.getByRole('button', { name: '다시 시작' })
    expect(alert).toHaveTextContent(ENDED)
    expect(alert).not.toContainElement(button)
    expect(alert.parentElement).toBe(button.parentElement)
  })
})

describe('CR-19(a) spawn 실패 alert 에도 [다시 시도] 로 복구', () => {
  it('문구 alert 와 버튼은 형제, 누르면 새 PTY 를 spawn 하고 오류를 지우며 새 터미널로 포커스', async () => {
    let n = 0
    const t = setup({
      ptySpawn: async () => {
        if (++n === 1) throw new Error('boom')
        return `pty-${n}`
      },
    })
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('boom')
    const retry = screen.getByRole('button', { name: '다시 시도' })
    expect(alert).not.toContainElement(retry)
    expect(alert.parentElement).toBe(retry.parentElement)
    // 오류 안내도 xterm host 보다 앞에 있다
    const host = xterm.instances[0].host as HTMLElement
    expect(retry.compareDocumentPosition(host) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    fireEvent.click(retry)
    await vi.waitFor(() => expect(t.tauri.ptySpawn).toHaveBeenCalledTimes(2))
    await flush()
    expect(xterm.instances).toHaveLength(2)
    expect(xterm.instances[1].focus).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('button', { name: '다시 시도' })).toBeNull()
  })
})

describe('AX-39 xterm 입력 textarea 에도 탈출 안내 연결 + 라벨 한국어화', () => {
  it('입력 textarea 의 aria-describedby 는 보이는 탈출 안내 요소의 id, 라벨은 "터미널 입력"', () => {
    setup()
    const hint = screen.getByText(`${TERMINAL_EXIT_HINT}: 터미널 밖으로 이동`)
    const input = xterm.instances[0].textarea as HTMLTextAreaElement
    expect(input.getAttribute('aria-describedby')).toBe(hint.id)
    expect(input).toHaveAccessibleDescription(`${TERMINAL_EXIT_HINT}: 터미널 밖으로 이동`)
    expect(xterm.strings.promptLabel).toBe('터미널 입력')
    expect(input).toHaveAccessibleName('터미널 입력')
  })
})

describe('패널 분할 (Ctrl+D / Ctrl+Shift+D / Ctrl+W)', () => {
  const key = (init: KeyboardEventInit, type = 'keydown') => new KeyboardEvent(type, { ctrlKey: true, ...init })
  const press = (i: number, init: KeyboardEventInit) => act(() => void xterm.instances[i].keyHandler?.(key(init)))

  it('키 핸들러: 세 조합은 셸로 보내지 않고(false) keydown 에서만 1회 실행, Ctrl+C 등은 통과', () => {
    const panes = { splitRight: vi.fn(), splitDown: vi.fn(), close: vi.fn() }
    const h = createTerminalKeyHandler(vi.fn(), panes)
    expect(h(key({ key: 'd', code: 'KeyD' }))).toBe(false)
    expect(h(key({ key: 'D', code: 'KeyD', shiftKey: true }))).toBe(false)
    expect(h(key({ key: 'w', code: 'KeyW' }))).toBe(false)
    expect(h(key({ key: 'd', code: 'KeyD' }, 'keyup'))).toBe(false)
    expect([panes.splitRight.mock.calls.length, panes.splitDown.mock.calls.length, panes.close.mock.calls.length]).toEqual([1, 1, 1])
    expect(h(key({ key: 'c', code: 'KeyC' }))).toBe(true)
    expect(h(key({ key: 'd', code: 'KeyD', altKey: true }))).toBe(true)
    // Dvorak: 물리 KeyD 자리에서 'e' 가 입력되면 Ctrl+E(줄 끝)로 셸에 보낸다 · 한글 IME 는 물리 키로 판단
    expect(h(key({ key: 'e', code: 'KeyD' }))).toBe(true)
    expect(h(key({ key: 'ㅇ', code: 'KeyD' }))).toBe(false)
    // 패널 동작을 넘기지 않으면(기존 호출) Ctrl+D 는 셸로 간다
    expect(createTerminalKeyHandler(vi.fn())(key({ key: 'd', code: 'KeyD' }))).toBe(true)
  })

  it('Ctrl+D → 오른쪽에 새 패널(PTY 하나 더) + 새 패널로 포커스, Ctrl+Shift+D → 아래 분할', async () => {
    let n = 0
    const t = setup({ ptySpawn: async () => `pty-${++n}` })
    await vi.waitFor(() => expect(t.tauri.ptySpawn).toHaveBeenCalledTimes(1))
    press(0, { key: 'd', code: 'KeyD' })
    await vi.waitFor(() => expect(t.tauri.ptySpawn).toHaveBeenCalledTimes(2))
    expect(t.tauri.ptySpawn.mock.calls[1][0].cwd).toBe(A.cwd)
    const panes = screen.getAllByTestId('terminal-pane')
    expect(panes.map((p) => [p.style.left, p.style.width])).toEqual([
      ['0%', '50%'],
      ['50%', '50%'],
    ])
    // 기존 패널은 다시 만들지 않는다(PTY 유지)
    expect(t.tauri.ptyKill).not.toHaveBeenCalled()
    expect(xterm.instances[0].focus).not.toHaveBeenCalled()
    expect(xterm.instances[1].focus).toHaveBeenCalledTimes(1)

    press(1, { key: 'D', code: 'KeyD', shiftKey: true })
    await vi.waitFor(() => expect(t.tauri.ptySpawn).toHaveBeenCalledTimes(3))
    expect(screen.getAllByTestId('terminal-pane').map((p) => [p.style.top, p.style.height])).toEqual([
      ['0%', '100%'],
      ['0%', '50%'],
      ['50%', '50%'],
    ])
  })

  it('Ctrl+W → 그 패널의 PTY 만 종료(프로세스 트리 정리는 Rust pty_kill)하고 형제로 포커스, 마지막 패널을 닫으면 [새 터미널]', async () => {
    let n = 0
    const t = setup({ ptySpawn: async () => `pty-${++n}` })
    await vi.waitFor(() => expect(t.tauri.ptySpawn).toHaveBeenCalledTimes(1))
    press(0, { key: 'd', code: 'KeyD' })
    await vi.waitFor(() => expect(useUiStore.getState().terminalIds).toHaveProperty([`${A.issueId}::2`], 'pty-2'))

    press(1, { key: 'w', code: 'KeyW' })
    await vi.waitFor(() => expect(t.tauri.ptyKill).toHaveBeenCalledWith('pty-2'))
    expect(t.tauri.ptyKill).toHaveBeenCalledTimes(1)
    expect(screen.getAllByTestId('terminal-pane')).toHaveLength(1)
    expect(xterm.instances[0].focus).toHaveBeenCalledTimes(1)
    expect(useUiStore.getState().terminalIds).not.toHaveProperty([`${A.issueId}::2`])

    press(0, { key: 'w', code: 'KeyW' })
    await vi.waitFor(() => expect(t.tauri.ptyKill).toHaveBeenCalledWith('pty-1'))
    const again = screen.getByRole('button', { name: '새 터미널' })
    fireEvent.click(again)
    await vi.waitFor(() => expect(t.tauri.ptySpawn).toHaveBeenCalledTimes(3))
  })

  it('StrictMode(개발 실행)에서도 새 패널 xterm 이 포커스를 받는다', async () => {
    let n = 0
    const fake = createFakeTauri({ ptySpawn: async () => `pty-${++n}` })
    renderWithDeps(
      <StrictMode>
        <TerminalTab sessions={[A]} activeId={A.issueId} visible />
      </StrictMode>,
      makeDeps({ tauri: fake.tauri }),
    )
    await vi.waitFor(() => expect(fake.tauri.ptySpawn).toHaveBeenCalled())
    const before = xterm.instances.length
    press(before - 1, { key: 'd', code: 'KeyD' })
    await vi.waitFor(() => expect(xterm.instances.length).toBeGreaterThan(before))
    // StrictMode 는 effect 를 두 번 돌려 xterm 을 다시 만든다 — 실제로 남는 마지막 인스턴스가 포커스를 받아야 한다
    expect(xterm.instances.at(-1)!.focus).toHaveBeenCalledTimes(1)
  })

  it('패널 상태가 지워져도(마운트 유지) 새 패널을 다시 만든다 — 빈 화면에 갇히지 않음', async () => {
    let n = 0
    const t = setup({ ptySpawn: async () => `pty-${++n}` })
    await vi.waitFor(() => expect(t.tauri.ptySpawn).toHaveBeenCalledTimes(1))
    act(() => useUiStore.getState().removeWorktree(A.issueId))
    await vi.waitFor(() => expect(t.tauri.ptySpawn).toHaveBeenCalledTimes(2))
    expect(t.tauri.ptyKill).toHaveBeenCalledWith('pty-1')
    expect(screen.getAllByTestId('terminal-pane')).toHaveLength(1)
  })

  it('removeWorktree 는 그 이슈의 패널·PTY id·남은 포커스 요청을 지운다', () => {
    useUiStore.setState({
      panes: { [A.issueId]: { tree: { kind: 'leaf', id: `${A.issueId}::2` }, focused: null, seq: 2 } },
      terminalIds: { [`${A.issueId}::2`]: 'pty-9', 'x::1': 'pty-1' },
      focusRequest: { paneId: `${A.issueId}::2`, token: 3 },
    })
    useUiStore.getState().removeWorktree(A.issueId)
    const s = useUiStore.getState()
    expect(s.panes).toEqual({})
    expect(s.terminalIds).toEqual({ 'x::1': 'pty-1' })
    expect(s.focusRequest).toBeNull()
  })

  it('터미널 입력에 포커스가 들어오면 그 패널이 분할·닫기 대상이 된다', async () => {
    const t = setup()
    await vi.waitFor(() => expect(t.tauri.ptySpawn).toHaveBeenCalledTimes(1))
    press(0, { key: 'd', code: 'KeyD' })
    await vi.waitFor(() => expect(xterm.instances).toHaveLength(2))
    expect(useUiStore.getState().panes[A.issueId].focused).toBe(`${A.issueId}::2`)
    fireEvent.focus(xterm.instances[0].textarea!)
    expect(useUiStore.getState().panes[A.issueId].focused).toBe(`${A.issueId}::1`)
  })

  it('테마 전환을 열린 터미널에도 반영(블랙 #000000 · 라이트 #1e1e1e · Ghostty 는 16색까지)', async () => {
    setup()
    const theme = () => xterm.instances[0].options.theme as { background: string; red?: string }
    expect(theme().background).toBe('#000000')
    act(() => useUiStore.getState().setTheme('light'))
    expect(theme().background).toBe('#1e1e1e')
    act(() => useUiStore.getState().setTheme('ghostty'))
    expect([theme().background, theme().red]).toEqual(['#282c34', '#cc6666'])
  })
})

describe('원격 호스트 터미널', () => {
  const R: TerminalSessionSpec = { issueId: 'ssh:my-server|o/r#1', cwd: '/home/dev/w/1', remote: { host: 'my-server', tmux: true } }

  it('첫 패널은 worktree 의 기본 tmux 세션, 분할 패널은 떼면 사라지는 세션으로 연다', async () => {
    const fake = createFakeTauri()
    renderWithDeps(<TerminalTab sessions={[R]} activeId={R.issueId} visible />, makeDeps({ tauri: fake.tauri }))
    await vi.waitFor(() => expect(fake.tauri.ptySpawn).toHaveBeenCalledTimes(1))
    const first = fake.tauri.ptySpawn.mock.calls[0][0]
    expect(first.cwd).toBe('/home/dev/w/1')
    expect(first.remote).toMatchObject({ host: 'my-server', ephemeral: false })
    expect(first.remote?.session).toMatch(/^minmo-[0-9a-f]{10}$/)

    act(() => useUiStore.getState().splitPane(R.issueId, `${R.issueId}::1`, 'row'))
    await vi.waitFor(() => expect(fake.tauri.ptySpawn).toHaveBeenCalledTimes(2))
    expect(fake.tauri.ptySpawn.mock.calls[1][0].remote).toEqual({ host: 'my-server', session: `${first.remote?.session}-p2`, ephemeral: true })
  })

  it('tmux 가 없는 호스트는 로그인 셸 · 세션 목록이 다시 만들어져도 터미널을 새로 띄우지 않는다', async () => {
    const fake = createFakeTauri()
    const plain = { ...R, remote: { host: 'my-server', tmux: false } }
    const r = renderWithDeps(<TerminalTab sessions={[plain]} activeId={R.issueId} visible />, makeDeps({ tauri: fake.tauri }))
    await vi.waitFor(() => expect(fake.tauri.ptySpawn).toHaveBeenCalledTimes(1))
    expect(fake.tauri.ptySpawn.mock.calls[0][0].remote).toEqual({ host: 'my-server', session: null, ephemeral: false })
    r.rerender(<TerminalTab sessions={[{ ...plain, remote: { host: 'my-server', tmux: false } }]} activeId={R.issueId} visible />)
    await flush()
    expect(fake.tauri.ptySpawn).toHaveBeenCalledTimes(1)
    expect(fake.tauri.ptyKill).not.toHaveBeenCalled()
  })

  it('이 PC 의 터미널은 remote 없이 연다', async () => {
    const t = setup()
    await vi.waitFor(() => expect(t.tauri.ptySpawn).toHaveBeenCalledTimes(1))
    expect(t.tauri.ptySpawn.mock.calls[0][0].remote).toBeUndefined()
  })
})

describe('편집 키 (Ctrl+Backspace 단어 지우기 · Shift+Enter 줄바꿈)', () => {
  const key = (init: KeyboardEventInit, type = 'keydown') => new KeyboardEvent(type, { cancelable: true, ...init })
  function handler() {
    const sent: string[] = []
    return { sent, h: createTerminalKeyHandler(vi.fn(), undefined, undefined, (d) => void sent.push(d)) }
  }

  it('Ctrl+Backspace 는 ^W, Shift+Enter 는 ESC+\\r 을 보내고 xterm 의 원래 글자(^H·\\r)는 막는다', () => {
    const { h, sent } = handler()
    const bs = key({ key: 'Backspace', code: 'Backspace', ctrlKey: true })
    expect(h(bs)).toBe(false)
    expect(bs.defaultPrevented).toBe(true)
    expect(h(key({ key: 'Enter', code: 'Enter', shiftKey: true }))).toBe(false)
    expect(sent).toEqual(['\x17', '\x1b\r'])
    // 누르고 있으면 반복되고, keypress·keyup 은 보내지 않고 막기만 한다
    expect(h(key({ key: 'Backspace', ctrlKey: true, repeat: true }))).toBe(false)
    expect(h(key({ key: 'Backspace', ctrlKey: true }, 'keyup'))).toBe(false)
    expect(h(key({ key: 'Enter', shiftKey: true }, 'keypress'))).toBe(false)
    expect(sent).toEqual(['\x17', '\x1b\r', '\x17'])
  })

  it('그냥 Backspace·Enter 와 다른 수정 키 조합, 한글 조합 중에는 건드리지 않는다', () => {
    const { h, sent } = handler()
    for (const init of [
      { key: 'Backspace' },
      { key: 'Enter' },
      { key: 'Backspace', ctrlKey: true, shiftKey: true },
      { key: 'Enter', ctrlKey: true, shiftKey: true },
      { key: 'Backspace', ctrlKey: true, altKey: true },
      { key: 'Enter', shiftKey: true, altKey: true },
      { key: 'Enter', shiftKey: true, metaKey: true },
      { key: 'Enter', shiftKey: true, isComposing: true },
      { key: 'Backspace', ctrlKey: true, isComposing: true },
    ]) {
      expect(h(key(init))).toBe(true)
    }
    expect(sent).toEqual([])
  })

  it('보내는 함수가 없으면(send 생략) 가로채지 않는다', () => {
    const h = createTerminalKeyHandler(vi.fn())
    expect(h(key({ key: 'Backspace', ctrlKey: true }))).toBe(true)
    expect(h(key({ key: 'Enter', shiftKey: true }))).toBe(true)
  })
})

describe('복사·붙여넣기 (Ctrl+C / Ctrl+V — Windows Terminal 방식)', () => {
  const key = (init: KeyboardEventInit, type = 'keydown') => new KeyboardEvent(type, { ctrlKey: true, cancelable: true, ...init })
  function handler(selected = '') {
    const clip = { text: selected, copied: [] as string[] }
    const h = createTerminalKeyHandler(vi.fn(), undefined, {
      hasSelection: () => clip.text !== '',
      selection: () => clip.text,
      copy: (t) => void clip.copied.push(t),
      clearSelection: () => {
        clip.text = ''
      },
    })
    return { h, clip }
  }

  it('Ctrl+C: 선택이 있으면 복사하고 선택을 풀며 셸로 보내지 않는다 · 선택이 없으면 셸로 보낸다(중단)', () => {
    const { h, clip } = handler('hello')
    const down = key({ key: 'c', code: 'KeyC' })
    expect(h(down)).toBe(false)
    expect(down.defaultPrevented).toBe(true)
    expect(clip.copied).toEqual(['hello'])
    // 복사 뒤에는 선택이 없으므로 다음 Ctrl+C 는 중단 신호다
    expect(h(key({ key: 'c', code: 'KeyC' }))).toBe(true)
    expect(clip.copied).toEqual(['hello'])
  })

  it('Ctrl+C: 복사한 키를 누르고 있어도(키 반복) 셸로 중단 신호를 보내지 않는다 — 뗀 뒤 다시 누르면 보낸다', () => {
    const { h, clip } = handler('abc')
    expect(h(key({ key: 'c', code: 'KeyC' }))).toBe(false)
    // 복사로 선택이 풀린 뒤의 키 반복
    expect(h(key({ key: 'c', code: 'KeyC', repeat: true }))).toBe(false)
    expect(h(key({ key: 'c', code: 'KeyC', repeat: true }))).toBe(false)
    expect(h(key({ key: 'c', code: 'KeyC' }, 'keyup'))).toBe(false)
    expect(clip.copied).toEqual(['abc'])
    expect(h(key({ key: 'c', code: 'KeyC' }))).toBe(true)
    // 선택 없이 누르고 있는 Ctrl+C 는 계속 셸로 간다
    expect(h(key({ key: 'c', code: 'KeyC', repeat: true }))).toBe(true)
  })

  it('Ctrl+C: 빈칸만 선택하면(글자는 비어 있음) 셸로 보내지 않고 선택만 푼다 — 클립보드는 덮어쓰지 않는다', () => {
    const copied: string[] = []
    const clear = vi.fn()
    const h = createTerminalKeyHandler(vi.fn(), undefined, { hasSelection: () => true, selection: () => '', copy: (t) => void copied.push(t), clearSelection: clear })
    expect(h(key({ key: 'c', code: 'KeyC' }))).toBe(false)
    expect(copied).toEqual([])
    expect(clear).toHaveBeenCalledTimes(1)
  })

  it('Ctrl+C: keyup 을 놓쳐도(포커스 이동 등) 다음에 새로 누르면 정상 동작한다', () => {
    const { h, clip } = handler('abc')
    expect(h(key({ key: 'c', code: 'KeyC' }))).toBe(false)
    // keyup 없이 새로 누름: 선택이 없으니 셸로 간다
    expect(h(key({ key: 'c', code: 'KeyC' }))).toBe(true)
    expect(h(key({ key: 'c', code: 'KeyC', repeat: true }))).toBe(true)
    expect(clip.copied).toEqual(['abc'])
  })

  it('Ctrl+Shift+C: 복사 전용 — 선택이 없어도 셸로 보내지 않는다', () => {
    const { h, clip } = handler()
    expect(h(key({ key: 'C', code: 'KeyC', shiftKey: true }))).toBe(false)
    expect(clip.copied).toEqual([])
    const sel = handler('x')
    expect(sel.h(key({ key: 'C', code: 'KeyC', shiftKey: true }))).toBe(false)
    expect(sel.clip.copied).toEqual(['x'])
  })

  it('Ctrl+V · Ctrl+Shift+V: 셸로 ^V 를 보내지 않고, 브라우저의 붙여넣기(기본 동작)는 막지 않는다', () => {
    const { h } = handler()
    for (const init of [{ key: 'v', code: 'KeyV' }, { key: 'V', code: 'KeyV', shiftKey: true }]) {
      const down = key(init)
      expect(h(down)).toBe(false)
      expect(down.defaultPrevented).toBe(false)
    }
  })

  it('한글 입력 상태에서도 물리 키로 동작한다 · Alt 조합과 다른 글자는 그대로 셸로', () => {
    const { h, clip } = handler('가나다')
    expect(h(key({ key: 'ㅊ', code: 'KeyC' }))).toBe(false)
    expect(clip.copied).toEqual(['가나다'])
    expect(h(key({ key: 'ㅍ', code: 'KeyV' }))).toBe(false)
    expect(h(key({ key: 'v', code: 'KeyV', altKey: true }))).toBe(true)
    expect(h(key({ key: 'x', code: 'KeyX' }))).toBe(true)
  })

  it('터미널에 연결: 선택한 글자를 클립보드에 쓰고 선택을 푼다', async () => {
    const writeText = vi.fn(async (_text: string) => {})
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    try {
      setup()
      const term = xterm.instances[0]
      term.selection = 'npm run build'
      act(() => void term.keyHandler?.(key({ key: 'c', code: 'KeyC' })))
      expect(writeText).toHaveBeenCalledWith('npm run build')
      expect(term.selection).toBe('')
      // 클립보드에 쓰지 못해도(권한 등) 터미널은 그대로 동작한다
      writeText.mockRejectedValueOnce(new Error('denied'))
      term.selection = 'again'
      expect(() => act(() => void term.keyHandler?.(key({ key: 'c', code: 'KeyC' })))).not.toThrow()
    } finally {
      vi.unstubAllGlobals()
    }
    const term = xterm.instances[0]
    expect(term.selection).toBe('')
    expect(screen.getByText(/Ctrl\+C: 복사\(선택했을 때\) · Ctrl\+V: 붙여넣기/)).toBeInTheDocument()
  })
})

describe('글자 크기 (Ctrl + / Ctrl - / Ctrl 0)', () => {
  const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', { ctrlKey: true, cancelable: true, ...init })

  it('세 조합은 셸로 보내지 않는다(앱이 처리) · 다른 조합은 그대로', () => {
    const h = createTerminalKeyHandler(vi.fn())
    for (const init of [{ key: '=' }, { key: '+', shiftKey: true }, { key: '-' }, { key: '0' }, { key: '+', code: 'NumpadAdd' }, { key: '-', code: 'NumpadSubtract' }, { key: '0', code: 'Numpad0' }]) {
      expect(h(key(init))).toBe(false)
    }
    expect(h(key({ key: '_', shiftKey: true }))).toBe(true)
    expect(h(key({ key: '1' }))).toBe(true)
    expect(h(key({ key: '-', altKey: true }))).toBe(true)
  })

  it('저장된 크기로 터미널을 만들고, 바꾸면 열린 터미널에 반영한 뒤 PTY 에 새 크기를 알린다(새로 띄우지 않는다)', async () => {
    useUiStore.setState({ fontSize: 16 })
    try {
      const t = setup()
      await vi.waitFor(() => expect(t.tauri.ptySpawn).toHaveBeenCalledTimes(1))
      const term = xterm.instances[0]
      expect(term.options.fontSize).toBe(16)
      const before = t.tauri.ptyResize.mock.calls.length
      act(() => useUiStore.getState().setFontSize(20))
      expect(term.options.fontSize).toBe(20)
      await vi.waitFor(() => expect(t.tauri.ptyResize.mock.calls.length).toBeGreaterThan(before))
      expect(t.tauri.ptySpawn).toHaveBeenCalledTimes(1)
      expect(xterm.instances).toHaveLength(1)
    } finally {
      useUiStore.setState({ fontSize: 13 })
    }
  })
})
