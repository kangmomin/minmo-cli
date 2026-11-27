// 답변 모드(#122) 대기열 훅 — 진입·자동 이동·열기·취소·포커스·알림(Plan §6, U9a).
// openPaneTarget(열기·기다림·시간 제한)은 navigate.test.tsx 가 따로 본다 — 여기서는 그 결과에 훅이 어떻게 반응하는지만 본다.
import { QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DepsProvider } from '../../app/deps'
import { useAgentStore } from '../agents/agentStore'
import type { PaneAgent } from '../agents/agentStore'
import { openPaneTarget } from '../agents/navigate'
import type { OpenPaneOptions, OpenPaneResult } from '../agents/navigate'
import type { AgentRow } from '../agents/overview'
import { noteTerminalInput } from '../agents/useAgentTracker'
import { WorktreeProvider } from '../issue/useWorktree'
import { useSetupStore } from '../../store/setup'
import { useUiStore } from '../../store/ui'
import { makeDeps, makeQueryClient } from '../../test/render'
import { useAnswerQueue } from './useAnswerQueue'

vi.mock('../agents/navigate', async (importOriginal) => ({ ...(await importOriginal<typeof import('../agents/navigate')>()), openPaneTarget: vi.fn() }))
const openMock = vi.mocked(openPaneTarget)

const T0 = Date.parse('2026-11-27T09:00:00Z')
const ISSUE = { A: 'acme/app#1', B: 'acme/app#2', C: 'acme/app#3', D: 'acme/app#4' } as const
const A1 = `${ISSUE.A}::1`
const A2 = `${ISSUE.A}::2`
const B1 = `${ISSUE.B}::1`
const C1 = `${ISSUE.C}::1`
const D1 = `${ISSUE.D}::1`
const target = (n: number) => ({ owner: 'acme', repo: 'app', key: String(n), number: n, title: ['', '로그인', '문서', '배포', '원격'][n] })
const READY = { phase: 'ready' as const, path: '/w', branch: 'b', pathChanged: false }

const agent = (paneId: string, o: Partial<PaneAgent>): PaneAgent => ({
  paneId,
  issueId: paneId.slice(0, paneId.lastIndexOf('::')),
  agent: 'claude',
  program: 'claude',
  label: '',
  activity: 'idle',
  unseen: false,
  lastOutputAt: 0,
  since: 0,
  waitingSince: 0,
  ...o,
})
const done = (paneId: string, at: number) => agent(paneId, { activity: 'idle', unseen: true, since: at, waitingSince: at })
const attention = (paneId: string, at: number) => agent(paneId, { activity: 'attention', since: at, waitingSince: at })
const busy = (paneId: string, at: number) => agent(paneId, { activity: 'working', since: at, waitingSince: null })
const setAgents = (...ps: PaneAgent[]) => act(() => useAgentStore.setState({ panes: Object.fromEntries(ps.map((p) => [p.paneId, p])) }))
const putAgent = (p: PaneAgent) => act(() => useAgentStore.getState().set(p.paneId, p))

/** 이슈들의 열기 대상·패널(::1 하나)을 두고, ready 목록은 이 창에서 연 이슈 */
function world(o: { ready?: string[]; selected?: string | null; noPanes?: string[] } = {}) {
  const ids = Object.values(ISSUE)
  useSetupStore.setState({
    targets: Object.fromEntries(ids.map((id, i) => [id, target(i + 1)])),
    open: Object.fromEntries((o.ready ?? ids).map((id) => [id, READY])),
    script: {},
    logs: {},
  })
  useUiStore.setState({
    selectedIssueId: o.selected === undefined ? ISSUE.A : o.selected,
    tab: 'terminal',
    viewMode: 'answer',
    focusRequest: null,
    terminalIds: {},
    startedTerminals: {},
    panes: Object.fromEntries(ids.filter((id) => !(o.noPanes ?? []).includes(id)).map((id) => [id, { tree: { kind: 'leaf' as const, id: `${id}::1` }, focused: `${id}::1`, seq: 1 }])),
  })
}

function mount(enabled = true, narrowListOpen = false) {
  const deps = makeDeps()
  const client = makeQueryClient()
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <DepsProvider value={deps}>
        <WorktreeProvider>{children}</WorktreeProvider>
      </DepsProvider>
    </QueryClientProvider>
  )
  return renderHook((p: { enabled: boolean; narrowListOpen: boolean }) => useAnswerQueue(p.enabled, { narrowListOpen: p.narrowListOpen }), { wrapper, initialProps: { enabled, narrowListOpen } })
}

const tick = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms))
const selected = () => useUiStore.getState().selectedIssueId
const rowOf = (rows: AgentRow[], paneId: string) => rows.find((r) => r.paneId === paneId)!
/** 사용자가 지금 패널에 답을 입력하고(ms 뒤) 에이전트가 작업 중이 된다 */
async function answer(paneId: string) {
  act(() => noteTerminalInput(paneId))
  await tick(300)
  putAgent(busy(paneId, Date.now()))
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
  openMock.mockReset()
  useAgentStore.getState().clear()
  document.body.innerHTML = ''
})
afterEach(() => {
  vi.useRealTimers()
  useUiStore.setState({ viewMode: 'normal' })
})

describe('진입(AC-04 · EC-21)', () => {
  it('AC-04 켜는 순간 지금 패널이 작업 중이면 대기열 첫 세션으로 간다 — 포커스는 옮기지 않는다', async () => {
    world()
    setAgents(busy(A1, T0 - 1000), done(B1, T0 - 5000))
    mount()
    await tick(1000)
    expect(selected()).toBe(ISSUE.B)
    expect(useUiStore.getState().panes[ISSUE.B].focused).toBe(B1)
    expect(useUiStore.getState().focusRequest).toBeNull()
    expect(openMock).not.toHaveBeenCalled()
  })

  it.each(['0개', '지금 세션 1개', '3개'])('AC-04 켜는 순간 세션이 %s 일 때', async (kind) => {
    world()
    if (kind === '지금 세션 1개') setAgents(done(A1, T0 - 1000))
    if (kind === '3개') setAgents(busy(A1, T0 - 1000), done(B1, T0 - 5000), attention(C1, T0 - 2000))
    const r = mount()
    await tick(6000)
    if (kind === '3개') {
      // 입력 대기가 끝남보다 앞이다
      expect(selected()).toBe(ISSUE.C)
      return
    }
    expect(selected()).toBe(ISSUE.A)
    expect(r.result.current.session).toMatchObject({ issueId: ISSUE.A, paneId: A1 })
    expect(r.result.current.current?.paneId ?? null).toBe(kind === '0개' ? null : A1)
  })

  it('EC-21 고른 이슈가 없으면 기다리지 않고 대기열 첫 세션으로 간다', async () => {
    world({ selected: null })
    setAgents(done(B1, T0 - 5000))
    mount()
    await tick(1000)
    expect(selected()).toBe(ISSUE.B)
    expect(openMock).not.toHaveBeenCalled()
  })

  it('EC-21 고른 이슈의 열기 대상(target)을 모르면 열지 않고, 지금 패널의 줄을 5초 기다린 뒤 대기열 첫 세션으로 간다', async () => {
    world()
    useSetupStore.setState((s) => {
      const targets = { ...s.targets }
      delete targets[ISSUE.A]
      const open = { ...s.open }
      delete open[ISSUE.A]
      return { targets, open }
    })
    setAgents(done(B1, T0 - 5000))
    mount()
    await tick(2000)
    expect(selected()).toBe(ISSUE.A)
    await tick(5000)
    expect(selected()).toBe(ISSUE.B)
    expect(openMock).not.toHaveBeenCalled()
  })

  it('EC-21 이 창에서 열지 않은 이슈면 먼저 연다(30초, 포커스 없음) — 연 뒤 지금 패널의 줄이 늦게 와도 5초 안이면 그 세션에 머문다', async () => {
    world({ ready: [ISSUE.B, ISSUE.C] })
    setAgents(done(B1, T0 - 5000))
    openMock.mockImplementation(async () => {
      useSetupStore.getState().setOpen(ISSUE.A, READY)
      return 'ok'
    })
    mount()
    await tick(100)
    expect(openMock).toHaveBeenCalledTimes(1)
    const o = openMock.mock.calls[0][0]
    expect(o).toMatchObject({ target: target(1), paneId: A1, keyboard: false, alias: null })
    expect(o.deadline - Date.now()).toBeGreaterThan(29_000)
    expect(o.deadline - Date.now()).toBeLessThanOrEqual(30_000)
    await tick(2000)
    expect(selected()).toBe(ISSUE.A)
    putAgent(done(A1, Date.now()))
    await tick(8000)
    expect(selected()).toBe(ISSUE.A)
  })

  it('EC-21 지금 이슈를 열지 못하면 그 줄을 열 수 없음으로 두고 대기열 첫 세션으로 간다', async () => {
    world({ ready: [ISSUE.B] })
    setAgents(done(A1, T0 - 9000), done(B1, T0 - 5000))
    openMock.mockResolvedValue('failed')
    const r = mount()
    await tick(1000)
    expect(selected()).toBe(ISSUE.B)
    expect(r.result.current.blockedRows.map((x) => x.paneId)).toEqual([A1])
  })

  it('EC-22 진입 열기 중 사용자가 다른 이슈를 고르면 그 선택을 되돌리지 않는다', async () => {
    world({ ready: [ISSUE.B, ISSUE.C] })
    setAgents(done(C1, T0 - 5000))
    let finish!: (r: OpenPaneResult) => void
    openMock.mockImplementation(() => new Promise((res) => (finish = res)))
    mount()
    await tick(100)
    expect(openMock).toHaveBeenCalledTimes(1)
    const o = openMock.mock.calls[0][0]
    act(() => useUiStore.getState().selectIssue(ISSUE.B))
    expect(o.isStale()).toBe(true)
    await act(async () => finish('stale'))
    await tick(3000)
    expect(selected()).toBe(ISSUE.B)
  })

  it('AC-04 useAnswerQueue(false) 는 아무것도 하지 않는다 — 켜면 그때 진입한다', async () => {
    world()
    setAgents(busy(A1, T0 - 1000), done(B1, T0 - 5000))
    const r = mount(false)
    await tick(5000)
    expect(selected()).toBe(ISSUE.A)
    expect(openMock).not.toHaveBeenCalled()
    r.rerender({ enabled: true, narrowListOpen: false })
    await tick(1000)
    expect(selected()).toBe(ISSUE.B)
  })

  it('EC-24 진입 열기 중 [건너뛰기]는 진입 판단을 끝낸다 — 도착한 세션에 답하면 2초 뒤 다음 세션으로 간다', async () => {
    world({ ready: [ISSUE.B, ISSUE.C] })
    setAgents(done(A1, T0 - 9000), done(B1, T0 - 8000), done(C1, T0 - 7000))
    openMock.mockImplementation(() => new Promise(() => {}))
    const r = mount()
    await tick(100)
    expect(openMock).toHaveBeenCalledTimes(1)
    const entryOpen = openMock.mock.calls[0][0]
    act(() => r.result.current.skip())
    await tick(100)
    expect(entryOpen.isStale()).toBe(true)
    expect(selected()).toBe(ISSUE.B)
    await tick(6000)
    expect(selected()).toBe(ISSUE.B)
    await answer(B1)
    await tick(2500)
    expect(selected()).toBe(ISSUE.C)
  })
})

describe('자동 이동·건너뛰기(AC-05 · AC-07 · EC-04)', () => {
  it('AC-05 보인 기다리는 세션에 답해 작업 중이 되면 마지막 입력 2초 뒤 대기열 첫 세션으로 간다', async () => {
    world()
    setAgents(done(A1, T0 - 9000), done(B1, T0 - 5000))
    mount()
    await tick(1000)
    await answer(A1)
    await tick(1000)
    expect(selected()).toBe(ISSUE.A)
    await tick(1500)
    expect(selected()).toBe(ISSUE.B)
    expect(useUiStore.getState().focusRequest).toBeNull()
  })

  it('AC-07 [건너뛰기]: 기다리는 지금 세션을 뒤로 보내고 다음 기다리는 세션을 보인다 — 작업 중인 세션은 기록 없이 넘어가고, 다음이 없으면 아무것도 하지 않는다', async () => {
    world()
    setAgents(done(A1, T0 - 9000), done(B1, T0 - 5000), done(C1, T0 - 4000))
    const r = mount()
    await tick(1000)
    act(() => r.result.current.skip())
    await tick(100)
    expect(selected()).toBe(ISSUE.B)
    expect(r.result.current.waiting.map((x) => x.paneId)).toEqual([B1, C1, A1])
    // 작업 중인 세션에서: 건너뛴 기록 없이 첫 기다리는 세션으로
    putAgent(busy(B1, Date.now()))
    await tick(100)
    act(() => r.result.current.skip())
    await tick(100)
    expect(selected()).toBe(ISSUE.C)
    expect(r.result.current.waiting.map((x) => x.paneId)).toEqual([C1, A1])
    // 다음이 없으면
    setAgents(done(C1, T0 - 4000))
    await tick(100)
    act(() => r.result.current.skip())
    await tick(100)
    expect(selected()).toBe(ISSUE.C)
  })

  it('EC-04 보인 뒤 상태가 대기 중으로 바뀌어도(강등) 보이기 시작한 상태로 더 급한 세션을 세고, [보기]는 그 첫 줄로 가며 알린다', async () => {
    world()
    setAgents(done(A1, T0 - 9000), attention(B1, T0 - 1000), done(C1, T0 - 4000))
    const r = mount()
    await tick(1000)
    putAgent(agent(A1, { activity: 'idle', unseen: false, since: Date.now(), waitingSince: T0 - 9000 }))
    await tick(1000)
    expect(selected()).toBe(ISSUE.A)
    expect(r.result.current.urgent.map((x) => x.paneId)).toEqual([B1])
    act(() => r.result.current.seeUrgent())
    await tick(100)
    expect(selected()).toBe(ISSUE.B)
    await vi.waitFor(() => expect(r.result.current.announce).toContain('다음 세션:'))
    expect(r.result.current.announce).toContain('#2 문서')
  })
})

describe('열기·실패·취소(EC-16 · EC-22 · EC-24 · EC-26)', () => {
  /** A1 에 답해 넘어갈 조건이 되었을 때 첫 세션(B1)이 이 창에서 열지 않은 이슈다 */
  async function answeredToUnopened(open: (o: OpenPaneOptions) => Promise<OpenPaneResult>, opening = false) {
    world({ ready: [ISSUE.A, ISSUE.C] })
    if (opening) useSetupStore.getState().setOpen(ISSUE.B, { phase: 'opening' })
    setAgents(done(A1, T0 - 9000), done(B1, T0 - 8000), done(C1, T0 - 7000))
    openMock.mockImplementation(open)
    const r = mount()
    await tick(1000)
    await answer(A1)
    await tick(2500)
    return r
  }

  it('EC-16 이 창에서 열지 않은 세션으로의 자동 이동은 15초 시간 제한으로 열고(포커스 없음), 실패하면 알리고 출발한 패널로 되돌린 뒤 다음 세션으로 간다', async () => {
    const r = await answeredToUnopened(async () => 'failed')
    expect(openMock).toHaveBeenCalled()
    const o = openMock.mock.calls[0][0]
    expect(o).toMatchObject({ target: target(2), paneId: B1, keyboard: false })
    expect(o.deadline - Date.now()).toBeLessThanOrEqual(15_000)
    expect(o.deadline - Date.now()).toBeGreaterThan(13_000)
    expect(r.result.current.alert).toContain('열 수 없습니다')
    expect(r.result.current.blockedRows.map((x) => x.paneId)).toEqual([B1])
    await tick(1500)
    expect(selected()).toBe(ISSUE.C)
  })

  it('EC-16 이미 여는 중(opening)인 이슈로 가는 이동도 실패로 보지 않고 열기 결과를 기다린다', async () => {
    let finish!: (r: OpenPaneResult) => void
    const r = await answeredToUnopened(() => new Promise((res) => (finish = res)), true)
    expect(openMock).toHaveBeenCalledTimes(1)
    expect(r.result.current.alert).toBe('')
    await tick(5000)
    expect(openMock).toHaveBeenCalledTimes(1)
    act(() => useUiStore.getState().selectIssue(ISSUE.B))
    await act(async () => finish('ok'))
    expect(r.result.current.session).toMatchObject({ paneId: B1 })
  })

  it.each(['다른 줄을 고름', '다른 이슈를 고름', '답변 모드를 끔', '좁은 화면에서 목록을 엶'])('EC-22 열기를 기다리는 동안 사용자가 %s — 이동은 쓸모없어진다(isStale)', async (action) => {
    let finish!: (r: OpenPaneResult) => void
    const r = await answeredToUnopened(() => new Promise((res) => (finish = res)))
    expect(openMock).toHaveBeenCalledTimes(1)
    const o = openMock.mock.calls[0][0]
    expect(o.isStale()).toBe(false)
    if (action === '다른 줄을 고름') act(() => r.result.current.pick(rowOf(r.result.current.waiting, C1)))
    if (action === '다른 이슈를 고름') act(() => useUiStore.getState().selectIssue(ISSUE.D))
    if (action === '답변 모드를 끔') r.rerender({ enabled: false, narrowListOpen: false })
    if (action === '좁은 화면에서 목록을 엶') r.rerender({ enabled: true, narrowListOpen: true })
    expect(o.isStale()).toBe(true)
    await act(async () => finish('stale'))
  })

  it('EC-26 열기를 기다리는 동안 옛 패널에 입력하면 이동이 쓸모없어지고 화면은 그대로다', async () => {
    let finish!: (r: OpenPaneResult) => void
    await answeredToUnopened(() => new Promise((res) => (finish = res)))
    expect(openMock).toHaveBeenCalledTimes(1)
    const o = openMock.mock.calls[0][0]
    expect(o.isStale()).toBe(false)
    await tick(200)
    act(() => noteTerminalInput(A1))
    expect(o.isStale()).toBe(true)
    await act(async () => finish('stale'))
    await tick(3000)
    expect(selected()).toBe(ISSUE.A)
  })

  it('EC-16 이 창에서 열린 이슈인데 그 패널로 가지 못하면(goToPane false) 그 줄을 막고 되돌린 뒤 다음 세션으로 간다', async () => {
    world({ noPanes: [ISSUE.B] })
    setAgents(done(A1, T0 - 9000), done(B1, T0 - 8000), done(C1, T0 - 7000))
    const r = mount()
    await tick(1000)
    await answer(A1)
    await tick(2500)
    expect(r.result.current.blockedRows.map((x) => x.paneId)).toEqual([B1])
    await tick(1500)
    expect(selected()).toBe(ISSUE.C)
    expect(openMock).not.toHaveBeenCalled()
  })

  it('EC-24 자동 이동이 끝난 직후 Ctrl+T 로 셸 패널을 만들면 그 세션에 머문다', async () => {
    world()
    setAgents(done(A1, T0 - 9000), done(B1, T0 - 8000), done(C1, T0 - 7000))
    mount()
    await tick(1000)
    await answer(A1)
    await tick(2500)
    expect(selected()).toBe(ISSUE.B)
    act(() => useUiStore.getState().splitPane(ISSUE.B, B1, 'row'))
    await tick(10_000)
    expect(selected()).toBe(ISSUE.B)
  })

  it('EC-24 고른 줄을 여는 동안(pick) 지금 세션이 넘어갈 조건이 되어도 자동 이동이 끼어들지 않는다 — 고름은 30초·키 입력 받음', async () => {
    world({ ready: [ISSUE.A, ISSUE.B, ISSUE.C] })
    setAgents(done(A1, T0 - 9000), done(B1, T0 - 8000), done(D1, T0 - 7000))
    openMock.mockImplementation(() => new Promise(() => {}))
    const r = mount()
    await tick(1000)
    await answer(A1)
    act(() => r.result.current.pick(rowOf(r.result.current.waiting, D1)))
    await tick(5000)
    expect(openMock).toHaveBeenCalledTimes(1)
    const o = openMock.mock.calls[0][0]
    expect(o).toMatchObject({ paneId: D1, keyboard: true })
    expect(o.deadline - Date.now()).toBeGreaterThan(24_000)
    expect(selected()).not.toBe(ISSUE.B)
  })

  it('EC-16 고른 줄이 열리지 않으면(failed) 알리고 출발한 패널로 되돌아가 머문다', async () => {
    world({ ready: [ISSUE.A, ISSUE.B] })
    setAgents(done(A1, T0 - 9000), done(B1, T0 - 8000), done(D1, T0 - 7000))
    openMock.mockResolvedValue('failed')
    const r = mount()
    await tick(1000)
    act(() => r.result.current.pick(rowOf(r.result.current.waiting, D1)))
    await tick(100)
    expect(openMock).toHaveBeenCalledTimes(1)
    expect(selected()).toBe(ISSUE.A)
    expect(r.result.current.alert).toContain('열 수 없습니다')
    await tick(10_000)
    expect(selected()).toBe(ISSUE.A)
  })

  it('EC-16 고른 줄이 열린 이슈인데 그 패널로 가지 못하면 되돌아간다', async () => {
    world({ noPanes: [ISSUE.B] })
    setAgents(done(A1, T0 - 9000), done(B1, T0 - 8000))
    const r = mount()
    await tick(1000)
    act(() => r.result.current.pick(rowOf(r.result.current.waiting, B1)))
    await tick(100)
    expect(selected()).toBe(ISSUE.A)
    expect(r.result.current.blockedRows.map((x) => x.paneId)).toEqual([B1])
  })

  it('EC-16 열 수 없는 줄은 그 줄을 다시 고르거나 줄이 없어지면 풀린다', async () => {
    world({ noPanes: [ISSUE.B] })
    setAgents(done(A1, T0 - 9000), done(B1, T0 - 8000))
    const r = mount()
    await tick(1000)
    act(() => r.result.current.pick(rowOf(r.result.current.waiting, B1)))
    await tick(100)
    expect(r.result.current.blockedRows.map((x) => x.paneId)).toEqual([B1])
    // 줄이 없어졌다가 다시 생기면 막힘은 풀려 있다
    setAgents(done(A1, T0 - 9000))
    await tick(1000)
    setAgents(done(A1, T0 - 9000), done(B1, Date.now()))
    await tick(1000)
    expect(r.result.current.blockedRows).toEqual([])
    expect(r.result.current.waiting.map((x) => x.paneId)).toContain(B1)
    // 다시 고르면 풀린다(재시도)
    act(() => r.result.current.pick(rowOf(r.result.current.waiting, B1)))
    await tick(100)
    expect(r.result.current.blockedRows.map((x) => x.paneId)).toEqual([B1])
    act(() => useUiStore.setState((s) => ({ panes: { ...s.panes, [ISSUE.B]: { tree: { kind: 'leaf', id: B1 }, focused: B1, seq: 1 } } })))
    act(() => r.result.current.pick(rowOf(r.result.current.blockedRows, B1)))
    await tick(100)
    expect(r.result.current.blockedRows).toEqual([])
    expect(selected()).toBe(ISSUE.B)
  })
})

describe('끝남·화면 변화(EC-07)', () => {
  it('EC-07 보이는 패널이 바뀌면 tick 을 기다리지 않고 바로 판단한다 — Ctrl+W 직후 옆 패널에 입력하면 머문다', async () => {
    world()
    useUiStore.setState((s) => ({ panes: { ...s.panes, [ISSUE.A]: { tree: { kind: 'split', dir: 'row', a: { kind: 'leaf', id: A1 }, b: { kind: 'leaf', id: A2 } }, focused: A1, seq: 2 } } }))
    setAgents(busy(A1, T0 - 1000), done(B1, T0 - 8000))
    // 진입 판단(작업 중 → 첫 세션)이 끼어들지 않게 지금 패널을 쓰는 중이다
    noteTerminalInput(A1)
    const r = mount()
    await tick(1500)
    expect(selected()).toBe(ISSUE.A)
    vi.setSystemTime(Date.now() + 250)
    const closedAt = Date.now()
    act(() => useUiStore.getState().closePane(ISSUE.A, A1))
    expect(r.result.current.session).toMatchObject({ paneId: A2, closedAt })
    // 닫은 직후(다음 tick 전) 옆 패널(셸)에 친다
    vi.setSystemTime(Date.now() + 100)
    act(() => noteTerminalInput(A2))
    await tick(5000)
    expect(selected()).toBe(ISSUE.A)
  })
})

describe('포커스·알림(AC-05 · EC-25)', () => {
  /** 터미널 영역(가려진 옛 패널 포함)과 요약 카드의 DOM 표시 */
  function dom() {
    document.body.innerHTML = `
      <div data-terminal-root>
        <div data-pane-id="${A1}"><textarea id="ta-a"></textarea><button id="restart">다시 시작</button></div>
        <div data-pane-id="${B1}"><textarea id="ta-b"></textarea></div>
      </div>
      <section data-answer-summary><h2 data-answer-heading tabindex="-1">세션 요약</h2><button id="skip">건너뛰기</button></section>
      <button id="elsewhere">다른 곳</button>`
    const $ = (id: string) => document.getElementById(id) as HTMLElement
    return { $, heading: document.querySelector('[data-answer-heading]') as HTMLElement }
  }

  it('AC-05 자동 이동 뒤 포커스가 터미널에 있었으면 카드 제목이 받고(터미널에 넣지 않는다), 그 뒤 다음 frame 에 "다음 세션: …"을 알린다', async () => {
    const { $, heading } = dom()
    world()
    setAgents(done(A1, T0 - 9000), done(B1, T0 - 8000))
    const r = mount()
    await tick(1000)
    $('ta-a').focus()
    await answer(A1)
    await tick(2500)
    expect(selected()).toBe(ISSUE.B)
    expect(document.activeElement).toBe(heading)
    expect(useUiStore.getState().focusRequest).toBeNull()
    await vi.waitFor(() => expect(r.result.current.announce).toContain('다음 세션:'))
    expect(r.result.current.announce).toContain('#2 문서')
  })

  it('AC-05 도착 때 포커스가 이미 다른 곳으로 갔으면 옮기지 않는다', async () => {
    const { $ } = dom()
    world({ ready: [ISSUE.A] })
    setAgents(done(A1, T0 - 9000), done(B1, T0 - 8000))
    let finish!: (r: OpenPaneResult) => void
    openMock.mockImplementation(() => new Promise((res) => (finish = res)))
    mount()
    await tick(1000)
    $('ta-a').focus()
    await answer(A1)
    await tick(2500)
    expect(openMock).toHaveBeenCalledTimes(1)
    $('elsewhere').focus()
    act(() => useUiStore.getState().selectIssue(ISSUE.B))
    await act(async () => finish('ok'))
    expect(document.activeElement).toBe($('elsewhere'))
  })

  it('EC-25 [건너뛰기]는 포커스를 옮기지 않는다', async () => {
    const { $ } = dom()
    world()
    setAgents(done(A1, T0 - 9000), done(B1, T0 - 8000))
    const r = mount()
    await tick(1000)
    $('skip').focus()
    act(() => r.result.current.skip())
    await tick(100)
    expect(selected()).toBe(ISSUE.B)
    expect(document.activeElement).toBe($('skip'))
  })

  it.each(['ta-a', 'restart'])('EC-25 보이는 패널이 바뀌면(사용자 선택 포함) 가려진 패널의 %s 에 있던 포커스를 카드 제목으로 옮긴다 — 새로 보이는 패널 안이면 그대로', async (id) => {
    const { $, heading } = dom()
    world()
    setAgents(done(A1, T0 - 9000), done(B1, T0 - 8000))
    const r = mount()
    await tick(1000)
    $(id).focus()
    act(() => useUiStore.getState().selectIssue(ISSUE.B))
    expect(document.activeElement).toBe(heading)
    expect(r.result.current.session).toMatchObject({ paneId: B1 })
    $('ta-b').focus()
    act(() => useUiStore.getState().selectIssue(ISSUE.B))
    expect(document.activeElement).toBe($('ta-b'))
  })
})
