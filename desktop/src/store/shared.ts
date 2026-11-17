// 함께 쓰는 상태를 호스트와 맞춘다(lib/sharedState.ts) — 저장소 목록·별칭, 작업 폴더 위치, 터미널 패널 구성, 에이전트 실행 명령,
// 호스트별 기준 저장소 폴더·기본 폴더, 저장소별 연결 호스트.
// 테마·글자 크기·지금 보는 이슈·포커스처럼 기기마다 다른 것은 맞추지 않는다.
import { LAUNCH_KINDS } from '../features/agents/launch'
import type { LaunchKind } from '../features/agents/launch'
import { leafIds } from '../features/terminal/panes'
import type { PaneNode } from '../features/terminal/panes'
import { bindShared, merge3 } from '../lib/sharedState'
import type { TauriApi } from '../lib/tauri'
import { aliasOfHostId, useHostsStore } from './hosts'
import type { HostsState } from './hosts'
import { normalizeNickname, useReposStore } from './repos'
import type { ReposState } from './repos'
import { useSetupStore } from './setup'
import type { SetupState } from './setup'
import { useUiStore } from './ui'
import type { IssuePanes, UiState } from './ui'

type SharedRepos = Pick<ReposState, 'added' | 'local' | 'nicknames'>
/** 작업 호스트 목록·지금 고른 호스트·tmux 사용은 기기마다 다르므로 뺀다 */
type SharedHosts = Pick<HostsState, 'baseRepos' | 'baseDirs' | 'repoHosts'>
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
      // 다른 기기가 패널 구성을 지운 이슈(작업 폴더 삭제 등)는 터미널 시작 표시도 지운다 — 지워진 폴더에서 셸을 다시 띄우지 않게
      const started = Object.keys(s.startedTerminals).filter((id) => id in panes)
      if (started.length !== Object.keys(s.startedTerminals).length) next.startedTerminals = Object.fromEntries(started.map((id) => [id, true as const]))
    }
    return next
  })
}

/**
 * 다른 화면이 연 이슈의 정보를 받는다. 같은 이슈는 받은 값으로 덮어쓴다 — 이 화면의 값을 남겨 두면 두 화면이 서로 다른 값을
 * 되올리며 끝없이 오간다(이 화면만 아는 이슈는 그대로 두고, 그것은 한 번 올라가면 끝난다).
 */
export function applySharedTargets(value: unknown) {
  if (!isRecord(value)) return
  const known = useSetupStore.getState().targets
  const valid = Object.entries(value).filter(([, t]) => isRecord(t) && typeof t.owner === 'string' && typeof t.repo === 'string' && typeof t.key === 'string' && typeof t.title === 'string' && (t.number === null || typeof t.number === 'number'))
  const changed = valid.filter(([id, t]) => JSON.stringify(known[id]) !== JSON.stringify(t))
  if (changed.length > 0) useSetupStore.setState({ targets: { ...known, ...(Object.fromEntries(changed) as SetupState['targets']) } })
}

export function applySharedRepos(value: unknown) {
  if (!isRecord(value)) return
  const next: Partial<SharedRepos> = {}
  if (Array.isArray(value.added)) next.added = value.added.filter((x): x is string => typeof x === 'string')
  if (isRecord(value.local)) next.local = value.local as SharedRepos['local']
  // 별칭 기능 전의 값(nicknames 없음)이면 이 화면의 별칭을 그대로 둔다
  // setNickname 과 같은 규칙(소문자 키·정리한 값)으로 맞춰 받는다
  if (isRecord(value.nicknames))
    next.nicknames = Object.fromEntries(
      Object.entries(value.nicknames)
        .map(([k, v]) => [k.toLowerCase(), typeof v === 'string' ? normalizeNickname(v) : ''] as const)
        .filter(([, v]) => v !== ''),
    )
  useReposStore.setState(next)
}

const isStringMap = (v: unknown): v is Record<string, string> => isRecord(v) && Object.values(v).every((x) => typeof x === 'string')

/** 호스트별 기준 저장소 폴더·기본 폴더·연결 호스트 — 모양이 맞는 부분만 받는다(잘못된 값이 경로·호스트로 쓰이지 않게) */
export function applySharedHosts(value: unknown) {
  if (!isRecord(value)) return
  const next: Partial<SharedHosts> = {}
  if (isRecord(value.baseRepos)) next.baseRepos = Object.fromEntries(Object.entries(value.baseRepos).filter((e): e is [string, Record<string, string>] => isStringMap(e[1])))
  if (isRecord(value.baseDirs)) next.baseDirs = Object.fromEntries(Object.entries(value.baseDirs).filter((e): e is [string, string] => typeof e[1] === 'string'))
  if (isRecord(value.repoHosts))
    next.repoHosts = Object.fromEntries(
      Object.entries(value.repoHosts).filter((e): e is [string, string] => typeof e[1] === 'string' && aliasOfHostId(e[1]) !== undefined),
    )
  useHostsStore.setState(next)
}

/** 이 화면의 기준 저장소 폴더를 함께 쓰는 값으로 옮겼는가(브라우저 저장소) */
export const HOSTS_MIGRATED_KEY = 'minmo-hosts-shared'

/**
 * 기준 저장소 폴더는 함께 쓰기 전에는 화면마다 브라우저 저장소에만 있었다 — 먼저 뜬 화면의 값이 호스트의 값이 되면
 * 다른 화면(원격으로 붙은 기기)에서 정해 둔 폴더가 사라져, 그 저장소를 새로 clone 하게 된다.
 * 그래서 화면마다 한 번만 이 화면의 값을 호스트의 값에 합친다. 그 뒤로는 호스트의 값이 기준이다
 * (매번 합치면 다른 화면에서 해제한 폴더가 이 화면의 옛 값으로 되살아난다).
 */
function mergeHostsOnce(mine: SharedHosts, theirs: SharedHosts): SharedHosts {
  try {
    if (localStorage.getItem(HOSTS_MIGRATED_KEY) !== null) return theirs
    localStorage.setItem(HOSTS_MIGRATED_KEY, '1')
  } catch {
    // 저장소를 쓸 수 없으면 합치지 않는다(매번 합치게 되므로)
    return theirs
  }
  return merge3({}, mine, theirs, 3) as SharedHosts
}

/** 앱이 뜬 뒤 한 번 묶는다. 푸는 함수를 돌려준다 */
export function bindSharedStores(tauri: Pick<TauriApi, 'sharedGet' | 'sharedSet' | 'onSharedChanged'>): () => void {
  const stops = [
    bindShared<SharedRepos>(tauri, {
      key: 'repos',
      pick: () => {
        const s = useReposStore.getState()
        return { added: s.added, local: s.local, nicknames: s.nicknames }
      },
      apply: applySharedRepos,
      subscribe: (cb) => useReposStore.subscribe(cb),
    }),
    bindShared<SharedHosts>(tauri, {
      key: 'hosts',
      pick: () => {
        const s = useHostsStore.getState()
        return { baseRepos: s.baseRepos, baseDirs: s.baseDirs, repoHosts: s.repoHosts }
      },
      apply: applySharedHosts,
      subscribe: (cb) => useHostsStore.subscribe(cb),
      // baseRepos 는 호스트 → 저장소 → 폴더라 한 단계 더 깊다 — 같은 호스트의 다른 저장소를 바꾼 두 화면의 변경이 모두 남게
      depth: 3,
      firstMerge: mergeHostsOnce,
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
