import { StarIcon } from 'lucide-react'
import { useId, useState } from 'react'

import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '../../components/ui/context-menu'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/ui/tooltip'
import type { DeleteCheck, IssueTarget } from '@minmo/core'
import { cn } from '../../lib/utils'
import { isLocalOwner, useRepoLabel, useReposStore } from '../../store/repos'
import { IssueAgentDot } from '../agents/AgentBadge'
import { describeOpenError, useIssueActions } from '../issue/useWorktree'
import type { TreeIssue } from './useTree'

export interface IssueRowProps {
  owner: string
  repo: string
  issue: TreeIssue
  /** 이 호스트에서의 이슈 id(worktree·터미널·에이전트 현황의 키) */
  issueId: string
  hasWorktree: boolean
  pathChanged: boolean
  selected: boolean
}

const PATH_CHANGED_TEXT = '설정의 worktree 경로가 바뀌었습니다. 기존 worktree 는 이동하지 않습니다.'

/** 삭제 확인 문구의 개수. null = git 검사 실패로 개수 불명(F-4) */
function countText(label: string, n: number | null) {
  return n === null ? (
    <>
      {label} <strong>확인 불가</strong>(git 검사 실패)
    </>
  ) : (
    <>
      {label} <strong>{n}</strong>개
    </>
  )
}

/** 이슈 행: 클릭 = 열기, ● = 로컬 worktree 있음, 닫힘·경로 변경 배지, 컨텍스트 메뉴 "worktree 삭제" */
export function IssueRow({ owner, repo, issue, issueId, hasWorktree, pathChanged, selected }: IssueRowProps) {
  const actions = useIssueActions()
  const isEtc = issue.key === 'etc'
  const repoLabel = useRepoLabel(owner, repo)
  // 로컬 저장소의 작업은 앱에서 닫고 다시 연다(GitHub 이슈는 GitHub 에서)
  const isTask = isLocalOwner(owner) && issue.number !== null
  const target: IssueTarget = { owner, repo, key: issue.key, number: issue.number, title: isEtc ? '' : issue.title }
  const [confirm, setConfirm] = useState<DeleteCheck | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const pathChangedId = useId()
  const deleteReasonId = useId()
  // EC-16: 비활성 사유는 툴팁(마우스 전용)이 아니라 항목 안에 보이고 aria-describedby 로도 읽힌다(AX-04)
  const deleteDisabledReason = isEtc ? '고정 이슈는 삭제할 수 없음' : !hasWorktree ? 'worktree 가 없습니다' : null

  async function remove(confirmed: boolean) {
    setDeleting(true)
    setDeleteError(null)
    try {
      const res = await actions.remove(target, confirmed)
      if (res.status === 'needs_confirmation') setConfirm({ uncommitted: res.uncommitted, unpushed: res.unpushed })
      else setConfirm(null)
    } catch (e) {
      setDeleteError(describeOpenError(e).message)
    } finally {
      setDeleting(false)
    }
  }

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            data-testid={`issue-row-${issue.key}`}
            aria-current={selected ? 'true' : undefined}
            aria-describedby={pathChanged ? pathChangedId : undefined}
            onClick={() => void actions.open(target)}
            className={cn(
              'flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-sm hover:bg-accent',
              selected && 'bg-accent font-medium',
              issue.state === 'closed' && 'text-muted-foreground',
            )}
          >
            {/* ● 기호 자체는 읽지 않고 의미만 이름으로 전달한다(AX-05) */}
            {hasWorktree ? (
              <span role="img" aria-label="worktree 있음" className="w-2 text-center text-xs text-emerald-600 dark:text-emerald-400">
                ●
              </span>
            ) : (
              <span aria-hidden="true" className="w-2 text-center text-xs text-transparent">
                ●
              </span>
            )}
            {isEtc ? (
              <>
                <StarIcon className="size-3.5 fill-amber-400 text-amber-500" />
                <span>기타</span>
              </>
            ) : (
              <>
                <span className="text-muted-foreground">#{issue.number}</span>
                <span className="min-w-0 flex-1 truncate">{issue.title}</span>
              </>
            )}
            <IssueAgentDot issueId={issueId} />
            {issue.state === 'closed' && <Badge variant="secondary">닫힘</Badge>}
            {pathChanged && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge variant="outline" className="border-amber-500 text-amber-700 dark:text-amber-400">
                    경로 변경됨
                  </Badge>
                </TooltipTrigger>
                <TooltipContent>{PATH_CHANGED_TEXT}</TooltipContent>
              </Tooltip>
            )}
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => void actions.open(target)}>열기</ContextMenuItem>
          {isTask && (
            <ContextMenuItem onSelect={() => useReposStore.getState().setTaskState(repo, issue.number!, issue.state === 'open' ? 'closed' : 'open')}>
              {issue.state === 'open' ? '작업 닫기' : '작업 다시 열기'}
            </ContextMenuItem>
          )}
          {deleteDisabledReason ? (
            <ContextMenuItem disabled variant="destructive" aria-label="worktree 삭제" aria-describedby={deleteReasonId}>
              worktree 삭제
              <span id={deleteReasonId} className="ml-auto pl-3 text-xs">
                {deleteDisabledReason}
              </span>
            </ContextMenuItem>
          ) : (
            <ContextMenuItem variant="destructive" onSelect={() => void remove(false)}>
              worktree 삭제
            </ContextMenuItem>
          )}
        </ContextMenuContent>
      </ContextMenu>
      {pathChanged && (
        <span id={pathChangedId} className="sr-only">
          {PATH_CHANGED_TEXT}
        </span>
      )}

      <Dialog
        open={confirm !== null || deleteError !== null}
        onOpenChange={(o) => {
          if (!o) {
            setConfirm(null)
            setDeleteError(null)
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>worktree 삭제</DialogTitle>
            {/* 데이터 손실 경고는 설명으로 두어 대화상자가 열릴 때 함께 낭독된다(AX-23) */}
            <DialogDescription>
              {repoLabel} #{issue.number} {issue.title}
              {confirm && (
                <span className="mt-2 block text-foreground">
                  {countText('미커밋 변경', confirm.uncommitted)}, {countText('미push 커밋', confirm.unpushed)}. 삭제하면 이 변경을 잃게 됩니다.
                  계속할까요?
                </span>
              )}
            </DialogDescription>
          </DialogHeader>
          {deleteError && (
            <pre role="alert" className="whitespace-pre-wrap rounded bg-muted p-2 text-xs text-destructive">
              {deleteError}
            </pre>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setConfirm(null)
                setDeleteError(null)
              }}
            >
              취소
            </Button>
            {confirm && (
              <Button variant="destructive" disabled={deleting} onClick={() => void remove(true)}>
                삭제
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
