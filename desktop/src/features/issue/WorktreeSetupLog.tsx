import { useEffect, useRef, useState } from 'react'

import { Button } from '../../components/ui/button'
import { worktreeId } from '../../lib/worktree'
import type { IssueTarget, SetupLogEvent, SetupStep } from '../../lib/worktree'
import { useSetupStore } from '../../store/setup'
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

const EMPTY: SetupLogEvent[] = []

function line(e: SetupLogEvent): string {
  if (e.status === 'log') return e.message ?? ''
  const label = STEP_LABEL[e.step]
  const status = { start: '시작', ok: '완료', error: '실패', cancelled: '취소됨', log: '' }[e.status]
  return `[${label}] ${status}${e.message ? ` — ${e.message}` : ''}`
}

/** worktree 준비 단계·생성 후 스크립트 로그 패널 (F-09, AC-16, EC-19, EC-21) */
export function WorktreeSetupLog({ target }: { target: IssueTarget }) {
  const id = worktreeId(target.owner, target.repo, target.key)
  const logs = useSetupStore((s) => s.logs[id] ?? EMPTY)
  const open = useSetupStore((s) => s.open[id])
  const script = useSetupStore((s) => s.script[id])
  const actions = useIssueActions()
  const [collapsed, setCollapsed] = useState(false)
  const bottom = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottom.current?.scrollIntoView?.({ block: 'end' })
  }, [logs.length])

  const running = script?.status === 'running'
  const visible = open?.phase === 'opening' || open?.phase === 'error' || script !== undefined
  if (!visible || logs.length === 0) {
    if (open?.phase === 'error') {
      return <pre className="m-3 whitespace-pre-wrap rounded bg-destructive/10 p-2 text-xs text-destructive">{open.message}</pre>
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

  return (
    <section className="border-b bg-muted/40" aria-label="준비 로그" data-testid="setup-log">
      <div className="flex items-center gap-2 px-4 py-1.5 text-sm">
        <span
          className={
            open?.phase === 'error' || script?.status === 'failed' ? 'flex-1 font-medium text-destructive' : 'flex-1 font-medium'
          }
        >
          {summary}
        </span>
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
        <Button size="sm" variant="ghost" onClick={() => setCollapsed((c) => !c)}>
          {collapsed ? '로그 보기' : '접기'}
        </Button>
      </div>
      {!collapsed && (
        <div className="max-h-48 overflow-auto px-4 pb-2 font-mono text-xs">
          {logs.map((e, i) => (
            <div key={i} className={e.status === 'error' ? 'whitespace-pre-wrap text-destructive' : 'whitespace-pre-wrap'}>
              {line(e)}
            </div>
          ))}
          {open?.phase === 'error' && <div className="whitespace-pre-wrap text-destructive">{open.message}</div>}
          <div ref={bottom} />
        </div>
      )}
    </section>
  )
}
