import { BotIcon, FileKeyIcon, GitBranchIcon, HomeIcon, Loader2Icon, ServerIcon, StarIcon } from 'lucide-react'
import { useEffect, useState } from 'react'

import { useHost } from '../../app/host'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import type { IssueTarget } from '@minmo/core'
import { isDefaultTarget } from '../../lib/defaultWorkspace'
import { useRepoFullNameIfNicknamed, useRepoLabel } from '../../store/repos'
import type { IssueOpenState } from '../../store/setup'
import { useUiStore } from '../../store/ui'
import { LaunchAgentDialog } from '../agents/LaunchAgentDialog'
import { TakerHeaderStatus } from '../taker/TakerStatus'
import { IssueManageActions } from './IssueManageActions'
import { LocalFilesDialog } from './LocalFilesDialog'
import { useIssueActions } from './useWorktree'

/** Why: 기본은 저장소·브랜치가 없어 ⌂ 기본 · 홈 경로 · 에이전트 실행만 보인다 */
export interface IssueHeaderProps {
  target: IssueTarget
  state: IssueOpenState | undefined
}

export function IssueHeader({ target, state }: IssueHeaderProps) {
  const actions = useIssueActions()
  const host = useHost()
  const [localOpen, setLocalOpen] = useState(false)
  const repoLabel = useRepoLabel(target.owner, target.repo)
  const repoFullName = useRepoFullNameIfNicknamed(target.owner, target.repo)
  const issueId = host.issueId(target.owner, target.repo, target.key)
  const [launchOpen, setLaunchOpen] = useState(false)
  const isDefault = isDefaultTarget(target)
  // 트리 메뉴의 [에이전트 실행] — 작업 폴더가 준비되면 대화상자를 연다
  const launchRequest = useUiStore((s) => s.launchRequest)
  const phase = state?.phase
  useEffect(() => {
    if (launchRequest === null) return
    // 다른 이슈를 보고 있거나 작업 폴더 준비에 실패했으면 요청을 버린다 — 한참 뒤에 대화상자가 불쑥 뜨지 않게
    if (launchRequest !== issueId || phase === 'error') useUiStore.getState().setLaunchRequest(null)
    else if (phase === 'ready') {
      useUiStore.getState().setLaunchRequest(null)
      setLaunchOpen(true)
    }
  }, [launchRequest, issueId, phase])
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2" data-testid="issue-header">
      {host.alias !== null && (
        <Badge variant="outline" data-testid="issue-host" title={`원격 호스트 ${host.alias} 의 worktree`}>
          <ServerIcon />
          {host.label}
        </Badge>
      )}
      {isDefault ? (
        <span className="flex items-center gap-1 font-medium">
          <HomeIcon aria-hidden className="size-4" />
          기본
        </span>
      ) : (
        <span className="text-sm text-muted-foreground" title={repoFullName}>
          {repoLabel}
        </span>
      )}
      {isDefault ? null : target.number === null ? (
        <span className="flex items-center gap-1 font-medium">
          <StarIcon className="size-4 fill-amber-400 text-amber-500" />
          기타
        </span>
      ) : (
        <>
          <span className="min-w-0 truncate font-medium">
            #{target.number} {target.title}
          </span>
          <TakerHeaderStatus key={issueId} issueId={issueId} />
          {/* worktree 준비 상태와 관계없이 둔다 — 열기에 실패한 이슈도 고치거나 닫을 수 있게(#64) */}
          <IssueManageActions key={issueId} target={{ ...target, number: target.number }} />
        </>
      )}
      {state?.phase === 'ready' && (
        <>
          {!isDefault && (
            <Badge variant="secondary" className="font-mono" data-testid="issue-branch">
              <GitBranchIcon />
              {state.branch}
            </Badge>
          )}
          <span className="min-w-0 truncate font-mono text-xs text-muted-foreground max-md:hidden" title={state.path}>
            {state.path}
          </span>
          {state.pathChanged && (
            <Badge variant="outline" className="border-amber-500 text-amber-700 dark:text-amber-400">
              경로 변경됨
            </Badge>
          )}
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setLaunchOpen(true)}>
            <BotIcon /> 에이전트 실행
          </Button>
          <LaunchAgentDialog issueId={issueId} target={target} open={launchOpen} onOpenChange={setLaunchOpen} />
          {!isDefault && (
            <>
              <Button size="sm" variant="ghost" onClick={() => setLocalOpen(true)}>
                <FileKeyIcon /> 로컬 파일
              </Button>
              <LocalFilesDialog target={target} worktreePath={state.path} open={localOpen} onOpenChange={setLocalOpen} />
            </>
          )}
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
