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

/** 이슈별 터미널 패널 배치. tree=null 이면 모든 패널을 닫은 상태 */
export type IssuePanes = { tree: PaneNode | null; focused: string | null; seq: number }

const THEME_VALUES: readonly Theme[] = ['ghostty', 'black', 'light']

/** 터미널·파일 편집기의 글자 크기(px) */
export const FONT_SIZE = { default: 13, min: 9, max: 28 } as const
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
const isTheme = (v: unknown): v is Theme => THEME_VALUES.includes(v as Theme)

export interface UiState {
  expanded: Record<string, boolean>
  selectedIssueId: string | null
  tab: WorkTab
  /** EC-24: worktreeId(owner,repo,key) → 생성 당시 {path, branch} (persist) */
  worktreePathMap: Record<string, WorktreeEntry>
  /** paneId → PTY id (프로세스 수명과 같아 persist 하지 않음) */
  terminalIds: Record<string, string>
  theme: Theme
  /** 터미널·파일 편집기의 글자 크기(px, persist) */
  fontSize: number
  /** 에이전트가 끝났거나 입력을 기다릴 때 OS 알림을 띄운다(persist) */
  agentNotify: boolean
  /** 전체 현황의 필터·정렬·그루핑(persist) */
  agentsView: AgentsView
  /** 에이전트별 실행 명령 틀(persist) — [에이전트 실행] 에서 고치면 저장된다 */
  agentCommands: Record<LaunchKind, string>
  /** 마지막으로 실행한 에이전트(persist) */
  lastLaunchKind: LaunchKind
  /** [에이전트 실행] 대화상자를 열 이슈(트리 메뉴에서 요청 — 그 이슈의 작업 폴더가 준비되면 열린다) */
  launchRequest: string | null
  /** 트리에 에이전트가 있는 이슈만 보인다(저장하지 않는다 — 에이전트 현황은 실행 중에만 있다) */
  treeAgentsOnly: boolean
  panes: Record<string, IssuePanes>
  /** 사용자가 분할·닫기를 했을 때만 포커스를 옮긴다 — token 이 바뀐 요청만 처리(자동 포커스 금지 AX-02) */
  focusRequest: { paneId: string; token: number } | null

  setExpanded(id: string, v: boolean): void
  selectIssue(id: string | null): void
  setTab(t: WorkTab): void
  setWorktree(id: string, e: WorktreeEntry): void
  removeWorktree(id: string): void
  setTheme(t: Theme): void
  /** 범위(FONT_SIZE)를 벗어나면 가까운 값으로 맞춘다 */
  setFontSize(n: number): void
  setAgentNotify(v: boolean): void
  setAgentsView(patch: Partial<AgentsView>): void
  setTreeAgentsOnly(v: boolean): void
  setAgentCommand(kind: LaunchKind, command: string): void
  setLastLaunchKind(kind: LaunchKind): void
  setLaunchRequest(issueId: string | null): void
  /**
   * 에이전트를 실행할 터미널 패널을 마련하고 그 id 를 돌려준다. 아직 터미널을 띄운 적이 없으면 첫 패널을 쓰고,
   * 이미 쓰는 패널이 있으면 오른쪽에 새 패널을 만든다(쓰던 터미널에 명령을 끼워 넣지 않는다).
   */
  launchPane(issueId: string): string
  /**
   * 저장소 식별이 바뀔 때(로컬 저장소를 GitHub 에 올림) 이슈 id 와 트리 노드 id 를 옮긴다.
   * 패널 id 에는 이슈 id 가 들어 있어 옮길 수 없다 — 그 이슈의 터미널 패널은 닫고 다시 열 때 새로 만든다.
   */
  rekey(issues: Record<string, string>, nodes: Record<string, string>): void
  ensurePanes(issueId: string): void
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
      tab: 'terminal',
      worktreePathMap: {},
      terminalIds: {},
      theme: 'ghostty',
      fontSize: FONT_SIZE.default,
      agentNotify: true,
      agentsView: DEFAULT_AGENTS_VIEW,
      treeAgentsOnly: false,
      agentCommands: DEFAULT_AGENT_COMMANDS,
      lastLaunchKind: 'claude',
      launchRequest: null,
      panes: {},
      focusRequest: null,
      setExpanded: (id, v) => set((s) => ({ expanded: { ...s.expanded, [id]: v } })),
      selectIssue: (selectedIssueId) => set({ selectedIssueId }),
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
          // 다시 만들면 패널 번호가 1부터 다시 시작한다 — 남은 요청이 새 터미널을 자동 포커스하지 않게 지운다
          const focusRequest = s.focusRequest?.paneId.startsWith(`${id}::`) ? null : s.focusRequest
          return { worktreePathMap, terminalIds, panes, focusRequest }
        }),
      setTheme: (theme) => set({ theme }),
      setFontSize: (n) => set({ fontSize: clampFontSize(n) }),
      setAgentNotify: (agentNotify) => set({ agentNotify }),
      setAgentsView: (patch) => set((s) => ({ agentsView: { ...s.agentsView, ...patch } })),
      setTreeAgentsOnly: (treeAgentsOnly) => set({ treeAgentsOnly }),
      setAgentCommand: (kind, command) => set((s) => ({ agentCommands: { ...s.agentCommands, [kind]: command } })),
      setLastLaunchKind: (lastLaunchKind) => set({ lastLaunchKind }),
      setLaunchRequest: (launchRequest) => set({ launchRequest }),
      launchPane: (issueId) => {
        const s = get()
        const cur = s.panes[issueId]
        const leaves = leafIds(cur?.tree ?? null)
        // 패널이 없거나(모두 닫음·아직 안 만듦) 하나도 터미널을 띄우지 않았으면 그 자리를 쓴다
        if (!cur || leaves.length === 0) {
          const seq = (cur?.seq ?? 0) + 1
          const id = paneIdOf(issueId, seq)
          set({ panes: { ...s.panes, [issueId]: { tree: leaf(id), focused: id, seq } }, focusRequest: { paneId: id, token: (s.focusRequest?.token ?? 0) + 1 } })
          return id
        }
        if (!leaves.some((p) => p in s.terminalIds)) {
          set({ panes: { ...s.panes, [issueId]: { ...cur, focused: leaves[0] } }, focusRequest: { paneId: leaves[0], token: (s.focusRequest?.token ?? 0) + 1 } })
          return leaves[0]
        }
        const from = cur.focused !== null && leaves.includes(cur.focused) ? cur.focused : leaves[leaves.length - 1]
        const seq = cur.seq + 1
        const id = paneIdOf(issueId, seq)
        set({ panes: { ...s.panes, [issueId]: { tree: splitPane(cur.tree!, from, 'row', id), focused: id, seq } }, focusRequest: { paneId: id, token: (s.focusRequest?.token ?? 0) + 1 } })
        return id
      },
      rekey: (issues, nodes) =>
        set((s) => {
          const worktreePathMap = { ...s.worktreePathMap }
          const terminalIds = { ...s.terminalIds }
          const panes = { ...s.panes }
          for (const [from, to] of Object.entries(issues)) {
            if (worktreePathMap[from]) {
              worktreePathMap[to] = worktreePathMap[from]
              delete worktreePathMap[from]
            }
            for (const pane of leafIds(panes[from]?.tree ?? null)) delete terminalIds[pane]
            delete panes[from]
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
          return { worktreePathMap, terminalIds, panes, expanded, focusRequest, selectedIssueId: moved ? null : s.selectedIssueId }
        }),
      ensurePanes: (issueId) =>
        set((s) => (s.panes[issueId] ? s : { panes: { ...s.panes, [issueId]: { tree: leaf(paneIdOf(issueId, 1)), focused: null, seq: 1 } } })),
      splitPane: (issueId, paneId, dir) =>
        set((s) => {
          const cur = s.panes[issueId]
          if (!cur?.tree) return s
          const seq = cur.seq + 1
          const newId = paneIdOf(issueId, seq)
          const tree = splitPane(cur.tree, paneId, dir, newId)
          if (tree === cur.tree) return s
          return {
            panes: { ...s.panes, [issueId]: { tree, focused: newId, seq } },
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
          const seq = (cur?.seq ?? 0) + 1
          const id = paneIdOf(issueId, seq)
          return {
            panes: { ...s.panes, [issueId]: { tree: leaf(id), focused: id, seq } },
            focusRequest: { paneId: id, token: (s.focusRequest?.token ?? 0) + 1 },
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
        agentNotify: s.agentNotify,
        agentsView: s.agentsView,
        agentCommands: s.agentCommands,
        lastLaunchKind: s.lastLaunchKind,
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
          // 예전 버전의 저장 값에는 없거나 모양이 다를 수 있다 — 기본값 위에 얹는다
          agentsView: { ...current.agentsView, ...(typeof state.agentsView === 'object' && state.agentsView !== null ? state.agentsView : {}) },
          agentCommands: { ...current.agentCommands, ...(typeof state.agentCommands === 'object' && state.agentCommands !== null ? state.agentCommands : {}) },
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
