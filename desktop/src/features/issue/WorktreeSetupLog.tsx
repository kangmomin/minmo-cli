import { ChevronDownIcon, ChevronRightIcon } from 'lucide-react'
import { memo, useEffect, useId, useRef, useState } from 'react'

import { Button } from '../../components/ui/button'
import { worktreeId } from '../../lib/worktree'
import type { IssueTarget, SetupLogEvent, SetupStep } from '../../lib/worktree'
import { useSetupStore } from '../../store/setup'
import type { SetupLogEntry } from '../../store/setup'
import { useIssueActions } from './useWorktree'

const STEP_LABEL: Record<SetupStep, string> = {
  effective: '설정',
  clone: 'clone',
  fetch: 'fetch',
  prune: 'prune',
  branch: '브랜치',
  worktree: 'worktree',
  script: '스크립트',
}

const EMPTY: SetupLogEntry[] = []

function line(e: SetupLogEvent): string {
  if (e.status === 'log') return e.message ?? ''
  const label = STEP_LABEL[e.step]
  const status = { start: '시작', ok: '완료', error: '실패', cancelled: '취소됨', log: '' }[e.status]
  return `[${label}] ${status}${e.message ? ` — ${e.message}` : ''}`
}

// 로그 줄마다 store 가 갱신되므로 기존 줄(항목 객체 동일)은 다시 그리지 않는다. key=seq 라 상한 slice 후에도 유지된다(CR-12)
const LogLine = memo(function LogLine({ e }: { e: SetupLogEvent }) {
  return <div className={e.status === 'error' ? 'whitespace-pre-wrap text-destructive' : 'whitespace-pre-wrap'}>{line(e)}</div>
})

/**
 * worktree 준비 단계·생성 후 스크립트 로그 패널 (F-09, AC-16, EC-19, EC-21).
 * 접힘 상태가 이슈 간에 이어지지 않도록 호출 쪽에서 key={이슈 id} 를 준다(CR-13).
 */
export interface WorktreeSetupLogProps {
  target: IssueTarget
}

export function WorktreeSetupLog({ target }: WorktreeSetupLogProps) {
  const id = worktreeId(target.owner, target.repo, target.key)
  const logs = useSetupStore((s) => s.logs[id] ?? EMPTY)
  const open = useSetupStore((s) => s.open[id])
  const script = useSetupStore((s) => s.script[id])
  const actions = useIssueActions()
  const [collapsed, setCollapsed] = useState(false)
  const bottom = useRef<HTMLDivElement>(null)
  const bodyId = useId()

  // 새 줄이 오거나 다시 펼칠 때 맨 아래로(접힌 동안은 bottom 이 없다) (CR-13)
  useEffect(() => {
    bottom.current?.scrollIntoView?.({ block: 'end' })
  }, [logs, collapsed])

  const running = script?.status === 'running'
  const visible = open?.phase === 'opening' || open?.phase === 'error' || script !== undefined
  if (!visible || logs.length === 0) {
    if (open?.phase === 'error') {
      return (
        <pre role="alert" className="m-3 whitespace-pre-wrap rounded bg-destructive/10 p-2 text-xs text-destructive">
          {open.message}
        </pre>
      )
    }
    return null
  }

  let summary = ''
  if (open?.phase === 'opening') summary = 'worktree 준비 중…'
  else if (open?.phase === 'error') summary = '준비 실패'
  else if (running) summary = '생성 후 스크립트 실행 중…'
  else if (script?.status === 'succeeded') summary = '생성 후 스크립트 완료'
  else if (script?.status === 'failed') summary = `생성 후 스크립트 실패${script.exitCode !== null ? `(종료 코드 ${script.exitCode})` : ''}`
  else if (script?.status === 'cancelled') summary = '생성 후 스크립트 취소됨'

  // 요약 live region: status 컨테이너는 항상 두고 진행·완료만 담는다. 실패는 role 을 바꾸지 않고 새 alert 노드를 삽입해 즉시 알린다(AX-08, AX-20)
  const failed = open?.phase === 'error' || script?.status === 'failed'

  return (
    <section className="border-b bg-muted/40" aria-label="준비 로그" data-testid="setup-log">
      <div className="flex items-center gap-2 px-4 py-1.5 text-sm">
        <div className="flex-1 font-medium">
          <div role="status">{failed ? null : summary}</div>
          {failed && (
            <div role="alert" className="text-destructive">
              {summary}
            </div>
          )}
        </div>
        {running && (
          <Button size="sm" variant="outline" onClick={() => void actions.cancelSetup(target)}>
            취소
          </Button>
        )}
        {(script?.status === 'failed' || script?.status === 'cancelled') && open?.phase === 'ready' && (
          <Button size="sm" variant="outline" onClick={() => void actions.rerunScript(target)}>
            다시 실행
          </Button>
        )}
        {/* 버튼 이름은 고정, 펼침 상태는 aria-expanded 로만 전달한다(AX-31) */}
        <Button size="sm" variant="ghost" aria-expanded={!collapsed} aria-controls={bodyId} onClick={() => setCollapsed((c) => !c)}>
          {collapsed ? <ChevronRightIcon aria-hidden="true" /> : <ChevronDownIcon aria-hidden="true" />}
          준비 로그
        </Button>
      </div>
      {!collapsed && (
        <div id={bodyId} className="max-h-48 overflow-auto px-4 pb-2 font-mono text-xs">
          {logs.map((e) => (
            <LogLine key={e.seq} e={e} />
          ))}
          {open?.phase === 'error' && <div className="whitespace-pre-wrap text-destructive">{open.message}</div>}
          <div ref={bottom} />
        </div>
      )}
    </section>
  )
}
