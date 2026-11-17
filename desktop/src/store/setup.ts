import { create } from 'zustand'

import type { IssueTarget, ScriptOutcome, SetupLogEvent } from '@minmo/core'

export type IssueOpenState =
  | { phase: 'opening' }
  | { phase: 'ready'; path: string; branch: string; pathChanged: boolean }
  | { phase: 'error'; code: string; message: string; path?: string }

export type ScriptState = { status: 'running' } | ScriptOutcome

/** 로그 항목 — seq 는 단조 증가라 React key 로 쓴다(2000줄 상한 slice 로 인덱스가 밀려도 기존 줄의 memo 가 유지됨, CR-12) */
export type SetupLogEntry = SetupLogEvent & { seq: number }

export interface SetupState {
  /** 이슈 id → 열기 대상(제목·번호). 선택 상태 복원에 사용(메모리) */
  targets: Record<string, IssueTarget>
  open: Record<string, IssueOpenState>
  script: Record<string, ScriptState>
  logs: Record<string, SetupLogEntry[]>

  setTarget(id: string, t: IssueTarget): void
  /** 같은 이슈의 모든 열기 대상(호스트마다 id 가 다를 수 있음)의 제목을 바꾼다 — 머리줄·PR 초안이 이 제목을 읽는다 */
  renameIssue(owner: string, repo: string, number: number, title: string): void
  setOpen(id: string, s: IssueOpenState): void
  setScript(id: string, s: ScriptState): void
  appendLog(e: SetupLogEvent): void
  clearLog(id: string): void
}

/** 이슈별 로그 상한 2000줄 — 긴 npm ci 출력이 메모리를 잡아먹지 않도록 최근 것만 */
export const MAX_LOG_LINES = 2000

// 이슈·clearLog 와 무관하게 앱 수명 동안 증가 — key 가 재사용되지 않는다
let nextLogSeq = 0

export const useSetupStore = create<SetupState>()((set) => ({
  targets: {},
  open: {},
  script: {},
  logs: {},
  setTarget: (id, t) => set((s) => ({ targets: { ...s.targets, [id]: t } })),
  renameIssue: (owner, repo, number, title) =>
    set((s) => {
      const hit = (t: IssueTarget) => t.owner === owner && t.repo === repo && t.number === number && t.title !== title
      if (!Object.values(s.targets).some(hit)) return s
      return { targets: Object.fromEntries(Object.entries(s.targets).map(([id, t]) => [id, hit(t) ? { ...t, title } : t])) }
    }),
  setOpen: (id, o) => set((s) => ({ open: { ...s.open, [id]: o } })),
  setScript: (id, sc) => set((s) => ({ script: { ...s.script, [id]: sc } })),
  appendLog: (e) => {
    const entry: SetupLogEntry = { ...e, seq: ++nextLogSeq }
    set((s) => {
      const prev = s.logs[e.issueId] ?? []
      const next = prev.length >= MAX_LOG_LINES ? [...prev.slice(prev.length - MAX_LOG_LINES + 1), entry] : [...prev, entry]
      return { logs: { ...s.logs, [e.issueId]: next } }
    })
  },
  clearLog: (id) => set((s) => ({ logs: { ...s.logs, [id]: [] } })),
}))
