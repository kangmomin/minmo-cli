import { StarIcon } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'

import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '../../components/ui/context-menu'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/ui/tooltip'
import type { DeleteCheck, IssueTarget } from '@minmo/core'
import { cn } from '../../lib/utils'
import { isLocalOwner, useRepoLabel, useReposStore } from '../../store/repos'
import { useSetupStore } from '../../store/setup'
import { useUiStore } from '../../store/ui'
import { IssueAgentDot } from '../agents/AgentBadge'
import { ASSIGN_OFF_TEXT, ASSIGN_ON_TEXT, useAssignMe } from '../issue/useIssueManage'
import { TakerRowIcon } from '../taker/TakerStatus'
import { describeOpenError, useIssueActions } from '../issue/useWorktree'
import { AssigneeBadge } from './AssigneeBadge'
import { shrinkBadge } from './badgeClasses'
import { githubErrorMessage } from './useTree'
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
  /** 줄을 눌러 열 때 부른다 */
  onOpen?(): void
}

const PATH_CHANGED_TEXT = '설정의 worktree 경로가 바뀌었습니다. 기존 worktree 는 이동하지 않습니다.'
const WORKTREE_TEXT = 'worktree 있음'
// #95: worktree 가 있으면 번호(★기타는 이름) 글자색만 바꾼다. 라이트 700 · 어두운 테마 400 — 세 테마의 배경·선택 행(accent) 모두 대비 4.5:1 이상(최저: 라이트 accent 4.9:1)
const WORKTREE_MARK = 'text-emerald-700 dark:text-emerald-400'

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

/** 이슈 행: 클릭 = 열기(터미널이 떠 있으면 그 터미널로 포커스), 왼쪽 점 = 에이전트 상태, 초록 번호 = worktree 있음, 닫힘·경로 변경 배지, 컨텍스트 메뉴 "worktree 삭제" */
export function IssueRow({ owner, repo, issue, issueId, hasWorktree, pathChanged, selected, onOpen }: IssueRowProps) {
  const actions = useIssueActions()
  const isEtc = issue.key === 'etc'
  const repoLabel = useRepoLabel(owner, repo)
  // 로컬 저장소의 작업은 앱에서 닫고 다시 연다(GitHub 이슈는 GitHub 에서)
  const isTask = isLocalOwner(owner) && issue.number !== null
  const target: IssueTarget = { owner, repo, key: issue.key, number: issue.number, title: isEtc ? '' : issue.title }
  const [confirm, setConfirm] = useState<DeleteCheck | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  // assign 은 GitHub 이슈에만 있다(★기타·로컬 작업 제외)
  const canAssign = !isEtc && !isLocalOwner(owner)
  const assign = useAssignMe(owner, repo, issue.number)
  const assignedToMe = assign.me !== null && issue.assignees.includes(assign.me)
  const [assignError, setAssignError] = useState<string | null>(null)
  // worktree 가 생기거나 없어지면 줄이 목록의 다른 묶음(작업 중 ↔ 나머지)으로 옮겨 간다 — 방금 누른(선택된) 줄이
  // 화면 밖으로 밀려나지 않게 따라간다. 처음 그릴 때는 움직이지 않는다(사용자가 보던 위치를 바꾸지 않게)
  const rowRef = useRef<HTMLButtonElement>(null)
  const hadWorktree = useRef(hasWorktree)
  useEffect(() => {
    if (hadWorktree.current === hasWorktree) return
    hadWorktree.current = hasWorktree
    if (selected) rowRef.current?.scrollIntoView?.({ block: 'nearest' })
  }, [hasWorktree, selected])
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
            ref={rowRef}
            type="button"
            data-testid={`issue-row-${issue.key}`}
            // 화면 표시(번호 색)와 별도로 E2E 가 읽는 값이다
            data-worktree={hasWorktree ? 'true' : undefined}
            aria-current={selected ? 'true' : undefined}
            aria-describedby={pathChanged ? pathChangedId : undefined}
            onClick={() => {
              // 고르기 전에 본다 — 준비 중인 이슈에는 터미널이 없다(#78: 그때는 포커스를 옮기지 않는다)
              const ready = useSetupStore.getState().open[issueId]?.phase === 'ready'
              onOpen?.()
              void actions.open(target)
              // selectIssue 와 같은 이벤트에서 요청해야 새 이슈의 터미널이 보이는 렌더에서 포커스한다
              if (ready) useUiStore.getState().focusIssueTerminal(issueId)
            }}
            className={cn(
              'flex w-full items-center gap-1.5 overflow-hidden rounded px-2 py-1 text-left text-sm hover:bg-accent',
              selected && 'bg-accent font-medium',
              issue.state === 'closed' && 'text-muted-foreground',
            )}
          >
            {/* 에이전트가 없어도 칸의 폭은 유지한다 — 행마다 제목의 시작 위치가 같아야 한다 */}
            <span className="flex w-2 shrink-0 justify-center">
              <IssueAgentDot issueId={issueId} />
            </span>
            {isEtc ? (
              <>
                <StarIcon className="size-3.5 fill-amber-400 text-amber-500" />
                <span className={cn(hasWorktree && WORKTREE_MARK)} title={hasWorktree ? WORKTREE_TEXT : undefined}>
                  기타
                </span>
              </>
            ) : (
              <>
                <span className={cn('text-muted-foreground', hasWorktree && WORKTREE_MARK)} title={hasWorktree ? WORKTREE_TEXT : undefined}>
                  #{issue.number}
                </span>
                {/* 배지(닫힘·경로 변경됨)가 함께 있어도 제목은 최소 40px 보인다 — 배지가 줄고 … 를 보인다 (#70) */}
                <span className="min-w-10 flex-1 truncate" title={issue.title}>
                  {issue.title}
                </span>
                <TakerRowIcon issueId={issueId} />
              </>
            )}
            {/* 색으로만 알리지 않는다 — 스크린 리더는 행 이름 끝에서 읽는다 */}
            {hasWorktree && <span className="sr-only">{WORKTREE_TEXT}</span>}
            <AssigneeBadge assignees={issue.assignees} me={assign.me} className={cn('max-w-24', shrinkBadge)} />
            {issue.state === 'closed' && (
              <Badge variant="secondary" className={shrinkBadge}>
                닫힘
              </Badge>
            )}
            {pathChanged && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge variant="outline" className={cn('border-amber-500 text-amber-700 dark:text-amber-400', shrinkBadge)}>
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
          <ContextMenuItem
            onSelect={() => {
              // 이슈를 열고(작업 폴더 준비) 준비되면 이슈 머리줄이 실행 대화상자를 띄운다
              useUiStore.getState().setLaunchRequest(issueId)
              void actions.open(target)
            }}
          >
            에이전트 실행…
          </ContextMenuItem>
          {canAssign && (
            <ContextMenuItem disabled={assign.me === null} onSelect={() => void assign.set(!assignedToMe).catch((e: unknown) => setAssignError(githubErrorMessage(e)))}>
              {assignedToMe ? ASSIGN_OFF_TEXT : ASSIGN_ON_TEXT}
            </ContextMenuItem>
          )}
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

      <Dialog open={assignError !== null} onOpenChange={(o) => !o && setAssignError(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>assign 실패</DialogTitle>
            <DialogDescription>
              {repoLabel} #{issue.number} {issue.title}
            </DialogDescription>
          </DialogHeader>
          <pre role="alert" className="whitespace-pre-wrap rounded bg-muted p-2 text-xs text-destructive">
            {assignError}
          </pre>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAssignError(null)}>
              닫기
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
