// Why: 순수 함수(상태 기계)로 둔다 — 화면·타이머는 useAnswerQueue 가 맡는다(#122).
import { statusRank } from '../agents/agentStore'
import type { AgentStatus } from '../agents/agentStore'
import { byName, rowKey } from '../agents/overview'
import type { AgentRow } from '../agents/overview'
import { leafIds } from '../terminal/panes'
import type { PaneNode } from '../terminal/panes'

/** Why: 답을 보낸 뒤(마지막 입력 뒤) 이만큼 지나야 넘어간다 */
export const ADVANCE_INPUT_GUARD_MS = 2000
/** Why: 작업 중이 된 뒤 이 시간 안의 입력은 "답을 보낸 입력"으로 본다(이어서 치는 중이 아님) */
export const ECHO_GRACE_MS = 400
/** Why: 에이전트가 끝난 뒤(패널을 닫은 뒤) 이만큼 지나야 넘어간다 */
export const ENDED_CONFIRM_MS = 1000
/** Why: 진입 때 지금 패널의 줄이 잡히기를 기다리는 시간 */
export const ENTRY_GRACE_MS = 5000
/** Why: 자동 이동의 열기 시간 제한 */
export const AUTO_OPEN_DEADLINE_MS = 15000
/** Why: 사용자가 고른 줄·진입의 열기 시간 제한 */
export const PICK_OPEN_DEADLINE_MS = 30000

export type Shown = { issueId: string | null; paneId: string | null }

export type Session = {
  issueId: string | null
  paneId: string | null
  /** Why: 화면에 보인 동안 기다리는 상태였다 */
  shownWaiting: boolean
  waitStart: number | null
  /** Why: 보이기 시작한 기다림 상태(작업 중이면 null) */
  shownStatus: AgentStatus | null
  /** Why: 이 세션에서 에이전트 줄을 본 적이 있다 */
  agentSeen: boolean
  /** Why: 에이전트가 없어진 것을 처음 본 때 */
  goneAt: number | null
  /** Why: 에이전트를 본 패널을 닫아 옆 패널로 바뀐 때 */
  closedAt: number | null
}

/** Why: 진입 판단 — until null = 지금 이슈를 여는 중 */
export type Entry = { issueId: string | null; startedAt: number; until: number | null }

export type PendingReason = 'answered' | 'ended' | 'entry' | 'skip' | 'pick'

/** Why: 이동 중 — from 은 이동을 시작한 때 보이던 것(실패하면 그곳으로 되돌린다), at 은 시작 시각 */
export type Pending = { token: number; issueId: string; paneId: string; row: AgentRow; from: Shown; at: number; reason: PendingReason }

/** Why: rowKey → 건너뛴 때의 waitingSince·순번 */
export type Skipped = Record<string, { waitingSince: number; seq: number }>
/** Why: rowKey → 열 수 없음(자동 이동 대상에서 뺀다) */
export type Blocked = Record<string, true>

export type QueueState = { session: Session | null; entry: Entry | null; pending: Pending | null; skipped: Skipped; blocked: Blocked }

export type StepInput = {
  now: number
  shown: Shown
  shownReady: boolean
  row: AgentRow | null
  /** Why: agentStore 에 shown 패널 항목이 있다('기타' 포함) */
  paneHasAgent: boolean
  sessionPaneExists: boolean
  /** Why: shown 패널의 마지막 입력 시각(패널이 없으면 0) */
  lastInput: number
  /** Why: pending 이 있으면 pending.from 패널의 마지막 입력 시각 */
  fromInput: number
  waiting: AgentRow[]
  overlay: boolean
  narrowListOpen: boolean
}

export type StepResult = { state: QueueState; go?: { row: AgentRow; reason: 'answered' | 'ended' | 'entry' }; cancelled?: true }

/** Why: 대기열에 오르는 줄 — 이 PC·알려진 에이전트·이슈를 아는 줄, 그 이슈의 패널 트리에 있는 패널만 */
export function answerRows(rows: AgentRow[], panes: Record<string, { tree: PaneNode | null } | undefined>): AgentRow[] {
  return rows.filter((r) => {
    if (r.peer !== undefined || r.agent === 'other' || r.target === null) return false
    const p = panes[r.issueId]
    return p === undefined || leafIds(p.tree).includes(r.paneId)
  })
}

export function isWaiting(status: AgentStatus): boolean {
  return status !== 'working'
}

/** Why: 지난 시간의 시작 — 작업 중이면 작업을 시작한 때, 기다리면 기다리기 시작한 때 */
export const sinceOf = (r: AgentRow) => (r.status === 'working' ? r.since : (r.waitingSince ?? r.since))

/** Why: 건너뛴 기록은 그때의 기다림에만 쓴다 — 다시 기다리는 상태가 되면(waitingSince 가 바뀜) 원래 순서로 돌아온다. */
const skipOf = (skipped: Skipped, r: AgentRow) => {
  const s = skipped[rowKey(r)]
  return s !== undefined && s.waitingSince === r.waitingSince ? s : undefined
}

export function skipRow(skipped: Skipped, row: AgentRow): Skipped {
  if (row.waitingSince === null) return skipped
  const seq = Math.max(0, ...Object.values(skipped).map((s) => s.seq)) + 1
  return { ...skipped, [rowKey(row)]: { waitingSince: row.waitingSince, seq } }
}

export function queueOrder(
  rows: AgentRow[],
  skipped: Skipped,
  blocked: Blocked,
): { waiting: AgentRow[]; working: AgentRow[]; blockedRows: AgentRow[] } {
  const waitingAll = rows.filter((r) => isWaiting(r.status))
  const open = waitingAll.filter((r) => blocked[rowKey(r)] !== true)
  const fresh = open
    .filter((r) => !skipOf(skipped, r))
    .sort((a, b) => statusRank(a.status) - statusRank(b.status) || (a.waitingSince ?? 0) - (b.waitingSince ?? 0) || byName(a, b))
  const later = open.filter((r) => skipOf(skipped, r)).sort((a, b) => (skipOf(skipped, a)?.seq ?? 0) - (skipOf(skipped, b)?.seq ?? 0))
  return {
    waiting: [...fresh, ...later],
    working: rows.filter((r) => !isWaiting(r.status)).sort(byName),
    blockedRows: waitingAll.filter((r) => blocked[rowKey(r)] === true).sort(byName),
  }
}

export function urgentRows(waiting: AgentRow[], session: Session | null, skipped: Skipped): AgentRow[] {
  if (session === null || session.shownStatus === null) return []
  const { paneId } = session
  const rank = statusRank(session.shownStatus)
  return waiting.filter((r) => r.paneId !== paneId && !skipOf(skipped, r) && statusRank(r.status) < rank)
}

export function sessionFromRow(row: AgentRow): Session {
  const waiting = isWaiting(row.status)
  return { ...newSession(row), shownWaiting: waiting, waitStart: row.waitingSince, shownStatus: waiting ? row.status : null, agentSeen: true }
}

export function newSession(shown: Shown): Session {
  return {
    issueId: shown.issueId,
    paneId: shown.paneId,
    shownWaiting: false,
    waitStart: null,
    shownStatus: null,
    agentSeen: false,
    goneAt: null,
    closedAt: null,
  }
}

export function blockRow(state: QueueState, row: AgentRow): QueueState {
  return { ...state, blocked: { ...state.blocked, [rowKey(row)]: true } }
}

function follow(prev: Session | null, input: StepInput): Session {
  const { shown } = input
  if (prev !== null && prev.issueId === shown.issueId && prev.paneId === shown.paneId) return prev
  const closed = prev !== null && prev.issueId === shown.issueId && !input.sessionPaneExists && prev.agentSeen
  return { ...newSession(shown), closedAt: closed ? input.now : null }
}

function observe(s: Session, input: StepInput): Session {
  const { row } = input
  const next = { ...s }
  if (row) {
    next.agentSeen = true
    next.goneAt = null
    if (isWaiting(row.status)) {
      next.shownWaiting = true
      next.waitStart = row.waitingSince
      next.shownStatus ??= row.status
      next.closedAt = null
    } else next.shownStatus = null
  }
  // Why: '기타'가 돌 때 끝난 때를 지우면, 그것이 끝날 때 새로 기록해 그 앞의 입력(npm test 등)을 못 본다.
  if (!row && !input.paneHasAgent && next.agentSeen && next.goneAt === null) {
    // Why: 같은 패널에서 새로 띄운 에이전트가 지난 기다림을 물려받으면, 띄우려고 친 입력을 "답을 보냄"으로 읽는다.
    return { ...next, goneAt: input.now, shownWaiting: false, waitStart: null, shownStatus: null }
  }
  return next
}

export function step(state: QueueState, input: StepInput): StepResult {
  const { now, shown, row, lastInput } = input
  const { pending } = state
  if (pending) {
    // Why: 이동 중 같은 이슈 안의 화면 변화는 열기 과정이라 사용자 선택이 아니다 — 다른 이슈를 고르거나 옛 패널에 쳐야 취소한다.
    const elsewhere = shown.issueId !== pending.from.issueId && shown.issueId !== pending.issueId
    const typedInFrom = shown.issueId === pending.from.issueId && shown.paneId === pending.from.paneId && input.fromInput > pending.at
    if (!elsewhere && !typedInFrom) return { state }
  }
  const cancelled = pending !== null

  const session = observe(follow(state.session, input), input)
  let entry = state.entry !== null && state.entry.issueId === shown.issueId ? state.entry : null
  let blocked = state.blocked
  if (row && input.shownReady && blocked[rowKey(row)] === true) {
    // Why: 줄은 공유 PTY 목록에서 와서 열 수 있다는 증거가 아니다 — 이 창에서 열려 보일 때만 푼다.
    blocked = { ...blocked }
    delete blocked[rowKey(row)]
  }
  const done = (go?: StepResult['go']): StepResult => {
    const next: QueueState = { session, entry, pending: null, skipped: state.skipped, blocked }
    return go ? { state: next, go } : cancelled ? { state: next, cancelled: true } : { state: next }
  }
  const isBlocked = (r: AgentRow) => blocked[rowKey(r)] === true
  const head = input.waiting.find((r) => r.paneId !== shown.paneId && !isBlocked(r))
  const waitingHere = row !== null && isWaiting(row.status) && !isBlocked(row)
  const quiet = now - lastInput >= ADVANCE_INPUT_GUARD_MS

  if (input.overlay || input.narrowListOpen) {
    entry = null
    return done()
  }

  if (entry) {
    if (lastInput > entry.startedAt) {
      entry = null
      return done()
    }
    if (entry.until === null || (row === null && shown.paneId !== null && now < entry.until)) return done()
    entry = null
    return done(!waitingHere && head && quiet ? { row: head, reason: 'entry' } : undefined)
  }

  const answered =
    row !== null &&
    row.status === 'working' &&
    session.shownWaiting &&
    session.waitStart !== null &&
    lastInput > session.waitStart &&
    lastInput <= row.since + ECHO_GRACE_MS
  if (answered && quiet && head) return done({ row: head, reason: 'answered' })

  // Why: 끝난 뒤 그 패널(닫았으면 보이는 옆 패널)에 입력했으면 사용자가 그 패널을 쓰는 중이다.
  // Why: '기타'(vim·개발 서버 등)가 도는 동안은 셸만 남은 것이 아니다.
  const endedAt = (input.paneHasAgent ? null : session.goneAt) ?? session.closedAt
  if (endedAt !== null && !waitingHere && lastInput <= endedAt && now - endedAt >= ENDED_CONFIRM_MS && quiet && head)
    return done({ row: head, reason: 'ended' })
  return done()
}

export function beginPending(state: QueueState, row: AgentRow, token: number, from: Shown, now: number, reason: PendingReason): QueueState {
  return { ...state, entry: null, pending: { token, issueId: row.issueId, paneId: row.paneId, row, from, at: now, reason } }
}

export function hitPending(state: QueueState, row: AgentRow): QueueState {
  return { ...state, session: sessionFromRow(row), pending: null }
}

export function failPending(state: QueueState, row: AgentRow): QueueState {
  return { ...blockRow(state, row), pending: null }
}

export function startEntry(state: QueueState, shown: Shown, now: number): QueueState {
  return { ...state, session: null, entry: { issueId: shown.issueId, startedAt: now, until: null } }
}

export function entryReady(state: QueueState, now: number): QueueState {
  return state.entry ? { ...state, entry: { ...state.entry, until: now + ENTRY_GRACE_MS } } : state
}

export function cancelAll(state: QueueState): QueueState {
  return { ...state, pending: null, entry: null }
}
