// 터미널 패널 분할 레이아웃 — 이슈별 이진 분할 트리(순수 함수). 각 leaf 가 PTY 하나를 가진다.

// Why: 기본·★기타는 탭이 2개 이상이면 루트가 TabsNode 라 트리 모양이 둘이다 —
// 소비처는 tabList·leafIds·tabOfPane 으로만 읽는다(tree.kind 를 직접 나누지 않는다).

/** row = 좌우(오른쪽에 새 패널), col = 상하(아래에 새 패널) */
export type SplitDir = 'row' | 'col'

export type PaneNode = { kind: 'leaf'; id: string } | { kind: 'split'; dir: SplitDir; a: PaneNode; b: PaneNode }

export const leaf = (id: string): PaneNode => ({ kind: 'leaf', id })

export type TermTab = { id: string; no: number; node: PaneNode }
export type TabsNode = { kind: 'tabs'; tabs: TermTab[] }
export type PaneTree = PaneNode | TabsNode
export const FIRST_TAB_ID = 't0'

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function isPaneNode(v: unknown, seen: Set<string>): boolean {
  if (!isObject(v)) return false
  if (v.kind === 'leaf') {
    if (typeof v.id !== 'string' || seen.has(v.id)) return false
    seen.add(v.id)
    return true
  }
  return v.kind === 'split' && (v.dir === 'row' || v.dir === 'col') && isPaneNode(v.a, seen) && isPaneNode(v.b, seen)
}

// Why: 공유 파일에서 받은 트리는 다른 기기·버전이 쓴 값이라 모양을 그대로 믿지 않는다
export function isPaneTree(v: unknown): v is PaneTree {
  if (!isObject(v)) return false
  const seen = new Set<string>()
  if (v.kind !== 'tabs') return isPaneNode(v, seen)
  if (!Array.isArray(v.tabs) || v.tabs.length === 0) return false
  const tabIds = new Set<string>()
  for (const t of v.tabs as unknown[]) {
    if (!isObject(t) || typeof t.id !== 'string' || tabIds.has(t.id) || typeof t.no !== 'number' || !isPaneNode(t.node, seen)) return false
    tabIds.add(t.id)
  }
  return true
}

const nodeLeaves = (node: PaneNode): string[] => (node.kind === 'leaf' ? [node.id] : [...nodeLeaves(node.a), ...nodeLeaves(node.b)])

export function tabList(tree: PaneTree | null): TermTab[] {
  if (!isPaneTree(tree)) return []
  return tree.kind === 'tabs' ? tree.tabs : [{ id: FIRST_TAB_ID, no: 1, node: tree }]
}

export function activeTabOf(tree: PaneTree | null, tabId: string | undefined): TermTab | null {
  const tabs = tabList(tree)
  return tabs.find((t) => t.id === tabId) ?? tabs[0] ?? null
}

export function selectedTabId(tree: PaneTree | null, tabId: string | undefined): string | null {
  return activeTabOf(tree, tabId)?.id ?? null
}

export function tabOfPane(tree: PaneTree | null, paneId: string): string | null {
  return tabList(tree).find((t) => nodeLeaves(t.node).includes(paneId))?.id ?? null
}

export function addTab(tree: PaneTree | null, tab: TermTab): TabsNode {
  return { kind: 'tabs', tabs: [...tabList(tree), tab] }
}

export function removeTab(tree: PaneTree, tabId: string): { tree: PaneTree | null; focus: string | null } {
  const tabs = tabList(tree)
  const i = tabs.findIndex((t) => t.id === tabId)
  if (i < 0) return { tree, focus: null }
  const rest = tabs.filter((_, j) => j !== i)
  const next = rest[i] ?? rest[i - 1]
  if (!next) return { tree: null, focus: null }
  return { tree: { kind: 'tabs', tabs: rest }, focus: nodeLeaves(next.node)[0] }
}

export function leafIds(tree: PaneTree | null): string[] {
  return tabList(tree).flatMap((t) => nodeLeaves(t.node))
}

function splitNode(node: PaneNode, target: string, dir: SplitDir, newId: string): PaneNode {
  if (node.kind === 'leaf') return node.id === target ? { kind: 'split', dir, a: node, b: leaf(newId) } : node
  const a = splitNode(node.a, target, dir, newId)
  const b = a === node.a ? splitNode(node.b, target, dir, newId) : node.b
  return a === node.a && b === node.b ? node : { ...node, a, b }
}

/** target 패널을 둘로 나눈다. 기존 패널은 왼쪽/위, 새 패널은 오른쪽/아래. target 이 없으면 그대로 */
export function splitPane(tree: PaneNode, target: string, dir: SplitDir, newId: string): PaneNode
export function splitPane(tree: PaneTree, target: string, dir: SplitDir, newId: string): PaneTree
export function splitPane(tree: PaneTree, target: string, dir: SplitDir, newId: string): PaneTree {
  if (!isPaneTree(tree)) return tree
  if (tree.kind !== 'tabs') return splitNode(tree, target, dir, newId)
  const tabs = tree.tabs.map((t) => {
    const node = splitNode(t.node, target, dir, newId)
    return node === t.node ? t : { ...t, node }
  })
  return tabs.every((t, i) => t === tree.tabs[i]) ? tree : { ...tree, tabs }
}

function closeNode(node: PaneNode, target: string): { tree: PaneNode | null; focus: string | null } {
  if (node.kind === 'leaf') return node.id === target ? { tree: null, focus: null } : { tree: node, focus: null }
  if (node.a.kind === 'leaf' && node.a.id === target) return { tree: node.b, focus: nodeLeaves(node.b)[0] }
  if (node.b.kind === 'leaf' && node.b.id === target) return { tree: node.a, focus: nodeLeaves(node.a).at(-1) ?? null }
  const left = closeNode(node.a, target)
  if (left.tree !== node.a) return { tree: left.tree ? { ...node, a: left.tree } : node.b, focus: left.focus }
  const right = closeNode(node.b, target)
  if (right.tree !== node.b) return { tree: right.tree ? { ...node, b: right.tree } : node.a, focus: right.focus }
  return { tree: node, focus: null }
}

/**
 * target 패널을 닫는다. 형제가 그 자리를 채우고, 포커스는 형제 쪽의 첫 패널로 옮긴다.
 * 마지막 패널이면 tree=null. target 이 없으면 그대로(focus=null).
 */
export function closePane(tree: PaneNode, target: string): { tree: PaneNode | null; focus: string | null }
export function closePane(tree: PaneTree, target: string): { tree: PaneTree | null; focus: string | null }
export function closePane(tree: PaneTree, target: string): { tree: PaneTree | null; focus: string | null } {
  if (!isPaneTree(tree)) return { tree, focus: null }
  if (tree.kind !== 'tabs') return closeNode(tree, target)
  const i = tree.tabs.findIndex((t) => nodeLeaves(t.node).includes(target))
  if (i < 0) return { tree, focus: null }
  const tab = tree.tabs[i]
  const closed = closeNode(tab.node, target)
  if (!closed.tree) return removeTab(tree, tab.id)
  return { tree: { ...tree, tabs: tree.tabs.map((t, j) => (j === i ? { ...t, node: closed.tree! } : t)) }, focus: closed.focus }
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
