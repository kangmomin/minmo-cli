// 이슈 머리줄의 수정·닫기(#64). GitHub 이슈는 gh/REST 로 바꾸고, 로컬 저장소의 작업은 앱 저장소(repos)에서 바꾼다.
import { useQuery, useQueryClient } from '@tanstack/react-query'

import type { GitHubIssueDetail, IssueCloseReason, IssueTarget, UpdateIssueInput } from '@minmo/core'

import { useDeps } from '../../app/deps'
import { queryKeys } from '../../lib/queryKeys'
import { isLocalOwner, useReposStore } from '../../store/repos'
import { useSetupStore } from '../../store/setup'
import { issuesQueryOptions, upsertIssueCache, useMyLogin } from '../tree/useTree'

/** 수정·닫기를 할 수 있는 이슈(★기타 제외) */
export type ManagedTarget = IssueTarget & { number: number }

export type IssueManageInfo = {
  kind: 'github' | 'task'
  /** GitHub 목록을 아직 받지 못했거나 목록에 없으면 open 으로 본다 */
  state: 'open' | 'closed'
  /** 로컬 작업의 현재 제목(앱 저장소가 기준) */
  title: string
  /** 로컬 저장소를 GitHub 에 올리는 중이면 true — 올리기는 작업 제목·상태가 그대로인지 확인하므로 바꾸지 않게 한다 */
  publishing: boolean
  /** GitHub 이슈 담당자의 login 목록(로컬 작업은 항상 빈 배열) */
  assignees: string[]
}

export function useIssueManageInfo(target: ManagedTarget): IssueManageInfo {
  const { github } = useDeps()
  const local = isLocalOwner(target.owner)
  // 트리와 같은 목록 캐시를 쓰되(이미 펼친 저장소면 다시 조회하지 않음) 이 이슈 하나만 구독한다
  const { data: issue } = useQuery({
    ...issuesQueryOptions(github, target.owner, target.repo),
    enabled: !local,
    select: (list) => list.find((i) => i.number === target.number),
  })
  const task = useReposStore((s) => (local ? s.local[target.repo]?.tasks.find((t) => t.number === target.number) : undefined))
  const publishing = useReposStore((s) => local && s.local[target.repo]?.publish !== undefined)
  if (local) return { kind: 'task', state: task?.state ?? 'open', title: task?.title ?? target.title, publishing, assignees: [] }
  return { kind: 'github', state: issue?.state ?? 'open', title: issue?.title ?? target.title, publishing: false, assignees: issue?.assignees ?? [] }
}

export const ASSIGN_ON_TEXT = '나에게 assign'
export const ASSIGN_OFF_TEXT = '내 assign 해제'

/** 나에게 assign · 해제(#86) — 트리 행의 메뉴와 이슈 머리줄이 함께 쓴다. me 가 null 이면(계정을 아직 모름) 할 수 없다 */
export function useAssignMe(owner: string, repo: string, number: number | null) {
  const { github } = useDeps()
  const queryClient = useQueryClient()
  const me = useMyLogin()
  return {
    me,
    async set(assign: boolean) {
      if (me === null || number === null) throw new Error('GitHub 계정을 확인할 수 없습니다 — 트리를 새로고침하세요')
      const issue = assign ? await github.assignIssue(owner, repo, number, me) : await github.unassignIssue(owner, repo, number, me)
      upsertIssueCache(queryClient, owner, repo, issue)
      // GitHub 은 쓰기 권한이 없는 assign·해제를 오류 없이 무시한다 — 결과로 확인해 알린다
      if (assign !== issue.assignees.includes(me)) throw new Error(`${assign ? 'assign 하지' : 'assign 을 해제하지'} 못했습니다 — 이 저장소에 쓰기 권한이 필요합니다`)
    },
  }
}

export function useIssueMutations(target: ManagedTarget) {
  const { github } = useDeps()
  const queryClient = useQueryClient()
  const { owner, repo, number } = target

  return {
    async updateGitHub(input: UpdateIssueInput) {
      const { body } = input
      const issue = await github.updateIssue(owner, repo, number, input)
      upsertIssueCache(queryClient, owner, repo, issue)
      useSetupStore.getState().renameIssue(owner, repo, number, issue.title)
      if (body !== undefined) {
        // Why: updateIssue 응답에는 본문이 없어 보낸 본문으로 이슈 탭 캐시를 고친다(upsertIssueCache 와 같은 방식).
        // 먼저 취소해야 진행 중인 옛 조회가 덮거나, 끝나지 않는 첫 조회를 다시 쓰지 않는다
        const key = queryKeys.githubIssueBody(owner, repo, number)
        await queryClient.cancelQueries({ queryKey: key })
        if (queryClient.getQueryData(key) !== undefined) queryClient.setQueryData<GitHubIssueDetail>(key, (d) => d && { ...d, ...issue, body })
        else void queryClient.invalidateQueries({ queryKey: key })
      }
    },
    async closeGitHub(reason: IssueCloseReason) {
      upsertIssueCache(queryClient, owner, repo, await github.closeIssue(owner, repo, number, reason))
    },
    renameTask(title: string) {
      // 작업이 없으면(다른 곳에서 저장소를 지움) 머리줄 제목만 바뀌지 않게 실패로 알린다
      if (!useReposStore.getState().local[repo]?.tasks.some((t) => t.number === number)) throw new Error('작업을 찾을 수 없습니다 — 트리를 새로고침하세요')
      useReposStore.getState().renameTask(repo, number, title)
      useSetupStore.getState().renameIssue(owner, repo, number, title)
    },
    closeTask() {
      useReposStore.getState().setTaskState(repo, number, 'closed')
    },
  }
}
