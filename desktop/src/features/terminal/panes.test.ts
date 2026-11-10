import { describe, expect, it } from 'vitest'

import { closePane, layoutPanes, leaf, leafIds, splitPane } from './panes'

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
