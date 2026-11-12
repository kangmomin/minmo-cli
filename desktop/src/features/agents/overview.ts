// 전체 현황의 줄 만들기와 필터·정렬·그루핑(순수 함수 — 화면은 AgentsOverview.tsx)
import type { IssueTarget } from '@minmo/core'

import type { AgentsView } from '../../store/ui'
import { STATUS_LABEL, STATUS_ORDER, statusOf } from './agentStore'
import type { AgentStatus, PaneAgent } from './agentStore'
import { AGENT_LABEL } from './detect'
import type { AgentKind } from './detect'
import { runningCount } from './subagents'
import type { Subagent } from './subagents'

export type AgentRow = {
  paneId: string
  issueId: string
  /** 원격 호스트 별칭(이 PC 면 null) */
  host: string | null
  hostLabel: string
  /** 저장소 표시 이름(로컬 저장소는 폴더명) */
  repo: string
  /** 이슈 표시: "#12 제목" 또는 "기타" */
  issue: string
  agent: AgentKind
  agentLabel: string
  /** 에이전트가 제목으로 알려 준 세션 이름 */
  label: string
  status: AgentStatus
  since: number
  lastOutputAt: number
  /** Claude Code 가 띄운 하위 에이전트들(실행 중인 것 먼저) */
  subagents: Subagent[]
  /** 그중 실행 중인 수 */
  running: number
}

export type RowContext = {
  targets: Record<string, IssueTarget>
  hostOf(issueId: string): string | null
  repoLabel(owner: string, repo: string): string
}

export function toRows(panes: Record<string, PaneAgent>, ctx: RowContext, subagents: Record<string, Subagent[]> = {}): AgentRow[] {
  return Object.values(panes).map((p) => {
    const t = ctx.targets[p.issueId]
    const host = ctx.hostOf(p.issueId)
    return {
      paneId: p.paneId,
      issueId: p.issueId,
      host,
      hostLabel: host ?? '이 PC',
      repo: t ? ctx.repoLabel(t.owner, t.repo) : p.issueId,
      issue: !t ? '' : t.number === null ? '기타' : `#${t.number} ${t.title}`,
      agent: p.agent,
      agentLabel: p.agent === 'other' ? `기타(${p.program})` : AGENT_LABEL[p.agent],
      label: p.label,
      status: statusOf(p),
      since: p.since,
      lastOutputAt: p.lastOutputAt,
      subagents: subagents[p.paneId] ?? [],
      running: runningCount(subagents[p.paneId]),
    }
  })
}

export function filterRows(rows: AgentRow[], view: Pick<AgentsView, 'statuses' | 'agents' | 'query'> & { subagentsOnly?: boolean }): AgentRow[] {
  const q = view.query.trim().toLowerCase()
  return rows.filter(
    (r) =>
      (view.statuses.length === 0 || view.statuses.includes(r.status)) &&
      (view.agents.length === 0 || view.agents.includes(r.agent)) &&
      (!view.subagentsOnly || r.running > 0) &&
      (q === '' || [r.repo, r.issue, r.agentLabel, r.label, r.hostLabel].some((s) => s.toLowerCase().includes(q)) || r.subagents.some((s) => `${s.type} ${s.description}`.toLowerCase().includes(q))),
  )
}

const byName = (a: AgentRow, b: AgentRow) => a.repo.localeCompare(b.repo) || a.issue.localeCompare(b.issue, undefined, { numeric: true }) || a.paneId.localeCompare(b.paneId)

export function sortRows(rows: AgentRow[], sort: AgentsView['sort']): AgentRow[] {
  const out = [...rows]
  if (sort === 'name') return out.sort(byName)
  // 하위 에이전트: 실행 중인 하위 에이전트가 많은 것부터
  if (sort === 'subagents') return out.sort((a, b) => b.running - a.running || b.subagents.length - a.subagents.length || byName(a, b))
  // 최근 활동: 방금 상태가 바뀌었거나 출력이 나온 것부터
  if (sort === 'recent') return out.sort((a, b) => Math.max(b.since, b.lastOutputAt) - Math.max(a.since, a.lastOutputAt) || byName(a, b))
  // 상태: 급한 것(입력 대기 → 끝남 → 작업 중 → 대기 중)부터, 같은 상태 안에서는 오래 기다린 것부터
  return out.sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || a.since - b.since || byName(a, b))
}

export type AgentGroup = { key: string; title: string; rows: AgentRow[] }

const AGENT_ORDER: readonly string[] = ['claude', 'codex', 'gemini', 'other']

/** 정렬된 줄을 묶는다. 묶음 순서: 상태는 급한 순, 에이전트는 정해 둔 순(기타가 마지막), 호스트는 이 PC 먼저, 나머지는 이름순. 줄의 순서는 그대로 둔다 */
export function groupRows(rows: AgentRow[], group: AgentsView['group']): AgentGroup[] {
  if (group === 'none') return [{ key: '', title: '', rows }]
  const keyOf = (r: AgentRow): [string, string] =>
    group === 'repo' ? [r.repo, r.repo] : group === 'status' ? [r.status, STATUS_LABEL[r.status]] : group === 'agent' ? [r.agent, r.agent === 'other' ? '기타' : AGENT_LABEL[r.agent]] : [r.host ?? '', r.hostLabel]
  const map = new Map<string, AgentGroup>()
  for (const r of rows) {
    const [key, title] = keyOf(r)
    let g = map.get(key)
    if (!g) map.set(key, (g = { key, title, rows: [] }))
    g.rows.push(r)
  }
  const groups = [...map.values()]
  if (group === 'status') return groups.sort((a, b) => STATUS_ORDER.indexOf(a.key as AgentStatus) - STATUS_ORDER.indexOf(b.key as AgentStatus))
  if (group === 'agent') return groups.sort((a, b) => AGENT_ORDER.indexOf(a.key) - AGENT_ORDER.indexOf(b.key))
  // 호스트는 "이 PC"(키가 빈 문자열)를 맨 앞에 둔다
  if (group === 'host') return groups.sort((a, b) => Number(a.key !== '') - Number(b.key !== '') || a.title.localeCompare(b.title))
  return groups.sort((a, b) => a.title.localeCompare(b.title))
}

export const SORT_LABEL: Record<AgentsView['sort'], string> = { status: '상태(급한 순)', recent: '최근 활동', name: '이름', subagents: '하위 에이전트 수' }
export const GROUP_LABEL: Record<AgentsView['group'], string> = { none: '묶지 않음', repo: '저장소', status: '상태', agent: '에이전트', host: '호스트' }

/** 지난 시간을 짧게: 12초 · 3분 · 2시간 */
export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}초`
  if (s < 3600) return `${Math.floor(s / 60)}분`
  return `${Math.floor(s / 3600)}시간`
}
