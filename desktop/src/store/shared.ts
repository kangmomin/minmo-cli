// 함께 쓰는 상태를 호스트와 맞춘다(lib/sharedState.ts) — 저장소 목록, 작업 폴더 위치, 터미널 패널 구성, 에이전트 실행 명령.
// 테마·글자 크기·지금 보는 이슈·포커스처럼 기기마다 다른 것은 맞추지 않는다.
import { LAUNCH_KINDS } from '../features/agents/launch'
import type { LaunchKind } from '../features/agents/launch'
import { leafIds } from '../features/terminal/panes'
import type { PaneNode } from '../features/terminal/panes'
import { bindShared } from '../lib/sharedState'
import type { TauriApi } from '../lib/tauri'
import { useReposStore } from './repos'
import type { ReposState } from './repos'
import { useSetupStore } from './setup'
import type { SetupState } from './setup'
import { useUiStore } from './ui'
import type { IssuePanes, UiState } from './ui'

type SharedRepos = Pick<ReposState, 'added' | 'local'>
type SharedUi = {
  worktreePathMap: UiState['worktreePathMap']
  agentCommands: UiState['agentCommands']
  /** 포커스는 기기마다 다르므로 뺀다 */
  panes: Record<string, Pick<IssuePanes, 'tree' | 'seq'>>
  /**
   * 열어 본 이슈의 정보(번호·제목) — 다른 기기가 연 이슈의 터미널도 이 화면의 에이전트 현황에 이름과 함께 나오고,
   * 다른 PC 에서 그 이슈를 바로 열 수 있다
   */
  targets?: SetupState['targets']
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export function pickSharedUi(s: UiState): SharedUi {
  return {
    worktreePathMap: s.worktreePathMap,
    agentCommands: s.agentCommands,
    panes: Object.fromEntries(Object.entries(s.panes).map(([id, p]) => [id, { tree: p.tree, seq: p.seq }])),
  }
}

export function applySharedUi(value: unknown) {
  if (!isRecord(value)) return
  useUiStore.setState((s) => {
    const next: Partial<UiState> = {}
    if (isRecord(value.worktreePathMap)) next.worktreePathMap = value.worktreePathMap as UiState['worktreePathMap']
    if (isRecord(value.agentCommands)) {
      const given = value.agentCommands
      next.agentCommands = { ...s.agentCommands, ...Object.fromEntries(LAUNCH_KINDS.filter((k) => typeof given[k] === 'string').map((k) => [k, given[k] as string])) } as Record<LaunchKind, string>
    }
    if (isRecord(value.panes)) {
      const panes: UiState['panes'] = {}
      for (const [id, p] of Object.entries(value.panes)) {
        if (!isRecord(p) || typeof p.seq !== 'number') continue
        const tree = (p.tree ?? null) as PaneNode | null
        // 이 기기에서 포커스하던 패널이 아직 있으면 그대로 둔다
        const focused = s.panes[id]?.focused ?? null
        panes[id] = { tree, seq: p.seq, focused: focused !== null && leafIds(tree).includes(focused) ? focused : null }
      }
      next.panes = panes
    }
    return next
  })
}

/** 다른 화면이 연 이슈의 정보를 받는다. 이 화면이 이미 아는 이슈는 그대로 둔다 */
export function applySharedTargets(value: unknown) {
  if (!isRecord(value)) return
  const known = useSetupStore.getState().targets
  const add = Object.entries(value).filter(([id, t]) => !(id in known) && isRecord(t) && typeof t.owner === 'string' && typeof t.repo === 'string' && typeof t.key === 'string' && typeof t.title === 'string')
  if (add.length > 0) useSetupStore.setState({ targets: { ...known, ...(Object.fromEntries(add) as SetupState['targets']) } })
}

export function applySharedRepos(value: unknown) {
  if (!isRecord(value)) return
  const next: Partial<SharedRepos> = {}
  if (Array.isArray(value.added)) next.added = value.added.filter((x): x is string => typeof x === 'string')
  if (isRecord(value.local)) next.local = value.local as SharedRepos['local']
  useReposStore.setState(next)
}

/** 앱이 뜬 뒤 한 번 묶는다. 푸는 함수를 돌려준다 */
export function bindSharedStores(tauri: Pick<TauriApi, 'sharedGet' | 'sharedSet' | 'onSharedChanged'>): () => void {
  const stops = [
    bindShared<SharedRepos>(tauri, {
      key: 'repos',
      pick: () => {
        const s = useReposStore.getState()
        return { added: s.added, local: s.local }
      },
      apply: applySharedRepos,
      subscribe: (cb) => useReposStore.subscribe(cb),
    }),
    bindShared<SharedUi>(tauri, {
      key: 'ui',
      pick: () => ({ ...pickSharedUi(useUiStore.getState()), targets: useSetupStore.getState().targets }),
      apply: (v) => {
        applySharedUi(v)
        applySharedTargets(isRecord(v) ? v.targets : undefined)
      },
      subscribe: (cb) => {
        const stops = [useUiStore.subscribe(cb), useSetupStore.subscribe(cb)]
        return () => stops.forEach((s) => s())
      },
    }),
  ]
  return () => stops.forEach((s) => s())
}
