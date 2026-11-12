// 원격 접속 — 원격 화면의 연결 계층(호출·이벤트·끊김), 호스트로 돌리는 요청, 기기 등록, 함께 쓰는 상태, 호스트 쪽 실행 다리
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SHARED_PUSH_DELAY_MS, bindShared } from '../../lib/sharedState'
import type { SharedChangedEvent } from '../../lib/tauri'
import { DEVICE_HEADER, PairError, RemoteConnection, SESSION_PLACEHOLDER, TOKEN_SENTINEL, createRemoteTauri, pairDevice, remoteFetch } from '../../lib/tauri.remote'
import { useReposStore } from '../../store/repos'
import { applySharedRepos, applySharedUi, pickSharedUi } from '../../store/shared'
import { useUiStore } from '../../store/ui'
import { createFakeTauri } from '../../test/fakes'
import { makeDeps, renderWithDeps } from '../../test/render'
import { leaf } from '../terminal/panes'
import { RemoteAccessDialog, shareableAddress } from './RemoteAccessDialog'
import { defaultDeviceName, pairErrorMessage } from './RemoteGate'
import { runRemoteCall } from './useRemoteHost'

/** 브라우저 WebSocket 대신 쓰는 가짜 — 보낸 것을 기록하고, 서버가 보낸 것처럼 넣을 수 있다 */
class FakeSocket {
  sent: Record<string, unknown>[] = []
  closed = false
  onopen: (() => void) | null = null
  onmessage: ((e: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>)
  }
  close() {
    this.closed = true
    this.onclose?.()
  }
  open() {
    this.onopen?.()
  }
  receive(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) })
  }
}

async function connected() {
  const ws = new FakeSocket()
  const conn = new RemoteConnection('ws://host/ws', 'tok', () => ws)
  const done = conn.connect()
  ws.open()
  ws.receive({ auth: true })
  await done
  return { ws, conn }
}

describe('RemoteConnection: 호스트와의 연결', () => {
  it('붙으면 먼저 기기 토큰을 보내고, 확인되면 열린다', async () => {
    const { ws, conn } = await connected()
    expect(ws.sent[0]).toEqual({ auth: 'tok' })
    expect(conn.link).toBe('open')
  })

  it('토큰이 거절되면 rejected 로 끝난다(다시 등록해야 한다)', async () => {
    const ws = new FakeSocket()
    const conn = new RemoteConnection('ws://host/ws', 'bad', () => ws)
    const links: string[] = []
    conn.onLink((l) => links.push(l))
    const done = conn.connect()
    ws.open()
    ws.receive({ auth: false })
    await expect(done).rejects.toThrow('rejected')
    expect(conn.link).toBe('rejected')
    expect(links).toEqual(['connecting', 'rejected'])
    expect(ws.closed).toBe(true)
  })

  it('호출은 id 로 짝지어 답을 돌려주고, 실패는 그 사유로 reject 한다', async () => {
    const { ws, conn } = await connected()
    const a = conn.call<string>('homeDir', [])
    const b = conn.call('gitRun', [['status'], { cwd: '/w' }])
    expect(ws.sent.slice(1)).toEqual([
      { id: 1, method: 'homeDir', args: [] },
      { id: 2, method: 'gitRun', args: [['status'], { cwd: '/w' }] },
    ])
    ws.receive({ id: 2, ok: false, error: '원격에서 쓸 수 없는 기능입니다: gitRun' })
    ws.receive({ id: 1, ok: true, value: '/home/u' })
    await expect(a).resolves.toBe('/home/u')
    await expect(b).rejects.toThrow('원격에서 쓸 수 없는')
  })

  it('이벤트는 구독한 쪽에만 전달하고, 해제하면 더 받지 않는다', async () => {
    const { ws, conn } = await connected()
    const got: unknown[] = []
    const off = conn.on('pty-data', (p) => got.push(p))
    ws.receive({ event: 'pty-data', payload: { id: 'pty-1', data: 'hi' } })
    ws.receive({ event: 'script-log', payload: 'x' })
    off()
    ws.receive({ event: 'pty-data', payload: { id: 'pty-1', data: 'again' } })
    expect(got).toEqual([{ id: 'pty-1', data: 'hi' }])
  })

  it('끊기면 기다리던 호출은 모두 실패하고, 그 뒤의 호출도 바로 실패한다', async () => {
    const { ws, conn } = await connected()
    const pending = conn.call('ptyWrite', ['pty-1', 'x'])
    ws.close()
    await expect(pending).rejects.toThrow('끊겼습니다')
    expect(conn.link).toBe('closed')
    await expect(conn.call('homeDir', [])).rejects.toThrow('연결되어 있지 않습니다')
  })
})

describe('createRemoteTauri: 원격 화면의 TauriApi', () => {
  it('적어 두지 않은 호출은 이름과 인자를 그대로 호스트에 보낸다', async () => {
    const { ws, conn } = await connected()
    const tauri = createRemoteTauri(conn)
    expect(tauri.runtime).toBe('remote')
    void tauri.ptyWrite('pty-1', 'ls\r')
    void tauri.ptySpawn({ cwd: '/w', cols: 80, rows: 24, key: 'a#1::1' })
    expect(ws.sent.slice(1)).toEqual([
      { id: 1, method: 'ptyWrite', args: ['pty-1', 'ls\r'] },
      { id: 2, method: 'ptySpawn', args: [{ cwd: '/w', cols: 80, rows: 24, key: 'a#1::1' }] },
    ])
  })

  it('세션·GitHub 토큰은 자리 표시만 돌려주고(실제 값은 호스트에만 있다), 저장 요청은 아무것도 하지 않는다', async () => {
    const { ws, conn } = await connected()
    const tauri = createRemoteTauri(conn)
    await expect(tauri.keychainGet('minmo.session')).resolves.toBe(SESSION_PLACEHOLDER)
    await expect(tauri.keychainGet('minmo.github-token')).resolves.toBe(TOKEN_SENTINEL)
    await tauri.keychainSet('minmo.session', 'x')
    await tauri.keychainDelete('minmo.session')
    expect(ws.sent).toHaveLength(1)
  })

  it('터미널 출력 등은 연결로 받고, 호스트 화면에서만 일어나는 일(창 닫기·업데이트)은 구독해도 오지 않는다', async () => {
    const { ws, conn } = await connected()
    const tauri = createRemoteTauri(conn)
    const data: unknown[] = []
    const exits: string[] = []
    await tauri.onPtyData((e) => data.push(e))
    await tauri.onPtyExit((id) => exits.push(id))
    const off = await tauri.onCloseRequested(() => data.push('close'))
    ws.receive({ event: 'pty-data', payload: { id: 'pty-1', data: 'x' } })
    ws.receive({ event: 'pty-exit', payload: 'pty-1' })
    ws.receive({ event: 'close-requested', payload: null })
    off()
    expect(data).toEqual([{ id: 'pty-1', data: 'x' }])
    expect(exits).toEqual(['pty-1'])
  })

  it('호스트 PC 에서만 할 수 있는 일은 보내지 않고 바로 거절한다', async () => {
    const { ws, conn } = await connected()
    const tauri = createRemoteTauri(conn)
    await expect(tauri.remotePairStart()).rejects.toThrow('호스트 PC')
    await expect(tauri.serverSettingsSave({ port: 1 })).rejects.toThrow('호스트 PC')
    await expect(tauri.appUpdateInstall()).rejects.toThrow('호스트 PC')
    await expect(tauri.appUpdateCheck()).resolves.toBeNull()
    await expect(tauri.pickFolder()).resolves.toBeNull()
    await expect(tauri.serverStatus()).resolves.toMatchObject({ state: 'external' })
    expect(ws.sent).toHaveLength(1)
  })

  it('Promise 로 오해받지 않는다(then 이 없다)', async () => {
    const { conn } = await connected()
    expect((createRemoteTauri(conn) as unknown as { then?: unknown }).then).toBeUndefined()
  })
})

describe('remoteFetch · pairDevice', () => {
  const ORIGIN = 'http://100.64.0.1:8790'

  it('/api 와 GitHub API 요청은 호스트로 돌리고 기기 토큰을 붙인다. 그 밖의 요청은 그대로 둔다', async () => {
    const base = vi.fn(async () => new Response('{}'))
    const f = remoteFetch(ORIGIN, () => 'dev-token', base as unknown as typeof fetch)
    await f(`${ORIGIN}/api/me`, { headers: { authorization: 'Bearer host-session' } })
    await f('https://api.github.com/user/orgs?per_page=100')
    await f('https://example.com/x')
    const calls = base.mock.calls as unknown as [string, RequestInit | undefined][]
    expect(calls[0][0]).toBe(`${ORIGIN}/api/me`)
    expect(new Headers(calls[0][1]?.headers).get(DEVICE_HEADER)).toBe('dev-token')
    expect(new Headers(calls[0][1]?.headers).get('authorization')).toBe('Bearer host-session')
    expect(calls[1][0]).toBe(`${ORIGIN}/gh/user/orgs?per_page=100`)
    expect(new Headers(calls[1][1]?.headers).get(DEVICE_HEADER)).toBe('dev-token')
    // 다른 사이트로 가는 요청에는 기기 토큰을 붙이지 않는다
    expect(calls[2]).toEqual(['https://example.com/x', undefined])
  })

  it('기기 등록: 성공하면 토큰, 실패는 사유별로 구분한다', async () => {
    const reply = (status: number, body: string) => (async () => new Response(body, { status })) as unknown as typeof fetch
    await expect(pairDevice(ORIGIN, '123456', '폰', reply(200, '{"token":"t","deviceId":"d"}'))).resolves.toBe('t')
    await expect(pairDevice(ORIGIN, '1', '폰', reply(403, 'pair_not_open'))).rejects.toMatchObject({ code: 'pair_not_open' })
    await expect(pairDevice(ORIGIN, '1', '폰', reply(403, '{"error":"pair_wrong_code","left":3}'))).rejects.toMatchObject({ code: 'pair_wrong_code', left: 3 })
    await expect(pairDevice(ORIGIN, '1', '폰', reply(404, 'not_enabled'))).rejects.toMatchObject({ code: 'not_enabled' })
    await expect(pairDevice(ORIGIN, '1', '폰', reply(500, 'boom'))).rejects.toMatchObject({ code: 'failed' })
  })

  it('안내 문구와 기기 이름 기본값', () => {
    expect(pairErrorMessage(new PairError('pair_wrong_code', 2))).toContain('남은 시도 2번')
    expect(pairErrorMessage(new PairError('pair_wrong_code', 0))).toContain('무효')
    expect(pairErrorMessage(new PairError('pair_not_open'))).toContain('새 코드')
    expect(pairErrorMessage(new Error('x'))).toBe('호스트에 연결할 수 없습니다')
    expect(defaultDeviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1')).toBe('iPhone · Safari')
    expect(defaultDeviceName('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36 Edg/130.0')).toBe('Windows PC · Edge')
    expect(defaultDeviceName('curl/8')).toBe('기기')
  })
})

describe('runRemoteCall: 붙은 기기의 호출을 이 PC 의 화면이 대신 실행', () => {
  it('허용한 호출은 그대로 실행하고, 생략한 인자(null)는 undefined 로 되돌린다', async () => {
    const fake = createFakeTauri({ sshProbe: async () => ({ platform: 'linux', home: '/h', git: 'git', tmux: true }) })
    await expect(runRemoteCall(fake.tauri, 'homeDir', [])).resolves.toBe('/home/u')
    await runRemoteCall(fake.tauri, 'sshProbe', ['srv', null])
    expect(fake.tauri.sshProbe).toHaveBeenCalledWith('srv', undefined)
  })

  it('이 PC 전용 호출과 없는 이름은 실행하지 않는다', async () => {
    const fake = createFakeTauri()
    for (const m of ['keychainGet', 'serverSettingsSave', 'appClose', 'appUpdateInstall', 'remoteConfigure', 'remoteRpcReply', 'openUrl', 'openDir', 'pickFolder', 'notify', 'sshHostSave', 'onPtyData', 'runtime', 'nope', 'constructor']) {
      await expect(runRemoteCall(fake.tauri, m, ['minmo.session'])).rejects.toThrow('원격에서 쓸 수 없는')
    }
    expect(fake.tauri.keychainGet).not.toHaveBeenCalled()
    expect(fake.tauri.openUrl).not.toHaveBeenCalled()
  })
})

describe('함께 쓰는 상태(bindShared)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  /** 호스트의 공유 상태 저장소 흉내 */
  function host(initial: Record<string, string> = {}) {
    const values = new Map(Object.entries(initial))
    const listeners = new Set<(e: SharedChangedEvent) => void>()
    const sets: { key: string; value: string; origin: string }[] = []
    return {
      values,
      sets,
      emit: (key: string, value: string, origin = 'other') => {
        values.set(key, value)
        for (const l of listeners) l({ key, origin })
      },
      api: {
        sharedGet: async (key: string) => values.get(key) ?? null,
        sharedSet: async (key: string, value: string, origin: string) => {
          values.set(key, value)
          sets.push({ key, value, origin })
        },
        onSharedChanged: async (cb: (e: SharedChangedEvent) => void) => {
          listeners.add(cb)
          return () => listeners.delete(cb)
        },
      },
    }
  }
  function store(initial: number) {
    let value = initial
    const subs = new Set<() => void>()
    return {
      get: () => value,
      set: (v: number) => {
        value = v
        subs.forEach((s) => s())
      },
      binding: { key: 'k', pick: () => ({ n: value }), apply: (v: { n: number }) => void (value = v.n), subscribe: (cb: () => void) => (subs.add(cb), () => subs.delete(cb)) },
    }
  }
  const settle = () => vi.advanceTimersByTimeAsync(SHARED_PUSH_DELAY_MS + 10)

  it('호스트에 값이 없으면(이 기능 전의 설치) 지금 값을 한 번 올린다', async () => {
    const h = host()
    const s = store(7)
    bindShared(h.api, s.binding)
    await settle()
    expect(h.sets.map((x) => x.value)).toEqual(['{"n":7}'])
  })

  it('호스트에 값이 있으면 그것을 적용하고, 되올리지 않는다', async () => {
    const h = host({ k: '{"n":3}' })
    const s = store(7)
    bindShared(h.api, s.binding)
    await settle()
    expect(s.get()).toBe(3)
    expect(h.sets).toEqual([])
  })

  it('이 화면에서 바뀌면 모아서 한 번 올리고, 다른 화면이 바꾸면 내려받아 적용한다(되올리지 않는다)', async () => {
    const h = host({ k: '{"n":1}' })
    const s = store(0)
    bindShared(h.api, s.binding)
    await settle()
    s.set(2)
    s.set(3)
    await settle()
    expect(h.sets.map((x) => x.value)).toEqual(['{"n":3}'])
    h.emit('k', '{"n":9}')
    await settle()
    expect(s.get()).toBe(9)
    expect(h.sets).toHaveLength(1)
    // 내가 올린 값의 알림(같은 origin)은 다시 읽지 않는다
    h.emit('k', '{"n":100}', h.sets[0].origin)
    await settle()
    expect(s.get()).toBe(9)
  })

  it('깨진 값은 무시하고, 풀면 더 이상 올리지 않는다', async () => {
    const h = host({ k: 'not json' })
    const s = store(5)
    const stop = bindShared(h.api, s.binding)
    await settle()
    expect(s.get()).toBe(5)
    stop()
    s.set(6)
    await settle()
    expect(h.sets).toEqual([])
  })
})

describe('store 의 함께 쓰는 부분', () => {
  beforeEach(() => {
    localStorage.clear()
    useUiStore.setState({ panes: {}, worktreePathMap: {} })
    useReposStore.setState({ added: [], local: {} })
  })

  it('패널 구성은 맞추되 포커스는 기기마다 둔다 — 아직 있는 패널이면 내 포커스를 유지한다', () => {
    useUiStore.setState({ panes: { 'a/b#1': { tree: leaf('a/b#1::1'), focused: 'a/b#1::1', seq: 1 } } })
    expect(pickSharedUi(useUiStore.getState()).panes['a/b#1']).toEqual({ tree: leaf('a/b#1::1'), seq: 1 })
    applySharedUi({ panes: { 'a/b#1': { tree: leaf('a/b#1::1'), seq: 3 }, 'a/b#2': { tree: leaf('a/b#2::1'), seq: 1 } } })
    const panes = useUiStore.getState().panes
    expect(panes['a/b#1']).toEqual({ tree: leaf('a/b#1::1'), seq: 3, focused: 'a/b#1::1' })
    expect(panes['a/b#2'].focused).toBeNull()
    // 내가 포커스하던 패널을 다른 기기가 닫았으면 포커스를 비운다
    applySharedUi({ panes: { 'a/b#1': { tree: leaf('a/b#1::2'), seq: 4 } } })
    expect(useUiStore.getState().panes['a/b#1'].focused).toBeNull()
  })

  it('모양이 맞지 않는 값은 적용하지 않는다', () => {
    useUiStore.setState({ worktreePathMap: { x: { path: '/p', branch: 'b' } } })
    applySharedUi(null)
    applySharedUi({ worktreePathMap: 'nope', panes: [], agentCommands: { claude: 42, codex: 'codex -x {prompt}' } })
    const ui = useUiStore.getState()
    expect(ui.worktreePathMap).toEqual({ x: { path: '/p', branch: 'b' } })
    expect(ui.agentCommands.codex).toBe('codex -x {prompt}')
    expect(ui.agentCommands.claude).toBe('claude {prompt}')
    applySharedRepos({ added: ['a/b', 3], local: 'x' })
    expect(useReposStore.getState().added).toEqual(['a/b'])
    expect(useReposStore.getState().local).toEqual({})
  })
})

describe('RemoteAccessDialog (호스트의 원격 접속 설정)', () => {
  it('다른 기기에서 열 주소는 Tailscale 을 먼저, 없으면 LAN — 이 PC 전용 주소는 쓰지 않는다', () => {
    const local = { kind: 'local' as const, url: 'http://127.0.0.1:8790' }
    const lan = { kind: 'lan' as const, url: 'http://192.168.0.5:8790' }
    const ts = { kind: 'tailscale' as const, url: 'http://100.64.0.1:8790' }
    expect(shareableAddress([local, lan, ts])).toBe(ts)
    expect(shareableAddress([local, lan])).toBe(lan)
    expect(shareableAddress([local])).toBeNull()
  })

  it('켜면 주소가 보이고, [기기 등록] 은 1회용 코드를 띄우며, 등록된 기기를 끊을 수 있다', async () => {
    const off = { enabled: false, lan: false, port: 8790, addresses: [], devices: [{ id: 'd1', name: '내 휴대폰', createdMs: 1, lastSeenMs: 1, connected: true }], error: null }
    const on = { ...off, enabled: true, addresses: [{ kind: 'tailscale' as const, url: 'http://100.64.0.1:8790' }] }
    const fake = createFakeTauri({
      remoteStatus: async () => off,
      remoteConfigure: async () => on,
      remotePairStart: async () => ({ code: '482913', expiresInSec: 120 }),
      remoteDeviceRemove: async () => ({ ...on, devices: [] }),
    })
    renderWithDeps(<RemoteAccessDialog open onOpenChange={() => {}} />, makeDeps({ tauri: fake.tauri }))
    const user = userEvent.setup()
    const toggle = await screen.findByRole('checkbox', { name: '원격 접속 켜기' })
    expect(toggle).not.toBeChecked()
    // 꺼져 있으면 주소·기기 등록은 없다
    expect(screen.queryByRole('button', { name: /기기 등록/ })).toBeNull()
    await user.click(toggle)
    expect(fake.tauri.remoteConfigure).toHaveBeenCalledWith({ enabled: true })
    expect(await screen.findByText('http://100.64.0.1:8790')).toBeInTheDocument()
    // LAN 은 암호화되지 않는다는 안내와 함께 따로 켠다
    expect(screen.getByText(/LAN 연결은 암호화되지 않습니다/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /기기 등록/ }))
    expect(await screen.findByTestId('pair-code')).toHaveTextContent('482913')
    expect(screen.getByRole('img', { name: /QR 코드: http:\/\/100\.64\.0\.1:8790/ })).toBeInTheDocument()
    expect(screen.getByText('접속 중')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /끊기/ }))
    expect(fake.tauri.remoteDeviceRemove).toHaveBeenCalledWith('d1')
    await waitFor(() => expect(screen.getByText('등록된 기기가 없습니다.')).toBeInTheDocument())
  })

  it('닫으면 쓰지 않은 등록 코드를 무효로 한다', async () => {
    const fake = createFakeTauri()
    const r = render(<div />)
    r.unmount()
    const view = renderWithDeps(<RemoteAccessDialog open onOpenChange={() => {}} />, makeDeps({ tauri: fake.tauri }))
    await screen.findByRole('checkbox', { name: '원격 접속 켜기' })
    view.unmount()
    expect(fake.tauri.remotePairCancel).toHaveBeenCalled()
  })
})
