// 알림 클릭 → 그 터미널 패널로 가기
import { act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { IssueTarget } from '@minmo/core'

import type { Host } from '../../app/host'
import type { NotifyTarget } from '../../lib/tauri'
import { parseNotifyTarget } from '../../lib/tauri'
import { useHostsStore } from '../../store/hosts'
import { useSetupStore } from '../../store/setup'
import { useUiStore } from '../../store/ui'
import { createFakeTauri, flush } from '../../test/fakes'
import { makeDeps, renderHookWithDeps } from '../../test/render'
import type { IssueActions } from '../issue/useWorktree'
import { leaf, splitPane } from '../terminal/panes'
import { goToPane, openPaneTarget, useNotifyClick } from './navigate'
import type { OpenPaneOptions } from './navigate'

const ISSUE = 'acme/app#1'
const P1 = `${ISSUE}::1`
const P2 = `${ISSUE}::2`

/** 훅을 마운트하고, 알림을 누른 것처럼 알리는 함수를 돌려준다 */
async function setup() {
  let click!: (t: NotifyTarget) => void
  const fake = createFakeTauri({
    onNotifyClick: async (cb) => {
      click = cb
      return () => {}
    },
  })
  renderHookWithDeps(() => useNotifyClick(), makeDeps({ tauri: fake.tauri }))
  await Promise.resolve()
  return { tauri: fake.tauri, click }
}

beforeEach(() => {
  useUiStore.setState({
    selectedIssueId: 'acme/app#9',
    tab: 'notes',
    focusRequest: null,
    panes: { [ISSUE]: { tree: splitPane(leaf(P1), P1, 'row', P2), focused: P1, seq: 2 } },
  })
})

describe('알림 클릭(useNotifyClick)', () => {
  it('이 PC 의 알림: 창을 앞으로 가져오고 그 이슈의 터미널 탭에서 그 패널에 포커스를 준다', async () => {
    const t = await setup()
    t.click({ kind: 'local', issueId: ISSUE, paneId: P2 })
    expect(t.tauri.appShow).toHaveBeenCalledTimes(1)
    const ui = useUiStore.getState()
    expect(ui.selectedIssueId).toBe(ISSUE)
    expect(ui.tab).toBe('terminal')
    expect(ui.panes[ISSUE].focused).toBe(P2)
    expect(ui.focusRequest).toEqual({ paneId: P2, token: 1 })
  })

  it('그 사이 닫힌 패널이면 이슈의 터미널 탭까지만 간다', async () => {
    const t = await setup()
    t.click({ kind: 'local', issueId: ISSUE, paneId: `${ISSUE}::7` })
    const ui = useUiStore.getState()
    expect(ui.selectedIssueId).toBe(ISSUE)
    expect(ui.tab).toBe('terminal')
    expect(ui.panes[ISSUE].focused).toBe(P1)
    expect(ui.focusRequest).toBeNull()
  })

  it('다른 PC 의 알림: 그 PC 의 화면을 그 터미널로 연다 — 이 PC 의 화면은 그대로 둔다', async () => {
    const t = await setup()
    const target = { owner: 'acme', repo: 'app', key: '1', number: 1, title: '로그인' }
    t.click({ kind: 'peer', peerId: 'p1', paneId: P1, target })
    expect(t.tauri.peerOpen).toHaveBeenCalledWith('p1', { target, paneId: P1 })
    t.click({ kind: 'peer', peerId: 'p1', paneId: P1, target: null })
    expect(t.tauri.peerOpen).toHaveBeenLastCalledWith('p1', undefined)
    expect(t.tauri.appShow).not.toHaveBeenCalled()
    expect(useUiStore.getState().selectedIssueId).toBe('acme/app#9')
  })
})

describe('parseNotifyTarget', () => {
  it('모양이 맞는 것만 받는다', () => {
    expect(parseNotifyTarget({ kind: 'local', issueId: ISSUE, paneId: P1, extra: 1 })).toEqual({ kind: 'local', issueId: ISSUE, paneId: P1 })
    expect(parseNotifyTarget({ kind: 'peer', peerId: 'p1', paneId: P1, target: 'x' })).toEqual({ kind: 'peer', peerId: 'p1', paneId: P1, target: null })
    for (const bad of [null, undefined, 'x', {}, { kind: 'local', paneId: P1 }, { kind: 'local', issueId: ISSUE }, { kind: 'peer', paneId: P1 }, { kind: 'other', issueId: ISSUE, paneId: P1 }]) {
      expect(parseNotifyTarget(bad)).toBeNull()
    }
  })
})

// #122 답변 모드의 이동 — 그 패널로 갔는지 알려 주고, 이 창에서 열지 않은 이슈는 먼저 연다(Plan §5, U4)
describe('#122 goToPane · openPaneTarget', () => {
  const TARGET = { owner: 'acme', repo: 'app', key: '1', number: 1, title: '로그인' }
  const ready = { phase: 'ready' as const, path: '/w/1', branch: 'issue/1', pathChanged: false }
  /** 열기 동작 — 실제 issueActions 처럼 이슈를 고르고 phase 를 바꾼다 */
  function fakeActions(open: (t: IssueTarget) => Promise<void>) {
    const fn = vi.fn(open)
    const actionsFor = vi.fn((_host: Host) => ({ open: fn }) as unknown as IssueActions)
    return { actionsFor, open: fn }
  }
  const never = () => new Promise<void>(() => {})
  const opts = (o: Partial<OpenPaneOptions> & Pick<OpenPaneOptions, 'actionsFor'>): OpenPaneOptions => ({
    tauri: createFakeTauri().tauri,
    alias: null,
    target: TARGET,
    paneId: P2,
    keyboard: false,
    deadline: Date.now() + 15_000,
    isStale: () => false,
    ...o,
  })

  beforeEach(() => {
    useSetupStore.setState({ targets: {}, open: {}, script: {}, logs: {} })
    useHostsStore.setState({ probes: {}, connecting: {}, errors: {} })
  })
  afterEach(() => vi.useRealTimers())

  it('EC-16 goToPane 은 그 패널로 갔으면 true, 그 사이 닫힌 패널이면 false', () => {
    expect(goToPane(ISSUE, P2)).toBe(true)
    expect(goToPane(ISSUE, `${ISSUE}::7`)).toBe(false)
  })

  it('EC-16 이 창에서 열지 않은 이슈: 열기가 끝나기를 기다리지 않고, 준비되면 그 패널로 가서 ok — keyboard 면 그 터미널이 키를 받는다', async () => {
    const a = fakeActions(async () => {
      useUiStore.getState().selectIssue(ISSUE)
      useSetupStore.getState().setOpen(ISSUE, { phase: 'opening' })
      await never()
    })
    const result = openPaneTarget(opts({ actionsFor: a.actionsFor, keyboard: true }))
    await vi.waitFor(() => expect(a.open).toHaveBeenCalledWith(TARGET))
    act(() => useSetupStore.getState().setOpen(ISSUE, ready))
    await expect(result).resolves.toBe('ok')
    const ui = useUiStore.getState()
    expect(ui).toMatchObject({ selectedIssueId: ISSUE, tab: 'terminal' })
    expect(ui.panes[ISSUE].focused).toBe(P2)
    expect(ui.focusRequest).toEqual({ paneId: P2, token: 1 })
  })

  it('EC-16 이미 여는 중(opening)이면 끝날 때까지 기다리고 실패로 보지 않는다', async () => {
    useSetupStore.getState().setOpen(ISSUE, { phase: 'opening' })
    const a = fakeActions(async () => {})
    let settled = false
    const result = openPaneTarget(opts({ actionsFor: a.actionsFor }))
    void result.then(() => (settled = true))
    await flush()
    expect(settled).toBe(false)
    act(() => useSetupStore.getState().setOpen(ISSUE, ready))
    await expect(result).resolves.toBe('ok')
    expect(useUiStore.getState().focusRequest).toBeNull()
  })

  it('EC-16 열기가 실패(error)하면 failed', async () => {
    const a = fakeActions(async () => {
      useSetupStore.getState().setOpen(ISSUE, { phase: 'opening' })
      await Promise.resolve()
      useSetupStore.getState().setOpen(ISSUE, { phase: 'error', code: 'git_failed', message: 'x' })
    })
    await expect(openPaneTarget(opts({ actionsFor: a.actionsFor }))).resolves.toBe('failed')
    expect(a.open).toHaveBeenCalledWith(TARGET)
  })

  it('EC-16 시간 제한(deadline) 안에 준비되지 않으면 failed', async () => {
    vi.useFakeTimers()
    const a = fakeActions(async () => {
      useSetupStore.getState().setOpen(ISSUE, { phase: 'opening' })
      await never()
    })
    let result: string | null = null
    void openPaneTarget(opts({ actionsFor: a.actionsFor, deadline: Date.now() + 15_000 })).then((r) => (result = r))
    await vi.advanceTimersByTimeAsync(14_900)
    expect(result).toBeNull()
    await vi.advanceTimersByTimeAsync(200)
    expect(result).toBe('failed')
  })

  it('EC-16 준비됐지만 그 패널이 트리에 없으면 failed · 패널을 정하지 않으면(paneId null) 터미널 탭까지만 가고 ok', async () => {
    useSetupStore.getState().setOpen(ISSUE, ready)
    const a = fakeActions(async () => {})
    await expect(openPaneTarget(opts({ actionsFor: a.actionsFor, paneId: `${ISSUE}::7` }))).resolves.toBe('failed')
    expect(a.open).toHaveBeenCalledTimes(1)
    await expect(openPaneTarget(opts({ actionsFor: a.actionsFor, paneId: null }))).resolves.toBe('ok')
    expect(useUiStore.getState().tab).toBe('terminal')
  })

  it('EC-16 원격 이슈는 먼저 연결(probe)하고, 연결하지 못하면 열지 않고 failed — 연결되면 그 호스트에서 연다', async () => {
    const RID = 'ssh:srv|acme/app#1'
    useUiStore.setState({ panes: { [RID]: { tree: leaf(`${RID}::1`), focused: null, seq: 1 } } })
    const a = fakeActions(async () => {
      useSetupStore.getState().setOpen(RID, ready)
    })
    const down = createFakeTauri({
      sshProbe: async () => {
        throw { kind: 'unreachable', message: 'no route' }
      },
    }).tauri
    await expect(openPaneTarget(opts({ actionsFor: a.actionsFor, tauri: down, alias: 'srv', paneId: `${RID}::1` }))).resolves.toBe('failed')
    expect(down.sshProbe.mock.calls[0]?.[0]).toBe('srv')
    expect(a.open).not.toHaveBeenCalled()

    const up = createFakeTauri().tauri
    await expect(openPaneTarget(opts({ actionsFor: a.actionsFor, tauri: up, alias: 'srv', paneId: `${RID}::1` }))).resolves.toBe('ok')
    expect(a.actionsFor.mock.calls.at(-1)?.[0]).toMatchObject({ alias: 'srv' })
    expect(useUiStore.getState().panes[RID].focused).toBe(`${RID}::1`)
  })

  it('EC-22 쓸모없어지면(isStale) 열기 전이든 기다리는 중이든 stale 이고, 화면을 옮기지 않는다', async () => {
    const a = fakeActions(async () => {
      useSetupStore.getState().setOpen(ISSUE, { phase: 'opening' })
      await never()
    })
    await expect(openPaneTarget(opts({ actionsFor: a.actionsFor, isStale: () => true }))).resolves.toBe('stale')
    expect(a.open).not.toHaveBeenCalled()

    let stale = false
    const result = openPaneTarget(opts({ actionsFor: a.actionsFor, isStale: () => stale }))
    await vi.waitFor(() => expect(a.open).toHaveBeenCalledTimes(1))
    stale = true
    act(() => useSetupStore.getState().setOpen(ISSUE, ready))
    await expect(result).resolves.toBe('stale')
    expect(useUiStore.getState().panes[ISSUE].focused).toBe(P1)
    expect(useUiStore.getState().focusRequest).toBeNull()
  })
})
