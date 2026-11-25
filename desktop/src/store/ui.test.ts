// UI store — 트리에서 이슈를 눌렀을 때의 터미널 포커스 요청(#78)·이슈 선택 번호
import { beforeEach, describe, expect, it } from 'vitest'

import { useUiStore } from './ui'

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
