// 직접 추가한 저장소(store/repos.ts)를 트리·기준 저장소 기록과 함께 다루는 동작.
import { normalizePath } from '@minmo/api-client'
import type { Platform } from '@minmo/api-client'

import { coreIdOf } from '../../app/host'
import { useHostsStore } from '../../store/hosts'
import { LOCAL_OWNER, useReposStore } from '../../store/repos'
import { useSetupStore } from '../../store/setup'
import { useUiStore } from '../../store/ui'
import { fileDrafts } from '../files/fileDrafts'
import { baseName } from './verifyRepoFolder'

export const orgNodeId = (owner: string) => `org:${owner}`
export const repoNodeId = (owner: string, name: string) => `repo:${owner}/${name}`

/** 트리에서 그 저장소가 보이게 소유자·저장소 노드를 펼친다 */
export function revealRepo(owner: string, name: string) {
  const ui = useUiStore.getState()
  ui.setExpanded(orgNodeId(owner), true)
  ui.setExpanded(repoNodeId(owner, name), true)
}

/** 이 호스트에서 이미 로컬 저장소로 열어 둔 폴더면 그 id */
export function findLocalByPath(hostId: string, path: string, platform: Platform): string | undefined {
  const want = normalizePath(path, platform)
  return Object.entries(useReposStore.getState().local).find(([, r]) => r.hostId === hostId && normalizePath(r.path, platform) === want)?.[0]
}

/** 폴더를 로컬 저장소로 등록한다 — worktree 는 그 폴더(기준 저장소)에서 만든다 */
export function registerLocalRepo(hostId: string, top: string): string {
  const id = useReposStore.getState().addLocal({ hostId, path: top, displayName: baseName(top) || top })
  useHostsStore.getState().setBaseRepo(hostId, LOCAL_OWNER, id, top)
  revealRepo(LOCAL_OWNER, id)
  return id
}

/**
 * 더 쓰지 않는 이슈 id 의 화면 상태를 정리한다 — 열린 터미널을 끝내고, 저장 안 한 편집 내용·열기 상태를 지우고, 선택을 푼다.
 * (작업 폴더 기록은 호출하는 쪽이 지우거나 옮긴다)
 */
export function forgetIssues(ids: string[], ptyKill?: (id: string) => Promise<void>) {
  const gone = new Set(ids)
  const ui = useUiStore.getState()
  for (const [pane, pty] of Object.entries(ui.terminalIds)) {
    if (gone.has(pane.slice(0, pane.lastIndexOf('::')))) void ptyKill?.(pty).catch(() => undefined)
  }
  for (const id of ids) fileDrafts.clearScope(id)
  useSetupStore.setState((s) => {
    const drop = <T>(rec: Record<string, T>) => Object.fromEntries(Object.entries(rec).filter(([id]) => !gone.has(id)))
    return { targets: drop(s.targets), open: drop(s.open), script: drop(s.script), logs: drop(s.logs) }
  })
  if (ui.selectedIssueId !== null && gone.has(ui.selectedIssueId)) ui.selectIssue(null)
}

/** 목록에서만 뺀다 — 폴더·브랜치·작업 폴더·서버의 메모는 그대로 둔다. 열려 있던 그 저장소의 작업은 닫는다 */
export function unregisterLocalRepo(id: string, ptyKill?: (id: string) => Promise<void>) {
  const repo = useReposStore.getState().local[id]
  if (!repo) return
  useHostsStore.getState().setBaseRepo(repo.hostId, LOCAL_OWNER, id, null)
  useReposStore.getState().removeLocal(id)
  // 다시 열면 새 id 를 받으므로 이 id 의 작업 폴더 기록은 더 쓰이지 않는다(폴더는 남는다)
  const mine = (key: string) => coreIdOf(key).startsWith(`${LOCAL_OWNER}/${id}#`)
  const ui = useUiStore.getState()
  forgetIssues([...new Set([...Object.keys(ui.worktreePathMap), ...Object.keys(useSetupStore.getState().targets), ...(ui.selectedIssueId ? [ui.selectedIssueId] : [])])].filter(mine), ptyKill)
  for (const key of Object.keys(ui.worktreePathMap)) if (mine(key)) ui.removeWorktree(key)
}

/** GitHub 저장소를 목록에 더하고, 폴더를 알면 기준 저장소로 지정한다 */
export function registerGitHubRepo(owner: string, name: string, base?: { hostId: string; path: string }) {
  useReposStore.getState().addGitHub(owner, name)
  if (base) useHostsStore.getState().setBaseRepo(base.hostId, owner, name, base.path)
  revealRepo(owner, name)
}
