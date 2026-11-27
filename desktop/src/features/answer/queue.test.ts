// 답변 모드(#122) 대기열 규칙 — 줄 고르기·순서·step 시퀀스(Plan §3, U3)
import { describe, expect, it } from 'vitest'

import type { AgentStatus } from '../agents/agentStore'
import type { AgentRow } from '../agents/overview'
import { rowKey } from '../agents/overview'
import { leaf } from '../terminal/panes'
import {
  answerRows,
  beginPending,
  blockRow,
  cancelAll,
  entryReady,
  failPending,
  hitPending,
  isWaiting,
  queueOrder,
  sessionFromRow,
  skipRow,
  startEntry,
  step,
  urgentRows,
} from './queue'
import type { QueueState, Session, Shown, StepInput } from './queue'

/** 시각의 기준 — 입력이 없는 패널(lastInput 0)도 "마지막 입력 2초 뒤" 조건을 넘도록 0 에서 떨어뜨린다 */
const T = 1_000_000
const ISSUE_A = 'acme/app#1'
const A1 = `${ISSUE_A}::1`
const A2 = `${ISSUE_A}::2`
const ISSUE_B = 'acme/app#2'
const B1 = `${ISSUE_B}::1`
const ISSUE_C = 'acme/app#3'
const C1 = `${ISSUE_C}::1`
const ISSUE_D = 'acme/app#4'
const D1 = `${ISSUE_D}::1`

const issueOf = (paneId: string) => paneId.slice(0, paneId.lastIndexOf('::'))

function row(paneId: string, o: Partial<AgentRow> = {}): AgentRow {
  const issueId = issueOf(paneId)
  const num = Number(issueId.slice(issueId.indexOf('#') + 1)) || 1
  return {
    paneId,
    issueId,
    host: null,
    hostLabel: '이 PC',
    repo: 'acme/app',
    issue: `#${num} T${num}`,
    agent: 'claude',
    agentLabel: 'Claude Code',
    label: '',
    status: 'idle',
    since: 0,
    waitingSince: 0,
    lastOutputAt: 0,
    subagents: [],
    running: 0,
    target: { owner: 'acme', repo: 'app', key: String(num), number: num, title: `T${num}` },
    ...o,
  }
}
/** 작업 중인 줄(since = 작업 중이 된 시각) */
const working = (paneId: string, since: number, o: Partial<AgentRow> = {}) => row(paneId, { status: 'working', since, waitingSince: null, ...o })
/** 기다리는 줄(waitingSince = 기다리기 시작한 시각) */
const waitingRow = (paneId: string, status: Exclude<AgentStatus, 'working'>, waitingSince: number, o: Partial<AgentRow> = {}) => row(paneId, { status, since: waitingSince, waitingSince, ...o })

const at = (paneId: string | null, issueId: string | null = paneId === null ? null : issueOf(paneId)): Shown => ({ issueId, paneId })
const empty = (): QueueState => ({ session: null, entry: null, pending: null, skipped: {}, blocked: {} })

function input(o: Partial<StepInput>): StepInput {
  const r = o.row ?? null
  return { now: T, shown: at(null), shownReady: true, row: r, paneHasAgent: r !== null, sessionPaneExists: true, lastInput: 0, fromInput: 0, waiting: [], overlay: false, narrowListOpen: false, ...o }
}

/** step 을 이어 부른다 — 훅의 tick 처럼 지난 결과의 state 위에서 */
function sim(initial: QueueState = empty()) {
  let state = initial
  return {
    get state() {
      return state
    },
    set(next: QueueState) {
      state = next
    },
    tick(o: Partial<StepInput>) {
      const r = step(state, input(o))
      state = r.state
      return r
    },
  }
}

const ids = (rows: AgentRow[]) => rows.map((r) => r.paneId)

/**
 * A1 이 끝남(waitingSince T+500)으로 보이고, T+5000 에 답을 입력해 T+5300 에 작업 중이 된다(답을 보냄).
 * 그 뒤 마지막 입력 2초(T+7000)가 되면 넘어갈 조건이 된다.
 */
function answeredFlow(others: AgentRow[] = [waitingRow(B1, 'done', T + 800)]) {
  const s = sim()
  const shown = at(A1)
  const doneA = waitingRow(A1, 'done', T + 500)
  s.tick({ now: T + 1000, shown, row: doneA, waiting: [doneA, ...others] })
  s.tick({ now: T + 5000, shown, row: doneA, lastInput: T + 5000, waiting: [doneA, ...others] })
  const workA = working(A1, T + 5300)
  s.tick({ now: T + 5300, shown, row: workA, lastInput: T + 5000, waiting: others })
  return { s, shown, workA, others }
}

/** A1 의 에이전트가 작업 중으로 보인 뒤, T+3000 에 셸만 남은 것(줄 없음·에이전트 없음)을 본다 */
function endedFlow(others: AgentRow[] = [waitingRow(B1, 'done', T + 800)], beforeDetect = 0) {
  const s = sim()
  const shown = at(A1)
  s.tick({ now: T + 1000, shown, row: working(A1, T + 500), lastInput: beforeDetect > 0 && beforeDetect < T + 1000 ? beforeDetect : 0, waiting: others })
  const lastInput = beforeDetect
  s.tick({ now: T + 3000, shown, row: null, paneHasAgent: false, lastInput, waiting: others })
  return { s, shown, others, lastInput }
}

describe('answerRows — 대기열에 오르는 줄', () => {
  it('EC-01 다른 PC·기타 프로그램·이슈를 모르는 줄·트리에 없는 패널(고아 PTY)은 빼고, ★기타 이슈의 에이전트는 넣는다', () => {
    const ETC = 'acme/app#etc'
    const mine = row(A1)
    const orphan = row(A2)
    const peer = row(B1, { peer: { id: 'p1', name: '집 PC' } })
    const other = row(C1, { agent: 'other', agentLabel: '기타(node)' })
    const unknown = row(D1, { target: null, issue: '' })
    const etc = row(`${ETC}::1`, { issueId: ETC, issue: '기타', target: { owner: 'acme', repo: 'app', key: 'etc', number: null, title: '' } })
    // 패널 구성을 아직 모르는 이슈(이 창이 열지 않음)의 줄은 그대로 둔다
    const unseen = row('acme/app#5::1')
    const panes = { [ISSUE_A]: { tree: leaf(A1) }, [ETC]: { tree: leaf(`${ETC}::1`) } }
    expect(ids(answerRows([mine, orphan, peer, other, unknown, etc, unseen], panes)).sort()).toEqual([A1, `${ETC}::1`, 'acme/app#5::1'].sort())
  })
})

describe('queueOrder · isWaiting — 순서', () => {
  it('AC-03 작업 중이 아닌 모든 상태(입력 대기·끝남·대기 중)가 기다리는 세션이다', () => {
    expect((['attention', 'done', 'idle', 'working'] as const).map(isWaiting)).toEqual([true, true, true, false])
  })

  it('AC-03 기다리는 세션은 입력 대기 → 끝남 → 대기 중, 같은 상태는 오래 기다린 것부터(같으면 이름순), 작업 중은 이름순', () => {
    const idle1 = waitingRow('acme/app#1::1', 'idle', 100)
    const att2 = waitingRow('acme/app#2::1', 'attention', 500)
    const done3 = waitingRow('acme/app#3::1', 'done', 300)
    const done4 = waitingRow('acme/app#4::1', 'done', 200)
    const att10 = waitingRow('acme/app#10::1', 'attention', 500)
    const workZeta = working('zeta/lib#6::1', 50, { repo: 'zeta/lib' })
    const workAcme = working('acme/app#7::1', 900)
    const out = queueOrder([idle1, workZeta, att10, done3, att2, workAcme, done4], {}, {})
    expect(ids(out.waiting)).toEqual([att2.paneId, att10.paneId, done4.paneId, done3.paneId, idle1.paneId])
    expect(ids(out.working)).toEqual([workAcme.paneId, workZeta.paneId])
    expect(out.blockedRows).toEqual([])
  })

  it('AC-07 건너뛴 세션은 뒤로 가고, 다시 기다리는 상태가 되면(waitingSince 가 바뀜) 원래 순서로 돌아온다', () => {
    const a = waitingRow(A1, 'done', 100)
    const b = waitingRow(B1, 'done', 200)
    const skipped = skipRow({}, a)
    expect(ids(queueOrder([a, b], skipped, {}).waiting)).toEqual([B1, A1])
    // a 가 작업한 뒤 입력 대기가 되었다 — 건너뛴 기록은 지난 기다림의 것이다
    const again = waitingRow(A1, 'attention', 400)
    expect(ids(queueOrder([again, b], skipped, {}).waiting)).toEqual([A1, B1])
  })

  it('EC-08 기다리는 세션을 모두 건너뛰면 건너뛴 순서대로 다시 돌고, 다시 건너뛰면 맨 뒤로 간다', () => {
    const a = waitingRow(A1, 'done', 100)
    const b = waitingRow(B1, 'done', 200)
    const c = waitingRow(C1, 'done', 300)
    const order = (sk: ReturnType<typeof skipRow>) => ids(queueOrder([a, b, c], sk, {}).waiting)
    let sk = skipRow({}, a)
    expect(order(sk)).toEqual([B1, C1, A1])
    sk = skipRow(sk, b)
    expect(order(sk)).toEqual([C1, A1, B1])
    sk = skipRow(sk, c)
    expect(order(sk)).toEqual([A1, B1, C1])
    sk = skipRow(sk, a)
    expect(order(sk)).toEqual([B1, C1, A1])
  })

  it('EC-16 열 수 없는(막힌) 줄은 기다리는 목록에서 빠져 따로 모이고, 상태가 바뀌어도(waitingSince) 막힌 채다', () => {
    const a = waitingRow(A1, 'done', 100)
    const b = waitingRow(B1, 'done', 200)
    const c = waitingRow(C1, 'done', 300)
    const blocked = { [rowKey(b)]: true as const }
    expect(ids(queueOrder([a, b, c], {}, blocked).waiting)).toEqual([A1, C1])
    expect(ids(queueOrder([a, b, c], {}, blocked).blockedRows)).toEqual([B1])
    const bAgain = waitingRow(B1, 'attention', 999)
    expect(ids(queueOrder([a, bAgain, c], {}, blocked).blockedRows)).toEqual([B1])
  })
})

describe('urgentRows · sessionFromRow — 더 급한 세션', () => {
  const session = (o: Partial<Session>): Session => ({ issueId: ISSUE_A, paneId: A1, shownWaiting: true, waitStart: 100, shownStatus: 'idle', agentSeen: true, goneAt: null, closedAt: null, ...o })

  it('EC-04 지금 세션이 기다리는 상태면 보이기 시작한 상태보다 급한 줄만 센다(지금 패널·건너뛴 줄 제외), 작업 중이면 없다', () => {
    const att = waitingRow(B1, 'attention', 300)
    const done = waitingRow(C1, 'done', 200)
    const idle = waitingRow(D1, 'idle', 100)
    const self = waitingRow(A1, 'attention', 50)
    const waiting = [self, att, done, idle]
    expect(ids(urgentRows(waiting, session({ shownStatus: 'idle' }), {}))).toEqual([B1, C1])
    expect(ids(urgentRows(waiting, session({ shownStatus: 'idle' }), skipRow({}, done)))).toEqual([B1])
    // 보이기 시작한 상태 기준 — 끝남으로 보인 세션이 대기 중이 되어도 끝남보다 급한 것만
    expect(ids(urgentRows(waiting, session({ shownStatus: 'done' }), {}))).toEqual([B1])
    expect(urgentRows(waiting, session({ shownStatus: null, shownWaiting: false }), {})).toEqual([])
  })

  it('EC-04 고른 줄로 세션을 채운다 — 기다리는 줄은 그 상태가 보이기 시작한 상태, 작업 중인 줄은 없음', () => {
    expect(sessionFromRow(waitingRow(B1, 'attention', 100))).toEqual({ issueId: ISSUE_B, paneId: B1, shownWaiting: true, waitStart: 100, shownStatus: 'attention', agentSeen: true, goneAt: null, closedAt: null })
    expect(sessionFromRow(working(B1, 300))).toEqual({ issueId: ISSUE_B, paneId: B1, shownWaiting: false, waitStart: null, shownStatus: null, agentSeen: true, goneAt: null, closedAt: null })
  })
})

describe('step — 진입(AC-04 · EC-21 · EC-24)', () => {
  /** 진입(startEntry) → 지금 이슈를 연 뒤(entryReady) */
  function entered(shown: Shown) {
    return sim(entryReady(startEntry(empty(), shown, T), T))
  }
  const doneB = () => waitingRow(B1, 'done', T - 5000)

  it('AC-04 켜는 순간 지금 패널이 기다리는 세션이면 그대로 두고 진입 판단을 끝낸다', () => {
    const s = entered(at(A1))
    const doneA = waitingRow(A1, 'done', T - 9000)
    const r = s.tick({ now: T + 300, shown: at(A1), row: doneA, waiting: [doneA, doneB()] })
    expect(r.go).toBeUndefined()
    expect(s.state.entry).toBeNull()
    expect(s.state.session).toMatchObject({ paneId: A1, shownWaiting: true, shownStatus: 'done' })
    expect(s.tick({ now: T + 20_000, shown: at(A1), row: doneA, waiting: [doneA, doneB()] }).go).toBeUndefined()
  })

  it('AC-04 켜는 순간 지금 패널이 작업 중이면 대기열 첫 세션으로 간다(entry)', () => {
    const s = entered(at(A1))
    const r = s.tick({ now: T + 300, shown: at(A1), row: working(A1, T - 100), waiting: [doneB()] })
    expect(r.go).toMatchObject({ row: { paneId: B1 }, reason: 'entry' })
    expect(s.state.entry).toBeNull()
  })

  it('AC-04 고른 이슈가 없으면 기다리지 않고 바로 대기열 첫 세션으로 간다', () => {
    const s = entered(at(null))
    expect(s.tick({ now: T + 100, shown: at(null), waiting: [doneB()] }).go).toMatchObject({ row: { paneId: B1 }, reason: 'entry' })
  })

  it.each(['셸', '기타 프로그램'])('EC-21 진입: 지금 패널이 %s 이면 줄을 최대 5초 기다린 뒤 대기열 첫 세션으로 간다', (kind) => {
    const s = entered(at(A1))
    const paneHasAgent = kind === '기타 프로그램'
    expect(s.tick({ now: T + 1000, shown: at(A1), row: null, paneHasAgent, waiting: [doneB()] }).go).toBeUndefined()
    expect(s.tick({ now: T + 4999, shown: at(A1), row: null, paneHasAgent, waiting: [doneB()] }).go).toBeUndefined()
    expect(s.tick({ now: T + 5000, shown: at(A1), row: null, paneHasAgent, waiting: [doneB()] }).go).toMatchObject({ row: { paneId: B1 }, reason: 'entry' })
  })

  it('EC-21 진입: 여는 동안 같은 이슈에 패널이 늦게 생겨도 진입 판단을 이어 가고, 5초 안에 잡힌 기다리는 줄에 머문다', () => {
    const s = sim(startEntry(empty(), at(null, ISSUE_A), T))
    expect(s.tick({ now: T + 100, shown: at(null, ISSUE_A), waiting: [doneB()] }).go).toBeUndefined()
    // 패널이 생겼다(같은 이슈) — 진입 판단은 남는다
    expect(s.tick({ now: T + 150, shown: at(A1), row: null, paneHasAgent: false, waiting: [doneB()] }).go).toBeUndefined()
    expect(s.state.entry).toMatchObject({ issueId: ISSUE_A })
    s.set(entryReady(s.state, T + 200))
    expect(s.tick({ now: T + 1000, shown: at(A1), row: null, paneHasAgent: false, waiting: [doneB()] }).go).toBeUndefined()
    const doneA = waitingRow(A1, 'done', T + 1500)
    expect(s.tick({ now: T + 2000, shown: at(A1), row: doneA, waiting: [doneA, doneB()] }).go).toBeUndefined()
    expect(s.tick({ now: T + 9000, shown: at(A1), row: doneA, waiting: [doneA, doneB()] }).go).toBeUndefined()
    expect(s.state.entry).toBeNull()
    expect(s.state.session).toMatchObject({ paneId: A1, shownWaiting: true })
  })

  it('EC-21 진입: 진입 뒤 지금 패널에 입력하면 진입 판단을 하지 않는다', () => {
    // 견줌: 입력이 없으면 5초 뒤 넘어간다
    const control = entered(at(A1))
    control.tick({ now: T + 1000, shown: at(A1), row: null, paneHasAgent: false, waiting: [doneB()] })
    expect(control.tick({ now: T + 6000, shown: at(A1), row: null, paneHasAgent: false, waiting: [doneB()] }).go).toMatchObject({ reason: 'entry' })

    const s = entered(at(A1))
    s.tick({ now: T + 1000, shown: at(A1), row: null, paneHasAgent: false, lastInput: T + 900, waiting: [doneB()] })
    expect(s.state.entry).toBeNull()
    expect(s.tick({ now: T + 6000, shown: at(A1), row: null, paneHasAgent: false, lastInput: T + 900, waiting: [doneB()] }).go).toBeUndefined()
  })

  it('EC-21 진입: 여는 동안 사용자가 이슈를 바꾸면 진입 판단을 하지 않는다', () => {
    const s = sim(startEntry(empty(), at(A1), T))
    const workB = working(B1, T - 100)
    const waiting = [waitingRow(C1, 'done', T - 3000)]
    expect(s.tick({ now: T + 500, shown: at(B1), row: workB, waiting }).go).toBeUndefined()
    expect(s.state.entry).toBeNull()
    expect(s.state.session).toMatchObject({ issueId: ISSUE_B, paneId: B1 })
    s.set(entryReady(s.state, T + 600))
    expect(s.tick({ now: T + 700, shown: at(B1), row: workB, waiting }).go).toBeUndefined()
    expect(s.tick({ now: T + 20_000, shown: at(B1), row: workB, waiting }).go).toBeUndefined()
  })

  it('EC-21 진입: 지금 이슈를 열지 못하면(지금 줄이 막힘) 그 줄에 머물지 않고 대기열 첫 세션으로 간다', () => {
    const doneA = waitingRow(A1, 'done', T - 9000)
    const st = entryReady(blockRow(startEntry(empty(), at(A1), T), doneA), T)
    const r = step(st, input({ now: T + 200, shown: at(A1), shownReady: false, row: doneA, waiting: [doneA, doneB()] }))
    expect(r.go).toMatchObject({ row: { paneId: B1 }, reason: 'entry' })
  })

  it('EC-24 진입 중 [건너뛰기](이동 시작)는 진입 판단을 끝내고, 도착한 세션에 머문다', () => {
    const b = doneB()
    let st = beginPending(entryReady(startEntry(empty(), at(A1), T), T), b, 1, at(A1), T + 500, 'skip')
    expect(st.entry).toBeNull()
    expect(st.pending).toMatchObject({ paneId: B1, reason: 'skip', from: at(A1), at: T + 500 })
    st = hitPending(st, b)
    expect(st.pending).toBeNull()
    expect(st.session).toMatchObject({ paneId: B1, shownWaiting: true })
    const s = sim(st)
    const c = waitingRow(C1, 'done', T - 1000)
    expect(s.tick({ now: T + 1000, shown: at(B1), row: b, waiting: [b, c] }).go).toBeUndefined()
    expect(s.tick({ now: T + 9000, shown: at(B1), row: b, waiting: [b, c] }).go).toBeUndefined()
  })
})

describe('step — 답을 보냄(AC-05 · AC-06 · AC-12 · EC-06 · EC-09)', () => {
  it('AC-05 보인 기다리는 세션에 답해 작업 중이 되면 마지막 입력 2초 뒤 대기열 첫 세션으로 간다', () => {
    const { s, shown, workA, others } = answeredFlow()
    expect(s.state.session).toMatchObject({ paneId: A1, shownWaiting: true, waitStart: T + 500 })
    expect(s.tick({ now: T + 6999, shown, row: workA, lastInput: T + 5000, waiting: others }).go).toBeUndefined()
    expect(s.tick({ now: T + 7000, shown, row: workA, lastInput: T + 5000, waiting: others }).go).toEqual({ row: others[0], reason: 'answered' })
  })

  it('AC-06 다음이 없으면 지금(작업 중) 세션을 계속 보이고, 뒤에 기다리는 세션이 생기면 넘어간다', () => {
    const { s, shown, workA } = answeredFlow([])
    expect(s.tick({ now: T + 7000, shown, row: workA, lastInput: T + 5000, waiting: [] }).go).toBeUndefined()
    expect(s.tick({ now: T + 15_000, shown, row: workA, lastInput: T + 5000, waiting: [] }).go).toBeUndefined()
    const later = waitingRow(B1, 'done', T + 19_000)
    expect(s.tick({ now: T + 20_000, shown, row: workA, lastInput: T + 5000, waiting: [later] }).go).toEqual({ row: later, reason: 'answered' })
  })

  it('EC-09 작업 중이 된 뒤 이어서 입력하면(이어서 치는 중) 넘어가지 않는다', () => {
    // 견줌: 이어서 치지 않으면 넘어간다
    const control = answeredFlow()
    expect(control.s.tick({ now: T + 7000, shown: control.shown, row: control.workA, lastInput: T + 5000, waiting: control.others }).go).toMatchObject({ reason: 'answered' })

    const { s, shown, workA, others } = answeredFlow()
    s.tick({ now: T + 5800, shown, row: workA, lastInput: T + 5800, waiting: others })
    expect(s.tick({ now: T + 8000, shown, row: workA, lastInput: T + 5800, waiting: others }).go).toBeUndefined()
    expect(s.tick({ now: T + 30_000, shown, row: workA, lastInput: T + 5800, waiting: others }).go).toBeUndefined()
  })

  it.each([
    ['입력이 없었다', 0],
    ['입력이 마지막 기다림보다 앞이었다', T + 400],
  ])('EC-09 %s — 작업 중이 되어도 넘어가지 않는다', (_label, lastInput) => {
    const s = sim()
    const shown = at(A1)
    const doneA = waitingRow(A1, 'done', T + 500)
    const others = [waitingRow(B1, 'done', T + 800)]
    s.tick({ now: T + 1000, shown, row: doneA, lastInput, waiting: [doneA, ...others] })
    expect(s.state.session).toMatchObject({ paneId: A1, shownWaiting: true, waitStart: T + 500 })
    const workA = working(A1, T + 5300)
    expect(s.tick({ now: T + 5300, shown, row: workA, lastInput, waiting: others }).go).toBeUndefined()
    expect(s.tick({ now: T + 30_000, shown, row: workA, lastInput, waiting: others }).go).toBeUndefined()
  })

  it('EC-06 사용자가 고른 작업 중 세션은 기다리는 상태가 되어 답할 때까지 머물고, 답하면 넘어간다', () => {
    const workA = working(A1, T + 900)
    let st = beginPending(empty(), workA, 1, at(null), T + 1000, 'pick')
    st = hitPending(st, workA)
    expect(st.session).toMatchObject({ paneId: A1, shownWaiting: false, agentSeen: true })
    const s = sim(st)
    const shown = at(A1)
    const doneB = waitingRow(B1, 'done', T + 100)
    expect(s.tick({ now: T + 2000, shown, row: workA, lastInput: T + 1500, waiting: [doneB] }).go).toBeUndefined()
    expect(s.tick({ now: T + 5000, shown, row: workA, lastInput: T + 1500, waiting: [doneB] }).go).toBeUndefined()
    const doneA = waitingRow(A1, 'done', T + 6000)
    expect(s.tick({ now: T + 6000, shown, row: doneA, lastInput: T + 1500, waiting: [doneB, doneA] }).go).toBeUndefined()
    expect(s.tick({ now: T + 7000, shown, row: doneA, lastInput: T + 7000, waiting: [doneB, doneA] }).go).toBeUndefined()
    const again = working(A1, T + 7100)
    expect(s.tick({ now: T + 7100, shown, row: again, lastInput: T + 7000, waiting: [doneB] }).go).toBeUndefined()
    expect(s.tick({ now: T + 9000, shown, row: again, lastInput: T + 7000, waiting: [doneB] }).go).toEqual({ row: doneB, reason: 'answered' })
  })

  it('AC-12 새 세션(에이전트가 아직 없는 새 패널)은 에이전트가 떠서 기다리는 상태가 되어도 사용자가 답할 때까지 머문다', () => {
    const s = sim()
    const shown = at(D1)
    const doneB = waitingRow(B1, 'done', T)
    expect(s.tick({ now: T + 1000, shown, row: null, paneHasAgent: false, waiting: [doneB] }).go).toBeUndefined()
    expect(s.tick({ now: T + 3000, shown, row: working(D1, T + 2500), waiting: [doneB] }).go).toBeUndefined()
    const idleD = waitingRow(D1, 'idle', T + 4000)
    expect(s.tick({ now: T + 4000, shown, row: idleD, waiting: [doneB, idleD] }).go).toBeUndefined()
    expect(s.tick({ now: T + 20_000, shown, row: idleD, waiting: [doneB, idleD] }).go).toBeUndefined()
    expect(s.state.session).toMatchObject({ paneId: D1, shownWaiting: true, agentSeen: true })
    // 답하면 넘어간다
    s.tick({ now: T + 21_000, shown, row: idleD, lastInput: T + 21_000, waiting: [doneB, idleD] })
    const workD = working(D1, T + 21_100)
    s.tick({ now: T + 21_100, shown, row: workD, lastInput: T + 21_000, waiting: [doneB] })
    expect(s.tick({ now: T + 23_000, shown, row: workD, lastInput: T + 21_000, waiting: [doneB] }).go).toEqual({ row: doneB, reason: 'answered' })
  })
})

describe('step — 끝남(EC-07 · EC-20, D-13)', () => {
  it('EC-07 에이전트가 끝나고(셸만 남음) 입력이 없으면 1초 뒤 대기열 첫 세션으로 간다(ended)', () => {
    const { s, shown, others } = endedFlow()
    expect(s.state.session).toMatchObject({ paneId: A1, goneAt: T + 3000, shownWaiting: false, waitStart: null, shownStatus: null })
    expect(s.tick({ now: T + 3999, shown, row: null, paneHasAgent: false, waiting: others }).go).toBeUndefined()
    expect(s.tick({ now: T + 4000, shown, row: null, paneHasAgent: false, waiting: others }).go).toEqual({ row: others[0], reason: 'ended' })
  })

  it('EC-07 끝난 뒤 그 패널(셸)에 입력하면 넘어가지 않는다', () => {
    const { s, shown, others } = endedFlow()
    expect(s.state.session).toMatchObject({ goneAt: T + 3000 })
    s.tick({ now: T + 3500, shown, row: null, paneHasAgent: false, lastInput: T + 3500, waiting: others })
    expect(s.tick({ now: T + 6000, shown, row: null, paneHasAgent: false, lastInput: T + 3500, waiting: others }).go).toBeUndefined()
    expect(s.tick({ now: T + 30_000, shown, row: null, paneHasAgent: false, lastInput: T + 3500, waiting: others }).go).toBeUndefined()
  })

  it('EC-07 끝나기 전(감지 전)의 입력은 막지 않는다 — 마지막 입력 2초 뒤 넘어간다', () => {
    const { s, shown, others } = endedFlow(undefined, T + 2500)
    expect(s.tick({ now: T + 4000, shown, row: null, paneHasAgent: false, lastInput: T + 2500, waiting: others }).go).toBeUndefined()
    expect(s.tick({ now: T + 4500, shown, row: null, paneHasAgent: false, lastInput: T + 2500, waiting: others }).go).toMatchObject({ reason: 'ended' })
  })

  it('EC-07 셸에서 기타 프로그램(vim·개발 서버 등)이 돌면 끝난 것으로 보지 않는다', () => {
    const s = sim()
    const shown = at(A1)
    const others = [waitingRow(B1, 'done', T)]
    s.tick({ now: T + 1000, shown, row: working(A1, T + 500), waiting: others })
    s.tick({ now: T + 3000, shown, row: null, paneHasAgent: true, waiting: others })
    expect(s.state.session).toMatchObject({ paneId: A1, agentSeen: true, goneAt: null })
    expect(s.tick({ now: T + 10_000, shown, row: null, paneHasAgent: true, waiting: others }).go).toBeUndefined()
  })

  it('EC-07 끝난 뒤 셸에 입력해 돌린 기타 프로그램(npm test 등)이 끝나 셸만 남아도 넘어가지 않는다', () => {
    const { s, shown, others } = endedFlow()
    expect(s.state.session).toMatchObject({ goneAt: T + 3000 })
    // 셸에 `npm test` 를 친다 → '기타'(node)가 잡힌다
    s.tick({ now: T + 3500, shown, row: null, paneHasAgent: false, lastInput: T + 3500, waiting: others })
    s.tick({ now: T + 4000, shown, row: null, paneHasAgent: true, lastInput: T + 3500, waiting: others })
    // 테스트가 끝나 셸만 남는다
    s.tick({ now: T + 8000, shown, row: null, paneHasAgent: false, lastInput: T + 3500, waiting: others })
    expect(s.tick({ now: T + 9000, shown, row: null, paneHasAgent: false, lastInput: T + 3500, waiting: others }).go).toBeUndefined()
    expect(s.tick({ now: T + 10_000, shown, row: null, paneHasAgent: false, lastInput: T + 3500, waiting: others }).go).toBeUndefined()
  })

  it('EC-07 끝난 뒤 입력 없이 기타 프로그램이 잡혀도(미리 친 명령) 그것이 도는 동안은 넘어가지 않는다', () => {
    const { s, shown, others } = endedFlow()
    expect(s.state.session).toMatchObject({ goneAt: T + 3000 })
    s.tick({ now: T + 3500, shown, row: null, paneHasAgent: true, waiting: others })
    expect(s.tick({ now: T + 4000, shown, row: null, paneHasAgent: true, waiting: others }).go).toBeUndefined()
    expect(s.tick({ now: T + 13_000, shown, row: null, paneHasAgent: true, waiting: others }).go).toBeUndefined()
  })

  it('EC-07 끝난 뒤 셸에서 새 에이전트를 띄우면(작업 중으로 시작) 넘어가지 않는다', () => {
    const { s, shown, others } = endedFlow()
    s.tick({ now: T + 3500, shown, row: null, paneHasAgent: false, lastInput: T + 3500, waiting: others })
    s.tick({ now: T + 4000, shown, row: working(A1, T + 4000), lastInput: T + 3500, waiting: others })
    expect(s.state.session).toMatchObject({ paneId: A1, goneAt: null, shownWaiting: false })
    expect(s.tick({ now: T + 10_000, shown, row: working(A1, T + 4000), lastInput: T + 3500, waiting: others }).go).toBeUndefined()
  })

  it.each(['작업 중인 에이전트', '셸'])('EC-07 에이전트를 본 패널을 닫으면(Ctrl+W) 옆 패널이 %s 이어도 1초 뒤 넘어간다', (kind) => {
    const s = sim()
    const others = [waitingRow(B1, 'done', T)]
    s.tick({ now: T + 1000, shown: at(A1), row: working(A1, T + 500), waiting: others })
    const side = kind === '셸' ? null : working(A2, T + 1500)
    s.tick({ now: T + 2000, shown: at(A2), row: side, paneHasAgent: side !== null, sessionPaneExists: false, waiting: others })
    expect(s.state.session).toMatchObject({ paneId: A2, closedAt: T + 2000 })
    expect(s.tick({ now: T + 2999, shown: at(A2), row: side, paneHasAgent: side !== null, waiting: others }).go).toBeUndefined()
    expect(s.tick({ now: T + 3000, shown: at(A2), row: side, paneHasAgent: side !== null, waiting: others }).go).toEqual({ row: others[0], reason: 'ended' })
  })

  it('EC-07 닫고 보인 옆 패널이 기다리는 에이전트면 그 세션에 머물고, 입력 없이 작업 중이 되어도 넘어가지 않는다', () => {
    const s = sim()
    const others = [waitingRow(B1, 'done', T)]
    s.tick({ now: T + 1000, shown: at(A1), row: working(A1, T + 500), waiting: others })
    const doneA2 = waitingRow(A2, 'done', T + 1800)
    s.tick({ now: T + 2000, shown: at(A2), row: doneA2, sessionPaneExists: false, waiting: [...others, doneA2] })
    expect(s.state.session).toMatchObject({ paneId: A2, shownWaiting: true, closedAt: null })
    expect(s.tick({ now: T + 5000, shown: at(A2), row: doneA2, waiting: [...others, doneA2] }).go).toBeUndefined()
    const workA2 = working(A2, T + 6000)
    expect(s.tick({ now: T + 6000, shown: at(A2), row: workA2, waiting: others }).go).toBeUndefined()
    expect(s.tick({ now: T + 20_000, shown: at(A2), row: workA2, waiting: others }).go).toBeUndefined()
  })

  it('EC-07 닫은 뒤 보이는 옆 패널에 입력하면 넘어가지 않는다', () => {
    const s = sim()
    const others = [waitingRow(B1, 'done', T)]
    s.tick({ now: T + 1000, shown: at(A1), row: working(A1, T + 500), waiting: others })
    s.tick({ now: T + 2000, shown: at(A2), row: null, paneHasAgent: false, sessionPaneExists: false, waiting: others })
    expect(s.state.session).toMatchObject({ paneId: A2, closedAt: T + 2000 })
    s.tick({ now: T + 2500, shown: at(A2), row: null, paneHasAgent: false, lastInput: T + 2500, waiting: others })
    expect(s.tick({ now: T + 10_000, shown: at(A2), row: null, paneHasAgent: false, lastInput: T + 2500, waiting: others }).go).toBeUndefined()
  })

  it('EC-07 하나뿐인 패널을 닫아 보이는 패널이 없어도 1초 뒤 넘어간다', () => {
    const s = sim()
    const others = [waitingRow(B1, 'done', T)]
    s.tick({ now: T + 1000, shown: at(A1), row: working(A1, T + 500), waiting: others })
    s.tick({ now: T + 2000, shown: at(null, ISSUE_A), row: null, paneHasAgent: false, sessionPaneExists: false, waiting: others })
    expect(s.state.session).toMatchObject({ issueId: ISSUE_A, paneId: null, closedAt: T + 2000 })
    expect(s.tick({ now: T + 3000, shown: at(null, ISSUE_A), row: null, paneHasAgent: false, waiting: others }).go).toEqual({ row: others[0], reason: 'ended' })
  })

  it('EC-20 Ctrl+T 로 만든 셸 패널이 보이는 동안 자동 이동은 없고, 그 패널을 닫아도(에이전트를 본 적 없음) 끝남으로 보지 않는다', () => {
    const s = sim()
    const others = [waitingRow(B1, 'done', T)]
    const doneA = waitingRow(A1, 'done', T + 500)
    s.tick({ now: T + 1000, shown: at(A1), row: doneA, waiting: [doneA, ...others] })
    // Ctrl+T — 옆에 셸 패널(A1 은 그대로 있다)
    s.tick({ now: T + 2000, shown: at(A2), row: null, paneHasAgent: false, waiting: [doneA, ...others] })
    expect(s.state.session).toMatchObject({ paneId: A2, closedAt: null })
    expect(s.tick({ now: T + 20_000, shown: at(A2), row: null, paneHasAgent: false, waiting: [doneA, ...others] }).go).toBeUndefined()
    // 셸 패널을 닫았다 — 그 사이 A1 은 작업 중이 되었다
    const workA = working(A1, T + 15_000)
    s.tick({ now: T + 21_000, shown: at(A1), row: workA, sessionPaneExists: false, waiting: others })
    expect(s.state.session).toMatchObject({ paneId: A1, closedAt: null, agentSeen: true })
    expect(s.tick({ now: T + 30_000, shown: at(A1), row: workA, waiting: others }).go).toBeUndefined()
  })
})

describe('step — 끼어들지 않음·대화상자·좁은 화면(EC-02 · EC-04 · EC-05 · EC-13 · EC-14)', () => {
  it('EC-02 끝남으로 보인 세션이 대기 중이 되어도 지금 세션으로 남고, 보이기 시작한 상태·기다린 시각을 지킨다', () => {
    const s = sim()
    const shown = at(A1)
    const others = [waitingRow(B1, 'attention', T + 100)]
    const doneA = waitingRow(A1, 'done', T + 500)
    s.tick({ now: T + 1000, shown, row: doneA, waiting: [...others, doneA] })
    // 보았으니 대기 중 — 기다린 시각(waitingSince)은 그대로
    const idleA = waitingRow(A1, 'idle', T + 500, { since: T + 1500 })
    expect(s.tick({ now: T + 2000, shown, row: idleA, waiting: [...others, idleA] }).go).toBeUndefined()
    expect(s.state.session).toMatchObject({ paneId: A1, shownWaiting: true, waitStart: T + 500, shownStatus: 'done' })
    expect(s.tick({ now: T + 20_000, shown, row: idleA, waiting: [...others, idleA] }).go).toBeUndefined()
  })

  it('EC-04 지금 세션이 기다리는 상태면 더 급한 세션이 생겨도 넘어가지 않는다', () => {
    const s = sim()
    const shown = at(A1)
    const idleA = waitingRow(A1, 'idle', T + 500)
    s.tick({ now: T + 1000, shown, row: idleA, waiting: [idleA] })
    const urgent = waitingRow(C1, 'attention', T + 2000)
    expect(s.tick({ now: T + 3000, shown, row: idleA, waiting: [urgent, idleA] }).go).toBeUndefined()
    expect(s.tick({ now: T + 30_000, shown, row: idleA, waiting: [urgent, idleA] }).go).toBeUndefined()
    expect(s.state.session).toMatchObject({ paneId: A1, shownWaiting: true, shownStatus: 'idle' })
  })

  it('EC-05 대화상자·메뉴가 열려 있으면 답을 보낸 세션도 넘어가지 않고, 닫히면 넘어간다', () => {
    const { s, shown, workA, others } = answeredFlow()
    expect(s.tick({ now: T + 7000, shown, row: workA, lastInput: T + 5000, waiting: others, overlay: true }).go).toBeUndefined()
    expect(s.tick({ now: T + 7500, shown, row: workA, lastInput: T + 5000, waiting: others }).go).toEqual({ row: others[0], reason: 'answered' })
  })

  it('EC-05 대화상자가 열리면 진입 판단을 끝낸다 — 대화상자에서 고른 새 세션을 진입 판단이 떠나지 않게', () => {
    const doneB = waitingRow(B1, 'done', T - 5000)
    const control = sim(entryReady(startEntry(empty(), at(A1), T), T))
    expect(control.tick({ now: T + 300, shown: at(A1), row: working(A1, T - 100), waiting: [doneB] }).go).toMatchObject({ reason: 'entry' })

    const s = sim(entryReady(startEntry(empty(), at(A1), T), T))
    expect(s.tick({ now: T + 300, shown: at(A1), row: working(A1, T - 100), waiting: [doneB], overlay: true }).go).toBeUndefined()
    expect(s.state.entry).toBeNull()
    expect(s.state.session).toMatchObject({ paneId: A1 })
    expect(s.tick({ now: T + 400, shown: at(A1), row: working(A1, T - 100), waiting: [doneB] }).go).toBeUndefined()
  })

  it('EC-13 좁은 화면에서 세션 목록이 열려 있으면 넘어가지 않고, 닫히면 넘어간다', () => {
    const { s, shown, workA, others } = answeredFlow()
    expect(s.tick({ now: T + 7000, shown, row: workA, lastInput: T + 5000, waiting: others, narrowListOpen: true }).go).toBeUndefined()
    expect(s.tick({ now: T + 7500, shown, row: workA, lastInput: T + 5000, waiting: others }).go).toMatchObject({ reason: 'answered' })
  })

  it('EC-14 [새 세션] 이슈의 준비가 실패해(줄·패널 없음) 그 이슈에 머물면 다른 세션을 고를 때까지 넘어가지 않는다', () => {
    const s = sim()
    const shown = at(null, ISSUE_D)
    const others = [waitingRow(B1, 'done', T)]
    for (const now of [T + 1000, T + 5000, T + 60_000]) {
      expect(s.tick({ now, shown, row: null, paneHasAgent: false, waiting: others }).go).toBeUndefined()
    }
    expect(s.state.session).toMatchObject({ issueId: ISSUE_D, paneId: null, agentSeen: false })
  })
})

describe('step — 이동 중·실패(EC-16 · EC-22 · EC-24 · EC-26)', () => {
  /** 답을 보낸 세션이 넘어갈 조건이 되어 B1 로 이동을 시작했다(T+7000) */
  function moving() {
    const others = [waitingRow(B1, 'done', T + 800), waitingRow(C1, 'done', T + 900)]
    const f = answeredFlow(others)
    const r = f.s.tick({ now: T + 7000, shown: f.shown, row: f.workA, lastInput: T + 5000, waiting: others })
    expect(r.go).toMatchObject({ row: { paneId: B1 }, reason: 'answered' })
    f.s.set(beginPending(f.s.state, r.go!.row, 1, f.shown, T + 7000, 'answered'))
    return { ...f, target: r.go!.row }
  }

  it('EC-24 이동 중에는 다른 자동 이동이 끼어들지 않고, 그 이슈 안의 화면 변화(목표 이슈가 열리는 중 포함)는 사용자 선택으로 보지 않는다', () => {
    const { s, others } = moving()
    expect(s.state.pending).toMatchObject({ paneId: B1, reason: 'answered', from: at(A1), at: T + 7000 })
    for (const shown of [at(A2), at(null, ISSUE_B), at(A1)]) {
      const r = s.tick({ now: T + 8000, shown, row: null, paneHasAgent: false, lastInput: T + 5000, fromInput: T + 5000, waiting: others })
      expect(r.go).toBeUndefined()
      expect(r.cancelled).toBeUndefined()
      expect(s.state.pending).toMatchObject({ paneId: B1 })
    }
  })

  it('EC-22 이동 중 사용자가 다른 이슈를 고르면 이동을 취소하고 그 세션을 따른다 · cancelAll 은 이동·진입을 모두 끝낸다', () => {
    const { s, others } = moving()
    const workC = working(C1, T + 7200)
    const r = s.tick({ now: T + 7500, shown: at(C1), row: workC, fromInput: T + 5000, waiting: others })
    expect(r.cancelled).toBe(true)
    expect(r.go).toBeUndefined()
    expect(s.state.pending).toBeNull()
    expect(s.state.session).toMatchObject({ issueId: ISSUE_C, paneId: C1 })

    const both = beginPending(entryReady(startEntry(empty(), at(A1), T), T), others[0], 2, at(A1), T + 100, 'pick')
    expect(both.pending).not.toBeNull()
    expect(cancelAll(entryReady(startEntry(empty(), at(A1), T), T)).entry).toBeNull()
    expect(cancelAll(both)).toMatchObject({ pending: null, entry: null })
  })

  it('EC-26 열기를 기다리는 동안 옛 패널에 입력하면 이동을 취소한다', () => {
    const { s, shown, workA, others } = moving()
    const r = s.tick({ now: T + 7500, shown, row: workA, lastInput: T + 7400, fromInput: T + 7400, waiting: others })
    expect(r.cancelled).toBe(true)
    expect(r.go).toBeUndefined()
    expect(s.state.pending).toBeNull()
  })

  it.each(['answered', 'ended'] as const)('EC-16 %s 이동이 실패하면 그 줄을 막고(되돌린 뒤) 다음 tick 에 막힌 줄을 뺀 첫 세션으로 간다', (reason) => {
    const others = [waitingRow(B1, 'done', T + 800), waitingRow(C1, 'done', T + 900)]
    let s: ReturnType<typeof sim>
    let next: Partial<StepInput>
    if (reason === 'answered') {
      const f = answeredFlow(others)
      s = f.s
      next = { shown: f.shown, row: f.workA, lastInput: T + 5000, waiting: others }
      expect(s.tick({ ...next, now: T + 7000 }).go).toMatchObject({ row: { paneId: B1 }, reason })
    } else {
      const f = endedFlow(others)
      s = f.s
      next = { shown: f.shown, row: null, paneHasAgent: false, waiting: others }
      expect(s.tick({ ...next, now: T + 4000 }).go).toMatchObject({ row: { paneId: B1 }, reason })
    }
    s.set(beginPending(s.state, others[0], 1, at(A1), T + 7000, reason))
    s.set(failPending(s.state, others[0]))
    expect(s.state.pending).toBeNull()
    expect(s.state.blocked[rowKey(others[0])]).toBe(true)
    // 같은 줄을 다시 시도하지 않는다 — 목록에 남아 있어도 막힌 줄은 건너뛴다
    expect(s.tick({ ...next, now: T + 8000 }).go).toEqual({ row: others[1], reason })
  })

  it.each(['skip', 'pick', 'entry'] as const)('EC-16 %s 이동이 실패하면 출발한 세션으로 되돌아가 머문다', (reason) => {
    const b = waitingRow(B1, 'done', T + 800)
    const c = waitingRow(C1, 'done', T + 900)
    const shown = at(A1)
    const s = sim(reason === 'entry' ? entryReady(startEntry(empty(), shown, T), T) : empty())
    // skip 은 기다리는 세션에서, pick·entry 는 작업 중 세션에서 시작한다
    const current = reason === 'skip' ? waitingRow(A1, 'done', T + 500) : working(A1, T + 500)
    const r = s.tick({ now: T + 1000, shown, row: current, waiting: [current, b, c].filter((x) => x.status !== 'working') })
    if (reason === 'entry') expect(r.go).toMatchObject({ row: { paneId: B1 }, reason: 'entry' })
    s.set(beginPending(s.state, b, 1, shown, T + 1500, reason))
    expect(s.state.entry).toBeNull()
    s.set(failPending(s.state, b))
    expect(s.state.blocked[rowKey(b)]).toBe(true)
    expect(s.state.session).toMatchObject({ paneId: A1 })
    const waiting = [current, b, c].filter((x) => x.status !== 'working')
    expect(s.tick({ now: T + 2000, shown, row: current, waiting }).go).toBeUndefined()
    expect(s.tick({ now: T + 30_000, shown, row: current, waiting }).go).toBeUndefined()
  })

  it('EC-16 막힌 줄은 waitingSince 가 바뀌어도 막힌 채다 — 자동 이동은 그 줄을 건너뛴다', () => {
    const { s, shown, workA } = answeredFlow([])
    s.set(blockRow(s.state, waitingRow(B1, 'done', T + 800)))
    const bAgain = waitingRow(B1, 'idle', T + 6500)
    const c = waitingRow(C1, 'done', T + 900)
    expect(s.tick({ now: T + 7000, shown, row: workA, lastInput: T + 5000, waiting: [bAgain, c] }).go).toEqual({ row: c, reason: 'answered' })
    expect(s.state.blocked[rowKey(bAgain)]).toBe(true)
  })

  it('EC-16 막힌 줄은 이 창에서 준비되지 않은 채 보이면 막힌 채이고, 이 창에서 열려 보이면 풀린다', () => {
    const doneA = waitingRow(A1, 'done', T + 500)
    const s = sim(blockRow(empty(), doneA))
    expect(s.state.blocked[rowKey(doneA)]).toBe(true)
    s.tick({ now: T + 1000, shown: at(A1), shownReady: false, row: doneA, waiting: [doneA] })
    expect(s.state.blocked[rowKey(doneA)]).toBe(true)
    s.tick({ now: T + 2000, shown: at(A1), shownReady: true, row: doneA, waiting: [doneA] })
    expect(s.state.blocked).toEqual({})
  })
})
