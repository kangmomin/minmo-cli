// UI store — 트리에서 이슈를 눌렀을 때의 터미널 포커스 요청(#78)·이슈 선택 번호
import { beforeEach, describe, expect, it } from 'vitest'

import { activeTabOf, isPaneTree, leaf, leafIds, selectedTabId, splitPane, tabList } from '../features/terminal/panes'
import type { PaneNode, PaneTree, TabsNode, TermTab } from '../features/terminal/panes'
import { DEFAULT_CORE_ID } from '../lib/defaultWorkspace'
import { applySharedUi } from './shared'
import { reconcileIssuePanes, useUiStore } from './ui'
import type { IssuePanes } from './ui'

const ID = 'o/r#1'
const P1 = `${ID}::1`
const P2 = `${ID}::2`
/** P1 | P2 로 나눈 패널 구성 */
const SPLIT = { tree: { kind: 'split' as const, dir: 'row' as const, a: { kind: 'leaf' as const, id: P1 }, b: { kind: 'leaf' as const, id: P2 } }, seq: 2 }

beforeEach(() => {
  useUiStore.setState({ tab: 'terminal', panes: {}, terminalIds: {}, startedTerminals: {}, focusRequest: null, selectedIssueId: null, selectSeq: 0 })
})

const request = () => useUiStore.getState().focusRequest

describe('focusIssueTerminal (#78)', () => {
  it('터미널 탭 + 이 화면이 연 터미널: 그 이슈에서 마지막으로 쓴 패널에 포커스를 요청한다', () => {
    useUiStore.setState({ panes: { [ID]: { ...SPLIT, focused: P2 } }, startedTerminals: { [ID]: true }, focusRequest: { paneId: 'x::1', token: 4 } })
    useUiStore.getState().focusIssueTerminal(ID)
    expect(request()).toEqual({ paneId: P2, token: 5 })
  })

  it('마지막으로 쓴 패널이 없거나 이미 닫혔으면 첫 패널', () => {
    useUiStore.setState({ panes: { [ID]: { ...SPLIT, focused: null } }, startedTerminals: { [ID]: true } })
    useUiStore.getState().focusIssueTerminal(ID)
    expect(request()).toEqual({ paneId: P1, token: 1 })
    useUiStore.setState({ panes: { [ID]: { ...SPLIT, focused: `${ID}::9` } } })
    useUiStore.getState().focusIssueTerminal(ID)
    expect(request()).toEqual({ paneId: P1, token: 2 })
  })

  it('다른 화면이 열어 떠 있는 터미널(이 화면은 아직 열지 않음)에도 요청한다 — 보이면 붙는다', () => {
    useUiStore.setState({ panes: { [ID]: { ...SPLIT, focused: null } }, terminalIds: { [P2]: 'pty-9' } })
    useUiStore.getState().focusIssueTerminal(ID)
    expect(request()).toEqual({ paneId: P1, token: 1 })
  })

  it('터미널이 없으면(열지 않음·패널을 모두 닫음) 아무것도 하지 않는다 — 셸을 만들지 않는다', () => {
    useUiStore.getState().focusIssueTerminal(ID)
    expect(request()).toBeNull()
    useUiStore.setState({ panes: { [ID]: { ...SPLIT, focused: null } } })
    useUiStore.getState().focusIssueTerminal(ID)
    expect(request()).toBeNull()
    useUiStore.setState({ panes: { [ID]: { tree: null, focused: null, seq: 2 } }, startedTerminals: { [ID]: true } })
    useUiStore.getState().focusIssueTerminal(ID)
    expect(request()).toBeNull()
    expect(useUiStore.getState().startedTerminals).toEqual({ [ID]: true })
  })

  it('다른 탭(메모 등)을 보는 중이면 탭을 바꾸지 않고 요청하지 않는다', () => {
    useUiStore.setState({ tab: 'notes', panes: { [ID]: { ...SPLIT, focused: P1 } }, startedTerminals: { [ID]: true } })
    useUiStore.getState().focusIssueTerminal(ID)
    expect(request()).toBeNull()
    expect(useUiStore.getState().tab).toBe('notes')
  })
})

// D-26(#89): 원격 tmux 의 기본 세션을 쓰는 패널(first)을 정해 두고, 분할·닫기로 바꾸지 않는다 —
// 첫 패널을 닫아도 남은 분할 패널이 기본 세션으로 옮겨 붙지 않고 자기 -pN 세션에 다시 붙게(AC-05)
describe('패널 역할 고정 — first (#89 D-26)', () => {
  const panes = () => useUiStore.getState().panes[ID]

  it.each([
    ['launchPane(빈 트리)', () => void useUiStore.getState().launchPane(ID), P1],
    ['launchPane(keepFirst, 빈 트리)', () => void useUiStore.getState().launchPane(ID, true), P1],
    ['ensurePanes', () => useUiStore.getState().ensurePanes(ID), P1],
    [
      'newPane(모두 닫은 뒤)',
      () => {
        useUiStore.setState({ panes: { [ID]: { tree: null, focused: null, seq: 2 } } })
        useUiStore.getState().newPane(ID)
      },
      `${ID}::3`,
    ],
  ])('패널이 없을 때 만드는 경로 %s: first 는 처음 만든 패널', (_, make, first) => {
    make()
    expect(panes().first).toBe(first)
  })

  it('분할·닫기 뒤에도 first 는 그대로다(첫 패널을 닫아도 남은 패널로 옮기지 않는다)', () => {
    useUiStore.getState().ensurePanes(ID)
    useUiStore.getState().splitPane(ID, P1, 'row')
    expect(panes().first).toBe(P1)
    useUiStore.getState().closePane(ID, P1)
    expect(panes().tree).toEqual({ kind: 'leaf', id: P2 })
    expect(panes().first).toBe(P1)
  })

  it('first 가 없는 이전 상태는 처음 읽을 때 지금 첫 패널로 한 번 채운다', () => {
    useUiStore.setState({ panes: { [ID]: { ...SPLIT, focused: null } } })
    expect(useUiStore.getState().firstPane(ID)).toBe(P1)
    expect(panes().first).toBe(P1)
    // 한 번 채운 뒤에는 첫 패널을 닫아도 남은 패널로 바꾸지 않는다
    useUiStore.getState().closePane(ID, P1)
    expect(useUiStore.getState().firstPane(ID)).toBe(P1)
  })
})

describe('launchPane — 포커스를 요청하지 않는 배경 실행', () => {
  const PREV = { paneId: 'x::1', token: 4 }

  it('AC-05 focus=false 로 첫 패널을 만들면 패널·터미널 시작은 하되 포커스 요청은 그대로다', () => {
    useUiStore.setState({ focusRequest: PREV })
    const id = useUiStore.getState().launchPane(ID, false, false)
    expect(id).toBe(P1)
    expect(useUiStore.getState().startedTerminals).toEqual({ [ID]: true })
    expect(leafIds(useUiStore.getState().panes[ID]?.tree ?? null)).toEqual([P1])
    expect(request()).toBe(PREV)
  })

  it('AC-05 focus=false 이고 그 이슈에 패널이 이미 있으면 새 패널을 만들어도 마지막으로 쓴 패널(focused)을 바꾸지 않는다', () => {
    useUiStore.setState({
      panes: { [ID]: { tree: { kind: 'leaf', id: P1 }, focused: P1, seq: 1, first: P1 } },
      terminalIds: { [P1]: 'pty-1' },
      startedTerminals: { [ID]: true },
      focusRequest: PREV,
    })
    const id = useUiStore.getState().launchPane(ID, true, false)
    expect(id).toBe(P2)
    expect(leafIds(useUiStore.getState().panes[ID]?.tree ?? null)).toEqual([P1, P2])
    expect(useUiStore.getState().panes[ID]?.focused).toBe(P1)
    expect(request()).toBe(PREV)
  })

  it('AC-05 focus 를 주지 않으면(기본값) 지금처럼 새 패널에 포커스를 요청한다', () => {
    useUiStore.setState({ focusRequest: PREV })
    const id = useUiStore.getState().launchPane(ID)
    expect(request()).toEqual({ paneId: id, token: 5 })
    expect(useUiStore.getState().panes[ID]?.focused).toBe(id)
  })
})

describe('selectIssue', () => {
  it('같은 이슈를 다시 골라도 선택 번호가 오른다(좁은 화면이 작업 화면으로 넘어가는 신호)', () => {
    useUiStore.getState().selectIssue(ID)
    useUiStore.getState().selectIssue(ID)
    expect(useUiStore.getState()).toMatchObject({ selectedIssueId: ID, selectSeq: 2 })
  })
})

// #111 CT-04 — 지운 기능(E2E 큐)이 저장해 둔 역할 설정은 다시 읽을 때 상태와 저장소에서 모두 없어진다
describe('지운 기능의 저장 값 (#111)', () => {
  beforeEach(() => localStorage.clear())

  it('CT-04 예전 저장 값의 e2eRoles 는 상태·저장소 모두에서 없어지고, 다시 읽어도 돌아오지 않는다', async () => {
    localStorage.setItem('minmo-ui', JSON.stringify({ state: { theme: 'light', e2eRoles: { run: { kind: 'codex' } } }, version: 1 }))
    await useUiStore.persist.rehydrate()
    expect(useUiStore.getState()).not.toHaveProperty('e2eRoles')
    const raw = JSON.parse(localStorage.getItem('minmo-ui') ?? '{}') as { state: Record<string, unknown>; version: number }
    expect(raw.version).toBe(2)
    expect(raw.state).not.toHaveProperty('e2eRoles')
    expect(raw.state.theme).toBe('light')
    await useUiStore.persist.rehydrate()
    expect(useUiStore.getState()).not.toHaveProperty('e2eRoles')
  })
})

// #120 기본·★기타의 터미널 탭 — 탭마다 따로 패널 분할. 패널 id `<이슈id>::<seq>` 와 이슈당 seq 하나는 그대로다
describe('터미널 탭 (#120)', () => {
  const ETC = 'o/r#etc'
  const E = (n: number) => `${ETC}::${n}`
  const tabsOf = (...tabs: TermTab[]): TabsNode => ({ kind: 'tabs', tabs })
  const T = (seq: number, no: number, node: PaneNode = leaf(E(seq))): TermTab => ({ id: seq === 1 ? 't0' : `t${seq}`, no, node })
  const panes = () => useUiStore.getState().panes[ETC]
  const names = () => useUiStore.getState().tabNames[ETC]
  const ui = () => useUiStore.getState()

  /**
   * 패널 구성 불변식(Plan "불변식 헬퍼"). 이름·고른 탭 검사는 모양이 맞는 트리일 때만 — 깨진 공유 트리는 EC-09′ 대로 그대로 둔다
   */
  function expectPanesInvariants(p: IssuePanes | undefined, tabNames: Record<string, string> | undefined, prevSeq = 0) {
    if (!p) return expect(tabNames).toBeUndefined()
    expect(p.seq).toBeGreaterThanOrEqual(prevSeq)
    if (p.tree === null) {
      expect(p).not.toHaveProperty('tab')
      expect(p).not.toHaveProperty('tabSeq')
      expect(tabNames).toBeUndefined()
      return
    }
    if (!isPaneTree(p.tree)) return
    const tabs = tabList(p.tree)
    const ids = leafIds(p.tree)
    expect(new Set(ids).size).toBe(ids.length)
    if (p.tree.kind === 'tabs') {
      expect(tabs.length).toBeGreaterThanOrEqual(1)
      if (p.tab !== undefined) expect(tabs.map((t) => t.id)).toContain(p.tab)
    } else {
      expect(p).not.toHaveProperty('tab')
      expect(p).not.toHaveProperty('tabSeq')
    }
    if (p.focused !== null) expect(leafIds(activeTabOf(p.tree, p.tab)?.node ?? null)).toContain(p.focused)
    for (const k of Object.keys(tabNames ?? {})) expect(tabs.map((t) => t.id)).toContain(k)
  }
  const inv = (prevSeq = 0, id = ETC) => expectPanesInvariants(useUiStore.getState().panes[id], useUiStore.getState().tabNames[id], prevSeq)

  beforeEach(() => {
    useUiStore.setState({ tabNames: {}, worktreePathMap: {}, expanded: {} })
  })

  /** 기타에 터미널을 연 상태: 탭 하나(탭 없는 트리) */
  const opened = () => useUiStore.setState({ panes: { [ETC]: { tree: leaf(E(1)), focused: E(1), seq: 1, first: E(1) } }, startedTerminals: { [ETC]: true }, terminalIds: { [E(1)]: 'pty-1' } })
  /** 기타에 탭 2개(t0 = ::1, t2 = ::2), 고른 탭은 t2 */
  const twoTabs = (o: Partial<IssuePanes> = {}) =>
    useUiStore.setState({
      panes: { [ETC]: { tree: tabsOf(T(1, 1), T(2, 2)), focused: E(2), seq: 2, first: E(1), tab: 't2', tabSeq: 2, ...o } },
      startedTerminals: { [ETC]: true },
      terminalIds: { [E(1)]: 'pty-1', [E(2)]: 'pty-2' },
    })

  it('AC-04 newTab: 새 탭(번호 이름, 패널 1개)을 만들고 그 탭으로 바꾸고 새 패널에 포커스한다 — 기존 탭은 그대로', () => {
    opened()
    ui().newTab(ETC)
    expect(panes()).toEqual({ tree: tabsOf(T(1, 1), T(2, 2)), focused: E(2), seq: 2, first: E(1), tab: 't2', tabSeq: 2 })
    expect(request()).toEqual({ paneId: E(2), token: 1 })
    expect(ui().startedTerminals[ETC]).toBe(true)
    inv(1)
    ui().newTab(ETC)
    expect(tabList(panes().tree).map((t) => [t.id, t.no])).toEqual([
      ['t0', 1],
      ['t2', 2],
      ['t3', 3],
    ])
    expect(panes()).toMatchObject({ tab: 't3', focused: E(3), seq: 3, tabSeq: 3 })
    inv(2)
  })

  it('AC-04 기타에서 터미널이 떠 있을 때 Ctrl+T(openTerminal) 는 오른쪽 분할이 아니라 새 탭', () => {
    opened()
    ui().openTerminal(ETC)
    expect(tabList(panes().tree)).toHaveLength(2)
    expect(leafIds(activeTabOf(panes().tree, panes().tab)?.node ?? null)).toEqual([E(2)])
    expect(panes().focused).toBe(E(2))
    inv(1)
  })

  it('AC-04 기본에서도 Ctrl+T(openTerminal) 는 새 탭', () => {
    const P = (n: number) => `${DEFAULT_CORE_ID}::${n}`
    useUiStore.setState({ panes: { [DEFAULT_CORE_ID]: { tree: leaf(P(1)), focused: P(1), seq: 1, first: P(1) } }, startedTerminals: { [DEFAULT_CORE_ID]: true } })
    ui().openTerminal(DEFAULT_CORE_ID)
    expect(tabList(ui().panes[DEFAULT_CORE_ID].tree).map((t) => t.id)).toEqual(['t0', 't2'])
    inv(1, DEFAULT_CORE_ID)
  })

  it('AC-06 selectTab: 그 탭을 고르고 포커스는 그 탭의 첫 패널 — 포커스 요청은 하지 않는다(탭 버튼 포커스 유지)', () => {
    twoTabs()
    ui().selectTab(ETC, 't0')
    expect(panes()).toMatchObject({ tab: 't0', focused: E(1) })
    expect(request()).toBeNull()
    inv(2)
  })

  it('AC-07 탭 안의 분할·닫기는 고른 탭의 패널에만 — 다른 탭의 트리는 그대로', () => {
    twoTabs()
    ui().splitPane(ETC, E(2), 'row')
    expect(panes().tree).toEqual(tabsOf(T(1, 1), T(2, 2, splitPane(leaf(E(2)), E(2), 'row', E(3)))))
    expect(panes()).toMatchObject({ focused: E(3), seq: 3, tab: 't2' })
    inv(2)
    ui().closePane(ETC, E(3))
    expect(panes().tree).toEqual(tabsOf(T(1, 1), T(2, 2)))
    expect(panes()).toMatchObject({ focused: E(2), tab: 't2' })
    expect(request()).toEqual({ paneId: E(2), token: 2 })
    inv(3)
  })

  it('AC-08 탭 1개의 이름 바꾸기는 트리를 바꾸지 않고(가상 t0 의 이름), 분할·새 탭 뒤에도 이름이 남는다', () => {
    opened()
    const before = panes()
    ui().renameTab(ETC, 't0', '빌드')
    expect(names()).toEqual({ t0: '빌드' })
    expect(panes().tree).toBe(before.tree)
    inv(1)
    ui().splitPane(ETC, E(1), 'row')
    expect(names()).toEqual({ t0: '빌드' })
    inv(1)
    ui().newTab(ETC)
    expect(tabList(panes().tree)[0].id).toBe('t0')
    expect(names()).toEqual({ t0: '빌드' })
    inv(2)
  })

  it('EC-05 이름을 비우면(공백만) 번호 이름으로 되돌리고, 앞뒤 공백은 뗀다', () => {
    twoTabs()
    ui().renameTab(ETC, 't2', '  서버  ')
    expect(names()).toEqual({ t2: '서버' })
    ui().renameTab(ETC, 't2', '   ')
    expect(useUiStore.getState().tabNames[ETC]?.t2).toBeUndefined()
    inv(2)
  })

  it('AC-11 고른 탭의 마지막 패널을 닫으면 탭도 닫히고 이웃 탭으로 · 마지막 탭이면 패널 없음(이름·탭 값도 지움)', () => {
    twoTabs()
    useUiStore.setState({ tabNames: { [ETC]: { t0: '빌드', t2: '서버' } } })
    ui().closePane(ETC, E(2))
    expect(tabList(panes().tree).map((t) => t.id)).toEqual(['t0'])
    expect(panes().focused).toBe(E(1))
    expect(selectedTabId(panes().tree, panes().tab)).toBe('t0')
    expect(request()).toEqual({ paneId: E(1), token: 1 })
    expect(names()).toEqual({ t0: '빌드' })
    inv(2)
    ui().closePane(ETC, E(1))
    expect(panes().tree).toBeNull()
    expect(panes()).not.toHaveProperty('tab')
    expect(panes()).not.toHaveProperty('tabSeq')
    expect(names()).toBeUndefined()
    inv(2)
  })

  it('AC-12 에이전트 실행(launchPane): 고른 탭에 새 패널 — 다른 탭의 터미널 유무는 보지 않는다', () => {
    twoTabs({ tab: 't0', focused: E(1) })
    useUiStore.setState({ terminalIds: { [E(2)]: 'pty-2' } })
    // 고른 탭(t0)의 패널은 아직 터미널을 띄우지 않았다 → 그 자리를 쓴다
    expect(ui().launchPane(ETC)).toBe(E(1))
    expect(panes().tree).toEqual(tabsOf(T(1, 1), T(2, 2)))
    inv(2)
    // 터미널이 떠 있으면 그 탭 안에서 오른쪽에 새 패널
    useUiStore.setState({ terminalIds: { [E(1)]: 'pty-1', [E(2)]: 'pty-2' } })
    expect(ui().launchPane(ETC)).toBe(E(3))
    expect(panes().tree).toEqual(tabsOf(T(1, 1, splitPane(leaf(E(1)), E(1), 'row', E(3))), T(2, 2)))
    expect(panes()).toMatchObject({ tab: 't0', focused: E(3) })
    // 원격(keepFirst)은 언제나 새 패널 — 역시 고른 탭 안
    expect(ui().launchPane(ETC, true)).toBe(E(4))
    expect(leafIds(activeTabOf(panes().tree, 't2')?.node ?? null)).toEqual([E(2)])
    inv(3)
  })

  it('AC-14 일반 이슈는 탭을 쓰지 않는다 — Ctrl+T 는 지금처럼 오른쪽 새 패널, tab·tabSeq·이름 없음', () => {
    useUiStore.setState({ panes: { [ID]: { tree: leaf(P1), focused: P1, seq: 1, first: P1 } }, startedTerminals: { [ID]: true } })
    ui().openTerminal(ID)
    expect(ui().panes[ID]).toEqual({ ...SPLIT, focused: P2, first: P1 })
    expect(ui().tabNames[ID]).toBeUndefined()
    inv(1, ID)
  })

  it('AC-15′ 다시 켠 뒤(고른 탭 값 없음) 고른 탭은 첫 탭이다 — 에이전트 실행이 첫 탭으로 간다', () => {
    useUiStore.setState({
      panes: { [ETC]: { tree: tabsOf(T(1, 1), T(2, 2)), focused: null, seq: 2, first: E(1), tabSeq: 2 } },
      startedTerminals: {},
      terminalIds: {},
    })
    expect(selectedTabId(panes().tree, panes().tab)).toBe('t0')
    expect(ui().launchPane(ETC)).toBe(E(1))
    expect(panes().tree).toEqual(tabsOf(T(1, 1), T(2, 2)))
    inv(2)
  })

  it('EC-04 기본·기타에서 터미널 시작 전 Ctrl+T 는 새 탭이 아니라 고른 탭(없으면 첫 탭)의 셸을 시작한다', () => {
    twoTabs()
    useUiStore.setState({ startedTerminals: {}, terminalIds: {} })
    const tree = panes().tree
    ui().openTerminal(ETC)
    expect(panes().tree).toBe(tree)
    expect(ui().startedTerminals[ETC]).toBe(true)
    expect(request()).toEqual({ paneId: E(2), token: 1 })
    inv(2)
  })

  it('EC-08 원격 tmux 기본 세션(first)은 이슈당 1개 — 새 탭·그 패널이 있는 탭 닫기로 옮기지 않는다', () => {
    opened()
    ui().newTab(ETC)
    expect(tabList(panes().tree)).toHaveLength(2)
    expect(panes().first).toBe(E(1))
    ui().closeTab(ETC, 't0')
    expect(tabList(panes().tree).map((t) => t.id)).toEqual(['t2'])
    expect(panes().first).toBe(E(1))
    inv(2)
  })

  it('EC-09′ 깨진 트리에서도 [새 터미널] 은 새 트리로 바꾸고, 옛 이름은 새 터미널에 붙지 않는다', () => {
    useUiStore.setState({ panes: { [ETC]: { tree: { kind: 'weird' } as unknown as PaneTree, focused: null, seq: 4 } }, tabNames: { [ETC]: { t0: '옛 이름' } } })
    ui().newPane(ETC)
    expect(panes()).toMatchObject({ tree: leaf(E(5)), focused: E(5), seq: 5 })
    expect(names()).toBeUndefined()
    inv(4)
  })

  it('EC-09′ reconcileIssuePanes: 깨진 트리면 아무것도 바꾸지 않는다(대조: 모양이 맞는 트리는 정리한다)', () => {
    const p: IssuePanes = { tree: { kind: 'weird' } as unknown as PaneTree, focused: 'x', seq: 3, tab: 't9', tabSeq: 4 }
    const r = reconcileIssuePanes(p, { t9: 'a' })
    expect(r.p).toBe(p)
    expect(r.names).toEqual({ t9: 'a' })
    expect(reconcileIssuePanes({ tree: leaf(E(1)), focused: null, seq: 1, tab: 't9' }, undefined).p).not.toHaveProperty('tab')
  })

  it('EC-10 worktree 삭제·rekey 는 그 이슈의 모든 탭의 패널 PTY id 와 탭 이름을 지운다', () => {
    twoTabs()
    useUiStore.setState({ tabNames: { [ETC]: { t2: '서버' } }, terminalIds: { [E(1)]: 'pty-1', [E(2)]: 'pty-2', 'x::1': 'pty-x' } })
    ui().removeWorktree(ETC)
    expect(ui().terminalIds).toEqual({ 'x::1': 'pty-x' })
    expect(ui().tabNames[ETC]).toBeUndefined()
    twoTabs()
    useUiStore.setState({ tabNames: { [ETC]: { t2: '서버' } }, terminalIds: { [E(1)]: 'pty-1', [E(2)]: 'pty-2' } })
    ui().rekey({ [ETC]: 'o/r2#etc' }, {})
    expect(ui().terminalIds).toEqual({})
    expect(ui().tabNames[ETC]).toBeUndefined()
  })

  it('EC-15 고르지 않은 탭을 닫으면 고른 탭·포커스는 그대로, 고른 탭을 닫으면 이웃 탭(오른쪽, 없으면 왼쪽)으로', () => {
    useUiStore.setState({
      panes: { [ETC]: { tree: tabsOf(T(1, 1), T(2, 2), T(3, 3)), focused: E(2), seq: 3, first: E(1), tab: 't2', tabSeq: 3 } },
      startedTerminals: { [ETC]: true },
    })
    ui().closeTab(ETC, 't3')
    expect(tabList(panes().tree).map((t) => t.id)).toEqual(['t0', 't2'])
    expect(panes()).toMatchObject({ tab: 't2', focused: E(2) })
    expect(request()).toBeNull()
    inv(3)
    ui().closeTab(ETC, 't2')
    expect(tabList(panes().tree).map((t) => t.id)).toEqual(['t0'])
    expect(selectedTabId(panes().tree, panes().tab)).toBe('t0')
    expect(panes().focused).toBe(E(1))
    expect(request()).toBeNull()
    inv(3)
  })

  it('EC-15 고른 탭 밖의 패널을 closePane 하면 고른 탭·포커스·포커스 요청은 그대로', () => {
    twoTabs({ tree: tabsOf(T(1, 1, splitPane(leaf(E(1)), E(1), 'row', E(3))), T(2, 2)), seq: 3 })
    ui().closePane(ETC, E(3))
    expect(panes().tree).toEqual(tabsOf(T(1, 1), T(2, 2)))
    expect(panes()).toMatchObject({ tab: 't2', focused: E(2) })
    expect(request()).toBeNull()
    inv(3)
  })

  it('AC-18 focusPane(알림·현황·딥링크): 숨은 탭의 패널이면 그 탭으로 바꾼다', () => {
    twoTabs({ tab: 't0', focused: E(1) })
    ui().focusPane(ETC, E(2))
    expect(panes()).toMatchObject({ tab: 't2', focused: E(2) })
    // 이미 포커스한 패널이어도 탭은 먼저 맞춘다
    useUiStore.setState((s) => ({ panes: { [ETC]: { ...s.panes[ETC], tab: 't0' } } }))
    ui().focusPane(ETC, E(2))
    expect(panes().tab).toBe('t2')
    inv(2)
  })

  it('AC-17 applySharedUi 뒤에도 불변식이 지켜진다 — 받은 탭 목록에 맞춰 이 기기의 고른 탭·포커스·이름을 정리한다', () => {
    twoTabs()
    useUiStore.setState({ tabNames: { [ETC]: { t2: '서버' } } })
    applySharedUi({ panes: { [ETC]: { tree: tabsOf(T(1, 1), T(3, 2)), seq: 3, first: E(1), tabSeq: 2 } }, tabNames: { [ETC]: { t2: '서버', t3: '새 탭' } } })
    expect(panes()).toMatchObject({ seq: 3, focused: null })
    expect(panes()).not.toHaveProperty('tab')
    expect(names()).toEqual({ t3: '새 탭' })
    inv(2)
  })

  it('AC-17 reconcileIssuePanes: 이름은 지금 탭 id 로 줄이고(탭 없는 트리는 t0 만), tab·tabSeq 는 TabsNode 일 때만, 사라진 고른 탭·고른 탭 밖 포커스는 지운다', () => {
    const two = tabsOf(T(1, 1), T(2, 2))
    const rows: [string, IssuePanes, Record<string, string> | undefined, { p: IssuePanes; names?: Record<string, string> }][] = [
      ['사라진 탭의 이름', { tree: two, focused: null, seq: 2, tabSeq: 2 }, { t0: 'a', t9: 'b' }, { p: { tree: two, focused: null, seq: 2, tabSeq: 2 }, names: { t0: 'a' } }],
      ['탭 없는 트리', { tree: leaf(E(1)), focused: null, seq: 1, tab: 't0', tabSeq: 2 }, { t0: 'a', t2: 'b' }, { p: { tree: leaf(E(1)), focused: null, seq: 1 }, names: { t0: 'a' } }],
      ['tree null', { tree: null, focused: null, seq: 2 }, { t0: 'a' }, { p: { tree: null, focused: null, seq: 2 } }],
      ['사라진 고른 탭', { tree: two, focused: null, seq: 2, tab: 't9', tabSeq: 2 }, undefined, { p: { tree: two, focused: null, seq: 2, tabSeq: 2 } }],
      ['고른 탭 밖의 포커스', { tree: two, focused: E(1), seq: 2, tab: 't2', tabSeq: 2 }, undefined, { p: { tree: two, focused: null, seq: 2, tab: 't2', tabSeq: 2 } }],
    ]
    const got = rows.map(([name, p, given]) => {
      const r = reconcileIssuePanes(p, given)
      return [name, { p: r.p, ...(r.names !== undefined && { names: r.names }) }]
    })
    expect(got).toEqual(rows.map(([name, , , want]) => [name, want]))
    for (const [, p, given] of rows) {
      const r = reconcileIssuePanes(p, given)
      expectPanesInvariants(r.p, r.names)
    }
  })
})
