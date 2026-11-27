// 답변 모드(#122)의 대기열 훅 — Workspace 가 한 번 부른다. 스텁: Phase 5.2(U9a)에서 구현한다(Plan §6).
import type { AgentRow } from '../agents/overview'
import type { Session } from './queue'

export interface AnswerQueue {
  /** 기다리는 세션(대기열 순서) */
  waiting: AgentRow[]
  /** 작업 중인 세션(이름순) */
  working: AgentRow[]
  /** 열 수 없는 세션 */
  blockedRows: AgentRow[]
  /** 지금 보이는 패널의 줄(없으면 null) */
  current: AgentRow | null
  session: Session | null
  /** 지금 세션보다 급한 세션들 */
  urgent: AgentRow[]
  pick(row: AgentRow): void
  skip(): void
  seeUrgent(): void
  /** polite 알림 글 */
  announce: string
  /** 오류 알림 글 */
  alert: string
}

export function useAnswerQueue(_enabled: boolean, _opts: { narrowListOpen: boolean }): AnswerQueue {
  return { waiting: [], working: [], blockedRows: [], current: null, session: null, urgent: [], pick: () => {}, skip: () => {}, seeUrgent: () => {}, announce: '', alert: '' }
}
