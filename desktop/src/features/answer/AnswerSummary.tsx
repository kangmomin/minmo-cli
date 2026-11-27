import { useId, useRef } from 'react'
import type { KeyboardEvent, Ref } from 'react'

import { aliasOfIssue } from '../../app/host'
import { Button } from '../../components/ui/button'
import { repoLabelOf, useReposStore } from '../../store/repos'
import { useSetupStore } from '../../store/setup'
import { useUiStore } from '../../store/ui'
import { StatusDot } from '../agents/AgentBadge'
import { STATUS_LABEL } from '../agents/agentStore'
import { goToPane } from '../agents/navigate'
import type { AgentRow } from '../agents/overview'
import { effectivePane } from '../terminal/panes'
import { ClaudeReply } from './ClaudeLastReply'
import { Elapsed } from './Elapsed'
import { JevVerdict } from './JevVerdict'
import type { AnswerQueue } from './useAnswerQueue'

export interface AnswerSummaryProps {
  queue: Pick<AnswerQueue, 'waiting' | 'current' | 'urgent' | 'skip' | 'seeUrgent' | 'cancel'>
  whereId: string
  headingRef?: Ref<HTMLHeadingElement>
  onNewSession(): void
}

const isPressKey = (e: KeyboardEvent) => e.key === 'Enter' || e.key === ' '

export function AnswerSummary({ queue, whereId, headingRef, onNewSession }: AnswerSummaryProps) {
  const uid = useId()
  const ids = { heading: `${uid}-h`, answer: `${uid}-a`, skip: `${uid}-s`, urgent: `${uid}-u` }
  const { waiting, current, urgent } = queue
  const issueId = useUiStore((s) => s.selectedIssueId)
  const paneId = useUiStore((s) => (s.selectedIssueId === null ? null : effectivePane(s.panes[s.selectedIssueId])))
  const hasTerminal = useUiStore((s) => paneId !== null && paneId in s.terminalIds)
  const ready = useSetupStore((s) => issueId !== null && s.open[issueId]?.phase === 'ready')
  const where = useWhere(current, issueId)
  const canAnswer = ready && hasTerminal
  const canSkip = waiting.some((r) => r.paneId !== paneId)
  const armed = useRef<string | null>(null)

  function answer() {
    // Why: 터미널이 없으면 누름이 focusRequest 로 남아, 나중에 열린 터미널이 사용자 모르게 포커스를 가져간다.
    if (!canAnswer || issueId === null || paneId === null) return
    queue.cancel()
    goToPane(issueId, paneId, true)
  }

  return (
    <section aria-labelledby={ids.heading} data-answer-summary data-testid="answer-summary" className="h-40 shrink-0 border-b max-md:h-24">
      <div className="grid h-full content-start gap-x-6 gap-y-2 overflow-y-auto px-4 py-2 text-sm md:grid-cols-2">
        <div className="grid min-w-0 content-start gap-1.5">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            <h2 ref={headingRef} id={ids.heading} tabIndex={-1} data-answer-heading aria-describedby={whereId} className="rounded-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring">
              세션 요약
            </h2>
            {current ? <StatusLine row={current} /> : <span className="text-muted-foreground">에이전트가 아직 없습니다</span>}
            {/* Why: 자동 이동 뒤 누른 채 둔 Enter 의 반복이 새 터미널로 가지 않게 이 버튼이 받은 첫 keydown 의 keyup 에서만 누른다 */}
            <Button
              type="button"
              size="sm"
              variant="secondary"
              data-testid="answer-focus-terminal"
              aria-disabled={!canAnswer || undefined}
              aria-describedby={canAnswer ? whereId : `${ids.answer} ${whereId}`}
              className="aria-disabled:cursor-not-allowed"
              onKeyDown={(e) => {
                if (!isPressKey(e)) return
                e.preventDefault()
                if (!e.repeat) armed.current = e.key
              }}
              onKeyUp={(e) => {
                if (!isPressKey(e)) return
                e.preventDefault()
                const press = armed.current === e.key
                armed.current = null
                if (press) answer()
              }}
              onBlur={() => {
                armed.current = null
              }}
              onClick={answer}
            >
              이 세션에 답하기
            </Button>
            {!canAnswer && (
              <span id={ids.answer} className="text-xs text-muted-foreground">
                {ready ? '터미널이 아직 열리지 않았습니다' : '터미널을 여는 중입니다'}
              </span>
            )}
          </div>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 text-xs">
            {current && (
              <>
                <dt className="text-muted-foreground">무엇</dt>
                <dd className="truncate">{current.label || '제목 없음'}</dd>
              </>
            )}
            <dt className="text-muted-foreground">어디</dt>
            <dd id={whereId} className="truncate">
              {where}
            </dd>
            {current && (
              <>
                <dt className="text-muted-foreground">에이전트</dt>
                <dd className="truncate">
                  {current.agentLabel}
                  {current.running > 0 && ` · 하위 에이전트 ${current.running}개 실행 중`}
                </dd>
              </>
            )}
          </dl>
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            <span>기다리는 세션 {waiting.length}개</span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 px-2 aria-disabled:cursor-not-allowed"
              data-testid="answer-skip"
              aria-disabled={!canSkip || undefined}
              aria-describedby={canSkip ? undefined : ids.skip}
              onClick={() => queue.skip()}
            >
              건너뛰기
            </Button>
            {!canSkip && (
              <span id={ids.skip} className="text-muted-foreground">
                다음 기다리는 세션이 없습니다
              </span>
            )}
            <Button type="button" size="sm" variant="outline" className="h-7 px-2" onClick={onNewSession}>
              새 세션
            </Button>
            {urgent.length > 0 && (
              <>
                <span id={ids.urgent} className="text-amber-700 dark:text-amber-400">
                  더 급한 세션 {urgent.length}개
                </span>
                <Button type="button" size="sm" variant="outline" className="h-7 px-2" aria-describedby={ids.urgent} onClick={() => queue.seeUrgent()}>
                  보기
                </Button>
              </>
            )}
          </div>
          <p className="text-xs text-muted-foreground">답을 보내면 2초 뒤 다음 세션으로 넘어갑니다.</p>
        </div>
        <div className="grid min-w-0 content-start gap-2">
          <ClaudeReply row={current} />
          <JevVerdict row={current} />
        </div>
      </div>
    </section>
  )
}

function StatusLine({ row }: { row: AgentRow }) {
  const working = row.status === 'working'
  return (
    <span className="flex items-center gap-1.5">
      <StatusDot status={row.status} />
      {STATUS_LABEL[row.status]} · <Elapsed since={working ? row.since : (row.waitingSince ?? row.since)} />
      {working ? '째 작업 중' : ' 기다림'}
    </span>
  )
}

// Why: 지금 줄이 없어도(셸 패널·새 패널) 카드 제목·터미널 입력이 설명으로 읽는 "어디" 줄을 고른 이슈로 남긴다.
function useWhere(row: AgentRow | null, issueId: string | null): string {
  const target = useSetupStore((s) => (issueId === null ? undefined : s.targets[issueId]))
  const repo = useReposStore((s) => (target ? repoLabelOf(s, target.owner, target.repo) : ''))
  const host = row ? row.host : issueId === null ? null : aliasOfIssue(issueId)
  const place = row ? `${row.repo} ${row.issue}` : target ? `${repo} ${target.number === null ? '기타' : `#${target.number} ${target.title}`}` : ''
  return host === null ? place : `${host} · ${place}`
}
