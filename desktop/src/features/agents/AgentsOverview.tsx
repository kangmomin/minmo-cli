// 전체 현황 — 모든 이슈의 터미널에서 도는 에이전트를 한 목록으로 보고, 필터·정렬·그루핑한다. 줄을 누르면 그 터미널로 간다.
import { BotIcon } from 'lucide-react'
import { useEffect, useId, useMemo, useState } from 'react'

import { aliasOfIssue } from '../../app/host'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../components/ui/dialog'
import { Input } from '../../components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/ui/tooltip'
import { repoLabelOf, useReposStore } from '../../store/repos'
import { useSetupStore } from '../../store/setup'
import { DEFAULT_AGENTS_VIEW, useUiStore } from '../../store/ui'
import type { AgentsView } from '../../store/ui'
import { StatusDot } from './AgentBadge'
import { STATUS_LABEL, STATUS_ORDER, useAgentStore } from './agentStore'
import type { AgentStatus } from './agentStore'
import { AGENT_LABEL } from './detect'
import type { AgentKind } from './detect'
import { GROUP_LABEL, SORT_LABEL, ago, filterRows, groupRows, sortRows, toRows } from './overview'
import type { AgentRow } from './overview'
import type { Subagent } from './subagents'

const AGENTS: readonly AgentKind[] = ['claude', 'codex', 'gemini', 'other']
const agentName = (a: AgentKind) => (a === 'other' ? '기타' : AGENT_LABEL[a])

function useRows(): AgentRow[] {
  const panes = useAgentStore((s) => s.panes)
  const subagents = useAgentStore((s) => s.subagents)
  const targets = useSetupStore((s) => s.targets)
  const local = useReposStore((s) => s.local)
  return useMemo(() => toRows(panes, { targets, hostOf: aliasOfIssue, repoLabel: (o, r) => repoLabelOf({ local }, o, r) }, subagents), [panes, targets, local, subagents])
}

/** 상단 바의 버튼 — 주의가 필요한(입력 대기·끝남) 에이전트 수를 함께 보인다 */
export function AgentsButton({ onClick }: { onClick(): void }) {
  const rows = useRows()
  const known = rows.filter((r) => r.agent !== 'other')
  const urgent = known.filter((r) => r.status === 'attention' || r.status === 'done').length
  const working = known.filter((r) => r.status === 'working').length
  const summary = known.length === 0 ? '에이전트 없음' : `작업 중 ${working} · 확인 필요 ${urgent}`
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="sm" aria-label={`에이전트 현황 — ${summary}`} onClick={onClick} data-testid="agents-button" className="gap-1.5">
          <BotIcon />
          {working > 0 && <StatusDot status="working" />}
          {urgent > 0 && (
            <Badge variant="secondary" className="px-1.5 py-0">
              {urgent}
            </Badge>
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent>에이전트 현황 — {summary}</TooltipContent>
    </Tooltip>
  )
}

export function AgentsOverview({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>에이전트 현황</DialogTitle>
          <DialogDescription>
            열어 둔 터미널에서 도는 에이전트와 프로그램입니다. 상태는 터미널 출력으로 추정합니다. 줄을 누르면 그 이슈의 터미널로 이동합니다.
          </DialogDescription>
        </DialogHeader>
        {open && <OverviewBody onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  )
}

function Toggle<T extends string>({ label, values, selected, nameOf, onChange }: { label: string; values: readonly T[]; selected: string[]; nameOf(v: T): string; onChange(next: string[]): void }) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-center gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      {values.map((v) => {
        const on = selected.includes(v)
        return (
          <Button key={v} type="button" size="sm" variant={on ? 'secondary' : 'ghost'} aria-pressed={on} className="h-6 px-2 text-xs" onClick={() => onChange(on ? selected.filter((x) => x !== v) : [...selected, v])}>
            {nameOf(v)}
          </Button>
        )
      })}
    </div>
  )
}

/** 한 에이전트 아래에 보일 하위 에이전트 수(실행 중인 것 먼저 — 나머지는 수만 알린다) */
const MAX_SUBAGENT_LINES = 6

function SubagentList({ subs, now }: { subs: Subagent[]; now: number }) {
  const shown = subs.slice(0, MAX_SUBAGENT_LINES)
  return (
    <ul className="mb-1 ml-9 border-l pl-2 text-xs" aria-label="하위 에이전트" data-testid="subagents">
      {shown.map((s) => (
        <li key={s.id} data-testid="subagent-row" data-finished={s.finished} className={s.finished ? 'flex items-center gap-2 py-0.5 text-muted-foreground' : 'flex items-center gap-2 py-0.5'}>
          <StatusDot status={s.finished ? 'idle' : 'working'} />
          <span className="w-12 shrink-0">{s.finished ? '끝남' : '실행 중'}</span>
          <span className="w-28 shrink-0 truncate">{s.type}</span>
          <span className="min-w-0 flex-1 truncate">{s.description}</span>
          <span className="w-12 shrink-0 text-right text-muted-foreground" title="마지막 활동 뒤 지난 시간">
            {ago(now - s.updatedAt)}
          </span>
        </li>
      ))}
      {subs.length > shown.length && <li className="py-0.5 text-muted-foreground">외 {subs.length - shown.length}개</li>}
    </ul>
  )
}

function OverviewBody({ onDone }: { onDone(): void }) {
  const uid = useId()
  const rows = useRows()
  const view = useUiStore((s) => s.agentsView)
  const setView = useUiStore((s) => s.setAgentsView)
  const groups = useMemo(() => groupRows(sortRows(filterRows(rows, view), view.sort), view.group), [rows, view])
  const shown = groups.reduce((n, g) => n + g.rows.length, 0)
  const filtering = view.statuses.length > 0 || view.agents.length > 0 || view.query.trim() !== '' || view.subagentsOnly
  // 열려 있는 동안 "지난 시간"이 흐르게 한다
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  function go(row: AgentRow) {
    const ui = useUiStore.getState()
    ui.selectIssue(row.issueId)
    ui.setTab('terminal')
    ui.focusPane(row.issueId, row.paneId)
    onDone()
  }

  return (
    <div className="grid gap-3">
      <div className="grid gap-2 rounded border p-2">
        <div className="flex flex-wrap items-center gap-2">
          <Input value={view.query} onChange={(e) => setView({ query: e.target.value })} placeholder="저장소·이슈·에이전트 검색" aria-label="검색" className="h-8 max-w-xs" />
          <label htmlFor={`${uid}-sort`} className="text-xs text-muted-foreground">
            정렬
          </label>
          <select id={`${uid}-sort`} className="h-8 rounded border bg-background px-2 text-sm" value={view.sort} onChange={(e) => setView({ sort: e.target.value as AgentsView['sort'] })}>
            {(Object.keys(SORT_LABEL) as AgentsView['sort'][]).map((k) => (
              <option key={k} value={k}>
                {SORT_LABEL[k]}
              </option>
            ))}
          </select>
          <label htmlFor={`${uid}-group`} className="text-xs text-muted-foreground">
            묶기
          </label>
          <select id={`${uid}-group`} className="h-8 rounded border bg-background px-2 text-sm" value={view.group} onChange={(e) => setView({ group: e.target.value as AgentsView['group'] })}>
            {(Object.keys(GROUP_LABEL) as AgentsView['group'][]).map((k) => (
              <option key={k} value={k}>
                {GROUP_LABEL[k]}
              </option>
            ))}
          </select>
          {filtering && (
            <Button type="button" size="sm" variant="ghost" className="ml-auto" onClick={() => setView({ statuses: DEFAULT_AGENTS_VIEW.statuses, agents: DEFAULT_AGENTS_VIEW.agents, query: '', subagentsOnly: false })}>
              필터 지우기
            </Button>
          )}
        </div>
        <Toggle label="상태" values={STATUS_ORDER} selected={view.statuses} nameOf={(s: AgentStatus) => STATUS_LABEL[s]} onChange={(statuses) => setView({ statuses })} />
        <Toggle label="에이전트" values={AGENTS} selected={view.agents} nameOf={agentName} onChange={(agents) => setView({ agents })} />
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={view.subagentsOnly} onChange={(e) => setView({ subagentsOnly: e.target.checked })} />
          하위 에이전트가 실행 중인 것만
        </label>
      </div>

      <p className="text-xs text-muted-foreground" role="status">
        {rows.length === 0 ? '터미널에서 도는 에이전트가 없습니다. 이슈의 터미널에서 claude·codex·gemini 등을 실행하면 여기에 나타납니다.' : `${shown}개 표시${shown !== rows.length ? ` (전체 ${rows.length}개)` : ''}`}
      </p>

      <div className="max-h-[50vh] overflow-y-auto" data-testid="agents-list">
        {groups.map((g) => (
          <section key={g.key} aria-label={g.title || '에이전트 목록'}>
            {g.title !== '' && (
              <h3 className="sticky top-0 bg-background px-1 py-1 text-xs font-semibold text-muted-foreground" data-testid="agents-group">
                {g.title} <span className="font-normal">({g.rows.length})</span>
              </h3>
            )}
            <ul>
              {g.rows.map((r) => (
                <li key={r.paneId}>
                  <button
                    type="button"
                    data-testid="agent-row"
                    data-status={r.status}
                    onClick={() => go(r)}
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <StatusDot status={r.status} />
                    <span className="w-16 shrink-0 text-xs">{STATUS_LABEL[r.status]}</span>
                    <span className="w-28 shrink-0 truncate">{r.agentLabel}</span>
                    <span className="min-w-0 flex-1 truncate">
                      <span className="text-muted-foreground">{r.repo}</span> {r.issue}
                      {r.label && <span className="text-muted-foreground"> — {r.label}</span>}
                    </span>
                    {r.host !== null && (
                      <Badge variant="outline" className="shrink-0">
                        {r.hostLabel}
                      </Badge>
                    )}
                    <span className="w-12 shrink-0 text-right text-xs text-muted-foreground" title="이 상태가 된 뒤 지난 시간">
                      {ago(now - r.since)}
                    </span>
                  </button>
                  {r.subagents.length > 0 && <SubagentList subs={r.subagents} now={now} />}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  )
}
