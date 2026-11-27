import { describe, expect, it } from 'vitest'

import { FIRST_TAB_ID, activeTabOf, addTab, closePane, isPaneTree, layoutPanes, leaf, leafIds, removeTab, selectedTabId, splitPane, tabList, tabOfPane } from './panes'
import type { PaneNode, PaneTree, TabsNode, TermTab } from './panes'

describe('패널 분할 트리', () => {
  it('split: 기존 패널은 왼쪽/위, 새 패널은 오른쪽/아래 · 없는 대상은 그대로', () => {
    const t1 = splitPane(leaf('p1'), 'p1', 'row', 'p2')
    expect(t1).toEqual({ kind: 'split', dir: 'row', a: leaf('p1'), b: leaf('p2') })
    const t2 = splitPane(t1, 'p2', 'col', 'p3')
    expect(leafIds(t2)).toEqual(['p1', 'p2', 'p3'])
    expect(splitPane(t2, 'nope', 'row', 'p4')).toBe(t2)
  })

  it('close: 형제가 자리를 채우고 포커스는 형제 쪽으로, 마지막이면 null', () => {
    const t = splitPane(splitPane(leaf('p1'), 'p1', 'row', 'p2'), 'p2', 'col', 'p3')
    // p1 | (p2 / p3)
    const a = closePane(t, 'p3')
    expect(a.tree).toEqual({ kind: 'split', dir: 'row', a: leaf('p1'), b: leaf('p2') })
    expect(a.focus).toBe('p2')
    const b = closePane(t, 'p1')
    expect(leafIds(b.tree)).toEqual(['p2', 'p3'])
    expect(b.focus).toBe('p2')
    expect(closePane(leaf('p1'), 'p1')).toEqual({ tree: null, focus: null })
    expect(closePane(t, 'nope')).toEqual({ tree: t, focus: null })
  })

  it('layout: 반씩 나눈 평면 사각형', () => {
    const t = splitPane(splitPane(leaf('p1'), 'p1', 'row', 'p2'), 'p2', 'col', 'p3')
    expect(layoutPanes(t)).toEqual([
      { id: 'p1', x: 0, y: 0, w: 0.5, h: 1 },
      { id: 'p2', x: 0.5, y: 0, w: 0.5, h: 0.5 },
      { id: 'p3', x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
    ])
    expect(layoutPanes(null)).toEqual([])
  })
})

// #120 터미널 탭 — 기본·★기타의 트리는 탭이 2개 이상이면 루트가 TabsNode 다. 패널 id·seq 는 이슈마다 하나라 탭 사이에 겹치지 않는다
describe('터미널 탭 트리 (#120)', () => {
  const P1 = 'o/r#etc::1'
  const P2 = 'o/r#etc::2'
  const P3 = 'o/r#etc::3'
  const P4 = 'o/r#etc::4'
  const tabsOf = (...tabs: TermTab[]): TabsNode => ({ kind: 'tabs', tabs })
  /** t0 = 탭 없는 트리를 감싼 첫 탭, 그 뒤 탭 id 는 그 탭 첫 패널의 seq */
  const T0 = (node: PaneNode = leaf(P1)): TermTab => ({ id: 't0', no: 1, node })
  const T2 = (node: PaneNode = leaf(P2)): TermTab => ({ id: 't2', no: 2, node })
  const T3 = (node: PaneNode = leaf(P3)): TermTab => ({ id: 't3', no: 3, node })

  it('AC-04 addTab: 탭 없는 트리는 먼저 t0(번호 1)로 감싸고 새 탭을 뒤에 붙인다 · leafIds 는 모든 탭의 패널', () => {
    const t = addTab(leaf(P1), T2())
    expect(t).toEqual(tabsOf(T0(), T2()))
    expect(addTab(t, T3())).toEqual(tabsOf(T0(), T2(), T3()))
    expect(leafIds(addTab(t, T3()))).toEqual([P1, P2, P3])
  })

  it('AC-07 split·close 는 그 패널이 있는 탭 안에서만 동작하고, 대상이 없으면 같은 참조를 돌려준다', () => {
    const t = tabsOf(T0(), T2())
    const split = splitPane(t, P2, 'row', P3)
    expect(split).toEqual(tabsOf(T0(), T2(splitPane(leaf(P2), P2, 'row', P3))))
    expect(splitPane(t, 'nope', 'row', P3)).toBe(t)
    const closed = closePane(split, P3)
    expect(closed).toEqual({ tree: t, focus: P2 })
    expect(closePane(t, 'nope').tree).toBe(t)
  })

  it('AC-11 탭의 마지막 패널을 닫으면 그 탭을 빼고 이웃 탭(오른쪽, 없으면 왼쪽)의 첫 패널로 포커스 · 마지막 탭이면 tree=null', () => {
    const t = tabsOf(T0(), T2(), T3(splitPane(leaf(P3), P3, 'row', P4)))
    expect(closePane(t, P2)).toEqual({ tree: tabsOf(T0(), T3(splitPane(leaf(P3), P3, 'row', P4))), focus: P3 })
    expect(closePane(tabsOf(T0(), T2()), P2)).toEqual({ tree: tabsOf(T0()), focus: P1 })
    expect(closePane(tabsOf(T0()), P1)).toEqual({ tree: null, focus: null })
  })

  it('EC-15 removeTab: 이웃 규칙은 closePane 과 같다(오른쪽, 없으면 왼쪽) · 마지막 탭이면 tree=null', () => {
    const t = tabsOf(T0(), T2(), T3())
    expect(removeTab(t, 't2')).toEqual({ tree: tabsOf(T0(), T3()), focus: P3 })
    expect(removeTab(t, 't3')).toEqual({ tree: tabsOf(T0(), T2()), focus: P2 })
    expect(removeTab(tabsOf(T0()), 't0')).toEqual({ tree: null, focus: null })
  })

  it('AC-17 고른 탭: 값이 없거나(undefined) 사라졌으면 첫 탭 — activeTabOf·selectedTabId', () => {
    const t = tabsOf(T0(), T2())
    expect(activeTabOf(t, 't2')).toEqual(T2())
    expect(selectedTabId(t, undefined)).toBe('t0')
    expect(selectedTabId(t, 't9')).toBe('t0')
    expect(selectedTabId(leaf(P1), undefined)).toBe('t0')
    expect(selectedTabId(null, undefined)).toBeNull()
  })

  it('AC-18 tabOfPane: 패널이 있는 탭 id — 탭 없는 트리의 패널은 t0, 없는 패널은 null', () => {
    const t = tabsOf(T0(), T2(splitPane(leaf(P2), P2, 'row', P3)))
    expect(tabOfPane(t, P3)).toBe('t2')
    expect(tabOfPane(t, P1)).toBe('t0')
    expect(tabOfPane(leaf(P1), P1)).toBe('t0')
    expect(tabOfPane(t, 'nope')).toBeNull()
  })

  it('EC-09′ isPaneTree: 모양이 맞는 트리만 받는다(leaf id 글자 · split dir row|col · 탭 1개 이상 · 탭 id 글자 · no 숫자 · node 유효 · 패널 id·탭 id 중복 없음)', () => {
    const rows: [string, unknown, boolean][] = [
      ['leaf', leaf(P1), true],
      ['split', splitPane(leaf(P1), P1, 'col', P2), true],
      ['탭 2개', { kind: 'tabs', tabs: [T0(), T2()] }, true],
      ['빈 탭 목록', { kind: 'tabs', tabs: [] }, false],
      ['leaf id 가 글자가 아님', { kind: 'leaf', id: 3 }, false],
      ['split dir 이 row|col 이 아님', { kind: 'split', dir: 'x', a: leaf(P1), b: leaf(P2) }, false],
      ['탭 no 가 숫자가 아님', { kind: 'tabs', tabs: [{ id: 't0', no: '1', node: leaf(P1) }] }, false],
      ['탭 node 가 깨짐', { kind: 'tabs', tabs: [{ id: 't0', no: 1, node: { kind: 'weird' } }] }, false],
      ['패널 id 가 탭 사이에 겹침', { kind: 'tabs', tabs: [T0(), { id: 't2', no: 2, node: leaf(P1) }] }, false],
      ['탭 id 가 겹침', { kind: 'tabs', tabs: [T0(), { id: 't0', no: 2, node: leaf(P2) }] }, false],
      ['알 수 없는 모양', { kind: 'weird' }, false],
    ]
    expect(rows.map(([name, v]) => [name, isPaneTree(v)])).toEqual(rows.map(([name, , valid]) => [name, valid]))
  })

  it('EC-09′ 깨진 트리·null 은 탭·패널이 없는 것으로 읽고, 이전 버전의 트리(탭 없음)는 탭 "1" 하나로 읽는다', () => {
    const broken = { kind: 'weird' } as unknown as PaneTree
    expect(tabList(broken)).toEqual([])
    expect(leafIds(broken)).toEqual([])
    expect(tabList(null)).toEqual([])
    expect(tabList(leaf(P1))).toEqual([{ id: FIRST_TAB_ID, no: 1, node: leaf(P1) }])
  })
})
