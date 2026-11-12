import { cn } from '../../lib/utils'
import { STATUS_LABEL, statusOf, useAgentStore, useIssueAgentStatus } from './agentStore'
import type { AgentStatus } from './agentStore'
import { AGENT_LABEL } from './detect'

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

/** 터미널 패널 오른쪽 위의 표시 — 그 패널에서 도는 에이전트와 상태 */
export function PaneAgentChip({ paneId }: { paneId: string }) {
  const agent = useAgentStore((s) => s.panes[paneId])
  if (!agent) return null
  const status = statusOf(agent)
  const name = agent.agent === 'other' ? agent.program : AGENT_LABEL[agent.agent]
  return (
    <div
      data-testid="pane-agent"
      data-status={status}
      title={agent.label ? `${name} — ${agent.label}` : name}
      className="pointer-events-none absolute top-1 right-3 z-10 flex max-w-[60%] items-center gap-1.5 rounded border bg-popover/90 px-2 py-0.5 text-xs text-popover-foreground shadow-sm"
    >
      <StatusDot status={status} />
      <span className="truncate">
        {name} · {STATUS_LABEL[status]}
      </span>
    </div>
  )
}
