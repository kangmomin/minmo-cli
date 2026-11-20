// 터미널 탭 — 리소스 정리(CR-01~03)·초기 출력/종료 처리(CR-07·08·18·19)·접근성(AX-02·18·34·35·39). xterm 은 jsdom 에서 렌더할 수 없어 가짜로 대체한다.
import { act, fireEvent, screen, within } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'


import type { PtyDataEvent, PtyFound, PtyLink, PtyLinkEvent, PtyResizedEvent, RemotePty, TauriApi } from '../../lib/tauri'
import { createFakeTauri, deferred, flush } from '../../test/fakes'
import { LAUNCH_DELAY_MS, queueLaunch, takeLaunch } from '../agents/launchQueue'
import { useSetupStore } from '../../store/setup'
import { useUiStore } from '../../store/ui'
import { makeDeps, renderWithDeps } from '../../test/render'
import { TERMINAL_EXIT_HINT, createTerminalKeyHandler, useTerminalOpenShortcut } from './keys'
import { MAX_PENDING_PTY_CHARS, TerminalTab } from './TerminalTab'
import type { TerminalSessionSpec } from './TerminalTab'

const xterm = vi.hoisted(() => ({
  instances: [] as {
    focus: ReturnType<typeof vi.fn>
    options: Record<string, unknown>
    keyHandler: ((e: KeyboardEvent) => boolean) | null
    cols: number
    rows: number
    written: string[]
    dataHandler: ((d: string) => void) | null
    host: HTMLElement | null
    textarea: HTMLTextAreaElement | undefined
    selection: string
    unicode: { activeVersion: string }
    addons: { kind?: string; handler?: (e: MouseEvent, uri: string) => void }[]
    oscHandlers: Map<number, (data: string) => boolean | Promise<boolean>>
  }[],
  // 정적 Terminal.strings — 실제 xterm 처럼 open() 이전에 바꿔야 입력 textarea 라벨에 반영된다
  strings: { promptLabel: 'Terminal input', tooMuchOutput: '' },
  // 만든 WebGL 렌더러들. WebGL2 를 쓸 수 없는 환경: failCreate 면 만들 때(Safari 16 미만), failLoad 면 붙일 때 실패한다
  webgl: { instances: [] as { kind: string; disposed: boolean; lose(): void }[], failCreate: false, failLoad: false },
  // 패널 크기에 맞춘 칸 수 — 정하면 FitAddon.fit() 이 xterm 을 이 크기로 바꾼다(없으면 그대로 둔다)
  fitTo: null as { cols: number; rows: number } | null,
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
    unicode = { activeVersion: '6' }
    addons: { kind?: string }[] = []
    // 프로그램이 보낸 OSC 신호(번호별) 처리기
    oscHandlers = new Map<number, (data: string) => boolean | Promise<boolean>>()
    parser = {
      registerOscHandler: (id: number, cb: (data: string) => boolean | Promise<boolean>) => {
        this.oscHandlers.set(id, cb)
        return { dispose: () => this.oscHandlers.delete(id) }
      },
    }
    static strings = xterm.strings
    constructor(options: Record<string, unknown>) {
      this.options = options
      xterm.instances.push(this)
    }
    loadAddon(addon: { kind?: string; activate?: (t: unknown) => void }) {
      if (addon.kind === 'webgl' && xterm.webgl.failLoad) throw new Error('WebGL2 not supported')
      addon.activate?.(this)
      this.addons.push(addon)
    }
    // 실제 xterm 처럼 host 안에 입력 textarea 를 만든다
    open(el: HTMLElement) {
      this.host = el
      this.textarea = document.createElement('textarea')
      this.textarea.setAttribute('aria-label', xterm.strings.promptLabel)
      el.appendChild(this.textarea)
    }
    write(d: string, done?: () => void) {
      this.written.push(d)
      // 실제 xterm 처럼 쓰는 동안 OSC 신호(ESC ] <번호> ; <데이터> BEL)를 처리하고, 콜백은 그 뒤에 부른다
      for (const part of d.split('\x1b]').slice(1)) {
        const body = part.slice(0, part.indexOf('\x07'))
        const sep = body.indexOf(';')
        this.oscHandlers.get(Number(body.slice(0, sep)))?.(body.slice(sep + 1))
      }
      done?.()
    }
    resize(cols: number, rows: number) {
      this.cols = cols
      this.rows = rows
    }
    input(d: string) {
      this.dataHandler?.(d)
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
    term: { cols: number; rows: number } | null = null
    activate(t: { cols: number; rows: number }) {
      this.term = t
    }
    fit() {
      if (this.term && xterm.fitTo) Object.assign(this.term, xterm.fitTo)
    }
  },
}))
vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class {
    kind = 'web-links'
    constructor(public handler: (e: MouseEvent, uri: string) => void) {}
  },
}))
vi.mock('@xterm/addon-unicode11', () => ({
  Unicode11Addon: class {
    kind = 'unicode11'
  },
}))
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    kind = 'webgl'
    disposed = false
    lost: (() => void) | null = null
    constructor() {
      if (xterm.webgl.failCreate) throw new Error('Webgl2 is only supported on Safari 16 and above')
      xterm.webgl.instances.push(this)
    }
    onContextLoss(cb: () => void) {
      this.lost = cb
      return { dispose() {} }
    }
    /** GPU 가 context 를 거둬 간 상황 */
    lose() {
      this.lost?.()
    }
    dispose() {
      this.disposed = true
    }
  },
}))

const A: TerminalSessionSpec = { issueId: 'o/r#1', cwd: '/w/1' }
const R: TerminalSessionSpec = { issueId: 'ssh:my-server|o/r#1', cwd: '/home/dev/w/1', remote: { host: 'my-server', tmux: true } }
/** 사용자가 이미 터미널을 연 상태 — 이 파일의 대부분은 열린 터미널의 동작을 본다 */
const STARTED = { [A.issueId]: true, [R.issueId]: true } as const

beforeEach(() => {
  xterm.instances.length = 0
  xterm.strings.promptLabel = 'Terminal input'
  xterm.webgl.instances.length = 0
  xterm.webgl.failCreate = false
  xterm.webgl.failLoad = false
  xterm.fitTo = null
  useUiStore.setState({ panes: {}, focusRequest: null, terminalIds: {}, startedTerminals: { ...STARTED }, tab: 'terminal', selectedIssueId: null, theme: 'black' })
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

describe('글자 그리기 — Unicode 11 폭·WebGL 렌더러(#58)', () => {
  /** 지금 붙어 있는(떼지 않은) WebGL 렌더러 */
  const liveWebgl = () => xterm.webgl.instances.filter((w) => !w.disposed)

  it('글자 폭은 Unicode 11 로 센다 — 이모지를 ConPTY·Claude Code 처럼 2칸으로', async () => {
    setup()
    await flush()
    const t = xterm.instances[0]
    expect(t.options.allowProposedApi).toBe(true)
    expect(t.addons.some((a) => a.kind === 'unicode11')).toBe(true)
    expect(t.unicode.activeVersion).toBe('11')
  })

  it('보이는 터미널만 WebGL 로 그린다 — 숨기면 떼고, 다시 보이면 새로 붙인다', async () => {
    const t = setup()
    await flush()
    expect(liveWebgl()).toHaveLength(1)
    expect(xterm.instances[0].addons).toContain(liveWebgl()[0])

    t.rerender(<TerminalTab sessions={[A]} activeId={A.issueId} visible={false} />)
    await flush()
    expect(liveWebgl()).toHaveLength(0)

    t.rerender(<TerminalTab sessions={[A]} activeId={A.issueId} visible />)
    await flush()
    expect(liveWebgl()).toHaveLength(1)
    expect(xterm.webgl.instances).toHaveLength(2)
  })

  it.each([
    ['만들 때', 'failCreate'],
    ['붙일 때', 'failLoad'],
  ] as const)('WebGL 을 %s 실패하면 DOM 렌더러로 그대로 쓴다(오류를 띄우지 않는다)', async (_, failAt) => {
    xterm.webgl[failAt] = true
    const t = setup()
    await vi.waitFor(() => expect(t.tauri.ptySpawn).toHaveBeenCalledTimes(1))
    expect(liveWebgl()).toHaveLength(0)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('WebGL context 를 잃으면 떼고 DOM 렌더러로 그린다', async () => {
    setup()
    await flush()
    act(() => liveWebgl()[0].lose())
    expect(liveWebgl()).toHaveLength(0)
  })

  it('호스트가 Windows ConPTY 면 PTY 를 열기(첫 출력) 전에 xterm 에 그 정보(windowsPty)를 준다', async () => {
    const info = { backend: 'conpty', buildNumber: 26200 } as const
    let atSpawn: unknown
    const t = setup({
      ptyWindows: async () => info,
      ptySpawn: async () => {
        atSpawn = xterm.instances[0].options.windowsPty
        return 'pty-1'
      },
    })
    await vi.waitFor(() => expect(t.tauri.ptySpawn).toHaveBeenCalledTimes(1))
    expect(atSpawn).toEqual(info)
  })

  it.each([
    ['ConPTY 가 아니면(null)', async () => null],
    ['묻지 못하면(reject)', async () => Promise.reject(new Error('원격에서 쓸 수 없는 기능입니다: ptyWindows'))],
  ])('%s windowsPty 없이 터미널을 연다', async (_, ptyWindows) => {
    const t = setup({ ptyWindows })
    await vi.waitFor(() => expect(t.tauri.ptySpawn).toHaveBeenCalledTimes(1))
    expect(xterm.instances[0].options.windowsPty).toBeUndefined()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('ConPTY 정보는 터미널이 여럿이어도 한 번만 묻고, 묻지 못했으면 다음에 여는 터미널이 다시 묻는다', async () => {
    const info = { backend: 'conpty', buildNumber: 26200 } as const
    const ptyWindows = vi.fn<TauriApi['ptyWindows']>().mockRejectedValueOnce(new Error('연결 끊김')).mockResolvedValue(info)
    const fake = createFakeTauri({ ptyWindows })
    const r = renderWithDeps(<TerminalTab sessions={[A]} activeId={A.issueId} visible />, makeDeps({ tauri: fake.tauri }))
    await vi.waitFor(() => expect(fake.tauri.ptySpawn).toHaveBeenCalledTimes(1))
    expect(xterm.instances[0].options.windowsPty).toBeUndefined()

    // 나중에 연 터미널은 다시 묻는다
    const S2: TerminalSessionSpec = { issueId: 'o/r#2', cwd: '/w/2' }
    const S3: TerminalSessionSpec = { issueId: 'o/r#3', cwd: '/w/3' }
    // 세션 목록에 없는 이슈는 열린 터미널에서 빠지므로(CR-03) 세션을 넣기 직전에 연다
    const open = (s: TerminalSessionSpec) => act(() => useUiStore.setState((u) => ({ startedTerminals: { ...u.startedTerminals, [s.issueId]: true } })))
    open(S2)
    r.rerender(<TerminalTab sessions={[A, S2]} activeId={A.issueId} visible />)
    await vi.waitFor(() => expect(fake.tauri.ptySpawn).toHaveBeenCalledTimes(2))
    expect(xterm.instances[1].options.windowsPty).toEqual(info)
    expect(ptyWindows).toHaveBeenCalledTimes(2)

    // 이미 읽은 값은 다시 묻지 않는다
    open(S3)
    r.rerender(<TerminalTab sessions={[A, S2, S3]} activeId={A.issueId} visible />)
    await vi.waitFor(() => expect(fake.tauri.ptySpawn).toHaveBeenCalledTimes(3))
    expect(xterm.instances[2].options.windowsPty).toEqual(info)
    expect(ptyWindows).toHaveBeenCalledTimes(2)
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

  it('ptyKill 의 reject 는 무시한다(패널 닫기 경로) — unhandled rejection 없음', async () => {
    const t = setup({
      ptyKill: async () => {
        throw new Error('already dead')
      },
    })
    await vi.waitFor(() => expect(t.tauri.ptySpawn).toHaveBeenCalled())
    await flush()
    const issueId = Object.keys(useUiStore.getState().panes)[0]
    act(() => useUiStore.getState().closePane(issueId, `${issueId}::1`))
    await flush()
    expect(t.tauri.ptyKill).toHaveBeenCalledWith('pty-1')
  })

  it('터미널 탭 전체가 내려가면(호스트 전환 등) 터미널을 끝내지 않는다 — 다른 기기가 보고 있을 수 있고, 돌아오면 다시 붙는다', async () => {
    const t = setup()
    await vi.waitFor(() => expect(t.tauri.ptySpawn).toHaveBeenCalled())
    await flush()
    t.unmount()
    await flush()
    expect(t.tauri.ptyKill).not.toHaveBeenCalled()
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

  it('패널 상태가 지워져도(마운트 유지) [터미널 열기] 로 다시 만든다 — 빈 화면에 갇히지 않음', async () => {
    let n = 0
    const t = setup({ ptySpawn: async () => `pty-${++n}` })
    await vi.waitFor(() => expect(t.tauri.ptySpawn).toHaveBeenCalledTimes(1))
    act(() => useUiStore.getState().removeWorktree(A.issueId))
    // 기록이 지워진 이슈의 터미널은 끝내고, 다시 열 수 있는 버튼을 보인다(자동으로 다시 띄우지 않는다)
    await vi.waitFor(() => expect(t.tauri.ptyKill).toHaveBeenCalledWith('pty-1'))
    expect(t.tauri.ptySpawn).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: '터미널 열기' }))
    await vi.waitFor(() => expect(t.tauri.ptySpawn).toHaveBeenCalledTimes(2))
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
    expect(s.startedTerminals).not.toHaveProperty([A.issueId])
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
  it('첫 패널은 worktree 의 기본 tmux 세션, 분할 패널은 그 패널의 세션(-pN — 패널을 닫을 때 끝낸다)으로 연다', async () => {
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

  it('tmux 를 쓰지 않으면(설정 꺼짐·tmux 없는 호스트) 로그인 셸 · 세션 목록이 다시 만들어져도 터미널을 새로 띄우지 않는다', async () => {
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

  it('열려 있는 터미널은 tmux 설정이 바뀌어도 다시 띄우지 않는다 — 새로 여는 패널부터 적용', async () => {
    const fake = createFakeTauri()
    const plain = { ...R, remote: { host: 'my-server', tmux: false } }
    const r = renderWithDeps(<TerminalTab sessions={[plain]} activeId={R.issueId} visible />, makeDeps({ tauri: fake.tauri }))
    await vi.waitFor(() => expect(fake.tauri.ptySpawn).toHaveBeenCalledTimes(1))
    r.rerender(<TerminalTab sessions={[R]} activeId={R.issueId} visible />)
    await flush()
    expect(fake.tauri.ptySpawn).toHaveBeenCalledTimes(1)
    expect(fake.tauri.ptyKill).not.toHaveBeenCalled()
    // 설정을 켠 뒤 분할한 패널은 tmux 세션으로 연다
    act(() => useUiStore.getState().splitPane(R.issueId, `${R.issueId}::1`, 'row'))
    await vi.waitFor(() => expect(fake.tauri.ptySpawn).toHaveBeenCalledTimes(2))
    expect(fake.tauri.ptySpawn.mock.calls[1][0].remote).toMatchObject({ host: 'my-server', ephemeral: true })
    expect(fake.tauri.ptySpawn.mock.calls[1][0].remote?.session).toMatch(/^minmo-[0-9a-f]{10}-p2$/)
  })

  it('끝난 터미널을 [다시 시작] 하면 지금 tmux 설정으로 연다', async () => {
    const fake = createFakeTauri({
      ptyWrite: async () => {
        throw new Error('pty gone')
      },
    })
    const plain = { ...R, remote: { host: 'my-server', tmux: false } }
    const r = renderWithDeps(<TerminalTab sessions={[plain]} activeId={R.issueId} visible />, makeDeps({ tauri: fake.tauri }))
    await vi.waitFor(() => expect(xterm.instances[0].dataHandler).not.toBeNull())
    r.rerender(<TerminalTab sessions={[R]} activeId={R.issueId} visible />)
    await act(async () => {
      xterm.instances[0].dataHandler?.('ls')
      await flush()
    })
    fireEvent.click(screen.getByRole('button', { name: '다시 시작' }))
    await vi.waitFor(() => expect(fake.tauri.ptySpawn).toHaveBeenCalledTimes(2))
    expect(fake.tauri.ptySpawn.mock.calls[0][0].remote?.session).toBeNull()
    expect(fake.tauri.ptySpawn.mock.calls[1][0].remote?.session).toMatch(/^minmo-[0-9a-f]{10}$/)
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

describe('ssh 원격 프로그램의 링크·복사 (#76)', () => {
  const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')

  it('프로그램의 복사(OSC 52)를 이 화면의 클립보드에 쓴다 · 클립보드를 읽는 요청에는 답하지 않는다', async () => {
    const writeText = vi.fn(async (_text: string) => {})
    const readText = vi.fn(async () => '비밀')
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText, readText } })
    try {
      const t = setup()
      await vi.waitFor(() => expect(t.tauri.ptySpawn).toHaveBeenCalledTimes(1))
      const term = xterm.instances[0]
      const osc52 = term.oscHandlers.get(52)
      expect(osc52?.(`c;${b64('git push origin 브랜치')}`)).toBe(true)
      expect(writeText).toHaveBeenCalledWith('git push origin 브랜치')
      osc52?.('c;?')
      await flush()
      expect(readText).not.toHaveBeenCalled()
      // 읽기 요청에 답하면 그 답이 PTY 입력으로 간다 — 아무것도 보내지 않는다
      expect(t.tauri.ptyWrite).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('링크는 Ctrl+클릭으로만 연다 — 일반 URL·OSC 8 링크 모두 이 화면의 openUrl 로', async () => {
    const t = setup()
    await flush()
    const term = xterm.instances[0]
    const webLinks = term.addons.find((a) => a.kind === 'web-links')?.handler
    const osc8 = term.options.linkHandler as { activate(e: MouseEvent, uri: string): void } | undefined
    webLinks?.(new MouseEvent('mouseup'), 'https://example.com')
    osc8?.activate(new MouseEvent('mouseup'), 'https://example.com')
    expect(t.tauri.openUrl).not.toHaveBeenCalled()
    webLinks?.(new MouseEvent('mouseup', { ctrlKey: true }), 'https://github.com/o/r/pull/1')
    osc8?.activate(new MouseEvent('mouseup', { ctrlKey: true }), 'https://example.com/docs')
    expect(vi.mocked(t.tauri.openUrl).mock.calls).toEqual([['https://github.com/o/r/pull/1'], ['https://example.com/docs']])
  })

  it('브라우저를 열지 못해도(거절) 터미널은 그대로 동작한다', async () => {
    const t = setup({ openUrl: vi.fn(async () => Promise.reject(new Error('not allowed'))) })
    await flush()
    const webLinks = xterm.instances[0].addons.find((a) => a.kind === 'web-links')?.handler
    expect(() => webLinks?.(new MouseEvent('mouseup', { ctrlKey: true }), 'https://example.com')).not.toThrow()
    await flush()
    expect(t.tauri.openUrl).toHaveBeenCalledTimes(1)
  })

  it('안내 줄에 링크 열기·마우스를 쓰는 프로그램에서의 선택 방법을 보인다', () => {
    setup()
    expect(screen.getByText(/Ctrl\+클릭: 링크 열기 · Shift\+드래그: 프로그램이 마우스를 쓸 때 선택/)).toBeInTheDocument()
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

describe('함께 쓰는 터미널 — 이미 떠 있는 터미널에 붙기(원격 접속)', () => {
  const FOUND = { id: 'pty-9', scrollback: 'PS C:\\w> echo hi\r\nhi\r\n', offset: 100, cols: 120, rows: 40 }

  /** 이벤트를 테스트에서 직접 넣을 수 있는 구독 */
  function emitter<T>() {
    const cbs = new Set<(e: T) => void>()
    return {
      on: async (cb: (e: T) => void) => {
        cbs.add(cb)
        return () => void cbs.delete(cb)
      },
      emit: (e: T) => cbs.forEach((cb) => cb(e)),
    }
  }

  it('패널의 터미널이 이미 있으면 새로 만들지 않고, 그 크기로 지금까지의 출력을 그린 뒤 붙는다', async () => {
    const t = setup({ ptyFind: async () => FOUND })
    await vi.waitFor(() => expect(xterm.instances[0].written).toEqual([FOUND.scrollback]))
    expect(t.tauri.ptyFind).toHaveBeenCalledWith(`${A.issueId}::1`)
    expect(t.tauri.ptySpawn).not.toHaveBeenCalled()
    expect([xterm.instances[0].cols, xterm.instances[0].rows]).toEqual([120, 40])
    expect(useUiStore.getState().terminalIds[`${A.issueId}::1`]).toBe('pty-9')
    // 입력은 그 터미널로 간다
    act(() => xterm.instances[0].dataHandler?.('ls\r'))
    expect(t.tauri.ptyWrite).toHaveBeenCalledWith('pty-9', 'ls\r')
  })

  it('지난 출력을 다시 그릴 때 그 안의 옛 복사(OSC 52)는 클립보드에 쓰지 않는다 · 붙은 뒤의 새 복사는 쓴다(#76)', async () => {
    const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')
    const writeText = vi.fn(async (_text: string) => {})
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    try {
      const data = emitter<{ id: string; data: string; end?: number }>()
      setup({ onPtyData: data.on, ptyFind: async () => ({ ...FOUND, scrollback: `${FOUND.scrollback}\x1b]52;c;${b64('옛 복사')}\x07` }) })
      await vi.waitFor(() => expect(xterm.instances[0].written).toHaveLength(1))
      await flush()
      expect(writeText).not.toHaveBeenCalled()
      act(() => data.emit({ id: 'pty-9', data: `\x1b]52;c;${b64('새 복사')}\x07` }))
      expect(writeText).toHaveBeenCalledWith('새 복사')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('붙는 사이에 온 출력은 지난 출력(scrollback)과 겹치는 것은 버리고 그 뒤의 것만 이어 그린다', async () => {
    const data = emitter<{ id: string; data: string; end?: number }>()
    const find = deferred<typeof FOUND>()
    setup({ onPtyData: data.on, ptyFind: () => find.promise })
    await flush()
    // ptyFind 의 답을 기다리는 동안 도착한 조각들: 앞의 둘은 scrollback(위치 100까지)에 이미 들어 있다
    act(() => {
      data.emit({ id: 'pty-9', data: 'old-1', end: 90 })
      data.emit({ id: 'pty-9', data: 'old-2', end: 100 })
      data.emit({ id: 'pty-9', data: 'new-1', end: 105 })
      data.emit({ id: 'pty-9', data: 'new-2', end: 110 })
      data.emit({ id: 'other', data: 'x', end: 999 })
    })
    await act(async () => {
      find.resolve(FOUND)
      await flush()
    })
    await vi.waitFor(() => expect(xterm.instances[0].written).toEqual([FOUND.scrollback, 'new-1new-2']))
  })

  it('새로 만들 때는 패널 id 를 key 로 넘긴다(다른 기기가 같은 터미널에 붙을 수 있게)', async () => {
    const t = setup()
    await vi.waitFor(() => expect(t.tauri.ptySpawn).toHaveBeenCalled())
    expect(t.tauri.ptySpawn.mock.calls[0][0].key).toBe(`${A.issueId}::1`)
  })

  it('붙은 터미널은 다른 화면의 크기로 본다 — 화면 크기가 바뀌어도 터미널 크기를 바꾸지 않고, 터미널을 누르면(포커스) 이 화면의 크기로 가져온다', async () => {
    const t = setup({ ptyFind: async () => FOUND })
    await vi.waitFor(() => expect(xterm.instances[0].written).toHaveLength(1))
    await flush()
    expect(t.tauri.ptyResize).not.toHaveBeenCalled()
    act(() => xterm.instances[0].textarea?.dispatchEvent(new FocusEvent('focus')))
    expect(t.tauri.ptyResize).toHaveBeenCalledTimes(1)
    expect(t.tauri.ptyResize.mock.calls[0][0]).toBe('pty-9')
    // 이미 가져온 뒤에는 다시 누르기만 해서는 바꾸지 않는다
    act(() => xterm.instances[0].textarea?.dispatchEvent(new FocusEvent('focus')))
    expect(t.tauri.ptyResize).toHaveBeenCalledTimes(1)
  })

  it('다른 화면이 크기를 바꾸면 같은 크기로 그린다', async () => {
    const resized = emitter<{ id: string; cols: number; rows: number }>()
    const t = setup({ onPtyResized: resized.on })
    await vi.waitFor(() => expect(t.tauri.ptySpawn).toHaveBeenCalled())
    await flush()
    act(() => resized.emit({ id: 'other', cols: 10, rows: 5 }))
    expect(xterm.instances[0].cols).toBe(80)
    act(() => resized.emit({ id: 'pty-1', cols: 44, rows: 20 }))
    expect([xterm.instances[0].cols, xterm.instances[0].rows]).toEqual([44, 20])
  })

  describe('이 화면이 바꾼 크기의 알림(#58)', () => {
    /** 화면 크기가 바뀐 것처럼 xterm 의 칸 수를 정하고 크기 맞춤을 다시 돌린다(글자 크기 변경이 크기 맞춤을 부른다) */
    let font = 13
    const refit = (cols: number) => {
      xterm.instances[0].cols = cols
      act(() => useUiStore.getState().setFontSize(++font))
    }
    /** 마지막 ptyResize 요청 — 그 크기와 이 화면의 표시(by) */
    const lastAsk = (t: ReturnType<typeof setup>) => {
      const [id, cols, rows, by] = t.tauri.ptyResize.mock.calls.at(-1)!
      return { id, cols, rows, by } as PtyResizedEvent
    }

    async function opened() {
      const resized = emitter<PtyResizedEvent>()
      const t = setup({ onPtyResized: resized.on })
      // 크기 알림 구독은 PTY 를 연 뒤에 한다 — terminalIds 가 채워지면 끝난 것이다
      await vi.waitFor(() => expect(useUiStore.getState().terminalIds[`${A.issueId}::1`]).toBe('pty-1'))
      return { t, resized }
    }

    afterEach(() => {
      font = 13
      useUiStore.setState({ fontSize: 13 })
    })

    it('크기를 빠르게 두 번 바꿔 앞 요청의 알림이 늦게 와도 옛 크기로 돌아가지 않고, 크기 맞춤을 이어 간다', async () => {
      const { t, resized } = await opened()
      refit(100)
      const first = lastAsk(t)
      refit(110)
      const second = lastAsk(t)
      expect([first.cols, second.cols]).toEqual([100, 110])
      expect(first.by).toBeTruthy()
      expect(first.by).not.toBe(second.by)

      act(() => resized.emit(first))
      expect(xterm.instances[0].cols).toBe(110)
      act(() => resized.emit(second))
      expect(xterm.instances[0].cols).toBe(110)

      // 여전히 이 화면이 크기를 정한다 — 화면 크기가 바뀌면 다시 알린다(누르지 않아도)
      const before = t.tauri.ptyResize.mock.calls.length
      refit(90)
      expect(t.tauri.ptyResize.mock.calls.length).toBe(before + 1)
      expect(lastAsk(t).cols).toBe(90)
    })

    it('다른 화면의 알림 뒤에 이 화면의 마지막 요청이 적용되면 그 크기로 돌아오고 다시 크기를 정한다', async () => {
      const { t, resized } = await opened()
      refit(100)
      const mine = lastAsk(t)
      // PTY 에서는 다른 화면의 요청이 먼저 처리됐다
      act(() => resized.emit({ id: 'pty-1', cols: 60, rows: 20, by: 'other:1' }))
      expect([xterm.instances[0].cols, xterm.instances[0].rows]).toEqual([60, 20])
      act(() => resized.emit(mine))
      expect([xterm.instances[0].cols, xterm.instances[0].rows]).toEqual([100, 24])

      const before = t.tauri.ptyResize.mock.calls.length
      refit(90)
      expect(t.tauri.ptyResize.mock.calls.length).toBe(before + 1)
    })

    it('같은 크기를 다시 요청해도 요청마다 알림을 받는다 — 다른 화면의 알림이 사이에 끼어도 마지막 요청에서 크기를 되찾는다', async () => {
      const { t, resized } = await opened()
      refit(100)
      const first = lastAsk(t)
      // 창을 끄는 동안처럼 칸 수가 그대로인 요청
      refit(100)
      const second = lastAsk(t)
      // PTY 에는 다른 화면의 요청 → 첫 요청 → 둘째 요청 순서로 적용됐다
      act(() => resized.emit({ id: 'pty-1', cols: 60, rows: 20, by: 'other:1' }))
      act(() => resized.emit(first))
      expect(xterm.instances[0].cols).toBe(60)
      act(() => resized.emit(second))
      expect([xterm.instances[0].cols, xterm.instances[0].rows]).toEqual([100, 24])

      const before = t.tauri.ptyResize.mock.calls.length
      refit(90)
      expect(t.tauri.ptyResize.mock.calls.length).toBe(before + 1)
    })

    it('옛 요청이 더 새 요청보다 늦게 적용되면(원격 호출의 순서가 바뀐 경우) 이 화면의 크기를 다시 알린다', async () => {
      const { t, resized } = await opened()
      refit(100)
      const first = lastAsk(t)
      refit(110)
      const second = lastAsk(t)
      act(() => resized.emit(second))
      const before = t.tauri.ptyResize.mock.calls.length
      // PTY 가 옛 크기(100)가 됐다
      act(() => resized.emit(first))
      expect(t.tauri.ptyResize.mock.calls.length).toBe(before + 1)
      expect(lastAsk(t)).toMatchObject({ cols: 110, rows: 24 })
      expect(xterm.instances[0].cols).toBe(110)
    })

    it('다른 화면의 크기로 보던 사이 패널이 바뀌었으면, 마지막 요청이 적용되어 크기를 되찾을 때 패널에 다시 맞춘다', async () => {
      const { t, resized } = await opened()
      refit(100)
      const mine = lastAsk(t)
      act(() => resized.emit({ id: 'pty-1', cols: 60, rows: 20, by: 'other:1' }))
      // 다른 화면의 크기로 보는 동안 패널이 바뀌었다(이때는 따라가지 않는다)
      xterm.fitTo = { cols: 90, rows: 30 }
      act(() => resized.emit(mine))
      expect([xterm.instances[0].cols, xterm.instances[0].rows]).toEqual([90, 30])
      expect(lastAsk(t)).toMatchObject({ cols: 90, rows: 30 })
    })

    it('이 화면의 마지막 요청 뒤에 다른 화면이 바꾸면 그 크기로 본다', async () => {
      const { t, resized } = await opened()
      refit(100)
      act(() => resized.emit(lastAsk(t)))
      act(() => resized.emit({ id: 'pty-1', cols: 60, rows: 20, by: 'other:1' }))
      expect([xterm.instances[0].cols, xterm.instances[0].rows]).toEqual([60, 20])
      // 다른 화면의 크기로 보는 중에는 이 화면의 크기를 알리지 않는다
      const before = t.tauri.ptyResize.mock.calls.length
      refit(90)
      expect(t.tauri.ptyResize.mock.calls.length).toBe(before)
    })
  })

  it('셸이 끝났다는 알림을 받으면 종료 안내를 띄운다(입력하지 않고 보기만 하던 화면도)', async () => {
    const exits = emitter<string>()
    const t = setup({ onPtyExit: exits.on })
    await vi.waitFor(() => expect(t.tauri.ptySpawn).toHaveBeenCalled())
    await flush()
    act(() => exits.emit('other'))
    expect(screen.queryByText('터미널 세션이 종료되었습니다')).toBeNull()
    act(() => exits.emit('pty-1'))
    expect(await screen.findByText('터미널 세션이 종료되었습니다')).toBeInTheDocument()
  })
})

describe('터미널은 사용자가 열 때만 만든다 (Ctrl+T · [터미널 열기])', () => {
  const ctrlT = (init: KeyboardEventInit = {}) => new KeyboardEvent('keydown', { ctrlKey: true, key: 't', code: 'KeyT', cancelable: true, bubbles: true, ...init })
  const READY = { phase: 'ready', path: A.cwd, branch: 'b', pathChanged: false } as const

  function Shortcut() {
    useTerminalOpenShortcut()
    return null
  }

  /** 이슈를 골라 작업 폴더가 준비된 화면(터미널은 아직 열지 않음) */
  function setupIdle(tauriOverrides: Partial<TauriApi> = {}) {
    useUiStore.setState({ startedTerminals: {}, selectedIssueId: A.issueId })
    useSetupStore.setState({ open: { [A.issueId]: READY } })
    const fake = createFakeTauri(tauriOverrides)
    const r = renderWithDeps(
      <>
        <Shortcut />
        <TerminalTab sessions={[A]} activeId={A.issueId} visible />
      </>,
      makeDeps({ tauri: fake.tauri }),
    )
    return { ...r, tauri: fake.tauri }
  }

  afterEach(() => useSetupStore.setState({ open: {} }))

  it('준비된 이슈를 보기만 해서는 터미널을 만들지 않고, 여는 방법을 안내한다', async () => {
    const t = setupIdle()
    await flush()
    expect(t.tauri.ptySpawn).not.toHaveBeenCalled()
    expect(t.tauri.ptyFind).not.toHaveBeenCalled()
    expect(xterm.instances).toHaveLength(0)
    expect(screen.getByRole('button', { name: '터미널 열기' })).toBeInTheDocument()
    // 터미널이 없으면 탈출 안내(단축키 줄)도 없다
    expect(screen.getByRole('region', { name: '터미널' })).not.toHaveAttribute('aria-describedby')
  })

  it('[터미널 열기] → 터미널 하나를 만들고 그쪽으로 포커스를 옮긴다', async () => {
    const t = setupIdle()
    fireEvent.click(screen.getByRole('button', { name: '터미널 열기' }))
    await vi.waitFor(() => expect(t.tauri.ptySpawn).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('button', { name: '터미널 열기' })).toBeNull()
    expect(screen.getAllByTestId('terminal-pane')).toHaveLength(1)
    expect(xterm.instances[0].focus).toHaveBeenCalledTimes(1)
  })

  it('Ctrl+T → 없으면 첫 터미널, 이미 있으면 오른쪽에 새 패널(첫 터미널이 뜨는 중이어도)', async () => {
    let n = 0
    const t = setupIdle({ ptySpawn: async () => `pty-${++n}` })
    useUiStore.setState({ tab: 'notes' })
    const first = ctrlT()
    act(() => void window.dispatchEvent(first))
    expect(first.defaultPrevented).toBe(true)
    expect(useUiStore.getState().tab).toBe('terminal')
    act(() => void window.dispatchEvent(ctrlT()))
    await vi.waitFor(() => expect(t.tauri.ptySpawn).toHaveBeenCalledTimes(2))
    expect(screen.getAllByTestId('terminal-pane').map((p) => [p.style.left, p.style.width])).toEqual([
      ['0%', '50%'],
      ['50%', '50%'],
    ])
    expect(t.tauri.ptyKill).not.toHaveBeenCalled()
  })

  it('Ctrl+T 는 작업 폴더가 준비되지 않았거나 대화상자가 열려 있으면 아무것도 하지 않는다 · 누르고 있어도 한 번만', async () => {
    const t = setupIdle()
    useSetupStore.setState({ open: { [A.issueId]: { phase: 'opening' } } })
    const early = ctrlT()
    act(() => void window.dispatchEvent(early))
    expect(early.defaultPrevented).toBe(false)
    useSetupStore.setState({ open: { [A.issueId]: READY } })
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    document.body.appendChild(dialog)
    try {
      act(() => void window.dispatchEvent(ctrlT()))
    } finally {
      dialog.remove()
    }
    act(() => void window.dispatchEvent(ctrlT({ shiftKey: true })))
    await flush()
    expect(t.tauri.ptySpawn).not.toHaveBeenCalled()
    act(() => void window.dispatchEvent(ctrlT()))
    act(() => void window.dispatchEvent(ctrlT({ repeat: true })))
    await vi.waitFor(() => expect(t.tauri.ptySpawn).toHaveBeenCalledTimes(1))
    await flush()
    expect(screen.getAllByTestId('terminal-pane')).toHaveLength(1)
  })

  it('터미널 안에서 누른 Ctrl+T 는 셸로 보내지 않는다(앱이 처리) · Ctrl+Shift+T 는 그대로', () => {
    const h = createTerminalKeyHandler(vi.fn())
    expect(h(ctrlT())).toBe(false)
    expect(h(new KeyboardEvent('keyup', { ctrlKey: true, key: 't', code: 'KeyT' }))).toBe(false)
    expect(h(ctrlT({ key: 'ㅅ' }))).toBe(false)
    expect(h(ctrlT({ key: 'T', shiftKey: true }))).toBe(true)
  })

  it('이미 떠 있는 터미널(다른 화면이 연 것)에는 열지 않아도 붙는다 — 새로 만들지 않는다', async () => {
    const FOUND = { id: 'pty-9', scrollback: 'hi', offset: 10, cols: 100, rows: 30 }
    useUiStore.setState({
      panes: { [A.issueId]: { tree: { kind: 'leaf', id: `${A.issueId}::1` }, focused: null, seq: 1 } },
      terminalIds: { [`${A.issueId}::1`]: 'pty-9' },
    })
    const t = setupIdle({ ptyFind: async () => FOUND })
    await vi.waitFor(() => expect(xterm.instances[0]?.written).toEqual([FOUND.scrollback]))
    expect(t.tauri.ptySpawn).not.toHaveBeenCalled()
    // 붙기만 했으므로 포커스는 옮기지 않는다(AX-02)
    expect(xterm.instances[0].focus).not.toHaveBeenCalled()
  })

  it('다른 이슈를 보고 와도 연 터미널은 그대로, 열지 않은 이슈에는 만들지 않는다', async () => {
    const B: TerminalSessionSpec = { issueId: 'o/r#2', cwd: '/w/2' }
    // 처음 그린 것과 같은 모양으로 다시 그린다(모양이 바뀌면 터미널 탭이 새로 마운트된다)
    const view = (activeId: string) => (
      <>
        <Shortcut />
        <TerminalTab sessions={[A, B]} activeId={activeId} visible />
      </>
    )
    const t = setupIdle()
    fireEvent.click(screen.getByRole('button', { name: '터미널 열기' }))
    await vi.waitFor(() => expect(t.tauri.ptySpawn).toHaveBeenCalledTimes(1))
    t.rerender(view(B.issueId))
    await flush()
    expect(screen.getByRole('button', { name: '터미널 열기' })).toBeInTheDocument()
    t.rerender(view(A.issueId))
    await flush()
    expect(t.tauri.ptySpawn).toHaveBeenCalledTimes(1)
    expect(t.tauri.ptyKill).not.toHaveBeenCalled()
  })
})

describe('#78 트리에서 이슈를 누르면 그 이슈의 터미널로 포커스', () => {
  const B: TerminalSessionSpec = { issueId: 'o/r#2', cwd: '/w/2' }

  /** 화면처럼 고른 이슈의 터미널을 보인다 */
  function Selected() {
    const id = useUiStore((s) => s.selectedIssueId)
    return <TerminalTab sessions={[A, B]} activeId={id} visible />
  }

  it('고른 렌더에서 새 이슈의 터미널이 보이는 채로 포커스하고, 요청 없이 고르기만 하면 포커스하지 않는다(AX-02)', async () => {
    useUiStore.setState({ selectedIssueId: A.issueId, startedTerminals: { [A.issueId]: true, [B.issueId]: true } })
    const fake = createFakeTauri()
    renderWithDeps(<Selected />, makeDeps({ tauri: fake.tauri }))
    await vi.waitFor(() => expect(fake.tauri.ptySpawn).toHaveBeenCalledTimes(2))
    const hidden = (x: (typeof xterm.instances)[number]) => x.host!.closest('.hidden') !== null
    const a = xterm.instances.find((x) => !hidden(x))!
    const b = xterm.instances.find(hidden)!
    let shownAtFocus: boolean | null = null
    b.focus.mockImplementation(() => {
      shownAtFocus = !hidden(b)
    })

    act(() => {
      useUiStore.getState().selectIssue(B.issueId)
      useUiStore.getState().focusIssueTerminal(B.issueId)
    })
    expect(b.focus).toHaveBeenCalledTimes(1)
    expect(shownAtFocus).toBe(true)
    expect(a.focus).not.toHaveBeenCalled()

    act(() => useUiStore.getState().selectIssue(A.issueId))
    await flush()
    expect(a.focus).not.toHaveBeenCalled()
  })

  it('처리한 요청을 지운 뒤 같은 패널에 다시 요청해도(token 이 다시 1) 포커스한다', async () => {
    useUiStore.setState({ selectedIssueId: A.issueId, startedTerminals: {} })
    const fake = createFakeTauri()
    renderWithDeps(<Selected />, makeDeps({ tauri: fake.tauri }))
    // [터미널 열기] 와 같다 — 첫 패널을 만들고 포커스(요청 token 1)
    act(() => useUiStore.getState().openTerminal(A.issueId))
    await vi.waitFor(() => expect(fake.tauri.ptySpawn).toHaveBeenCalledTimes(1))
    const [a] = xterm.instances
    expect(a.focus).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(useUiStore.getState().focusRequest).toBeNull())

    act(() => useUiStore.getState().focusIssueTerminal(A.issueId))
    expect(useUiStore.getState().focusRequest).toEqual({ paneId: `${A.issueId}::1`, token: 1 })
    expect(a.focus).toHaveBeenCalledTimes(2)
  })
})

describe('원격 터미널 재접속 (#89)', () => {
  const P1 = `${R.issueId}::1`
  const P2 = `${R.issueId}::2`
  const ENDED = '터미널 세션이 종료되었습니다'
  const link = (o: Partial<PtyLink> = {}): PtyLink => ({ phase: 'waiting', attempt: 1, max: 5, seq: 1, reason: null, at: null, ...o })
  const LIVE = link({ phase: 'connected', attempt: 0, seq: 0 })

  /** 이벤트를 테스트에서 직접 넣을 수 있는 구독 */
  function emitter<T>() {
    const cbs = new Set<(e: T) => void>()
    return {
      on: async (cb: (e: T) => void) => {
        cbs.add(cb)
        return () => void cbs.delete(cb)
      },
      emit: (e: T) => cbs.forEach((cb) => cb(e)),
    }
  }

  /** 원격 터미널을 연다. ptyFind 는 Rust 처럼 이 화면이 만든 터미널이면 그 연결 상태와 실제 tmux 세션을 돌려준다 */
  function setupRemote(overrides: Partial<TauriApi> = {}) {
    let n = 0
    const spawned = new Map<string, { id: string; remote?: RemotePty }>()
    const fake = createFakeTauri({
      ptySpawn: async (req) => {
        const id = `pty-${++n}`
        if (req.key) spawned.set(req.key, { id, remote: req.remote })
        return id
      },
      ptyFind: async (key): Promise<PtyFound | null> => {
        const s = spawned.get(key)
        if (!s) return null
        const tmux = s.remote?.session ? { session: s.remote.session, ephemeral: s.remote.ephemeral } : null
        return { id: s.id, scrollback: '', offset: 0, cols: 80, rows: 24, link: LIVE, tmux }
      },
      ...overrides,
    })
    const r = renderWithDeps(<TerminalTab sessions={[R]} activeId={R.issueId} visible />, makeDeps({ tauri: fake.tauri }))
    return { ...r, tauri: fake.tauri, emitLink: (e: PtyLinkEvent) => act(() => fake.emitPtyLink(e)) }
  }

  const opened = () => vi.waitFor(() => expect(useUiStore.getState().terminalIds[P1]).toBe('pty-1'))

  // AC-01 · AC-08
  it('pty-link 가 waiting 이면 ① 안내를 보이고, [지금 재접속] 을 누르면 그 터미널에 재접속을 요청한다', async () => {
    const t = setupRemote()
    await opened()
    t.emitLink({ id: 'pty-1', ...link({ phase: 'waiting', attempt: 1, seq: 1 }) })
    expect(screen.getByTestId('terminal-pane')).toHaveTextContent('연결이 끊겼습니다. 다시 접속하는 중… (1/5)')
    expect(screen.queryByText(ENDED)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '지금 재접속' }))
    expect(t.tauri.ptyReconnect).toHaveBeenCalledWith('pty-1')
  })

  // AC-09 — 재접속 중에 새로 붙은 화면도 지금 상태를 본다
  it('붙을 때 ptyFind 가 알려 준 지금 상태(waiting)로 바로 ① 안내를 보인다', async () => {
    const found: PtyFound = { id: 'pty-9', scrollback: 'old', offset: 3, cols: 80, rows: 24, link: link({ phase: 'waiting', attempt: 2, seq: 4 }), tmux: null }
    const t = setupRemote({ ptyFind: async () => found })
    await vi.waitFor(() => expect(screen.getByTestId('terminal-pane')).toHaveTextContent('연결이 끊겼습니다. 다시 접속하는 중… (2/5)'))
    expect(t.tauri.ptySpawn).not.toHaveBeenCalled()
  })

  // AC-06 · EC-05 — 분할 패널의 tmux 세션은 패널과 함께 끝낸다. 세션 이름은 Rust 가 가진 실제 값(ptyFind().tmux)
  it('tmux 분할 패널을 닫으면 ptyKill 다음에 그 -pN 세션을 1번 끝낸다 — 첫 패널을 닫을 때는 끝내지 않는다', async () => {
    const t = setupRemote()
    await opened()
    act(() => useUiStore.getState().splitPane(R.issueId, P1, 'row'))
    await vi.waitFor(() => expect(useUiStore.getState().terminalIds[P2]).toBe('pty-2'))
    const session = t.tauri.ptySpawn.mock.calls[1][0].remote?.session
    expect(session).toMatch(/-p2$/)

    act(() => useUiStore.getState().closePane(R.issueId, P2))
    await vi.waitFor(() => expect(t.tauri.sshExec).toHaveBeenCalledTimes(1))
    expect(t.tauri.sshExec.mock.calls[0].slice(0, 2)).toEqual(['my-server', ['tmux', '-L', 'minmo', 'kill-session', '-t', `=${session}`]])
    const killed = t.tauri.ptyKill.mock.calls.findIndex(([id]) => id === 'pty-2')
    expect(killed).toBeGreaterThanOrEqual(0)
    expect(t.tauri.ptyKill.mock.invocationCallOrder[killed]).toBeLessThan(t.tauri.sshExec.mock.invocationCallOrder[0])

    act(() => useUiStore.getState().closePane(R.issueId, P1))
    await vi.waitFor(() => expect(t.tauri.ptyKill).toHaveBeenCalledWith('pty-1'))
    await flush()
    expect(t.tauri.sshExec).toHaveBeenCalledTimes(1)
  })

  // AC-07 — 실패 안내로 바뀔 때 사용자가 터미널을 쓰던 중이면 [재접속] 으로 포커스(AX-34 와 같은 규칙)
  it('failed 로 바뀔 때 포커스가 터미널 안에 있었으면 [재접속] 으로 옮긴다 — waiting 에서는 옮기지 않는다', async () => {
    const t = setupRemote()
    await opened()
    const input = xterm.instances[0].textarea as HTMLTextAreaElement
    input.focus()
    t.emitLink({ id: 'pty-1', ...link({ phase: 'waiting', attempt: 1, seq: 1 }) })
    expect(input).toHaveFocus()
    t.emitLink({ id: 'pty-1', ...link({ phase: 'failed', attempt: 5, seq: 2 }) })
    expect(screen.getByRole('button', { name: '재접속' })).toHaveFocus()
  })

  // EC-02 — 재접속 중의 입력은 원격으로 가지 않는다 → 맡긴 명령은 연결된 뒤에 넣어야 사라지지 않는다
  it('연결이 끊긴 동안에는 [에이전트 실행] 으로 맡긴 명령을 넣지 않고, 다시 연결되면 넣는다', async () => {
    const data = emitter<PtyDataEvent>()
    queueLaunch(P1, 'claude')
    try {
      const t = setupRemote({ onPtyData: data.on })
      await opened()
      t.emitLink({ id: 'pty-1', ...link({ phase: 'waiting', attempt: 1, seq: 1 }) })
      act(() => data.emit({ id: 'pty-1', data: 'output while reconnecting\r\n' }))
      await act(async () => {
        await new Promise((r) => setTimeout(r, LAUNCH_DELAY_MS + 100))
      })
      expect(t.tauri.ptyWrite).not.toHaveBeenCalledWith('pty-1', 'claude\r')

      t.emitLink({ id: 'pty-1', ...link({ phase: 'connected', attempt: 0, seq: 2, at: '14:02' }) })
      act(() => data.emit({ id: 'pty-1', data: '$ ' }))
      await vi.waitFor(() => expect(t.tauri.ptyWrite).toHaveBeenCalledWith('pty-1', 'claude\r'))
    } finally {
      takeLaunch(P1)
    }
  })

  // AC-09 — 끝난 직후 붙은 화면도 종료를 놓치지 않는다(종료 알림 구독을 ptyFind 전으로)
  it('붙는 중(ptyFind 를 기다리는 동안)에 온 종료 알림도 id 가 정해지면 반영한다', async () => {
    const exits = emitter<string>()
    const find = deferred<PtyFound | null>()
    setupRemote({ onPtyExit: exits.on, ptyFind: () => find.promise })
    await flush()
    act(() => exits.emit('pty-9'))
    await act(async () => {
      find.resolve({ id: 'pty-9', scrollback: '', offset: 0, cols: 80, rows: 24, link: LIVE, tmux: null })
      await flush()
    })
    expect(await screen.findByText(ENDED)).toBeInTheDocument()
  })

  // D-26 · AC-05 — 첫 패널을 닫은 뒤 남은 분할 패널(::2)은 기본 세션으로 옮겨 붙지 않고 자기 -p2 세션에 붙는다
  it('패널 역할은 first 를 따른다 — 첫 패널을 닫은 뒤 남은 ::2 패널을 다시 열면 -p2 세션을 쓴다', async () => {
    useUiStore.setState({ panes: { [R.issueId]: { tree: { kind: 'leaf', id: P2 }, focused: null, seq: 2, first: P1 } } })
    const t = setupRemote()
    await vi.waitFor(() => expect(t.tauri.ptySpawn).toHaveBeenCalledTimes(1))
    const remote = t.tauri.ptySpawn.mock.calls[0][0].remote
    expect(remote).toMatchObject({ host: 'my-server', ephemeral: true })
    expect(remote?.session).toMatch(/^minmo-[0-9a-f]{10}-p2$/)
  })
})
