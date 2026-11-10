// 터미널 패널 분할 레이아웃 — 이슈별 이진 분할 트리(순수 함수). 각 leaf 가 PTY 하나를 가진다.

/** row = 좌우(오른쪽에 새 패널), col = 상하(아래에 새 패널) */
export type SplitDir = 'row' | 'col'

export type PaneNode = { kind: 'leaf'; id: string } | { kind: 'split'; dir: SplitDir; a: PaneNode; b: PaneNode }

export const leaf = (id: string): PaneNode => ({ kind: 'leaf', id })

export function leafIds(tree: PaneNode | null): string[] {
  if (!tree) return []
  return tree.kind === 'leaf' ? [tree.id] : [...leafIds(tree.a), ...leafIds(tree.b)]
}

/** target 패널을 둘로 나눈다. 기존 패널은 왼쪽/위, 새 패널은 오른쪽/아래. target 이 없으면 그대로 */
export function splitPane(tree: PaneNode, target: string, dir: SplitDir, newId: string): PaneNode {
  if (tree.kind === 'leaf') return tree.id === target ? { kind: 'split', dir, a: tree, b: leaf(newId) } : tree
  const a = splitPane(tree.a, target, dir, newId)
  const b = a === tree.a ? splitPane(tree.b, target, dir, newId) : tree.b
  return a === tree.a && b === tree.b ? tree : { ...tree, a, b }
}

/**
 * target 패널을 닫는다. 형제가 그 자리를 채우고, 포커스는 형제 쪽의 첫 패널로 옮긴다.
 * 마지막 패널이면 tree=null. target 이 없으면 그대로(focus=null).
 */
export function closePane(tree: PaneNode, target: string): { tree: PaneNode | null; focus: string | null } {
  if (tree.kind === 'leaf') return tree.id === target ? { tree: null, focus: null } : { tree, focus: null }
  if (tree.a.kind === 'leaf' && tree.a.id === target) return { tree: tree.b, focus: leafIds(tree.b)[0] }
  if (tree.b.kind === 'leaf' && tree.b.id === target) return { tree: tree.a, focus: leafIds(tree.a).at(-1) ?? null }
  const left = closePane(tree.a, target)
  if (left.tree !== tree.a) return { tree: left.tree ? { ...tree, a: left.tree } : tree.b, focus: left.focus }
  const right = closePane(tree.b, target)
  if (right.tree !== tree.b) return { tree: right.tree ? { ...tree, b: right.tree } : tree.a, focus: right.focus }
  return { tree, focus: null }
}

/** 패널 위치(부모 대비 비율 0~1) */
export type PaneRect = { id: string; x: number; y: number; w: number; h: number }

/**
 * 트리를 평면 사각형 목록으로 펼친다. 패널은 이 목록을 id 로 key 해 같은 부모 아래 절대 배치한다 —
 * 트리 모양대로 중첩 렌더하면 분할할 때 기존 패널이 다시 마운트돼 PTY 가 새로 만들어지기 때문이다
 */
export function layoutPanes(tree: PaneNode | null, rect: Omit<PaneRect, 'id'> = { x: 0, y: 0, w: 1, h: 1 }): PaneRect[] {
  if (!tree) return []
  if (tree.kind === 'leaf') return [{ id: tree.id, ...rect }]
  const { x, y, w, h } = rect
  return tree.dir === 'row'
    ? [...layoutPanes(tree.a, { x, y, w: w / 2, h }), ...layoutPanes(tree.b, { x: x + w / 2, y, w: w / 2, h })]
    : [...layoutPanes(tree.a, { x, y, w, h: h / 2 }), ...layoutPanes(tree.b, { x, y: y + h / 2, w, h: h / 2 })]
}
