// 이슈 머리줄의 수정·닫기(#64). GitHub 이슈는 gh/REST 로 바꾸고, 로컬 저장소의 작업은 앱 저장소(repos)에서 바꾼다.
import { useQuery, useQueryClient } from '@tanstack/react-query'

import type { IssueCloseReason, IssueTarget, UpdateIssueInput } from '@minmo/core'

import { useDeps } from '../../app/deps'
import { isLocalOwner, useReposStore } from '../../store/repos'
import { useSetupStore } from '../../store/setup'
import { issuesQueryOptions, upsertIssueCache } from '../tree/useTree'

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
  if (local) return { kind: 'task', state: task?.state ?? 'open', title: task?.title ?? target.title, publishing }
  return { kind: 'github', state: issue?.state ?? 'open', title: issue?.title ?? target.title, publishing: false }
}

export function useIssueMutations(target: ManagedTarget) {
  const { github } = useDeps()
  const queryClient = useQueryClient()
  const { owner, repo, number } = target

  return {
    async updateGitHub(input: UpdateIssueInput) {
      const issue = await github.updateIssue(owner, repo, number, input)
      upsertIssueCache(queryClient, owner, repo, issue)
      useSetupStore.getState().renameIssue(owner, repo, number, issue.title)
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
