// 답변 모드(#122)의 대기열 규칙 — 순수 함수(상태 기계). 화면·타이머는 useAnswerQueue 가 맡는다.
// 스텁 — Phase 5.2(U3)에서 구현한다(Plan §3).
import type { AgentStatus } from '../agents/agentStore'
import type { AgentRow } from '../agents/overview'
import type { PaneNode } from '../terminal/panes'

/** 답을 보낸 뒤(마지막 입력 뒤) 이만큼 지나야 넘어간다 */
export const ADVANCE_INPUT_GUARD_MS = 2000
/** 작업 중이 된 뒤 이 시간 안의 입력은 "답을 보낸 입력"으로 본다(이어서 치는 중이 아님) */
export const ECHO_GRACE_MS = 400
/** 에이전트가 끝난 뒤(패널을 닫은 뒤) 이만큼 지나야 넘어간다 */
export const ENDED_CONFIRM_MS = 1000
/** 진입 때 지금 패널의 줄이 잡히기를 기다리는 시간 */
export const ENTRY_GRACE_MS = 5000
/** 자동 이동의 열기 시간 제한 */
export const AUTO_OPEN_DEADLINE_MS = 15000
/** 사용자가 고른 줄·진입의 열기 시간 제한 */
export const PICK_OPEN_DEADLINE_MS = 30000

/** 지금 보이는 것 — 고른 이슈와 그 이슈에서 보이는 패널 */
export type Shown = { issueId: string | null; paneId: string | null }

/** 보이는 것(shown)에 붙은 메타데이터 */
export type Session = {
  issueId: string | null
  paneId: string | null
  /** 화면에 보인 동안 기다리는 상태였다 */
  shownWaiting: boolean
  /** 마지막 기다림이 시작된 시각 */
  waitStart: number | null
  /** 보이기 시작한 기다림 상태(작업 중이면 null) */
  shownStatus: AgentStatus | null
  /** 이 세션에서 에이전트 줄을 본 적이 있다 */
  agentSeen: boolean
  /** 에이전트가 없어진 것을 처음 본 때 */
  goneAt: number | null
  /** 에이전트를 본 패널을 닫아 옆 패널로 바뀐 때 */
  closedAt: number | null
}

/** 진입 판단 — until null = 지금 이슈를 여는 중 */
export type Entry = { issueId: string | null; startedAt: number; until: number | null }

export type PendingReason = 'answered' | 'ended' | 'entry' | 'skip' | 'pick'

/** 이동 중 — from 은 이동을 시작한 때 보이던 것(실패하면 그곳으로 되돌린다), at 은 시작 시각 */
export type Pending = { token: number; issueId: string; paneId: string; row: AgentRow; from: Shown; at: number; reason: PendingReason }

/** rowKey → 건너뛴 때의 waitingSince·순번 */
export type Skipped = Record<string, { waitingSince: number; seq: number }>
/** rowKey → 열 수 없음(자동 이동 대상에서 뺀다) */
export type Blocked = Record<string, true>

export type QueueState = { session: Session | null; entry: Entry | null; pending: Pending | null; skipped: Skipped; blocked: Blocked }

export type StepInput = {
  now: number
  shown: Shown
  /** 보이는 이슈가 이 창에서 phase ready */
  shownReady: boolean
  /** answerRows 중 shown 패널의 줄 */
  row: AgentRow | null
  /** agentStore 에 shown 패널 항목이 있다('기타' 포함) */
  paneHasAgent: boolean
  /** session 의 패널이 아직 트리에 있다 */
  sessionPaneExists: boolean
  /** shown 패널의 마지막 입력 시각(패널이 없으면 0) */
  lastInput: number
  /** pending 이 있으면 pending.from 패널의 마지막 입력 시각 */
  fromInput: number
  /** queueOrder 의 기다리는 줄 */
  waiting: AgentRow[]
  overlay: boolean
  narrowListOpen: boolean
}

export type StepResult = { state: QueueState; go?: { row: AgentRow; reason: 'answered' | 'ended' | 'entry' }; cancelled?: true }

/** 대기열에 오르는 줄 — 이 PC·알려진 에이전트·이슈를 아는 줄, 그 이슈의 패널 트리에 있는 패널만 */
export function answerRows(_rows: AgentRow[], _panes: Record<string, { tree: PaneNode | null } | undefined>): AgentRow[] {
  return []
}

export function isWaiting(_status: AgentStatus): boolean {
  return false
}

export function skipRow(skipped: Skipped, _row: AgentRow): Skipped {
  return skipped
}

export function queueOrder(_rows: AgentRow[], _skipped: Skipped, _blocked: Blocked): { waiting: AgentRow[]; working: AgentRow[]; blockedRows: AgentRow[] } {
  return { waiting: [], working: [], blockedRows: [] }
}

export function urgentRows(_waiting: AgentRow[], _session: Session | null, _skipped: Skipped): AgentRow[] {
  return []
}

const inert: Session = { issueId: null, paneId: null, shownWaiting: false, waitStart: null, shownStatus: null, agentSeen: false, goneAt: null, closedAt: null }

export function sessionFromRow(_row: AgentRow): Session {
  return { ...inert }
}

export function newSession(_shown: Shown): Session {
  return { ...inert }
}

export function blockRow(state: QueueState, _row: AgentRow): QueueState {
  return state
}

export function step(state: QueueState, _input: StepInput): StepResult {
  return { state }
}

export function beginPending(state: QueueState, _row: AgentRow, _token: number, _from: Shown, _now: number, _reason: PendingReason): QueueState {
  return state
}

export function hitPending(state: QueueState, _row: AgentRow): QueueState {
  return state
}

export function failPending(state: QueueState, _row: AgentRow): QueueState {
  return state
}

export function startEntry(state: QueueState, _shown: Shown, _now: number): QueueState {
  return state
}

export function entryReady(state: QueueState, _now: number): QueueState {
  return state
}

export function cancelAll(state: QueueState): QueueState {
  return state
}
