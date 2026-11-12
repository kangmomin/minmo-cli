// 여러 PC — 다른 PC 의 현황 받기·알림, 그 PC 의 화면 주소, 주소 # 뒤 처리, 등록 화면, 통합 현황의 묶기
import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { IssueTarget } from '@minmo/core'

import type { Peer, Unlisten } from '../../lib/tauri'
import { RemoteConnection as RemoteConnectionClass } from '../../lib/tauri.remote'
import type { RemoteConnection, RemoteLink } from '../../lib/tauri.remote'
import { usePeersStore } from '../../store/peers'
import { useSetupStore } from '../../store/setup'
import { applySharedTargets } from '../../store/shared'
import { useUiStore } from '../../store/ui'
import { createFakeTauri } from '../../test/fakes'
import { makeDeps, renderHookWithDeps, renderWithDeps } from '../../test/render'
import { groupRows, rowKey } from '../agents/overview'
import type { AgentRow } from '../agents/overview'
import { consumeHash, parseHash, takePendingOpen } from './deepLink'
import { MAX_PEER_ROWS, NOTIFY_MAX, NOTIFY_WINDOW_MS, allowNotify, forPublish, newlyUrgent, parsePeerRows, usePeerAgents, usePeerAgentsStore } from './peerAgents'
import { RemoteAccessDialog } from './RemoteAccessDialog'

const PEER: Peer = { id: 'p1', name: '회사 PC', url: 'http://100.64.0.5:8790', token: 'tok' }
const TARGET: IssueTarget = { owner: 'acme', repo: 'app', key: '42', number: 42, title: 'Add login' }
const raw = (o: Record<string, unknown> = {}) => ({ paneId: 'acme/app#42::1', issueId: 'acme/app#42', host: null, hostLabel: '이 PC', repo: 'acme/app', issue: '#42 Add login', agent: 'claude', agentLabel: 'Claude Code', label: '', status: 'working', since: 1, lastOutputAt: 2, subagents: [], running: 0, target: TARGET, ...o })

beforeEach(() => {
  usePeersStore.setState({ peers: [] })
  usePeerAgentsStore.setState({ rows: {}, online: {} })
  useUiStore.setState({ agentNotify: true })
})

describe('parsePeerRows · newlyUrgent', () => {
  it('다른 PC 의 줄에는 그 PC 를 표시하고, 호스트 이름은 PC 이름(그 PC 의 SSH 호스트면 함께)으로 바꾼다', () => {
    const rows = parsePeerRows([raw(), raw({ paneId: 'x', host: 'srv' })], PEER)
    expect(rows[0]).toMatchObject({ hostLabel: '회사 PC', peer: { id: 'p1', name: '회사 PC' }, target: TARGET, status: 'working' })
    expect(rows[1].hostLabel).toBe('회사 PC · srv')
  })

  it('모양이 맞지 않는 줄은 버린다(다른 PC 가 보낸 값을 그대로 믿지 않는다)', () => {
    expect(parsePeerRows('nope', PEER)).toEqual([])
    expect(parsePeerRows([null, 3, { paneId: 1 }, raw({ status: 'exploded' }), raw({ agent: 'weird', since: 'x' })], PEER)).toMatchObject([{ agent: 'other', since: 0 }])
  })

  it('줄 수·글자 수를 제한하고 같은 패널이 두 번 오면 처음 것만 쓴다', () => {
    const many = Array.from({ length: MAX_PEER_ROWS + 50 }, (_, i) => raw({ paneId: `p${i}` }))
    expect(parsePeerRows(many, PEER)).toHaveLength(MAX_PEER_ROWS)
    const rows = parsePeerRows([raw({ label: 'x'.repeat(5000) }), raw({ status: 'done' })], PEER)
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('working')
    expect(rows[0].label.length).toBeLessThanOrEqual(200)
  })

  it('알림은 PC 마다 일정 시간에 정해진 횟수까지만(상태를 계속 뒤집어 알림을 쏟아내지 못한다)', () => {
    const times: number[] = []
    for (let i = 0; i < NOTIFY_MAX; i++) expect(allowNotify(times, 1000 + i)).toBe(true)
    expect(allowNotify(times, 2000)).toBe(false)
    // 시간이 지나면 다시 된다
    expect(allowNotify(times, 1000 + NOTIFY_WINDOW_MS)).toBe(true)
  })

  it('올리는 줄의 "마지막 출력 시각"은 10초 단위로 뭉친다(출력 중에 매초 다시 올리지 않는다)', () => {
    const row = parsePeerRows([raw({ lastOutputAt: 123_456 })], PEER)[0]
    expect(forPublish([row])[0].lastOutputAt).toBe(120_000)
    expect(JSON.stringify(forPublish([{ ...row, lastOutputAt: 125_999 }]))).toBe(JSON.stringify(forPublish([row])))
  })

  it('방금 끝났거나 입력을 기다리게 된 줄만 알림 대상이다 — 처음 보는 줄·그대로인 줄·기타 프로그램은 아니다', () => {
    const row = (paneId: string, status: string, agent = 'claude') => parsePeerRows([raw({ paneId, status, agent })], PEER)[0]
    const prev = [row('a', 'working'), row('b', 'done'), row('c', 'working'), row('d', 'working', 'other')]
    const next = [row('a', 'done'), row('b', 'done'), row('c', 'attention'), row('d', 'done', 'other'), row('new', 'done')]
    expect(newlyUrgent(prev, next).map((r) => r.paneId)).toEqual(['a', 'c'])
  })
})

describe('usePeerAgents: 등록한 PC 에 붙어 현황을 받는다', () => {
  /** RemoteConnection 대신 — 붙기·이벤트·끊김을 테스트에서 직접 일으킨다 */
  function fakeConn(snapshot: unknown) {
    const handlers = new Map<string, (p: unknown) => void>()
    let link: (l: RemoteLink) => void = () => {}
    const conn = {
      on: (event: string, cb: (p: unknown) => void): Unlisten => (handlers.set(event, cb), () => handlers.delete(event)),
      onLink: (cb: (l: RemoteLink) => void): Unlisten => ((link = cb), () => {}),
      connect: async () => {},
      call: vi.fn(async () => snapshot),
      close: vi.fn(),
    }
    return { conn: conn as unknown as RemoteConnection, emit: (e: string, p: unknown) => handlers.get(e)?.(p), setLink: (l: RemoteLink) => link(l), raw: conn }
  }

  it('붙으면 지금 현황을 받고(알리지 않는다), 그 뒤 끝난 에이전트를 PC 이름과 함께 알린다', async () => {
    const fake = createFakeTauri({ runtime: 'native', peersList: async () => [PEER] })
    const c = fakeConn([raw()])
    const connect = vi.fn(() => c.conn)
    renderHookWithDeps(() => usePeerAgents(fake.tauri, connect), makeDeps({ tauri: fake.tauri }))
    await waitFor(() => expect(usePeerAgentsStore.getState().rows.p1).toHaveLength(1))
    expect(connect).toHaveBeenCalledWith('http://100.64.0.5:8790', 'tok')
    expect(usePeerAgentsStore.getState().online.p1).toBe(true)
    expect(fake.tauri.notify).not.toHaveBeenCalled()

    act(() => c.emit('agents-changed', [raw({ status: 'done' })]))
    expect(usePeerAgentsStore.getState().rows.p1[0].status).toBe('done')
    expect(fake.tauri.notify).toHaveBeenCalledWith('회사 PC: Claude Code — 끝남', 'acme/app #42 Add login')
    // 알림을 꺼 두었으면 알리지 않는다
    useUiStore.setState({ agentNotify: false })
    act(() => c.emit('agents-changed', [raw({ status: 'working' })]))
    act(() => c.emit('agents-changed', [raw({ status: 'attention' })]))
    expect(fake.tauri.notify).toHaveBeenCalledTimes(1)
  })

  it('끊기면 그 PC 의 줄을 비우고 연결 안 됨으로 표시한다 · 토큰이 없는 PC 는 붙지 않는다', async () => {
    const fake = createFakeTauri({ runtime: 'native', peersList: async () => [PEER, { ...PEER, id: 'p2', token: null }] })
    const c = fakeConn([raw()])
    const connect = vi.fn(() => c.conn)
    renderHookWithDeps(() => usePeerAgents(fake.tauri, connect), makeDeps({ tauri: fake.tauri }))
    await waitFor(() => expect(usePeerAgentsStore.getState().rows.p1).toHaveLength(1))
    expect(connect).toHaveBeenCalledTimes(1)
    act(() => c.setLink('closed'))
    expect(usePeerAgentsStore.getState()).toMatchObject({ online: { p1: false }, rows: { p1: [] } })
  })

  it('화면이 다시 그려져도 연결을 새로 만들지 않는다(다시 그릴 때마다 끊고 붙으면 한 번도 붙지 못한다)', async () => {
    const connect = vi.spyOn(RemoteConnectionClass.prototype, 'connect').mockImplementation(() => new Promise(() => {}))
    const fake = createFakeTauri({ runtime: 'native', peersList: async () => [PEER] })
    // 연결 방법을 넘기지 않는다 — 기본 연결을 쓴다
    const r = renderHookWithDeps(() => usePeerAgents(fake.tauri), makeDeps({ tauri: fake.tauri }))
    await waitFor(() => expect(connect).toHaveBeenCalledTimes(1))
    r.rerender()
    r.rerender()
    await Promise.resolve()
    expect(connect).toHaveBeenCalledTimes(1)
    connect.mockRestore()
  })

  it('원격 화면(다른 기기의 브라우저)에서는 하지 않는다', async () => {
    const fake = createFakeTauri({ runtime: 'remote', peersList: async () => [PEER] })
    const connect = vi.fn()
    usePeersStore.setState({ peers: [PEER] })
    renderHookWithDeps(() => usePeerAgents(fake.tauri, connect), makeDeps({ tauri: fake.tauri }))
    await Promise.resolve()
    expect(connect).not.toHaveBeenCalled()
    expect(fake.tauri.peersList).not.toHaveBeenCalled()
  })
})

describe('그 PC 의 화면 열기(주소 # 뒤)', () => {
  it('# 뒤의 기기 토큰과 열 곳을 읽는다(호스트 앱이 src-tauri/src/remote.rs peer_url 로 만든 모양)', () => {
    const open = encodeURIComponent(JSON.stringify({ target: TARGET, paneId: 'acme/app#42::2' }))
    expect(parseHash(`#device=tok&open=${open}&n=7`)).toEqual({ device: 'tok', open: { target: TARGET, paneId: 'acme/app#42::2' } })
    expect(parseHash('#device=tok')).toEqual({ device: 'tok', open: null })
  })

  it('모양이 맞지 않는 "열 곳"은 무시한다', () => {
    expect(parseHash('#device=t&open=not-json')).toEqual({ device: 't', open: null })
    expect(parseHash('#open=' + encodeURIComponent(JSON.stringify({ target: { owner: 'a' } })))).toEqual({ device: null, open: null })
    expect(parseHash('')).toEqual({ device: null, open: null })
  })

  it('"열 곳"은 이 화면이 쓰는 토큰과 같은 토큰이 함께 온 경우에만 따른다(토큰을 모르는 쪽이 만든 링크는 따르지 않는다)', () => {
    const open = encodeURIComponent(JSON.stringify({ target: TARGET, paneId: null }))
    const win = (hash: string) => ({ location: { hash, pathname: '/', search: '' }, history: { replaceState: vi.fn() }, dispatchEvent: vi.fn() }) as unknown as Window
    // 토큰 없이 온 "열 곳" — 기억조차 하지 않는다
    consumeHash(win(`#open=${open}`))
    expect(takePendingOpen('real-token')).toBeNull()
    // 다른(틀린) 토큰과 함께 온 "열 곳"
    consumeHash(win(`#device=guess&open=${open}`))
    expect(takePendingOpen('real-token')).toBeNull()
    // 이 화면이 쓰는 토큰과 함께 온 것만 따른다 — 한 번만
    consumeHash(win(`#device=real-token&open=${open}`))
    expect(takePendingOpen('real-token')).toEqual({ target: TARGET, paneId: null })
    expect(takePendingOpen('real-token')).toBeNull()
    // 아직 등록되지 않은 화면(토큰 없음)은 따르지 않는다
    consumeHash(win(`#device=real-token&open=${open}`))
    expect(takePendingOpen(null)).toBeNull()
  })

  it('읽은 뒤 주소에서 지운다(토큰이 주소창·기록에 남지 않게)', () => {
    const replaceState = vi.fn()
    const win = { location: { hash: '#device=tok', pathname: '/', search: '' }, history: { replaceState }, dispatchEvent: vi.fn() } as unknown as Window
    expect(consumeHash(win)).toBe('tok')
    expect(replaceState).toHaveBeenCalledWith(null, '', '/')
    expect(consumeHash({ ...win, location: { hash: '', pathname: '/', search: '' } } as unknown as Window)).toBeNull()
  })
})

describe('함께 쓰는 이슈 정보', () => {
  it('같은 이슈는 받은 값으로 덮어쓴다 — 이 화면의 값을 남기면 두 화면이 서로 되올리며 끝없이 오간다', () => {
    useSetupStore.setState({ targets: { 'acme/app#42': { ...TARGET, title: '옛 제목' }, 'acme/app#7': { ...TARGET, key: '7', number: 7, title: '나만 아는 이슈' } } })
    applySharedTargets({ 'acme/app#42': TARGET, 'acme/app#9': { ...TARGET, key: '9', number: 9, title: '남이 연 이슈' }, bad: { owner: 1 } })
    const t = useSetupStore.getState().targets
    expect(t['acme/app#42'].title).toBe('Add login')
    expect(t['acme/app#9'].title).toBe('남이 연 이슈')
    expect(t['acme/app#7'].title).toBe('나만 아는 이슈')
    expect(t.bad).toBeUndefined()
    // 같은 값을 다시 받으면 store 를 건드리지 않는다(되올림이 생기지 않는다)
    const before = useSetupStore.getState().targets
    applySharedTargets({ 'acme/app#42': TARGET })
    expect(useSetupStore.getState().targets).toBe(before)
  })
})

describe('통합 현황: PC 로 묶기', () => {
  it('이 PC 가 먼저, 다른 PC 는 PC 별로 묶이고 같은 패널 id 라도 줄이 섞이지 않는다', () => {
    const mine = { ...parsePeerRows([raw()], PEER)[0], peer: undefined, hostLabel: '이 PC' } as AgentRow
    const theirs = parsePeerRows([raw()], PEER)[0]
    const other = parsePeerRows([raw()], { id: 'p2', name: '집 PC' })[0]
    const groups = groupRows([theirs, mine, other], 'host')
    expect(groups.map((g) => g.title)).toEqual(['이 PC', '집 PC', '회사 PC'])
    expect(new Set([mine, theirs, other].map(rowKey)).size).toBe(3)
  })
})

describe('다른 PC 등록 화면', () => {
  it('주소·코드로 등록하면 목록에 나오고, 삭제할 수 있다 · 실패 사유를 보여 준다', async () => {
    let peers: Peer[] = []
    const fake = createFakeTauri({
      peersList: async () => peers,
      peerAdd: async (input) => {
        if (input.code !== '482913') throw new Error('코드가 맞지 않습니다(남은 시도 4번)')
        peers = [{ id: 'p1', name: input.name, url: input.url, token: 't' }]
        return peers
      },
      peerRemove: async () => (peers = []),
    })
    renderWithDeps(<RemoteAccessDialog open onOpenChange={() => {}} />, makeDeps({ tauri: fake.tauri }))
    const user = userEvent.setup()
    const submit = await screen.findByRole('button', { name: 'PC 등록' })
    expect(submit).toBeDisabled()
    await user.type(screen.getByLabelText('그 PC 의 주소'), 'http://100.64.0.5:8790')
    await user.type(screen.getByLabelText('등록 코드'), '111111')
    await user.type(screen.getByLabelText('이름(선택)'), '회사 PC')
    await user.click(submit)
    expect(await screen.findByText('코드가 맞지 않습니다(남은 시도 4번)')).toBeInTheDocument()
    await user.clear(screen.getByLabelText('등록 코드'))
    await user.type(screen.getByLabelText('등록 코드'), '482 913')
    await user.click(submit)
    const item = await screen.findByTestId('peer')
    expect(item).toHaveTextContent('회사 PC')
    expect(item).toHaveTextContent('연결 안 됨')
    expect(fake.tauri.peerAdd).toHaveBeenLastCalledWith({ url: 'http://100.64.0.5:8790', code: '482913', name: '회사 PC' })
    expect(usePeersStore.getState().peers).toHaveLength(1)
    // 등록한 뒤 입력란을 비운다
    expect(screen.getByLabelText('그 PC 의 주소')).toHaveValue('')
    await user.click(screen.getByRole('button', { name: /삭제/ }))
    await waitFor(() => expect(screen.queryByTestId('peer')).toBeNull())
  })
})
