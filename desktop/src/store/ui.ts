import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

import { DEFAULT_AGENT_COMMANDS, LAUNCH_KINDS } from '../features/agents/launch'
import type { LaunchKind } from '../features/agents/launch'
import { closePane, leaf, leafIds, splitPane } from '../features/terminal/panes'
import type { PaneNode, SplitDir } from '../features/terminal/panes'
import type { WorktreeEntry, WorktreePathStore } from '@minmo/core'

export type WorkTab = 'terminal' | 'changes' | 'files' | 'notes'
/** ghostty = Ghostty 터미널의 기본 색(기본값) */
export type Theme = 'ghostty' | 'black' | 'light'

/**
 * 이슈별 터미널 패널 배치. tree=null 이면 모든 패널을 닫은 상태.
 * first: 패널이 없을 때 처음 만든 패널 — 원격 tmux 의 기본 세션을 쓰는 패널이다(분할·닫기로 바뀌지 않는다, #89 D-26)
 */
export type IssuePanes = { tree: PaneNode | null; focused: string | null; seq: number; first?: string }

/** 패널이 없을 때 새로 만드는 패널 하나 — 이 패널이 first 가 된다(패널을 처음 만드는 모든 경로가 쓴다) */
function freshPanes(issueId: string, seq: number): IssuePanes & { focused: string } {
  const id = paneIdOf(issueId, seq)
  return { tree: leaf(id), focused: id, seq, first: id }
}

const THEME_VALUES: readonly Theme[] = ['ghostty', 'black', 'light']

/** 터미널·파일 편집기의 글자 크기(px) */
export const FONT_SIZE = { default: 13, min: 9, max: 28 } as const
/** 사이드바 폭(px) — 끌기·←/→(step)·Home/End 로 바꾼다 */
export const SIDEBAR_WIDTH = { default: 288, min: 240, max: 480, step: 16 } as const
/** 전체 현황(에이전트 목록)의 보기 옵션 — 값의 뜻은 features/agents/overview.ts */
export type AgentsView = {
  /** 보일 상태(빈 목록 = 전부) */
  statuses: string[]
  /** 보일 에이전트 종류(빈 목록 = 전부) */
  agents: string[]
  query: string
  /** 하위 에이전트가 실행 중인 것만 */
  subagentsOnly: boolean
  sort: 'status' | 'recent' | 'name' | 'subagents'
  group: 'none' | 'repo' | 'status' | 'agent' | 'host'
}
export const DEFAULT_AGENTS_VIEW: AgentsView = { statuses: [], agents: [], query: '', subagentsOnly: false, sort: 'status', group: 'none' }

export const clampFontSize = (n: unknown): number =>
  typeof n === 'number' && Number.isFinite(n) ? Math.min(FONT_SIZE.max, Math.max(FONT_SIZE.min, Math.round(n))) : FONT_SIZE.default
export const clampSidebarWidth = (n: unknown): number =>
  typeof n === 'number' && Number.isFinite(n) ? Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, Math.round(n))) : SIDEBAR_WIDTH.default
const isTheme = (v: unknown): v is Theme => THEME_VALUES.includes(v as Theme)

export interface UiState {
  expanded: Record<string, boolean>
  selectedIssueId: string | null
  /** selectIssue 를 부를 때마다 1 오른다 — 같은 이슈를 다시 골라도 좁은 화면이 작업 화면으로 넘어가게 한다(저장하지 않는다) */
  selectSeq: number
  tab: WorkTab
  /** EC-24: worktreeId(owner,repo,key) → 생성 당시 {path, branch} (persist) */
  worktreePathMap: Record<string, WorktreeEntry>
  /** paneId → PTY id (프로세스 수명과 같아 persist 하지 않음) */
  terminalIds: Record<string, string>
  theme: Theme
  /** 터미널·파일 편집기의 글자 크기(px, persist) */
  fontSize: number
  /** 사이드바 폭(px, persist) */
  sidebarWidth: number
  /** 에이전트가 끝났거나 입력을 기다릴 때 OS 알림을 띄운다(persist) */
  agentNotify: boolean
  /** 하단 바에 AI 별 사용량을 보인다(persist) */
  showUsage: boolean
  /** 전체 현황의 필터·정렬·그루핑(persist) */
  agentsView: AgentsView
  /** 에이전트별 실행 명령 틀(persist) — [에이전트 실행] 에서 고치면 저장된다 */
  agentCommands: Record<LaunchKind, string>
  /** 마지막으로 실행한 에이전트(persist) */
  lastLaunchKind: LaunchKind
  /** 등록한 다른 PC 와 저장소 목록·설정·메모·에이전트 명령을 맞춘다(persist) */
  peerSync: boolean
  /** [에이전트 실행] 대화상자를 열 이슈(트리 메뉴에서 요청 — 그 이슈의 작업 폴더가 준비되면 열린다) */
  launchRequest: string | null
  /** 트리에 에이전트가 있는 이슈만 보인다(저장하지 않는다 — 에이전트 현황은 실행 중에만 있다) */
  treeAgentsOnly: boolean
  /** 트리의 이슈를 에이전트 상태가 급한 순으로 놓는다(#98, persist) */
  treeSortByStatus: boolean
  panes: Record<string, IssuePanes>
  /**
   * 터미널을 띄우기로 한 이슈. 이슈를 고르기만 해서는 터미널(셸 프로세스)을 만들지 않는다 — 잘못 고른 이슈마다 터미널이 생기지 않게,
   * 사용자가 열 때(Ctrl+T·[터미널 열기]·에이전트 실행)만 만든다. 프로세스 수명과 같아 persist 하지 않는다
   */
  startedTerminals: Record<string, true>
  /**
   * 사용자가 분할·닫기·터미널 열기를 하거나 트리에서 이슈를 눌렀을 때(#78)만 포커스를 옮긴다 —
   * 터미널은 처리하지 않은 새 요청(객체)만 처리한다(자동 포커스 금지 AX-02)
   */
  focusRequest: { paneId: string; token: number } | null

  setExpanded(id: string, v: boolean): void
  selectIssue(id: string | null): void
  setTab(t: WorkTab): void
  setWorktree(id: string, e: WorktreeEntry): void
  removeWorktree(id: string): void
  setTheme(t: Theme): void
  /** 범위(FONT_SIZE)를 벗어나면 가까운 값으로 맞춘다 */
  setFontSize(n: number): void
  /** 범위(SIDEBAR_WIDTH)를 벗어나면 가까운 값으로 맞춘다 */
  setSidebarWidth(n: number): void
  setAgentNotify(v: boolean): void
  setShowUsage(v: boolean): void
  setAgentsView(patch: Partial<AgentsView>): void
  setTreeAgentsOnly(v: boolean): void
  setTreeSortByStatus(v: boolean): void
  setAgentCommand(kind: LaunchKind, command: string): void
  setLastLaunchKind(kind: LaunchKind): void
  setPeerSync(v: boolean): void
  setLaunchRequest(issueId: string | null): void
  /**
   * 에이전트를 실행할 터미널 패널을 마련하고 그 id 를 돌려준다. 아직 터미널을 띄운 적이 없으면 첫 패널을 쓰고,
   * 이미 쓰는 패널이 있으면 오른쪽에 새 패널을 만든다(쓰던 터미널에 명령을 끼워 넣지 않는다).
   * keepFirst: 첫 패널을 쓰지 않는다 — 원격 호스트의 첫 패널은 앱을 꺼도 남는 tmux 세션에 다시 붙으므로,
   * 거기서 돌고 있을지 모르는 프로그램에 명령이 입력되지 않게 항상 새 패널을 만든다.
   */
  launchPane(issueId: string, keepFirst?: boolean): string
  /** 이슈의 터미널을 연다(Ctrl+T·[터미널 열기]): 아직 없으면 첫 터미널을 시작하고, 이미 있으면 오른쪽에 새 패널을 만든다 */
  openTerminal(issueId: string): void
  /** 이미 떠 있는 터미널에 붙을 때 — 패널 구성·포커스는 건드리지 않고 터미널만 보이게 한다 */
  markTerminalStarted(issueId: string): void
  /** 터미널을 유지하는 이슈(keep)가 아닌 것은 시작 표시를 지운다 — 다시 나타나도 사용자가 열 때까지 만들지 않게 */
  pruneStartedTerminals(keep: ReadonlySet<string>): void
  /**
   * 저장소 식별이 바뀔 때(로컬 저장소를 GitHub 에 올림) 이슈 id 와 트리 노드 id 를 옮긴다.
   * 패널 id 에는 이슈 id 가 들어 있어 옮길 수 없다 — 그 이슈의 터미널 패널은 닫고 다시 열 때 새로 만든다.
   */
  rekey(issues: Record<string, string>, nodes: Record<string, string>): void
  /**
   * 트리에서 이슈를 눌렀을 때(#78): 터미널 탭을 보고 있고 그 이슈의 터미널이 이미 떠 있으면 그 이슈에서 마지막으로 쓴 패널로 포커스를 옮긴다.
   * 터미널이 없으면 만들지 않고, 다른 탭을 보는 중이면 탭을 바꾸지 않는다(아무것도 하지 않는다)
   */
  focusIssueTerminal(issueId: string): void
  ensurePanes(issueId: string): void
  /** 이슈의 첫 패널(first) — 없으면(이전 버전의 상태) 지금 첫 패널로 한 번 채운다. 패널이 없으면 null */
  firstPane(issueId: string): string | null
  splitPane(issueId: string, paneId: string, dir: SplitDir): void
  closePane(issueId: string, paneId: string): void
  focusPane(issueId: string, paneId: string): void
  /** 모든 패널을 닫은 뒤 [새 터미널] */
  newPane(issueId: string): void
}

export const useUiStore = create<UiState>()(
  persist(
    (set, get) => ({
      expanded: {},
      selectedIssueId: null,
      selectSeq: 0,
      tab: 'terminal',
      worktreePathMap: {},
      terminalIds: {},
      theme: 'ghostty',
      fontSize: FONT_SIZE.default,
      sidebarWidth: SIDEBAR_WIDTH.default,
      agentNotify: true,
      showUsage: true,
      agentsView: DEFAULT_AGENTS_VIEW,
      treeAgentsOnly: false,
      treeSortByStatus: false,
      agentCommands: DEFAULT_AGENT_COMMANDS,
      lastLaunchKind: 'claude',
      peerSync: true,
      launchRequest: null,
      panes: {},
      startedTerminals: {},
      focusRequest: null,
      setExpanded: (id, v) => set((s) => ({ expanded: { ...s.expanded, [id]: v } })),
      selectIssue: (selectedIssueId) => set((s) => ({ selectedIssueId, selectSeq: s.selectSeq + 1 })),
      setTab: (tab) => set({ tab }),
      setWorktree: (id, e) => set((s) => ({ worktreePathMap: { ...s.worktreePathMap, [id]: e } })),
      removeWorktree: (id) =>
        set((s) => {
          const worktreePathMap = { ...s.worktreePathMap }
          delete worktreePathMap[id]
          const terminalIds = { ...s.terminalIds }
          for (const pane of leafIds(s.panes[id]?.tree ?? null)) delete terminalIds[pane]
          const panes = { ...s.panes }
          delete panes[id]
          const startedTerminals = { ...s.startedTerminals }
          delete startedTerminals[id]
          // 다시 만들면 패널 번호가 1부터 다시 시작한다 — 남은 요청이 새 터미널을 자동 포커스하지 않게 지운다
          const focusRequest = s.focusRequest?.paneId.startsWith(`${id}::`) ? null : s.focusRequest
          return { worktreePathMap, terminalIds, panes, startedTerminals, focusRequest }
        }),
      setTheme: (theme) => set({ theme }),
      setFontSize: (n) => set({ fontSize: clampFontSize(n) }),
      setSidebarWidth: (n) => {
        const sidebarWidth = clampSidebarWidth(n)
        // persist 는 set 만 불러도(값이 같아도) localStorage 에 쓴다 — 같은 값이면 set 하지 않는다
        if (sidebarWidth !== get().sidebarWidth) set({ sidebarWidth })
      },
      setAgentNotify: (agentNotify) => set({ agentNotify }),
      setShowUsage: (showUsage) => set({ showUsage }),
      setAgentsView: (patch) => set((s) => ({ agentsView: { ...s.agentsView, ...patch } })),
      setTreeAgentsOnly: (treeAgentsOnly) => set({ treeAgentsOnly }),
      setTreeSortByStatus: (treeSortByStatus) => set({ treeSortByStatus }),
      setAgentCommand: (kind, command) => set((s) => ({ agentCommands: { ...s.agentCommands, [kind]: command } })),
      setLastLaunchKind: (lastLaunchKind) => set({ lastLaunchKind }),
      setPeerSync: (peerSync) => set({ peerSync }),
      setLaunchRequest: (launchRequest) => set({ launchRequest }),
      launchPane: (issueId, keepFirst = false) => {
        const s = get()
        let cur = s.panes[issueId]
        const leaves = leafIds(cur?.tree ?? null)
        const commit = (next: NonNullable<typeof cur>, id: string) => {
          set({
            panes: { ...s.panes, [issueId]: next },
            startedTerminals: { ...s.startedTerminals, [issueId]: true },
            focusRequest: { paneId: id, token: (s.focusRequest?.token ?? 0) + 1 },
          })
          return id
        }
        if (!cur || leaves.length === 0) {
          // 패널이 없으면(모두 닫음·아직 안 만듦) 새로 만든다
          const fresh = freshPanes(issueId, (cur?.seq ?? 0) + 1)
          cur = fresh
          if (!keepFirst) return commit(fresh, fresh.focused)
          leaves.push(fresh.focused)
        } else if (!keepFirst && !leaves.some((p) => p in s.terminalIds)) {
          // 하나도 터미널을 띄우지 않았으면 그 자리를 쓴다
          return commit({ ...cur, focused: leaves[0] }, leaves[0])
        }
        const from = cur.focused !== null && leaves.includes(cur.focused) ? cur.focused : leaves[leaves.length - 1]
        const seq = cur.seq + 1
        const id = paneIdOf(issueId, seq)
        return commit({ ...cur, tree: splitPane(cur.tree!, from, 'row', id), focused: id, seq }, id)
      },
      openTerminal: (issueId) => {
        const s = get()
        const cur = s.panes[issueId]
        const leaves = leafIds(cur?.tree ?? null)
        // 이미 연 이슈는 항상 새 패널 — 첫 터미널이 아직 뜨는 중(terminalIds 에 없음)이어도 그 자리를 다시 쓰지 않는다
        if (s.startedTerminals[issueId] && cur && leaves.length > 0) {
          s.splitPane(issueId, cur.focused !== null && leaves.includes(cur.focused) ? cur.focused : leaves[leaves.length - 1], 'row')
          return
        }
        s.launchPane(issueId)
      },
      markTerminalStarted: (issueId) => set((s) => (s.startedTerminals[issueId] ? s : { startedTerminals: { ...s.startedTerminals, [issueId]: true } })),
      pruneStartedTerminals: (keep) =>
        set((s) => {
          const ids = Object.keys(s.startedTerminals)
          const kept = ids.filter((id) => keep.has(id))
          return kept.length === ids.length ? s : { startedTerminals: Object.fromEntries(kept.map((id) => [id, true as const])) }
        }),
      rekey: (issues, nodes) =>
        set((s) => {
          const worktreePathMap = { ...s.worktreePathMap }
          const terminalIds = { ...s.terminalIds }
          const panes = { ...s.panes }
          const startedTerminals = { ...s.startedTerminals }
          for (const [from, to] of Object.entries(issues)) {
            if (worktreePathMap[from]) {
              worktreePathMap[to] = worktreePathMap[from]
              delete worktreePathMap[from]
            }
            for (const pane of leafIds(panes[from]?.tree ?? null)) delete terminalIds[pane]
            delete panes[from]
            delete startedTerminals[from]
          }
          const expanded = { ...s.expanded }
          for (const [from, to] of Object.entries(nodes)) {
            if (from in expanded) {
              expanded[to] = expanded[from]
              delete expanded[from]
            }
          }
          const moved = s.selectedIssueId !== null && s.selectedIssueId in issues
          const focusRequest = Object.keys(issues).some((id) => s.focusRequest?.paneId.startsWith(`${id}::`)) ? null : s.focusRequest
          // 열려 있던 이슈는 선택을 풀어 둔다 — 옛 id 로 잡힌 열기 상태(터미널 등)를 새 id 로 다시 열게
          return { worktreePathMap, terminalIds, panes, startedTerminals, expanded, focusRequest, selectedIssueId: moved ? null : s.selectedIssueId }
        }),
      focusIssueTerminal: (issueId) =>
        set((s) => {
          if (s.tab !== 'terminal') return s
          const cur = s.panes[issueId]
          const leaves = leafIds(cur?.tree ?? null)
          // 이 화면이 연 터미널, 또는 다른 화면이 열어 이미 떠 있는 터미널(보이면 붙는다)
          if (!s.startedTerminals[issueId] && !leaves.some((p) => p in s.terminalIds)) return s
          const paneId = cur && cur.focused !== null && leaves.includes(cur.focused) ? cur.focused : leaves[0]
          if (paneId === undefined) return s
          return { focusRequest: { paneId, token: (s.focusRequest?.token ?? 0) + 1 } }
        }),
      ensurePanes: (issueId) =>
        set((s) => (s.panes[issueId] ? s : { panes: { ...s.panes, [issueId]: { ...freshPanes(issueId, 1), focused: null } } })),
      firstPane: (issueId) => {
        const cur = get().panes[issueId]
        if (!cur) return null
        if (cur.first !== undefined) return cur.first
        // 이전 버전의 상태 — 지금 첫 패널로 한 번만 정한다(그 뒤에는 첫 패널을 닫아도 바꾸지 않는다)
        const first = leafIds(cur.tree)[0]
        if (first === undefined) return null
        set((s) => (s.panes[issueId] === cur ? { panes: { ...s.panes, [issueId]: { ...cur, first } } } : s))
        return first
      },
      splitPane: (issueId, paneId, dir) =>
        set((s) => {
          const cur = s.panes[issueId]
          if (!cur?.tree) return s
          const seq = cur.seq + 1
          const newId = paneIdOf(issueId, seq)
          const tree = splitPane(cur.tree, paneId, dir, newId)
          if (tree === cur.tree) return s
          return {
            panes: { ...s.panes, [issueId]: { ...cur, tree, focused: newId, seq } },
            focusRequest: { paneId: newId, token: (s.focusRequest?.token ?? 0) + 1 },
          }
        }),
      closePane: (issueId, paneId) =>
        set((s) => {
          const cur = s.panes[issueId]
          if (!cur?.tree) return s
          const { tree, focus } = closePane(cur.tree, paneId)
          if (tree === cur.tree) return s
          return {
            panes: { ...s.panes, [issueId]: { ...cur, tree, focused: focus } },
            focusRequest: focus ? { paneId: focus, token: (s.focusRequest?.token ?? 0) + 1 } : s.focusRequest,
          }
        }),
      focusPane: (issueId, paneId) =>
        set((s) => {
          const cur = s.panes[issueId]
          return !cur || cur.focused === paneId ? s : { panes: { ...s.panes, [issueId]: { ...cur, focused: paneId } } }
        }),
      newPane: (issueId) =>
        set((s) => {
          const cur = s.panes[issueId]
          if (cur?.tree) return s
          const next = freshPanes(issueId, (cur?.seq ?? 0) + 1)
          return {
            panes: { ...s.panes, [issueId]: next },
            focusRequest: { paneId: next.focused, token: (s.focusRequest?.token ?? 0) + 1 },
          }
        }),
    }),
    {
      name: 'minmo-ui',
      storage: createJSONStorage(() => localStorage),
      // Plan 은 terminal ids 도 persist 였으나 PTY 세션 id 는 프로세스 수명과 같아 재시작 후 의미가 없다 → 영속 대상에서 제외
      partialize: (s) => ({
        expanded: s.expanded,
        selectedIssueId: s.selectedIssueId,
        tab: s.tab,
        worktreePathMap: s.worktreePathMap,
        theme: s.theme,
        fontSize: s.fontSize,
        sidebarWidth: s.sidebarWidth,
        agentNotify: s.agentNotify,
        showUsage: s.showUsage,
        agentsView: s.agentsView,
        treeSortByStatus: s.treeSortByStatus,
        agentCommands: s.agentCommands,
        lastLaunchKind: s.lastLaunchKind,
        peerSync: s.peerSync,
      }),
      // v1: Ghostty 가 새 기본 테마다. 예전에는 고른 적이 없어도 기본값 'black' 이 저장돼 있었으므로, 저장된 'black' 을
      // 한 번만 Ghostty 로 옮긴다(직접 고른 'light' 는 그대로 둔다). 그 뒤에 고른 블랙은 유지된다
      version: 1,
      migrate: (persisted, version) => {
        const state = (persisted ?? {}) as Partial<UiState>
        return version < 1 && state.theme === 'black' ? { ...state, theme: 'ghostty' as const } : state
      },
      // 알 수 없는 테마 값(손으로 고친 값·다른 버전이 남긴 값)은 기본 테마로 본다
      merge: (persisted, current) => {
        const state = (persisted ?? {}) as Partial<UiState>
        return { ...current, ...state, theme: isTheme(state.theme) ? state.theme : current.theme, fontSize: state.fontSize === undefined ? current.fontSize : clampFontSize(state.fontSize),
          sidebarWidth: state.sidebarWidth === undefined ? current.sidebarWidth : clampSidebarWidth(state.sidebarWidth),
          // 예전 버전의 저장 값에는 없거나 모양이 다를 수 있다 — 기본값 위에 얹는다
          agentsView: { ...current.agentsView, ...(typeof state.agentsView === 'object' && state.agentsView !== null ? state.agentsView : {}) },
          // 글자 "false" 같은 값이 정렬을 켜지 않게 boolean 만 받는다
          treeSortByStatus: typeof state.treeSortByStatus === 'boolean' ? state.treeSortByStatus : current.treeSortByStatus,
          // 저장된 값이 글자가 아니면 버린다(대화상자가 그 값을 명령으로 쓴다)
          agentCommands: {
            ...current.agentCommands,
            ...Object.fromEntries(Object.entries(typeof state.agentCommands === 'object' && state.agentCommands !== null ? state.agentCommands : {}).filter(([k, v]) => LAUNCH_KINDS.includes(k as LaunchKind) && typeof v === 'string')),
          },
          lastLaunchKind: LAUNCH_KINDS.includes(state.lastLaunchKind as LaunchKind) ? (state.lastLaunchKind as LaunchKind) : current.lastLaunchKind,
        }
      },
    },
  ),
)

/** 패널 id: 이슈 안에서 단조 증가하는 번호 */
export const paneIdOf = (issueId: string, seq: number) => `${issueId}::${seq}`

/** worktree 서비스에 넘기는 WorktreePathStore 어댑터 */
export function uiWorktreePathStore(): WorktreePathStore {
  return {
    get: (id) => useUiStore.getState().worktreePathMap[id],
    set: (id, entry) => useUiStore.getState().setWorktree(id, entry),
    delete: (id) => useUiStore.getState().removeWorktree(id),
  }
}
