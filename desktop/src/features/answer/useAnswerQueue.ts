// 답변 모드(#122)의 대기열 훅 — Workspace 가 한 번 부른다.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { useBaseDeps } from '../../app/deps'
import { aliasOfIssue } from '../../app/host'
import { useSetupStore } from '../../store/setup'
import { useUiStore } from '../../store/ui'
import type { UiState } from '../../store/ui'
import { useLocalRows } from '../agents/AgentsOverview'
import { STATUS_LABEL, useAgentStore } from '../agents/agentStore'
import { goToPane, openPaneTarget } from '../agents/navigate'
import { rowKey } from '../agents/overview'
import type { AgentRow } from '../agents/overview'
import { lastInputAt } from '../agents/useAgentTracker'
import { useIssueActionsFor } from '../issue/useWorktree'
import { overlayOpen } from '../terminal/keys'
import { effectivePane, leafIds } from '../terminal/panes'
import { useAnnouncer } from './announce'
import {
  AUTO_OPEN_DEADLINE_MS,
  PICK_OPEN_DEADLINE_MS,
  answerRows,
  beginPending,
  blockRow,
  cancelAll,
  entryReady,
  failPending,
  hitPending,
  isWaiting,
  queueOrder,
  skipRow,
  startEntry,
  step,
  urgentRows,
} from './queue'
import type { PendingReason, QueueState, Session, Shown } from './queue'

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
  /** Why: [이 세션에 답하기]는 사용자가 지금 세션을 고른 것이라 진행 중인 이동·진입을 끝내야 한다. */
  cancel(): void
  /** polite 알림 글 */
  announce: string
  /** 오류 알림 글 */
  alert: string
}

const TICK_MS = 1000
const EMPTY: QueueState = { session: null, entry: null, pending: null, skipped: {}, blocked: {} }

type View = Pick<QueueState, 'session' | 'skipped' | 'blocked'>
type Arrival = { focus: boolean; text: string }

// Why: step 은 부를 때마다 새 session 객체를 돌려준다 — 값이 같으면 다시 그리지 않는다.
const sameSession = (a: Session | null, b: Session | null) => a === b || (a !== null && b !== null && (Object.keys(a) as (keyof Session)[]).every((k) => a[k] === b[k]))

/** 고른 이슈에서 보이는 패널(store selector) — 대기열과 요약 카드가 같은 패널을 본다 */
export const shownPaneOf = (s: Pick<UiState, 'selectedIssueId' | 'panes'>): string | null =>
  s.selectedIssueId === null ? null : effectivePane(s.panes[s.selectedIssueId])

function shownNow(): Shown {
  const s = useUiStore.getState()
  return { issueId: s.selectedIssueId, paneId: shownPaneOf(s) }
}

const isReady = (issueId: string | null) => issueId !== null && useSetupStore.getState().open[issueId]?.phase === 'ready'
const rowOf = (rows: AgentRow[], paneId: string | null) => rows.find((r) => r.paneId === paneId) ?? null
const nextText = (r: AgentRow) => `다음 세션: ${r.repo} ${r.issue} — ${STATUS_LABEL[r.status]}`
const inAnswerArea = (el: Element | null) => el?.closest('[data-terminal-root],[data-answer-summary]') != null
const focusHeading = () => document.querySelector<HTMLElement>('[data-answer-heading]')?.focus()

export function useAnswerQueue(enabled: boolean, { narrowListOpen }: { narrowListOpen: boolean }): AnswerQueue {
  const { tauri } = useBaseDeps()
  const actionsFor = useIssueActionsFor()
  const local = useLocalRows()
  const panes = useUiStore((s) => s.panes)
  const shownIssue = useUiStore((s) => s.selectedIssueId)
  const shownPane = useUiStore(shownPaneOf)
  const rows = useMemo(() => answerRows(local, panes), [local, panes])
  const [view, setView] = useState<View>(EMPTY)
  const [arrival, setArrival] = useState<Arrival | null>(null)
  const [announce, say] = useAnnouncer()
  const [alert, warn] = useAnnouncer()

  // Why: 타이머·store 구독·열기 결과는 render 밖에서 돈다 — 지금 값을 ref 로 읽는다.
  const live = useRef({ enabled, narrowListOpen, local, tauri, actionsFor })
  useLayoutEffect(() => {
    live.current = { enabled, narrowListOpen, local, tauri, actionsFor }
  })
  const queue = useRef<QueueState>(EMPTY)
  const token = useRef(0)

  const api = useMemo(() => {
    const commit = (next: QueueState) => {
      queue.current = next
      setView((v) => (sameSession(v.session, next.session) && v.skipped === next.skipped && v.blocked === next.blocked ? v : { session: next.session, skipped: next.skipped, blocked: next.blocked }))
    }
    // Why: store 구독은 다시 그리기 전에 돈다 — 줄·패널은 그때의 store 값으로 다시 계산한다.
    const rowsNow = () => answerRows(live.current.local, useUiStore.getState().panes)

    function tick() {
      if (!live.current.enabled) return
      const s = queue.current
      const shown = shownNow()
      const rs = rowsNow()
      const sp = s.session
      const res = step(s, {
        now: Date.now(),
        shown,
        shownReady: isReady(shown.issueId),
        row: rowOf(rs, shown.paneId),
        paneHasAgent: shown.paneId !== null && shown.paneId in useAgentStore.getState().panes,
        sessionPaneExists: sp === null || sp.issueId === null || sp.paneId === null || leafIds(useUiStore.getState().panes[sp.issueId]?.tree ?? null).includes(sp.paneId),
        lastInput: shown.paneId === null ? 0 : lastInputAt(shown.paneId),
        fromInput: s.pending?.from.paneId ? lastInputAt(s.pending.from.paneId) : 0,
        waiting: queueOrder(rs, s.skipped, s.blocked).waiting,
        overlay: overlayOpen(),
        narrowListOpen: live.current.narrowListOpen,
      })
      if (res.cancelled) token.current += 1
      commit(res.state)
      if (res.go) move(res.go.row, res.go.reason)
    }

    function move(row: AgentRow, reason: PendingReason) {
      token.current += 1
      const my = token.current
      const from = shownNow()
      const at = Date.now()
      const focusWas = inAnswerArea(document.activeElement)
      commit(beginPending(queue.current, row, my, from, at, reason))
      const settle = (ok: boolean) => {
        if (queue.current.pending?.token !== my) return
        if (ok) {
          commit(hitPending(queue.current, row))
          if (reason !== 'pick') setArrival({ focus: focusWas && reason !== 'skip', text: nextText(rowOf(rowsNow(), row.paneId) ?? row) })
          return
        }
        warn(`열 수 없습니다: ${row.repo} ${row.issue}`)
        // Why: pending 을 둔 채 되돌린다 — 되돌림이 부르는 step 이 이 자리에서 다음 세션으로 가지 않게(다음 tick 에 간다).
        if (from.issueId !== null && from.paneId !== null) goToPane(from.issueId, from.paneId, false)
        else if (from.issueId !== null) {
          const ui = useUiStore.getState()
          ui.selectIssue(from.issueId)
          ui.setTab('terminal')
        }
        commit(failPending(queue.current, row))
      }
      if (isReady(row.issueId)) {
        settle(goToPane(row.issueId, row.paneId, reason === 'pick'))
        return
      }
      const { actionsFor, tauri } = live.current
      void openPaneTarget({
        actionsFor,
        tauri,
        alias: aliasOfIssue(row.issueId),
        // Why: answerRows 는 열기 대상을 아는 줄만 둔다.
        target: row.target!,
        paneId: row.paneId,
        keyboard: reason === 'pick',
        deadline: at + (reason === 'pick' ? PICK_OPEN_DEADLINE_MS : AUTO_OPEN_DEADLINE_MS),
        isStale: () => {
          const selected = useUiStore.getState().selectedIssueId
          return token.current !== my || !live.current.enabled || (selected !== from.issueId && selected !== row.issueId) || (from.paneId !== null && lastInputAt(from.paneId) > at)
        },
      }).then((res) => {
        if (res !== 'stale') settle(res === 'ok')
        else if (queue.current.pending?.token === my) commit(cancelAll(queue.current))
      })
    }

    function enter() {
      token.current += 1
      const my = token.current
      const now = Date.now()
      const shown = shownNow()
      const { issueId } = shown
      commit(startEntry(queue.current, shown, now))
      const target = issueId === null ? undefined : useSetupStore.getState().targets[issueId]
      if (issueId === null || target === undefined || isReady(issueId)) {
        commit(entryReady(queue.current, now))
        tick()
        return
      }
      const isStale = () => token.current !== my || !live.current.enabled || queue.current.entry?.issueId !== issueId
      const { actionsFor, tauri } = live.current
      void openPaneTarget({ actionsFor, tauri, alias: aliasOfIssue(issueId), target, paneId: shown.paneId, keyboard: false, deadline: now + PICK_OPEN_DEADLINE_MS, isStale }).then((res) => {
        if (res === 'stale' || isStale()) return
        // Why: 지금 이슈를 열지 못하면 지금 줄을 막는다 — 진입 판단이 그 줄에 머물지 않고 대기열 첫 세션으로 가게.
        const row = res === 'failed' ? rowOf(rowsNow(), shownNow().paneId) : null
        commit(entryReady(row ? blockRow(queue.current, row) : queue.current, Date.now()))
        tick()
      })
      tick()
    }

    function stop() {
      token.current += 1
      commit(cancelAll(queue.current))
      say('')
      warn('')
    }

    function cancel() {
      if (!live.current.enabled) return
      token.current += 1
      commit(cancelAll(queue.current))
    }

    function pick(row: AgentRow) {
      if (!live.current.enabled) return
      say('')
      const s = cancelAll(queue.current)
      const blocked = { ...s.blocked }
      delete blocked[rowKey(row)]
      commit({ ...s, blocked })
      move(row, 'pick')
    }

    function skip() {
      if (!live.current.enabled) return
      const s = queue.current
      const shown = shownNow()
      const rs = rowsNow()
      const next = queueOrder(rs, s.skipped, s.blocked).waiting.find((r) => r.paneId !== shown.paneId)
      if (!next) return
      const cur = rowOf(rs, shown.paneId)
      if (cur && isWaiting(cur.status)) commit({ ...s, skipped: skipRow(s.skipped, cur) })
      move(next, 'skip')
    }

    function seeUrgent() {
      if (!live.current.enabled) return
      const s = queue.current
      const first = urgentRows(queueOrder(rowsNow(), s.skipped, s.blocked).waiting, s.session, s.skipped)[0]
      if (!first) return
      pick(first)
      // Why: pick 은 알림을 지운다 — 그 뒤에 넣는다.
      say(nextText(first))
    }

    function prune(rs: AgentRow[]) {
      const keys = new Set(rs.map(rowKey))
      const keep = <T>(rec: Record<string, T>) => (Object.keys(rec).every((k) => keys.has(k)) ? rec : Object.fromEntries(Object.entries(rec).filter(([k]) => keys.has(k))))
      const s = queue.current
      commit({ ...s, skipped: keep(s.skipped), blocked: keep(s.blocked) })
    }

    return { tick, enter, stop, cancel, pick, skip, seeUrgent, prune }
  }, [say, warn])

  useEffect(() => {
    if (!enabled) return
    api.enter()
    const timer = setInterval(api.tick, TICK_MS)
    let last = shownNow()
    // Why: 보이는 패널이 바뀌면 tick 을 기다리지 않고 판단한다 — Ctrl+W 의 닫은 때가 늦게 찍히면 그 사이 옆 패널에 친 입력을 못 본다.
    const unsubscribe = useUiStore.subscribe(() => {
      const shown = shownNow()
      if (shown.issueId === last.issueId && shown.paneId === last.paneId) return
      last = shown
      api.tick()
    })
    return () => {
      clearInterval(timer)
      unsubscribe()
      api.stop()
    }
  }, [enabled, api])

  useEffect(() => {
    if (narrowListOpen) api.cancel()
  }, [narrowListOpen, api])

  useEffect(() => {
    if (!live.current.enabled) return
    api.prune(rows)
    api.tick()
  }, [rows, api])

  // Why: 가려진 터미널·[다시 시작] 같은 버튼에 포커스가 남으면 친 키가 보이지 않는 패널로 간다.
  useLayoutEffect(() => {
    if (!enabled) return
    const active = document.activeElement
    if (!active?.closest('[data-terminal-root]')) return
    if (shownPane !== null && active.closest('[data-pane-id]')?.getAttribute('data-pane-id') === shownPane) return
    focusHeading()
  }, [enabled, shownIssue, shownPane])

  // Why: 자동 이동 뒤 이어서 치던 글자가 새 터미널로 가지 않게 카드 제목이 먼저 포커스를 받고, 그 뒤에 알린다.
  useLayoutEffect(() => {
    if (!arrival) return
    const active = document.activeElement
    if (arrival.focus && (active === null || active === document.body || inAnswerArea(active))) focusHeading()
    say(arrival.text)
  }, [arrival, say])

  const { waiting, working, blockedRows } = useMemo(() => queueOrder(rows, view.skipped, view.blocked), [rows, view.skipped, view.blocked])
  const urgent = useMemo(() => urgentRows(waiting, view.session, view.skipped), [waiting, view.session, view.skipped])
  const current = useMemo(() => rowOf(rows, shownPane), [rows, shownPane])
  return { waiting, working, blockedRows, current, session: view.session, urgent, pick: api.pick, skip: api.skip, seeUrgent: api.seeUrgent, cancel: api.cancel, announce, alert }
}
