import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

import { closePane, leaf, leafIds, splitPane } from '../features/terminal/panes'
import type { PaneNode, SplitDir } from '../features/terminal/panes'
import type { WorktreeEntry, WorktreePathStore } from '../lib/worktree'

export type WorkTab = 'terminal' | 'changes' | 'notes'
export type Theme = 'black' | 'light'

/** 이슈별 터미널 패널 배치. tree=null 이면 모든 패널을 닫은 상태 */
export type IssuePanes = { tree: PaneNode | null; focused: string | null; seq: number }

export interface UiState {
  expanded: Record<string, boolean>
  selectedIssueId: string | null
  tab: WorkTab
  /** EC-24: worktreeId(owner,repo,key) → 생성 당시 {path, branch} (persist) */
  worktreePathMap: Record<string, WorktreeEntry>
  /** paneId → PTY id (프로세스 수명과 같아 persist 하지 않음) */
  terminalIds: Record<string, string>
  theme: Theme
  panes: Record<string, IssuePanes>
  /** 사용자가 분할·닫기를 했을 때만 포커스를 옮긴다 — token 이 바뀐 요청만 처리(자동 포커스 금지 AX-02) */
  focusRequest: { paneId: string; token: number } | null

  setExpanded(id: string, v: boolean): void
  selectIssue(id: string | null): void
  setTab(t: WorkTab): void
  setWorktree(id: string, e: WorktreeEntry): void
  removeWorktree(id: string): void
  setTheme(t: Theme): void
  ensurePanes(issueId: string): void
  splitPane(issueId: string, paneId: string, dir: SplitDir): void
  closePane(issueId: string, paneId: string): void
  focusPane(issueId: string, paneId: string): void
  /** 모든 패널을 닫은 뒤 [새 터미널] */
  newPane(issueId: string): void
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      expanded: {},
      selectedIssueId: null,
      tab: 'terminal',
      worktreePathMap: {},
      terminalIds: {},
      theme: 'black',
      panes: {},
      focusRequest: null,
      setExpanded: (id, v) => set((s) => ({ expanded: { ...s.expanded, [id]: v } })),
      selectIssue: (selectedIssueId) => set({ selectedIssueId }),
      setTab: (tab) => set({ tab }),
      setWorktree: (id, e) => set((s) => ({ worktreePathMap: { ...s.worktreePathMap, [id]: e } })),
      removeWorktree: (id) =>
        set((s) => {
          const worktreePathMap = { ...s.worktreePathMap }
          delete worktreePathMap[id]
          const terminalIds = { ...s.terminalIds }
          for (const pane of leafIds(s.panes[id]?.tree ?? null)) delete terminalIds[pane]
          const panes = { ...s.panes }
          delete panes[id]
          // 다시 만들면 패널 번호가 1부터 다시 시작한다 — 남은 요청이 새 터미널을 자동 포커스하지 않게 지운다
          const focusRequest = s.focusRequest?.paneId.startsWith(`${id}::`) ? null : s.focusRequest
          return { worktreePathMap, terminalIds, panes, focusRequest }
        }),
      setTheme: (theme) => set({ theme }),
      ensurePanes: (issueId) =>
        set((s) => (s.panes[issueId] ? s : { panes: { ...s.panes, [issueId]: { tree: leaf(paneIdOf(issueId, 1)), focused: null, seq: 1 } } })),
      splitPane: (issueId, paneId, dir) =>
        set((s) => {
          const cur = s.panes[issueId]
          if (!cur?.tree) return s
          const seq = cur.seq + 1
          const newId = paneIdOf(issueId, seq)
          const tree = splitPane(cur.tree, paneId, dir, newId)
          if (tree === cur.tree) return s
          return {
            panes: { ...s.panes, [issueId]: { tree, focused: newId, seq } },
            focusRequest: { paneId: newId, token: (s.focusRequest?.token ?? 0) + 1 },
          }
        }),
      closePane: (issueId, paneId) =>
        set((s) => {
          const cur = s.panes[issueId]
          if (!cur?.tree) return s
          const { tree, focus } = closePane(cur.tree, paneId)
          if (tree === cur.tree) return s
          return {
            panes: { ...s.panes, [issueId]: { ...cur, tree, focused: focus } },
            focusRequest: focus ? { paneId: focus, token: (s.focusRequest?.token ?? 0) + 1 } : s.focusRequest,
          }
        }),
      focusPane: (issueId, paneId) =>
        set((s) => {
          const cur = s.panes[issueId]
          return !cur || cur.focused === paneId ? s : { panes: { ...s.panes, [issueId]: { ...cur, focused: paneId } } }
        }),
      newPane: (issueId) =>
        set((s) => {
          const cur = s.panes[issueId]
          if (cur?.tree) return s
          const seq = (cur?.seq ?? 0) + 1
          const id = paneIdOf(issueId, seq)
          return {
            panes: { ...s.panes, [issueId]: { tree: leaf(id), focused: id, seq } },
            focusRequest: { paneId: id, token: (s.focusRequest?.token ?? 0) + 1 },
          }
        }),
    }),
    {
      name: 'minmo-ui',
      storage: createJSONStorage(() => localStorage),
      // Plan 은 terminal ids 도 persist 였으나 PTY 세션 id 는 프로세스 수명과 같아 재시작 후 의미가 없다 → 영속 대상에서 제외
      partialize: (s) => ({
        expanded: s.expanded,
        selectedIssueId: s.selectedIssueId,
        tab: s.tab,
        worktreePathMap: s.worktreePathMap,
        theme: s.theme,
      }),
    },
  ),
)

/** 패널 id: 이슈 안에서 단조 증가하는 번호 */
export const paneIdOf = (issueId: string, seq: number) => `${issueId}::${seq}`

/** worktree 서비스에 넘기는 WorktreePathStore 어댑터 */
export function uiWorktreePathStore(): WorktreePathStore {
  return {
    get: (id) => useUiStore.getState().worktreePathMap[id],
    set: (id, entry) => useUiStore.getState().setWorktree(id, entry),
    delete: (id) => useUiStore.getState().removeWorktree(id),
  }
}
