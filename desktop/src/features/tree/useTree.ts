// 트리 데이터 (F-02) — GitHub 목록은 서버 캐시 없이 gh/REST 로 직접 조회(D-22).
// 자동 재시도 없음(EC-18), 새로고침 버튼으로만 다시 불러온다.
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useMemo } from 'react'

import { isOfflineError } from '../../lib/apiErrors'
import { useDeps } from '../../app/deps'
import { GitHubError } from '../../lib/github'
import type { GitHubIssue, GitHubOwner } from '../../lib/github'
import { queryKeys } from '../../lib/queryKeys'
import { worktreeId } from '../../lib/worktree'
import { useSessionStore } from '../../store/session'
import { useUiStore } from '../../store/ui'

const GITHUB_QUERY = { staleTime: Infinity, retry: false } as const

/** 저장소 노드의 이슈 행. key 는 이슈 번호 문자열 또는 'etc' */
export type TreeIssue = { key: string; number: number | null; title: string; state: 'open' | 'closed'; htmlUrl: string | null }

export const ETC_ISSUE: Omit<TreeIssue, 'key'> & { key: 'etc' } = { key: 'etc', number: null, title: '기타', state: 'open', htmlUrl: null }

export function useGitHubSource() {
  const { github } = useDeps()
  return useQuery({ queryKey: queryKeys.githubSource, queryFn: () => github.source(), ...GITHUB_QUERY })
}

export function useOwners() {
  const { github } = useDeps()
  return useQuery({ queryKey: queryKeys.githubOwners, queryFn: () => github.listOwners(), ...GITHUB_QUERY })
}

export function useRepos(owner: GitHubOwner, enabled: boolean) {
  const { github } = useDeps()
  return useQuery({ queryKey: queryKeys.githubRepos(owner.login), queryFn: () => github.listRepos(owner), enabled, ...GITHUB_QUERY })
}

/** 이 저장소에서 로컬 worktree 가 있는 이슈 번호 (worktreePathMap 기준) */
function worktreeNumbers(owner: string, repo: string): number[] {
  const prefix = worktreeId(owner, repo, '')
  return Object.keys(useUiStore.getState().worktreePathMap)
    .filter((id) => id.startsWith(prefix))
    .map((id) => Number(id.slice(prefix.length)))
    .filter((n) => Number.isInteger(n) && n > 0)
}

/** AC-03: ★기타 + open 이슈 + closed 중 로컬 worktree 가 있는 것(A-10) */
export function useIssues(owner: string, repo: string, enabled: boolean) {
  const { github } = useDeps()
  const map = useUiStore((s) => s.worktreePathMap)
  const query = useQuery({
    queryKey: queryKeys.githubIssues(owner, repo),
    queryFn: () => github.listIssues(owner, repo, { ensureNumbers: worktreeNumbers(owner, repo) }),
    enabled,
    ...GITHUB_QUERY,
  })
  // 렌더마다 새 배열을 만들면 RepoNode 의 경로 비교 memo 가 매번 다시 돈다
  const data = query.data
  const issues = useMemo(() => {
    const hasWorktree = (key: string) => map[worktreeId(owner, repo, key)] !== undefined
    const rows: TreeIssue[] = (data ?? [])
      .filter((i: GitHubIssue) => i.state === 'open' || hasWorktree(String(i.number)))
      .sort((a, b) => b.number - a.number)
      .map((i) => ({ key: String(i.number), number: i.number, title: i.title, state: i.state, htmlUrl: i.htmlUrl }))
    return [ETC_ISSUE as TreeIssue, ...rows]
  }, [data, map, owner, repo])
  return { ...query, issues }
}

/** AC-04 새로고침: GitHub 목록 재조회 + 로컬 worktree 존재 여부(●) 재확인 */
export function useRefreshTree() {
  const queryClient = useQueryClient()
  const { tauri } = useDeps()
  return useCallback(async () => {
    const map = useUiStore.getState().worktreePathMap
    await Promise.all(
      Object.entries(map).map(async ([id, entry]) => {
        const exists = await tauri.pathExists(entry.path).catch(() => true)
        if (!exists) useUiStore.getState().removeWorktree(id)
      }),
    )
    await queryClient.invalidateQueries({ queryKey: queryKeys.githubAll })
    if (useSessionStore.getState().status === 'online') await queryClient.invalidateQueries({ queryKey: queryKeys.effectiveAll })
  }, [queryClient, tauri])
}

/** GitHub 오류 → 트리 인라인 문구 (EC-18 재시도 가능 시각 포함) */
export function githubErrorMessage(e: unknown): string {
  if (e instanceof GitHubError) {
    if (e.code === 'rate_limited') {
      if (e.retryAt) {
        const hhmm = e.retryAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
        return `GitHub 사용량 제한 — ${hhmm} 이후 재시도`
      }
      return 'GitHub 사용량 제한 — 잠시 후 재시도'
    }
    if (e.code === 'unauthorized') return 'GitHub 인증이 만료되었습니다 — 다시 로그인하세요'
    if (e.code === 'network') return 'GitHub 에 연결할 수 없습니다'
    if (e.code === 'forbidden') return `GitHub 접근 거부 — ${e.message}`
    return `GitHub 오류(${e.code}) ${e.message}`
  }
  if (isOfflineError(e)) return '서버에 연결할 수 없습니다'
  return e instanceof Error ? e.message : String(e)
}
