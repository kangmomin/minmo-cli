import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

import type { WorktreeEntry, WorktreePathStore } from '../lib/worktree'

export type WorkTab = 'terminal' | 'changes' | 'notes'

export interface UiState {
  expanded: Record<string, boolean>
  selectedIssueId: string | null
  tab: WorkTab
  /** EC-24: worktreeId(owner,repo,key) → 생성 당시 {path, branch} (persist) */
  worktreePathMap: Record<string, WorktreeEntry>
  terminalIds: Record<string, string>

  setExpanded(id: string, v: boolean): void
  selectIssue(id: string | null): void
  setTab(t: WorkTab): void
  setWorktree(id: string, e: WorktreeEntry): void
  removeWorktree(id: string): void
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      expanded: {},
      selectedIssueId: null,
      tab: 'terminal',
      worktreePathMap: {},
      terminalIds: {},
      setExpanded: (id, v) => set((s) => ({ expanded: { ...s.expanded, [id]: v } })),
      selectIssue: (selectedIssueId) => set({ selectedIssueId }),
      setTab: (tab) => set({ tab }),
      setWorktree: (id, e) => set((s) => ({ worktreePathMap: { ...s.worktreePathMap, [id]: e } })),
      removeWorktree: (id) =>
        set((s) => {
          const worktreePathMap = { ...s.worktreePathMap }
          delete worktreePathMap[id]
          const terminalIds = { ...s.terminalIds }
          delete terminalIds[id]
          return { worktreePathMap, terminalIds }
        }),
    }),
    {
      name: 'minmo-ui',
      storage: createJSONStorage(() => localStorage),
      // PTY 세션 id 는 프로세스 수명과 같으므로 재시작 후 의미가 없다 → 영속 대상에서 제외
      partialize: (s) => ({
        expanded: s.expanded,
        selectedIssueId: s.selectedIssueId,
        tab: s.tab,
        worktreePathMap: s.worktreePathMap,
      }),
    },
  ),
)

/** worktree 서비스에 넘기는 WorktreePathStore 어댑터 */
export function uiWorktreePathStore(): WorktreePathStore {
  return {
    get: (id) => useUiStore.getState().worktreePathMap[id],
    set: (id, entry) => useUiStore.getState().setWorktree(id, entry),
    delete: (id) => useUiStore.getState().removeWorktree(id),
  }
}
