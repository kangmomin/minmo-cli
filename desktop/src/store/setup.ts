import { create } from 'zustand'

import type { IssueTarget, ScriptOutcome, SetupLogEvent } from '../lib/worktree'

export type IssueOpenState =
  | { phase: 'opening' }
  | { phase: 'ready'; path: string; branch: string; pathChanged: boolean }
  | { phase: 'error'; code: string; message: string; path?: string }

export type ScriptState = { status: 'running' } | ScriptOutcome

export interface SetupState {
  /** 이슈 id → 열기 대상(제목·번호). 선택 상태 복원에 사용(메모리) */
  targets: Record<string, IssueTarget>
  open: Record<string, IssueOpenState>
  script: Record<string, ScriptState>
  logs: Record<string, SetupLogEvent[]>

  setTarget(id: string, t: IssueTarget): void
  setOpen(id: string, s: IssueOpenState): void
  setScript(id: string, s: ScriptState): void
  appendLog(e: SetupLogEvent): void
  clearLog(id: string): void
}

/** [Assumption] 이슈별 로그 상한 2000줄 — 긴 npm ci 출력이 메모리를 잡아먹지 않도록 최근 것만 */
export const MAX_LOG_LINES = 2000

export const useSetupStore = create<SetupState>()((set) => ({
  targets: {},
  open: {},
  script: {},
  logs: {},
  setTarget: (id, t) => set((s) => ({ targets: { ...s.targets, [id]: t } })),
  setOpen: (id, o) => set((s) => ({ open: { ...s.open, [id]: o } })),
  setScript: (id, sc) => set((s) => ({ script: { ...s.script, [id]: sc } })),
  appendLog: (e) =>
    set((s) => {
      const prev = s.logs[e.issueId] ?? []
      const next = prev.length >= MAX_LOG_LINES ? [...prev.slice(prev.length - MAX_LOG_LINES + 1), e] : [...prev, e]
      return { logs: { ...s.logs, [e.issueId]: next } }
    }),
  clearLog: (id) => set((s) => ({ logs: { ...s.logs, [id]: [] } })),
}))
