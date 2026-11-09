import { StarIcon } from 'lucide-react'
import { useState } from 'react'

import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '../../components/ui/context-menu'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/ui/tooltip'
import type { DeleteCheck, IssueTarget } from '../../lib/worktree'
import { cn } from '../../lib/utils'
import { describeOpenError, useIssueActions } from '../issue/useWorktree'
import type { TreeIssue } from './useTree'

export interface IssueRowProps {
  owner: string
  repo: string
  issue: TreeIssue
  hasWorktree: boolean
  pathChanged: boolean
  selected: boolean
}

/** 이슈 행: 클릭 = 열기, ● = 로컬 worktree 있음, 닫힘·경로 변경 배지, 컨텍스트 메뉴 "worktree 삭제" */
export function IssueRow({ owner, repo, issue, hasWorktree, pathChanged, selected }: IssueRowProps) {
  const actions = useIssueActions()
  const isEtc = issue.key === 'etc'
  const target: IssueTarget = { owner, repo, key: issue.key, number: issue.number, title: isEtc ? '' : issue.title }
  const [confirm, setConfirm] = useState<DeleteCheck | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)

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
            onClick={() => void actions.open(target)}
            className={cn(
              'flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-sm hover:bg-accent',
              selected && 'bg-accent font-medium',
              issue.state === 'closed' && 'text-muted-foreground',
            )}
          >
            <span className={cn('w-2 text-center text-xs', hasWorktree ? 'text-emerald-600' : 'text-transparent')} aria-label={hasWorktree ? 'worktree 있음' : undefined}>
              ●
            </span>
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
            {issue.state === 'closed' && <Badge variant="secondary">닫힘</Badge>}
            {pathChanged && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge variant="outline" className="border-amber-500 text-amber-700">
                    경로 변경됨
                  </Badge>
                </TooltipTrigger>
                <TooltipContent>설정의 worktree 경로가 바뀌었습니다. 기존 worktree 는 이동하지 않습니다.</TooltipContent>
              </Tooltip>
            )}
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => void actions.open(target)}>열기</ContextMenuItem>
          {isEtc ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <ContextMenuItem disabled variant="destructive">
                    worktree 삭제
                  </ContextMenuItem>
                </span>
              </TooltipTrigger>
              <TooltipContent>고정 이슈는 삭제할 수 없음</TooltipContent>
            </Tooltip>
          ) : (
            <ContextMenuItem variant="destructive" disabled={!hasWorktree} onSelect={() => void remove(false)}>
              worktree 삭제
            </ContextMenuItem>
          )}
        </ContextMenuContent>
      </ContextMenu>

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
            <DialogDescription>
              {owner}/{repo} #{issue.number} {issue.title}
            </DialogDescription>
          </DialogHeader>
          {confirm && (
            <p className="text-sm">
              미커밋 변경 <strong>{confirm.uncommitted}</strong>개, 미push 커밋 <strong>{confirm.unpushed}</strong>개가 있습니다. 삭제하면
              잃게 됩니다. 계속할까요?
            </p>
          )}
          {deleteError && <pre className="whitespace-pre-wrap rounded bg-muted p-2 text-xs text-destructive">{deleteError}</pre>}
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
