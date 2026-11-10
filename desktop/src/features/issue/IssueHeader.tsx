import { FileKeyIcon, GitBranchIcon, Loader2Icon, StarIcon } from 'lucide-react'
import { useState } from 'react'

import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import type { IssueTarget } from '@minmo/core'
import type { IssueOpenState } from '../../store/setup'
import { LocalFilesDialog } from './LocalFilesDialog'
import { useIssueActions } from './useWorktree'

/** 상단 바: 저장소·이슈, 브랜치(AC-05), worktree 경로, 준비 상태 */
export interface IssueHeaderProps {
  target: IssueTarget
  state: IssueOpenState | undefined
}

export function IssueHeader({ target, state }: IssueHeaderProps) {
  const actions = useIssueActions()
  const [localOpen, setLocalOpen] = useState(false)
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2" data-testid="issue-header">
      <span className="text-sm text-muted-foreground">
        {target.owner}/{target.repo}
      </span>
      {target.number === null ? (
        <span className="flex items-center gap-1 font-medium">
          <StarIcon className="size-4 fill-amber-400 text-amber-500" />
          기타
        </span>
      ) : (
        <span className="min-w-0 truncate font-medium">
          #{target.number} {target.title}
        </span>
      )}
      {state?.phase === 'ready' && (
        <>
          <Badge variant="secondary" className="font-mono" data-testid="issue-branch">
            <GitBranchIcon />
            {state.branch}
          </Badge>
          <span className="min-w-0 truncate font-mono text-xs text-muted-foreground" title={state.path}>
            {state.path}
          </span>
          {state.pathChanged && (
            <Badge variant="outline" className="border-amber-500 text-amber-700 dark:text-amber-400">
              경로 변경됨
            </Badge>
          )}
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setLocalOpen(true)}>
            <FileKeyIcon /> 로컬 파일
          </Button>
          <LocalFilesDialog target={target} worktreePath={state.path} open={localOpen} onOpenChange={setLocalOpen} />
        </>
      )}
      {state?.phase === 'opening' && (
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <Loader2Icon className="size-3.5 animate-spin" /> worktree 준비 중…
        </span>
      )}
      {state?.phase === 'error' && (
        <Button size="sm" variant="outline" onClick={() => void actions.open(target)}>
          다시 열기
        </Button>
      )}
    </div>
  )
}
