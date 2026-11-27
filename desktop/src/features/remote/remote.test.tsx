// 원격 접속 — 원격 화면의 연결 계층(호출·이벤트·끊김), 호스트로 돌리는 요청, 기기 등록, 함께 쓰는 상태, 호스트 쪽 실행 다리
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SHARED_CONFLICT, SHARED_PUSH_DELAY_MS, bindShared, merge3 } from '../../lib/sharedState'
import type { SharedChangedEvent } from '../../lib/tauri'
import { DEVICE_HEADER, PairError, RemoteConnection, SESSION_PLACEHOLDER, TOKEN_SENTINEL, createRemoteTauri, pairDevice, remoteFetch } from '../../lib/tauri.remote'
import { useHostsStore } from '../../store/hosts'
import { useReposStore } from '../../store/repos'
import { applySharedHosts, applySharedRepos, applySharedUi, bindSharedStores, pickSharedUi } from '../../store/shared'
import { useUiStore } from '../../store/ui'
import { createFakeTauri } from '../../test/fakes'
import { makeDeps, renderWithDeps } from '../../test/render'
import { leaf, leafIds, selectedTabId, splitPane, tabList } from '../terminal/panes'
import type { TabsNode, TermTab } from '../terminal/panes'
import { RemoteAccessSettings, shareableAddress } from './RemoteAccessSettings'
import { defaultDeviceName, pairErrorMessage, reloadAllowed } from './RemoteGate'
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

  it('놓친 출력 때문에 새로 고치는 것은 한동안 한 번만 한다(느린 연결에서 되풀이되지 않게)', () => {
    sessionStorage.clear()
    expect(reloadAllowed(100_000)).toBe(true)
    expect(reloadAllowed(110_000)).toBe(false)
    expect(reloadAllowed(140_000)).toBe(true)
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
    for (const m of ['keychainGet', 'serverSettingsSave', 'appClose', 'appUpdateInstall', 'remoteConfigure', 'remoteRpcReply', 'openUrl', 'openDir', 'pickFolder', 'notify', 'onNotifyClick', 'appShow', 'sshHostSave', 'onPtyData', 'runtime', 'nope', 'constructor']) {
      await expect(runRemoteCall(fake.tauri, m, ['minmo.session'])).rejects.toThrow('원격에서 쓸 수 없는')
    }
    expect(fake.tauri.keychainGet).not.toHaveBeenCalled()
    expect(fake.tauri.openUrl).not.toHaveBeenCalled()
  })
})

describe('merge3: 내가 바꾼 것만 호스트의 지금 값 위에 얹는다', () => {
  it('서로 다른 항목을 바꾼 두 화면의 변경이 모두 남는다(패널 구성은 이슈별로)', () => {
    const base = { panes: { a: { seq: 1 }, b: { seq: 1 } }, worktreePathMap: { a: '/a' } }
    const mine = { panes: { a: { seq: 2 }, b: { seq: 1 } }, worktreePathMap: { a: '/a' } }
    const theirs = { panes: { a: { seq: 1 }, b: { seq: 5 }, c: { seq: 1 } }, worktreePathMap: { a: '/a', c: '/c' } }
    expect(merge3(base, mine, theirs)).toEqual({ panes: { a: { seq: 2 }, b: { seq: 5 }, c: { seq: 1 } }, worktreePathMap: { a: '/a', c: '/c' } })
  })

  it('내가 지운 항목은 지워지고, 남이 지운 항목은 내가 건드리지 않았으면 지워진 채로 둔다', () => {
    const base = { local: { x: 1, y: 1, z: 1 } }
    expect(merge3(base, { local: { y: 1, z: 1 } }, { local: { x: 1, y: 1, z: 1, w: 1 } })).toEqual({ local: { y: 1, z: 1, w: 1 } })
    expect(merge3(base, { local: { x: 1, y: 1, z: 1 } }, { local: { x: 1 } })).toEqual({ local: { x: 1 } })
  })

  it('같은 항목을 둘 다 바꿨으면 이 화면의 값이 이긴다 · 내가 안 바꾼 것은 호스트의 값', () => {
    expect(merge3({ a: { k: 1 } }, { a: { k: 2 } }, { a: { k: 3 } })).toEqual({ a: { k: 2 } })
    expect(merge3({ a: { k: 1 } }, { a: { k: 1 } }, { a: { k: 3 } })).toEqual({ a: { k: 3 } })
  })

  it('글자 목록은 집합처럼 합친다(저장소 목록)', () => {
    expect(merge3({ added: ['a/x', 'a/y'] }, { added: ['a/y', 'a/mine'] }, { added: ['a/x', 'a/y', 'a/theirs'] })).toEqual({ added: ['a/y', 'a/theirs', 'a/mine'] })
  })
})

describe('함께 쓰는 상태(bindShared)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  /** 호스트의 공유 상태 저장소 흉내 — 판 번호가 다르면 거절한다 */
  function host(initial: Record<string, string> = {}) {
    const values = new Map(Object.entries(initial))
    const revs = new Map<string, number>()
    const listeners = new Set<(e: SharedChangedEvent) => void>()
    const sets: { key: string; value: string; origin: string }[] = []
    let conflicts = 0
    return {
      values,
      sets,
      conflicts: () => conflicts,
      /** 다른 화면이 저장한 것처럼 */
      emit: (key: string, value: string, origin = 'other') => {
        values.set(key, value)
        revs.set(key, (revs.get(key) ?? 0) + 1)
        for (const l of listeners) l({ key, origin })
      },
      /** 알림 없이 값만 바꾼다(알림이 닿기 전에 이 화면이 저장하는 상황) */
      silently: (key: string, value: string) => {
        values.set(key, value)
        revs.set(key, (revs.get(key) ?? 0) + 1)
      },
      api: {
        sharedGet: async (key: string) => ({ value: values.get(key) ?? null, rev: revs.get(key) ?? 0 }),
        sharedSet: async (key: string, value: string, origin: string, base: number) => {
          if (base !== (revs.get(key) ?? 0)) {
            conflicts++
            throw new Error(SHARED_CONFLICT)
          }
          values.set(key, value)
          revs.set(key, base + 1)
          sets.push({ key, value, origin })
          return base + 1
        },
        onSharedChanged: async (cb: (e: SharedChangedEvent) => void) => {
          listeners.add(cb)
          return () => listeners.delete(cb)
        },
      },
    }
  }
  function store<T>(initial: T) {
    let value = initial
    const subs = new Set<() => void>()
    return {
      get: () => value,
      set: (v: T) => {
        value = v
        subs.forEach((s) => s())
      },
      binding: { key: 'k', pick: () => value, apply: (v: T) => void (value = v), subscribe: (cb: () => void) => (subs.add(cb), () => subs.delete(cb)) },
    }
  }
  const settle = () => vi.advanceTimersByTimeAsync(SHARED_PUSH_DELAY_MS + 10)

  it('호스트에 값이 없으면(이 기능 전의 설치) 지금 값을 한 번 올린다', async () => {
    const h = host()
    const s = store({ n: 7 })
    bindShared(h.api, s.binding)
    await settle()
    expect(h.sets.map((x) => x.value)).toEqual(['{"n":7}'])
  })

  it('호스트에 값이 있으면 그것을 적용하고(이 화면의 저장소에 남은 옛 값으로 덮지 않는다), 되올리지 않는다', async () => {
    const h = host({ k: '{"n":3}' })
    const s = store({ n: 7 })
    bindShared(h.api, s.binding)
    await settle()
    expect(s.get()).toEqual({ n: 3 })
    expect(h.sets).toEqual([])
  })

  it('이 화면에서 바뀌면 모아서 한 번 올리고, 다른 화면이 바꾸면 내려받아 적용한다(되올리지 않는다)', async () => {
    const h = host({ k: '{"n":1}' })
    const s = store({ n: 0 })
    bindShared(h.api, s.binding)
    await settle()
    s.set({ n: 2 })
    s.set({ n: 3 })
    await settle()
    expect(h.sets.map((x) => x.value)).toEqual(['{"n":3}'])
    h.emit('k', '{"n":9}')
    await settle()
    expect(s.get()).toEqual({ n: 9 })
    expect(h.sets).toHaveLength(1)
  })

  it('그 사이 다른 화면이 먼저 저장했으면 덮어쓰지 않고, 다시 읽어 내 변경만 얹어 올린다', async () => {
    const h = host({ k: JSON.stringify({ panes: { a: 1 } }) })
    const s = store<{ panes: Record<string, number> }>({ panes: {} })
    bindShared(h.api, s.binding)
    await settle()
    // 다른 화면이 패널 b 를 더해 저장했는데(알림은 아직 안 옴), 이 화면은 패널 a 를 바꿔 저장하려 한다
    h.silently('k', JSON.stringify({ panes: { a: 1, b: 1 } }))
    s.set({ panes: { a: 2 } })
    await settle()
    expect(h.conflicts()).toBe(1)
    // 남의 변경(b)이 남고 내 변경(a=2)도 들어간다
    expect(JSON.parse(h.values.get('k')!)).toEqual({ panes: { a: 2, b: 1 } })
    expect(s.get()).toEqual({ panes: { a: 2, b: 1 } })
  })

  it('아직 올리지 않은 내 변경이 있을 때 다른 화면의 변경이 와도 내 변경을 잃지 않는다', async () => {
    const h = host({ k: JSON.stringify({ panes: { a: 1 } }) })
    const s = store<{ panes: Record<string, number> }>({ panes: {} })
    bindShared(h.api, s.binding)
    await settle()
    s.set({ panes: { a: 1, mine: 1 } })
    h.emit('k', JSON.stringify({ panes: { a: 1, theirs: 1 } }))
    await settle()
    expect(s.get()).toEqual({ panes: { a: 1, theirs: 1, mine: 1 } })
    expect(JSON.parse(h.values.get('k')!)).toEqual({ panes: { a: 1, theirs: 1, mine: 1 } })
  })

  it('깨진 값은 무시하고 이 화면의 값으로 덮는다 · 풀면 더 이상 올리지 않는다', async () => {
    const h = host({ k: 'not json' })
    const s = store({ n: 5 })
    const stop = bindShared(h.api, s.binding)
    await settle()
    expect(s.get()).toEqual({ n: 5 })
    expect(h.values.get('k')).toBe('{"n":5}')
    stop()
    s.set({ n: 6 })
    await settle()
    expect(h.values.get('k')).toBe('{"n":5}')
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

  it('저장소 별칭: 글자 값만 받고, 별칭이 없는 값(이 기능 전)은 이 화면의 별칭을 지우지 않는다', () => {
    useReposStore.setState({ nicknames: { 'a/b': 'mine' } })
    applySharedRepos({ added: [] })
    expect(useReposStore.getState().nicknames).toEqual({ 'a/b': 'mine' })
    applySharedRepos({ nicknames: { 'a/b': 'theirs', 'c/d': 3, 'e/f': '  ', 'G/H': '  gh ' } })
    // setNickname 과 같은 규칙: 소문자 키, 앞뒤 공백 없는 값
    expect(useReposStore.getState().nicknames).toEqual({ 'a/b': 'theirs', 'g/h': 'gh' })
    useReposStore.setState({ nicknames: {} })
  })

  it('그룹(#105): 모양이 맞는 그룹만 정리해 받고, 그룹이 없는 값(이 기능 전)은 이 화면의 그룹을 지우지 않는다', () => {
    useReposStore.setState({ groups: { g1: { name: 'mine', repos: ['a/b'] } } })
    applySharedRepos({ added: [] })
    expect(useReposStore.getState().groups).toEqual({ g1: { name: 'mine', repos: ['a/b'] } })
    applySharedRepos({ groups: { g1: { name: ' theirs ', repos: ['a/b', 'A/B', 3, 'bad'] }, g2: { name: '', repos: [] }, g3: 'x', g4: { name: 'n' } } })
    expect(useReposStore.getState().groups).toEqual({ g1: { name: 'theirs', repos: ['a/b'] } })
    useReposStore.setState({ groups: {} })
  })

  it('호스트별 기준 저장소 폴더·기본 폴더: 모양이 맞는 부분만 받고, 기기마다 다른 값(호스트 목록·tmux)은 건드리지 않는다', () => {
    useHostsStore.setState({ aliases: ['mine'], useTmux: true, baseRepos: { local: { 'a/b': '/old' } }, baseDirs: { local: '/old' } })
    applySharedHosts(null)
    applySharedHosts({ baseRepos: 'nope', baseDirs: [] })
    expect(useHostsStore.getState()).toMatchObject({ baseRepos: { local: { 'a/b': '/old' } }, baseDirs: { local: '/old' } })
    applySharedHosts({ baseRepos: { 'ssh:srv': { 'a/b': '/src/b' }, bad: { 'a/b': 3 }, worse: 'x' }, baseDirs: { 'ssh:srv': '/workspace', bad: 1 }, aliases: ['theirs'], useTmux: false })
    expect(useHostsStore.getState()).toMatchObject({ aliases: ['mine'], useTmux: true, baseRepos: { 'ssh:srv': { 'a/b': '/src/b' } }, baseDirs: { 'ssh:srv': '/workspace' } })
    useHostsStore.setState({ aliases: [], useTmux: false, baseRepos: {}, baseDirs: {} })
  })

  it('저장소별 연결 호스트: 호스트 id 형식(local · ssh:<별칭>)인 값만 받는다', () => {
    useHostsStore.setState({ repoHosts: { 'a/b': 'local' } })
    applySharedHosts({ repoHosts: 'nope' })
    expect(useHostsStore.getState().repoHosts).toEqual({ 'a/b': 'local' })
    applySharedHosts({ repoHosts: { 'a/b': 'ssh:srv', 'c/d': 'local', 'e/f': 'srv', 'g/h': 'ssh:', 'i/j': 3 } })
    expect(useHostsStore.getState().repoHosts).toEqual({ 'a/b': 'ssh:srv', 'c/d': 'local' })
    useHostsStore.setState({ repoHosts: {} })
  })

  it('기준 저장소 폴더: 화면마다 처음 한 번은 이 화면의 값을 호스트의 값에 합치고(옛 값 보존), 그 뒤로는 호스트의 값이 기준이다', async () => {
    localStorage.clear()
    const binding = (stored: string) => {
      const sharedSet = vi.fn(async () => 2)
      const { tauri } = createFakeTauri({ sharedGet: async () => ({ value: stored, rev: 1 }), sharedSet })
      return { stop: bindSharedStores(tauri), sharedSet }
    }
    // 함께 쓰기 전에 이 화면에서만 정해 둔 폴더(a/b)가 있고, 호스트에는 다른 화면이 올린 값(a/c)이 있다
    useHostsStore.setState({ baseRepos: { local: { 'a/b': '/mine' } }, baseDirs: {} })
    const first = binding(JSON.stringify({ baseRepos: { local: { 'a/c': '/theirs' } }, baseDirs: { local: '/ws' } }))
    await waitFor(() => expect(useHostsStore.getState().baseRepos).toEqual({ local: { 'a/c': '/theirs', 'a/b': '/mine' } }))
    expect(useHostsStore.getState().baseDirs).toEqual({ local: '/ws' })
    // 합친 값을 호스트에 올린다
    await waitFor(() => expect(first.sharedSet.mock.calls.some((c) => (c as unknown as string[])[0] === 'hosts')).toBe(true))
    first.stop()
    // 다음에 뜰 때는 합치지 않는다 — 다른 화면에서 해제한 폴더가 이 화면의 옛 값으로 되살아나지 않는다
    const second = binding(JSON.stringify({ baseRepos: { local: { 'a/c': '/theirs' } }, baseDirs: {} }))
    await waitFor(() => expect(useHostsStore.getState().baseRepos).toEqual({ local: { 'a/c': '/theirs' } }))
    second.stop()
    useHostsStore.setState({ baseRepos: {}, baseDirs: {} })
  })
})

// D-26(#89): 패널 역할(first)은 기기마다 다르면 안 된다 — 같은 패널이 기기마다 다른 tmux 세션에 붙지 않게 함께 맞춘다
describe('store 의 함께 쓰는 부분 — 패널 역할 first (#89 D-26)', () => {
  beforeEach(() => {
    useUiStore.setState({ panes: {} })
  })

  it('pickSharedUi 는 first 를 보내고, applySharedUi 는 받은 first(글자)를 그대로 쓴다', () => {
    useUiStore.setState({ panes: { 'a/b#1': { tree: leaf('a/b#1::2'), focused: null, seq: 2, first: 'a/b#1::1' } } })
    expect(pickSharedUi(useUiStore.getState()).panes['a/b#1']).toEqual({ tree: leaf('a/b#1::2'), seq: 2, first: 'a/b#1::1' })
    // 지금 잎이 아닌 패널이어도(첫 패널을 닫은 뒤) 거르지 않는다
    useUiStore.setState({ panes: {} })
    applySharedUi({ panes: { 'a/b#1': { tree: leaf('a/b#1::2'), seq: 2, first: 'a/b#1::1' } } })
    expect(useUiStore.getState().panes['a/b#1'].first).toBe('a/b#1::1')
  })

  it('받은 값에 first 가 없으면(이전 버전 화면) 이 기기의 값을 둔다', () => {
    useUiStore.setState({ panes: { 'a/b#1': { tree: leaf('a/b#1::2'), focused: null, seq: 2, first: 'a/b#1::1' } } })
    applySharedUi({ panes: { 'a/b#1': { tree: leaf('a/b#1::2'), seq: 3 } } })
    expect(useUiStore.getState().panes['a/b#1']).toMatchObject({ seq: 3, first: 'a/b#1::1' })
  })
})

// #120 터미널 탭: 탭 구조(트리)·tabSeq·이름(tabNames)은 원격 접속 기기와 공유하고, 고른 탭(tab)·포커스는 기기마다 둔다(D-19).
// 앱을 다시 켜면 호스트 공유 파일이 탭 목록·이름·분할을 되살린다(D-18′)
describe('store 의 함께 쓰는 부분 — 터미널 탭 (#120)', () => {
  const ETC = 'a/b#etc'
  const E = (n: number) => `${ETC}::${n}`
  const tabsOf = (...tabs: TermTab[]): TabsNode => ({ kind: 'tabs', tabs })
  const TWO = tabsOf({ id: 't0', no: 1, node: leaf(E(1)) }, { id: 't2', no: 2, node: splitPane(leaf(E(2)), E(2), 'row', E(3)) })

  beforeEach(() => {
    useUiStore.setState({ panes: {}, tabNames: {}, startedTerminals: {} })
  })

  it('AC-17 pickSharedUi: 트리·seq·first·tabSeq 와 빈 값이 아닌 이름을 보내고, 고른 탭·포커스는 보내지 않는다', () => {
    useUiStore.setState({
      panes: {
        [ETC]: { tree: TWO, focused: E(3), seq: 3, first: E(1), tab: 't2', tabSeq: 2 },
        'a/b#1': { tree: leaf('a/b#1::1'), focused: null, seq: 1 },
      },
      tabNames: { [ETC]: { t0: '빌드', t2: '' } },
    })
    const shared = pickSharedUi(useUiStore.getState())
    expect(shared.panes[ETC]).toEqual({ tree: TWO, seq: 3, first: E(1), tabSeq: 2 })
    // 일반 이슈는 지금 모양 그대로(tabSeq 키 없음)
    expect(shared.panes['a/b#1']).toEqual({ tree: leaf('a/b#1::1'), seq: 1 })
    expect(shared.tabNames).toEqual({ [ETC]: { t0: '빌드' } })
  })

  it('AC-17 applySharedUi: 받은 탭 목록·이름을 쓰고 고른 탭·포커스는 이 기기 값 · seq 는 큰 쪽 · 이름은 정리하고 고아 이름은 지운다', () => {
    useUiStore.setState({
      panes: { [ETC]: { tree: TWO, focused: E(2), seq: 5, first: E(1), tab: 't2', tabSeq: 2 } },
      tabNames: { [ETC]: { t2: '옛 이름' }, 'gone#etc': { t0: 'x' } },
    })
    const theirs = tabsOf(...TWO.tabs, { id: 't4', no: 3, node: leaf(E(4)) })
    applySharedUi({
      panes: { [ETC]: { tree: theirs, seq: 4, first: E(1), tabSeq: 3 } },
      tabNames: { [ETC]: { t0: '  빌드 ', t2: 5, t4: '  ', t9: '고아' }, 'gone#etc': { t0: 'y' } },
    })
    const ui = useUiStore.getState()
    expect(ui.panes[ETC]).toEqual({ tree: theirs, seq: 5, first: E(1), tabSeq: 3, tab: 't2', focused: E(2) })
    expect(ui.tabNames).toEqual({ [ETC]: { t0: '빌드' } })
  })

  it('AC-17 다른 기기가 이 기기의 고른 탭을 닫으면 고른 탭 값을 지운다(= 첫 탭)', () => {
    useUiStore.setState({ panes: { [ETC]: { tree: TWO, focused: E(2), seq: 3, first: E(1), tab: 't2', tabSeq: 2 } } })
    // 대조: 고른 탭이 아직 있으면 그대로 둔다
    applySharedUi({ panes: { [ETC]: { tree: TWO, seq: 3, first: E(1), tabSeq: 2 } } })
    expect(useUiStore.getState().panes[ETC]).toMatchObject({ tab: 't2', focused: E(2) })
    const theirs = tabsOf(TWO.tabs[0], { id: 't4', no: 3, node: leaf(E(4)) })
    applySharedUi({ panes: { [ETC]: { tree: theirs, seq: 4, first: E(1), tabSeq: 3 } } })
    const p = useUiStore.getState().panes[ETC]
    expect(p.tree).toEqual(theirs)
    expect(p).not.toHaveProperty('tab')
    expect(p.focused).toBeNull()
  })

  it('AC-15′ 다시 켠 뒤(이 기기 값 없음) 공유 파일의 탭 목록·순서·이름·분할이 되살아나고, 고른 탭은 첫 탭이다', () => {
    applySharedUi({ panes: { [ETC]: { tree: TWO, seq: 3, first: E(1), tabSeq: 2 } }, tabNames: { [ETC]: { t2: '서버' } } })
    const ui = useUiStore.getState()
    expect(ui.panes[ETC]).toEqual({ tree: TWO, seq: 3, first: E(1), tabSeq: 2, focused: null })
    expect(selectedTabId(ui.panes[ETC].tree, ui.panes[ETC].tab)).toBe('t0')
    expect(ui.tabNames).toEqual({ [ETC]: { t2: '서버' } })
  })

  it('AC-08 탭 1개(탭 없는 트리)를 분할한 값과 t0 이름을 받으면 이름이 남는다 — 탭 없는 트리에는 tab·tabSeq 를 두지 않는다', () => {
    const split = splitPane(leaf(E(1)), E(1), 'row', E(2))
    applySharedUi({ panes: { [ETC]: { tree: split, seq: 2, first: E(1) } }, tabNames: { [ETC]: { t0: '빌드', t2: '고아' } } })
    const ui = useUiStore.getState()
    expect(ui.panes[ETC]).toEqual({ tree: split, seq: 2, first: E(1), focused: null })
    expect(ui.tabNames).toEqual({ [ETC]: { t0: '빌드' } })
  })

  it('EC-09′ 받은 트리가 깨졌으면 그대로 두고(되올리지 않음) 읽을 때 "패널 없음"으로 본다 · 이전 버전의 트리(탭 없음)는 탭 "1" 하나', () => {
    const broken = { kind: 'weird' }
    applySharedUi({ panes: { [ETC]: { tree: broken, seq: 3 }, 'a/b#etc2': { tree: leaf('a/b#etc2::1'), seq: 1 } } })
    const ui = useUiStore.getState()
    expect(ui.panes[ETC].tree).toEqual(broken)
    expect(leafIds(ui.panes[ETC].tree)).toEqual([])
    expect(pickSharedUi(ui).panes[ETC].tree).toEqual(broken)
    expect(tabList(ui.panes['a/b#etc2'].tree)).toEqual([{ id: 't0', no: 1, node: leaf('a/b#etc2::1') }])
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
    renderWithDeps(<RemoteAccessSettings />, makeDeps({ tauri: fake.tauri }))
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
    const view = renderWithDeps(<RemoteAccessSettings />, makeDeps({ tauri: fake.tauri }))
    await screen.findByRole('checkbox', { name: '원격 접속 켜기' })
    view.unmount()
    expect(fake.tauri.remotePairCancel).toHaveBeenCalled()
  })
})
