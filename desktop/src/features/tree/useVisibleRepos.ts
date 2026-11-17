// 보일 저장소 선택(E15/E16) — 서버에 저장해 원격 CLI 와 공유한다.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'

import type { VisibleRepos } from '@minmo/api-client'
import { isOwnerVisible, isRepoVisible } from '@minmo/core'
import type { RepoSelection } from '@minmo/core'

import { useDeps } from '../../app/deps'
import { aliasOfIssue, coreIdOf, useHost } from '../../app/host'
import { queryKeys } from '../../lib/queryKeys'
import { repoAliasOf, useHostsStore } from '../../store/hosts'
import { useUiStore } from '../../store/ui'

export function useVisibleRepos() {
  const { api } = useDeps()
  return useQuery({ queryKey: queryKeys.visibleRepos, queryFn: () => api.getVisibleRepos() })
}

/** 트리에 적용할 선택. 아직 못 불러왔거나 서버에 닿지 않으면 전체 표시(null) — 선택 때문에 트리가 비지 않게 */
export function useRepoSelection(): RepoSelection {
  return useVisibleRepos().data?.repos ?? null
}

/**
 * 로컬 worktree 가 있는 저장소는 숨김으로 골라도 보여 준다(작업 중인 것을 잃지 않게).
 * 저장소가 지금 쓰는 호스트(연결 호스트, 없으면 작업 호스트)의 기록만 센다
 */
export function useHasWorktree() {
  const map = useUiStore((s) => s.worktreePathMap)
  const repoHosts = useHostsStore((s) => s.repoHosts)
  const host = useHost()
  return useCallback(
    (owner: string, repo?: string) => {
      const o = owner.toLowerCase()
      const r = repo?.toLowerCase()
      return Object.keys(map).some((id) => {
        // core id 는 "owner/repo#key"
        const core = coreIdOf(id).toLowerCase()
        const slash = core.indexOf('/')
        const hash = core.indexOf('#', slash)
        if (slash < 0 || hash < 0 || core.slice(0, slash) !== o) return false
        const name = core.slice(slash + 1, hash)
        if (r !== undefined && name !== r) return false
        const alias = repoAliasOf({ repoHosts }, owner, name)
        return aliasOfIssue(id) === (alias === undefined ? host.alias : alias)
      })
    },
    [map, repoHosts, host],
  )
}

export function useOwnerFilter() {
  const sel = useRepoSelection()
  const hasWorktree = useHasWorktree()
  return useCallback((owner: string) => isOwnerVisible(sel, owner) || hasWorktree(owner), [sel, hasWorktree])
}

/** 저장소 표시 여부와, 숨김인데 worktree 때문에 보이는지 */
export function useRepoFilter() {
  const sel = useRepoSelection()
  const hasWorktree = useHasWorktree()
  return useCallback(
    (owner: string, repo: string): { show: boolean; hidden: boolean } => {
      const visible = isRepoVisible(sel, owner, repo)
      return visible ? { show: true, hidden: false } : { show: hasWorktree(owner, repo), hidden: true }
    },
    [sel, hasWorktree],
  )
}

export function useSaveVisibleRepos() {
  const { api } = useDeps()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { repos: string[] | null; base: string | null }) =>
      api.putVisibleRepos({ repos: input.repos, baseUpdatedAt: input.base }),
    onSuccess: (saved: VisibleRepos) => queryClient.setQueryData(queryKeys.visibleRepos, saved),
  })
}
