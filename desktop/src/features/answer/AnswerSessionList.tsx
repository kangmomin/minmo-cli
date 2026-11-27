import { PlusIcon } from 'lucide-react'
import { useId, useRef, useState } from 'react'
import type { Ref } from 'react'

import { Button } from '../../components/ui/button'
import { StatusDot } from '../agents/AgentBadge'
import { STATUS_LABEL } from '../agents/agentStore'
import { rowKey } from '../agents/overview'
import type { AgentRow } from '../agents/overview'
import { Elapsed } from './Elapsed'
import { sinceOf } from './queue'
import type { AnswerQueue } from './useAnswerQueue'

export interface AnswerSessionListProps {
  queue: Pick<AnswerQueue, 'waiting' | 'working' | 'blockedRows' | 'current' | 'pick'>
  onNewSession(): void
  newSessionRef?: Ref<HTMLButtonElement>
}

export function AnswerSessionList({ queue, onNewSession, newSessionRef }: AnswerSessionListProps) {
  const uid = useId()
  const { waiting, working, blockedRows, current, pick } = queue
  const groups = [
    { key: 'waiting', title: `기다리는 세션 ${waiting.length}`, rows: waiting, blocked: false },
    { key: 'working', title: `작업 중 ${working.length}`, rows: working, blocked: false },
    ...(blockedRows.length > 0 ? [{ key: 'blocked', title: `열 수 없음 ${blockedRows.length}`, rows: blockedRows, blocked: true }] : []),
  ]

  // Why: 누르려던 줄이 상태가 바뀌어 다른 자리로 밀리지 않게 포인터·포커스가 목록 안에 있는 동안 묶음 안 순서를 고정한다.
  const inside = useRef({ pointer: false, focus: false })
  const [frozen, setFrozen] = useState<string[] | null>(null)
  const liveKeys = groups.flatMap((g) => g.rows.map(rowKey))
  const hold = (kind: 'pointer' | 'focus', on: boolean) => {
    const was = inside.current.pointer || inside.current.focus
    inside.current = { ...inside.current, [kind]: on }
    const is = inside.current.pointer || inside.current.focus
    if (is && !was) setFrozen(liveKeys)
    else if (!is && was) setFrozen(null)
  }
  const arrange = (rows: AgentRow[]) => {
    if (!frozen) return rows
    const at = (r: AgentRow) => {
      const i = frozen.indexOf(rowKey(r))
      return i < 0 ? frozen.length : i
    }
    return [...rows].sort((a, b) => at(a) - at(b))
  }

  return (
    <nav
      aria-label="세션 목록"
      data-testid="answer-list"
      className="flex min-h-0 flex-1 flex-col"
      onPointerEnter={() => hold('pointer', true)}
      onPointerLeave={() => hold('pointer', false)}
      onFocus={() => hold('focus', true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) hold('focus', false)
      }}
    >
      <div className="min-h-0 flex-1 overflow-y-auto py-2 pl-2 pr-3">
        {liveKeys.length === 0 ? (
          <p className="p-2 text-sm text-muted-foreground">에이전트 세션이 없습니다. [새 세션]으로 시작하세요.</p>
        ) : (
          groups.map((g) => {
            const headingId = `${uid}-${g.key}`
            return (
              <div key={g.key} className="mb-3">
                <h2 id={headingId} className="px-2 py-1 text-xs font-semibold text-muted-foreground">
                  {g.title}
                </h2>
                {g.rows.length > 0 && (
                  <ul aria-labelledby={headingId} className="grid gap-0.5">
                    {arrange(g.rows).map((r, i) => (
                      <SessionRow key={rowKey(r)} row={r} current={current !== null && rowKey(current) === rowKey(r)} reasonId={g.blocked ? `${headingId}-${i}` : null} onPick={() => pick(r)} />
                    ))}
                  </ul>
                )}
              </div>
            )
          })
        )}
      </div>
      <div className="border-t p-2">
        <Button ref={newSessionRef} type="button" size="sm" variant="outline" className="w-full" data-testid="answer-new-session" onClick={onNewSession}>
          <PlusIcon /> 새 세션
        </Button>
      </div>
    </nav>
  )
}

function SessionRow({ row, current, reasonId, onPick }: { row: AgentRow; current: boolean; reasonId: string | null; onPick(): void }) {
  return (
    <li>
      {/* Why: 지난 시간은 이름에서 뺀다(aria-hidden) — 줄 이름이 1초마다 바뀌어 다시 읽히지 않게. 막힌 줄도 누르면 다시 시도한다 */}
      <button
        type="button"
        data-testid="answer-row"
        data-status={row.status}
        aria-current={current ? 'true' : undefined}
        aria-disabled={reasonId !== null || undefined}
        aria-describedby={reasonId ?? undefined}
        onClick={onPick}
        className="grid w-full min-w-0 gap-0.5 rounded px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-[current=true]:bg-accent"
      >
        <span className="flex min-w-0 items-center gap-2">
          <StatusDot status={row.status} />
          <span className="text-xs text-foreground">{STATUS_LABEL[row.status]}</span>
          <Elapsed aria-hidden="true" since={sinceOf(row)} className="ml-auto shrink-0 text-xs text-muted-foreground" />
        </span>
        <span className="truncate">
          <span className="text-muted-foreground">{row.repo}</span> {row.issue}
        </span>
        {row.label && <span className="truncate text-xs text-muted-foreground">{row.label}</span>}
      </button>
      {reasonId !== null && (
        <p id={reasonId} className="px-2 pb-1 text-xs text-destructive">
          열 수 없습니다 — 누르면 다시 시도합니다
        </p>
      )}
    </li>
  )
}
