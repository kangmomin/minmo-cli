import { cn } from '../../lib/utils'
import { STATUS_LABEL, statusOf, useAgentStore, useIssueAgentStatus } from './agentStore'
import type { AgentStatus } from './agentStore'
import { AGENT_LABEL } from './detect'
import { runningCount } from './subagents'

const DOT: Record<AgentStatus, string> = {
  working: 'bg-sky-500 animate-pulse',
  attention: 'bg-amber-500',
  done: 'bg-emerald-500',
  idle: 'bg-muted-foreground/50',
}

/** 상태 점 — 색만으로 구분하지 않도록 이름(aria-label)과 함께 쓴다 */
export function StatusDot({ status, className }: { status: AgentStatus; className?: string }) {
  return <span aria-hidden="true" className={cn('inline-block size-2 shrink-0 rounded-full', DOT[status], className)} />
}

/** 트리 이슈 행의 표시 — 그 이슈의 터미널에서 도는 에이전트 중 가장 급한 상태 */
export function IssueAgentDot({ issueId }: { issueId: string }) {
  const status = useIssueAgentStatus(issueId)
  if (!status) return null
  return (
    <span role="img" aria-label={`에이전트 ${STATUS_LABEL[status]}`} title={`에이전트 ${STATUS_LABEL[status]}`} data-testid="issue-agent" data-status={status} className="flex items-center">
      <StatusDot status={status} />
    </span>
  )
}

/**
 * 터미널 패널 위의 한 줄 — 그 패널에서 도는 에이전트(프로그램)와 상태. 에이전트가 없어도 자리는 차지한다:
 * 생겼다 없어졌다 하면 터미널 크기가 바뀌어 화면을 다시 그리게 되고, 터미널 위에 겹쳐 두면 TUI 의 첫 줄을 가린다.
 */
export function PaneAgentStrip({ paneId }: { paneId: string }) {
  const agent = useAgentStore((s) => s.panes[paneId])
  const running = useAgentStore((s) => runningCount(s.subagents[paneId]))
  const status = agent ? statusOf(agent) : null
  const name = !agent ? '' : agent.agent === 'other' ? agent.program : AGENT_LABEL[agent.agent]
  return (
    <div className="flex h-5 shrink-0 items-center gap-1.5 px-3 text-xs text-neutral-400" data-testid="pane-strip">
      {agent && status && (
        <span data-testid="pane-agent" data-status={status} title={agent.label ? `${name} — ${agent.label}` : name} className="flex min-w-0 items-center gap-1.5">
          <StatusDot status={status} />
          <span className="truncate">
            {name} · {STATUS_LABEL[status]}
            {running > 0 && <span data-testid="pane-subagents"> · 하위 에이전트 {running}개 실행 중</span>}
            {agent.label && <span className="opacity-70"> — {agent.label}</span>}
          </span>
        </span>
      )}
    </div>
  )
}
