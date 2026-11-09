import { create } from 'zustand'

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

// STUB (Phase 6.1 Red): persist 미들웨어·액션은 6.2 에서 구현
export const useUiStore = create<UiState>()(() => ({
  expanded: {},
  selectedIssueId: null,
  tab: 'terminal',
  worktreePathMap: {},
  terminalIds: {},
  setExpanded: () => {},
  selectIssue: () => {},
  setTab: () => {},
  setWorktree: () => {},
  removeWorktree: () => {},
}))

/** worktree 서비스에 넘기는 WorktreePathStore 어댑터 */
export function uiWorktreePathStore(): WorktreePathStore {
  throw new Error('not implemented')
}
