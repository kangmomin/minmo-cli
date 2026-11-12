// 터미널 패널별 에이전트 현황. 터미널 출력으로 추정한 값이라 앱 실행 중에만 유지한다(저장하지 않는다).
import { create } from 'zustand'

import { guessProgram } from './detect'
import type { Activity, AgentKind, TitleSignal } from './detect'

/** 화면에 보이는 상태: 작업 중 · 입력 대기(사용자 확인 필요) · 끝남(아직 안 봄) · 대기 중 */
export type AgentStatus = 'working' | 'attention' | 'done' | 'idle'

export const STATUS_LABEL: Record<AgentStatus, string> = { working: '작업 중', attention: '입력 대기', done: '끝남', idle: '대기 중' }
/** 급한 순서 — 이슈의 여러 패널을 하나로 합칠 때와 정렬에 쓴다 */
export const STATUS_ORDER: readonly AgentStatus[] = ['attention', 'done', 'working', 'idle']

export type PaneAgent = {
  paneId: string
  issueId: string
  agent: AgentKind
  /** 프로그램 이름(기타 프로그램은 실행 파일 이름) */
  program: string
  /** 에이전트가 제목으로 알려 준 세션 이름 등(없으면 '') */
  label: string
  activity: Activity
  /** 작업을 마친 뒤 사용자가 아직 그 패널을 보지 않았다 */
  unseen: boolean
  /** 마지막으로 화면에 출력이 나온 시각(ms) */
  lastOutputAt: number
  /** 지금 상태가 된 시각(ms) */
  since: number
}

export const statusOf = (p: Pick<PaneAgent, 'activity' | 'unseen'>): AgentStatus =>
  p.activity === 'attention' ? 'attention' : p.activity === 'working' ? 'working' : p.unseen ? 'done' : 'idle'

/** 패널 id(`<이슈 id>::<번호>`)의 이슈 id */
export const issueOfPane = (paneId: string) => paneId.slice(0, paneId.lastIndexOf('::'))

/** 출력이 이만큼 끊기면 "작업 중"이 아니라고 본다(제목으로 상태를 알 수 없는 프로그램) */
export const QUIET_MS = 4000

/** 패널에서 모은 신호 */
export type PaneSignals = {
  /** 제목에서 읽은 에이전트·상태(없으면 null) */
  title: TitleSignal | null
  /** 원격 tmux 가 알려 준, 지금 앞에서 도는 프로그램(없으면 undefined) */
  tmuxProgram?: string
  /** 이 PC 에서 조회한, 셸 아래의 프로세스 이름들(아직 모르면 null) */
  processes: string[] | null
  lastOutputAt: number
  /** 벨이 울린 뒤 아직 사용자가 보지 않았다 */
  bell: boolean
}

export type Derived = { next: PaneAgent | null; /** 알릴 만한 변화 */ event: 'done' | 'attention' | null }

/**
 * 신호 → 패널의 에이전트 현황. prev 는 직전 값(상태가 바뀐 시각·"안 봄" 표시를 이어 가는 데 쓴다),
 * viewed 는 사용자가 지금 그 패널을 보고 있는지.
 */
export function derive(paneId: string, sig: PaneSignals, prev: PaneAgent | null, now: number, viewed: boolean): Derived {
  const guess = sig.title ? { agent: sig.title.agent, program: sig.title.agent as string } : guessProgram(sig.tmuxProgram !== undefined ? [sig.tmuxProgram] : (sig.processes ?? []))
  if (!guess) return { next: null, event: null }
  // 이 PC: 셸 아래에 다른 프로세스가 없으면 에이전트는 없다 — 끝난 프로그램이 남긴 제목만으로 살려 두지 않는다
  if (sig.processes !== null && sig.tmuxProgram === undefined && guessProgram(sig.processes) === null) return { next: null, event: null }
  // tmux 는 프로그램이 끝나도 그 프로그램이 정한 제목을 남겨 둔다 — 앞에서 도는 것이 셸이면 에이전트는 없는 것이다
  if (sig.tmuxProgram !== undefined && guessProgram([sig.tmuxProgram]) === null) return { next: null, event: null }

  // 제목이 상태를 알려 주면 그대로, 아니면 출력이 이어지는 동안을 작업 중으로 본다
  let activity: Activity = sig.title ? sig.title.activity : now - sig.lastOutputAt <= QUIET_MS ? 'working' : 'idle'
  if (sig.bell && activity !== 'working' && !viewed) activity = 'attention'

  const same = prev !== null && prev.agent === guess.agent && prev.program === guess.program
  const was = same ? prev : null
  const finished = was?.activity === 'working' && activity === 'idle'
  const unseen = activity !== 'idle' ? false : viewed ? false : finished || (was?.unseen ?? false)
  const next: PaneAgent = {
    paneId,
    issueId: issueOfPane(paneId),
    agent: guess.agent,
    program: guess.program,
    label: sig.title?.label ?? '',
    activity,
    unseen,
    lastOutputAt: sig.lastOutputAt,
    since: was && was.activity === activity ? was.since : now,
  }
  const before = was ? statusOf(was) : null
  const after = statusOf(next)
  // 보고 있는 터미널의 변화는 알릴 필요가 없다
  const event = !viewed && after !== before && (after === 'done' || after === 'attention') ? after : null
  return { next, event }
}

export interface AgentState {
  panes: Record<string, PaneAgent>
  set(paneId: string, next: PaneAgent | null): void
  clear(): void
}

const sameAgent = (a: PaneAgent, b: PaneAgent) =>
  a.agent === b.agent && a.program === b.program && a.label === b.label && a.activity === b.activity && a.unseen === b.unseen && a.since === b.since && a.lastOutputAt === b.lastOutputAt

export const useAgentStore = create<AgentState>()((set) => ({
  panes: {},
  set: (paneId, next) =>
    set((s) => {
      const cur = s.panes[paneId]
      if (next === null) {
        if (!cur) return s
        const panes = { ...s.panes }
        delete panes[paneId]
        return { panes }
      }
      // 바뀐 것이 없으면 그대로 둔다 — 1초마다 다시 계산해도 화면을 다시 그리지 않게
      return cur && sameAgent(cur, next) ? s : { panes: { ...s.panes, [paneId]: next } }
    }),
  clear: () => set({ panes: {} }),
}))

/**
 * 이슈의 패널들 중 가장 급한 상태(에이전트가 없으면 null). 트리 표시용이라 알려진 에이전트만 센다 —
 * 개발 서버 같은 기타 프로그램까지 표시하면 이슈마다 표시가 붙어 구분이 안 된다(전체 현황에서는 볼 수 있다).
 */
export function issueStatus(panes: Record<string, PaneAgent>, issueId: string): AgentStatus | null {
  let best: AgentStatus | null = null
  for (const p of Object.values(panes)) {
    if (p.issueId !== issueId || p.agent === 'other') continue
    const st = statusOf(p)
    if (best === null || STATUS_ORDER.indexOf(st) < STATUS_ORDER.indexOf(best)) best = st
  }
  return best
}

export function useIssueAgentStatus(issueId: string): AgentStatus | null {
  return useAgentStore((s) => issueStatus(s.panes, issueId))
}
