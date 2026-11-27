import { useLayoutEffect, useRef, useState } from 'react'

import { Button } from '../../components/ui/button'
import { TAKER_STATUS_LABEL } from './IssueTakerDialog'
import { isActive } from './taker'
import { useTakerStore } from './takerStore'
import type { TakerRun } from './takerStore'
import { useTakerActions } from './useIssueTaker'

function lastRunOf(runs: readonly TakerRun[], issueId: string): TakerRun | undefined {
  for (let i = runs.length - 1; i >= 0; i--) if (runs[i].issueId === issueId) return runs[i]
  return undefined
}

export function TakerHeaderStatus({ issueId }: { issueId: string }) {
  const actions = useTakerActions()
  const run = useTakerStore((s) => lastRunOf(s.runs, issueId))
  // Why: 누른 때의 실행 객체에 묶어 둔다 — store 는 바뀐 실행만 새 객체로 만들어, 실행이 바뀌면 잠금·알림이 저절로 풀린다
  const [locked, setLocked] = useState<TakerRun | null>(null)
  const [notice, setNotice] = useState<TakerRun | null>(null)
  const textRef = useRef<HTMLSpanElement>(null)
  const buttonFocused = useRef(false)

  useLayoutEffect(() => {
    if (!buttonFocused.current) return
    const active = document.activeElement
    if (active !== null && active !== document.body) return
    buttonFocused.current = false
    textRef.current?.focus()
  })

  if (actions === null) return null
  const acts = actions

  function nextStep(r: TakerRun) {
    const result = acts.nextStep(r.id)
    setLocked(result === 'started' ? r : null)
    if (result === 'notReady') setNotice(r)
  }

  const step = run ? Math.min(run.step + 1, run.steps.length) : 0
  const stop = run !== undefined && (run.status === 'queued' || isActive(run))
  const retry = run?.status === 'failed' ? '자동 실행 다시 시도' : run?.status === 'interrupted' || run?.status === 'stopped' ? '이 단계부터 다시' : null

  return (
    <div className="flex items-center gap-2 text-sm">
      <div role="status" key={issueId} className="flex items-center gap-1">
        {run && (
          <span ref={textRef} tabIndex={-1} className="rounded outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <span aria-hidden="true">
              {isActive(run) && '↻ '}자동 실행 {step}/{run.steps.length} 단계
            </span>
            <span className="sr-only">{`자동 실행 ${run.steps.length}단계 중 ${step}단계`}</span>
            <span className="text-muted-foreground">{` · ${TAKER_STATUS_LABEL[run.status]}`}</span>
            {run.note && <span className="text-xs text-muted-foreground">{` · ${run.note}`}</span>}
          </span>
        )}
        {run && notice === run && <span className="text-xs text-muted-foreground">연결을 기다리는 중 — 잠시 뒤 다시 누르세요</span>}
      </div>
      {run?.status === 'failed' && (
        <p role="alert" className="text-xs text-destructive">
          {run.error ?? TAKER_STATUS_LABEL.failed}
        </p>
      )}
      {run && (
        <div
          className="flex items-center gap-1"
          onFocus={() => {
            buttonFocused.current = true
          }}
          onBlur={(e) => {
            if (e.relatedTarget !== null) buttonFocused.current = false
          }}
        >
          {run.status === 'manualNext' && (
            <Button type="button" size="sm" variant="outline" disabled={locked === run} onClick={() => nextStep(run)}>
              다음 단계
            </Button>
          )}
          {stop && (
            <Button type="button" size="sm" variant="ghost" onClick={() => actions.stop(run.id)}>
              자동 실행 멈춤
            </Button>
          )}
          {retry && (
            <Button type="button" size="sm" variant="ghost" onClick={() => actions.restart(run.id)}>
              {retry}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

export function TakerRowIcon({ issueId }: { issueId: string }) {
  const actions = useTakerActions()
  const on = useTakerStore((s) => s.runs.some((r) => r.issueId === issueId && isActive(r)))
  if (actions === null || !on) return null
  return (
    <span role="img" aria-label="자동 실행 중" title="자동 실행 중" className="inline-block shrink-0 animate-spin text-xs text-muted-foreground motion-reduce:animate-none">
      ↻
    </span>
  )
}
