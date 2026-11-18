// 트리 데이터 (F-02) — GitHub 목록은 서버 캐시 없이 gh/REST 로 직접 조회(D-22).
// 자동 재시도 없음(EC-18), 새로고침 버튼으로만 다시 불러온다.
import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query'
import type { QueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { isOfflineError } from '../../lib/apiErrors'
import { useDeps } from '../../app/deps'
import { aliasOfIssue, coreIdOf, hostOf, useHost, useHostDeps } from '../../app/host'
import { GitHubError, worktreeId as coreWorktreeId } from '@minmo/core'
import type { GitHubClient, GitHubIssue, GitHubOwner } from '@minmo/core'
import { queryKeys } from '../../lib/queryKeys'
import { useHostsStore } from '../../store/hosts'
import { isLocalOwner, useReposStore } from '../../store/repos'
import { useSessionStore } from '../../store/session'
import { useUiStore } from '../../store/ui'

const GITHUB_QUERY = { staleTime: Infinity, retry: false } as const

/** 저장소 노드의 이슈 행. key 는 이슈 번호 문자열 또는 'etc' */
export type TreeIssue = { key: string; number: number | null; title: string; state: 'open' | 'closed'; htmlUrl: string | null; assignees: string[] }

export const ETC_ISSUE: Omit<TreeIssue, 'key'> & { key: 'etc' } = { key: 'etc', number: null, title: '기타', state: 'open', htmlUrl: null, assignees: [] }

export function useGitHubSource() {
  const { github } = useDeps()
  return useQuery({ queryKey: queryKeys.githubSource, queryFn: () => github.source(), ...GITHUB_QUERY })
}

export function useOwners() {
  const { github } = useDeps()
  return useQuery({ queryKey: queryKeys.githubOwners, queryFn: () => github.listOwners(), ...GITHUB_QUERY })
}

/** GitHub API 를 부르는 내 계정의 login(#86). 소유자 목록 캐시에서 읽는다 — 아직 못 받았으면 null */
export function useMyLogin(): string | null {
  const { github } = useDeps()
  const { data } = useQuery({
    queryKey: queryKeys.githubOwners,
    queryFn: () => github.listOwners(),
    ...GITHUB_QUERY,
    // 행마다 이 훅을 쓴다 — 소유자 조회가 실패한 뒤 행이 그려질 때마다 다시 묻지 않게(EC-18: 자동 재시도 없음)
    retryOnMount: false,
    select: (owners) => owners.find((o) => o.kind === 'user')?.login ?? null,
  })
  return data ?? null
}

export function useRepos(owner: GitHubOwner, enabled: boolean) {
  const { github } = useDeps()
  return useQuery({ queryKey: queryKeys.githubRepos(owner.login), queryFn: () => github.listRepos(owner), enabled, ...GITHUB_QUERY })
}

/**
 * 이 저장소에서 worktree 가 있는 이슈 번호 (worktreePathMap 기준).
 * 어느 호스트의 것이든 모은다 — 이슈 목록 캐시는 호스트와 무관하게 하나라, 호스트를 바꿔도 닫힌 이슈가 빠지지 않게
 */
function worktreeNumbers(owner: string, repo: string): number[] {
  const prefix = coreWorktreeId(owner, repo, '')
  return Object.keys(useUiStore.getState().worktreePathMap)
    .map(coreIdOf)
    .filter((id) => id.startsWith(prefix))
    .map((id) => Number(id.slice(prefix.length)))
    .filter((n) => Number.isInteger(n) && n > 0)
}

/** 저장소의 GitHub 이슈 목록 — 트리와 이슈 머리줄이 같은 캐시·같은 조회 방식을 쓰도록 한곳에 둔다 */
export function issuesQueryOptions(github: GitHubClient, owner: string, repo: string) {
  return queryOptions({
    queryKey: queryKeys.githubIssues(owner, repo),
    queryFn: () => github.listIssues(owner, repo, { ensureNumbers: worktreeNumbers(owner, repo) }),
    ...GITHUB_QUERY,
  })
}

/** 다시 조회하지 않고 목록 캐시의 이슈 하나를 넣거나 바꾼다 — GitHub 목록은 방금 바뀐 이슈를 늦게 보여 줄 수 있다.
 *  캐시가 없으면(아직 안 펼친 저장소) 그대로 둔다: 펼칠 때 조회한다. 순서는 useIssues 가 정한다 */
export function upsertIssueCache(queryClient: QueryClient, owner: string, repo: string, issue: GitHubIssue) {
  queryClient.setQueryData<GitHubIssue[]>(queryKeys.githubIssues(owner, repo), (list) =>
    list === undefined ? list : list.some((i) => i.number === issue.number) ? list.map((i) => (i.number === issue.number ? issue : i)) : [issue, ...list],
  )
}

/** AC-03: ★기타 + open 이슈 + closed 중 로컬 worktree 가 있는 것(A-10). 로컬 저장소(GitHub 아님)는 이슈 대신 앱 안의 작업 */
export function useIssues(owner: string, repo: string, enabled: boolean) {
  const { github } = useDeps()
  const worktreeId = useHost().issueId
  const map = useUiStore((s) => s.worktreePathMap)
  const local = isLocalOwner(owner)
  const tasks = useReposStore((s) => (local ? s.local[repo]?.tasks : undefined))
  const query = useQuery({ ...issuesQueryOptions(github, owner, repo), enabled: enabled && !local })
  // 렌더마다 새 배열을 만들면 RepoNode 의 경로 비교 memo 가 매번 다시 돈다
  const data = query.data
  const issues = useMemo(() => {
    const hasWorktree = (key: string) => map[worktreeId(owner, repo, key)] !== undefined
    const source: Pick<GitHubIssue, 'number' | 'title' | 'state'>[] = local ? (tasks ?? []) : (data ?? [])
    const rows: TreeIssue[] = source
      .filter((i) => i.state === 'open' || hasWorktree(String(i.number)))
      // 작업 중인(이 호스트에 worktree 가 있는) 이슈를 위로 — 이슈가 많아도 하던 일을 바로 찾게. 그 안에서는 최신 번호 순
      .sort((a, b) => Number(hasWorktree(String(b.number))) - Number(hasWorktree(String(a.number))) || b.number - a.number)
      .map((i) => ({ key: String(i.number), number: i.number, title: i.title, state: i.state, htmlUrl: 'htmlUrl' in i ? (i as GitHubIssue).htmlUrl : null, assignees: 'assignees' in i ? (i as GitHubIssue).assignees : [] }))
    return [ETC_ISSUE as TreeIssue, ...rows]
  }, [data, local, tasks, map, owner, repo, worktreeId])
  return { ...query, issues }
}

/** 입력이 멈춘 뒤 GitHub 에 묻기까지의 시간 — GitHub 검색 한도(분당 30회)를 넘지 않게 글자마다 묻지 않는다 */
export const ISSUE_SEARCH_DEBOUNCE_MS = 400

/**
 * 검색어로 GitHub 에서 열린 이슈를 찾는다(#83) — 목록은 상한(500개)까지만 불러오므로 그 밖의 이슈는 목록 안 검색으로 못 찾는다.
 * pending 은 입력이 멈추기를 기다리는 동안에도 true 다("결과 없음"을 조회가 끝나기 전에 보이지 않게)
 */
export function useIssueSearch(owner: string, repo: string, query: string, enabled: boolean) {
  const { github } = useDeps()
  // 조합형(NFD)으로 붙여 넣은 한글도 GitHub 이 찾도록 완성형으로 보낸다
  const term = query.normalize('NFC').trim().replace(/\s+/g, ' ')
  const [debounced, setDebounced] = useState('')
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(term), ISSUE_SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [term])
  const active = enabled && term !== ''
  // 이전 검색어의 결과는 보이지 않는다 — 목록 안 검색(바로 바뀜)과 어긋난다
  const settled = debounced === term
  const result = useQuery({
    queryKey: queryKeys.githubIssueSearch(owner, repo, debounced),
    queryFn: () => github.searchIssues(owner, repo, debounced),
    enabled: active && settled,
    ...GITHUB_QUERY,
  })
  const data = result.data
  const issues = useMemo(() => (active && settled ? (data ?? []) : []), [active, settled, data])
  return {
    issues,
    pending: active && (!settled || result.isFetching),
    error: active && settled && !result.isFetching ? result.error : null,
    refetch: result.refetch,
  }
}

/** AC-04 새로고침: GitHub 목록 재조회 + 로컬 worktree 존재 여부(●) 재확인 */
export function useRefreshTree() {
  const queryClient = useQueryClient()
  const depsOf = useHostDeps()
  return useCallback(async () => {
    const map = useUiStore.getState().worktreePathMap
    const probes = useHostsStore.getState().probes
    await Promise.all(
      // 연결을 확인한 호스트(이 PC 포함)의 기록만 그 호스트에서 확인한다 — 저장소마다 호스트가 다를 수 있고,
      // 다른 호스트의 경로를 엉뚱한 곳에서 찾으면 없는 것으로 보여 지워진다
      Object.entries(map).map(async ([id, entry]) => {
        const alias = aliasOfIssue(id)
        if (alias !== null && !probes[alias]) return
        const exists = await depsOf(hostOf(alias))
          .tauri.pathExists(entry.path)
          .catch(() => true)
        if (!exists) useUiStore.getState().removeWorktree(id)
      }),
    )
    await queryClient.invalidateQueries({ queryKey: queryKeys.githubAll })
    if (useSessionStore.getState().status === 'online') await queryClient.invalidateQueries({ queryKey: queryKeys.effectiveAll })
  }, [queryClient, depsOf])
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
