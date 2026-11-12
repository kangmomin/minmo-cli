import { useQuery } from '@tanstack/react-query'
import { ChevronDownIcon, ChevronRightIcon, FolderGit2Icon, FolderInputIcon, MoreHorizontalIcon, PlusIcon, SettingsIcon } from 'lucide-react'
import { useId, useMemo, useState } from 'react'

import { normalizePath, renderPath } from '@minmo/api-client'
import type { SettingsScope } from '@minmo/api-client'

import { useDeps } from '../../app/deps'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '../../components/ui/context-menu'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../../components/ui/dropdown-menu'
import type { GitHubRepo } from '@minmo/core'
import { queryKeys } from '../../lib/queryKeys'
import { issueBranchContext, lacksOrigin } from '@minmo/core'
import { useHost } from '../../app/host'
import { baseRepoOf, useHostsStore } from '../../store/hosts'
import { isLocalOwner, useReposStore } from '../../store/repos'
import { useSessionStore } from '../../store/session'
import { useUiStore } from '../../store/ui'
import type { PreviewIssue } from '../settings/SettingsDialog'
import { BaseRepoDialog } from './BaseRepoDialog'
import { issueStatus, useAgentStore } from '../agents/agentStore'
import { IssueRow } from './IssueRow'
import { NewTaskDialog } from './LocalRepoDialogs'
import { useOpenPublish } from './publishContext'
import { isPublishing } from './publishRepo'
import { unregisterLocalRepo } from './localRepos'
import { githubErrorMessage, useIssues } from './useTree'

export interface RepoNodeProps {
  repo: GitHubRepo
  /** 표시 목록에서 뺐지만 로컬 worktree 가 있어 보여 주는 저장소 */
  hidden?: boolean
  onOpenSettings(scope: SettingsScope, preview: PreviewIssue | null): void
}

export function RepoNode({ repo, hidden = false, onOpenSettings }: RepoNodeProps) {
  const { api, tauri, home, platform } = useDeps()
  const host = useHost()
  const worktreeId = host.issueId
  const baseRepo = useHostsStore((s) => baseRepoOf(s, host.id, repo.owner, repo.name))
  const [baseOpen, setBaseOpen] = useState(false)
  // 로컬 저장소(GitHub 아님): 이슈 대신 앱 안의 작업을 쓰고, 폴더 자체가 기준 저장소다
  const local = isLocalOwner(repo.owner)
  const localRepo = useReposStore((s) => (local ? s.local[repo.name] : undefined))
  const added = useReposStore((s) => !local && s.added.some((a) => a.toLowerCase() === `${repo.owner}/${repo.name}`.toLowerCase()))
  const label = localRepo?.displayName ?? repo.name
  const [dialog, setDialog] = useState<null | 'task' | 'remove'>(null)
  const openPublish = useOpenPublish()
  const nodeId = `repo:${repo.owner}/${repo.name}`
  const expanded = useUiStore((s) => !!s.expanded[nodeId])
  const setExpanded = useUiStore((s) => s.setExpanded)
  const selectedId = useUiStore((s) => s.selectedIssueId)
  const map = useUiStore((s) => s.worktreePathMap)
  const online = useSessionStore((s) => s.status === 'online')
  const issues = useIssues(repo.owner, repo.name, expanded)
  const childrenId = useId()

  const entries = useMemo(
    () => issues.issues.map((i) => [i, map[worktreeId(repo.owner, repo.name, i.key)]] as const),
    [issues.issues, map, repo.owner, repo.name, worktreeId],
  )
  const hasAnyWorktree = entries.some(([, e]) => e !== undefined)
  // "에이전트가 있는 이슈만" 필터 — 켜면 터미널에서 에이전트가 도는 이슈만 남긴다
  const agentsOnly = useUiStore((s) => s.treeAgentsOnly)
  const agentPanes = useAgentStore((s) => (agentsOnly ? s.panes : null))
  // 지금 보고 있는 이슈는 에이전트가 없어도 남긴다(누른 줄이 사라지지 않게)
  const shownEntries = agentPanes
    ? entries.filter(([i]) => {
        const id = worktreeId(repo.owner, repo.name, i.key)
        return id === selectedId || issueStatus(agentPanes, id) !== null
      })
    : entries

  // F-08/EC-24: 펼칠 때 effective 로 현재 경로를 계산해 생성 당시 경로와 비교. 오프라인·캐시 없음이면 배지 생략
  const effective = useQuery({
    queryKey: queryKeys.effective(repo.owner, repo.name),
    queryFn: () => api.getEffective(repo.owner, repo.name),
    enabled: expanded && hasAnyWorktree && online,
  })

  const changed = useMemo(() => {
    const out = new Set<string>()
    const v = effective.data?.values
    if (!v) return out
    for (const [issue, entry] of entries) {
      if (!entry) continue
      try {
        const { ctx } = issueBranchContext(
          v,
          { owner: repo.owner, repo: repo.name, key: issue.key, number: issue.number, title: issue.title },
          { home, platform },
          { checkEtcConflict: false },
        )
        const expected = renderPath(v.worktreePath, ctx)
        if (normalizePath(expected, platform) !== normalizePath(entry.path, platform)) out.add(issue.key)
      } catch {
        // 템플릿 오류는 배지 판단에서 제외
      }
    }
    return out
  }, [effective.data, entries, repo.owner, repo.name, home, platform])

  // origin 이 없는 로컬 저장소만 GitHub 에 올릴 수 있다
  const noOrigin = useQuery({
    queryKey: queryKeys.gitOrigin(host.id, localRepo?.path ?? ''),
    queryFn: () => lacksOrigin(tauri.gitRun, localRepo!.path),
    enabled: localRepo !== undefined,
  })
  const canPublish = localRepo !== undefined && (noOrigin.data === true || localRepo.publish !== undefined)
  const remove = () => (local ? setDialog('remove') : useReposStore.getState().removeGitHub(repo.owner, repo.name))

  const etcPreview: PreviewIssue = { owner: repo.owner, repo: repo.name, key: 'etc', number: null, title: '' }
  const firstIssue = issues.issues.find((i) => i.number !== null)
  const preview: PreviewIssue = firstIssue
    ? { owner: repo.owner, repo: repo.name, key: firstIssue.key, number: firstIssue.number, title: firstIssue.title }
    : etcPreview
  const openSettings = () => onOpenSettings({ kind: 'project', owner: repo.owner, repo: repo.name }, preview)

  return (
    <div>
      <div className="group flex items-center">
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <button
              type="button"
              data-testid={`repo-node-${repo.owner}/${repo.name}`}
              aria-expanded={expanded}
              aria-controls={childrenId}
              onClick={() => setExpanded(nodeId, !expanded)}
              className="flex min-w-0 flex-1 items-center gap-1 rounded px-1 py-1 text-left text-sm hover:bg-accent"
            >
              {expanded ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}
              <FolderGit2Icon className="size-3.5 text-muted-foreground" />
              <span className="truncate" title={localRepo?.path}>
                {label}
              </span>
              {hidden && (
                <Badge variant="outline" className="ml-1 px-1 py-0 text-[10px]" title="표시 목록에서 뺐지만 로컬 worktree 가 있어 보입니다">
                  숨김
                </Badge>
              )}
              {baseRepo && !local && (
                <Badge variant="outline" className="ml-1 px-1 py-0 text-[10px]" title={`기준 저장소(${host.label}): ${baseRepo}`} data-testid="base-repo-badge">
                  기준 저장소
                </Badge>
              )}
            </button>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem onSelect={openSettings}>프로젝트 설정</ContextMenuItem>
            {!local && <ContextMenuItem onSelect={() => setBaseOpen(true)}>기준 저장소 폴더…</ContextMenuItem>}
            {local && <ContextMenuItem onSelect={() => setDialog('task')}>작업 추가…</ContextMenuItem>}
            {canPublish && <ContextMenuItem onSelect={() => openPublish(repo.name)}>GitHub 에 올리기…</ContextMenuItem>}
            {(local || added) && <ContextMenuItem onSelect={remove}>목록에서 제거</ContextMenuItem>}
          </ContextMenuContent>
        </ContextMenu>
        {local ? (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={`${label} 작업 추가`}
            title={`${label} 작업 추가`}
            onClick={() => setDialog('task')}
            className="size-6 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          >
            <PlusIcon className="size-3.5" />
          </Button>
        ) : (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={`${repo.name} 기준 저장소 폴더`}
            title={`${repo.name} 기준 저장소 폴더(기존 폴더 가져오기)`}
            onClick={() => setBaseOpen(true)}
            className="size-6 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          >
            <FolderInputIcon className="size-3.5" />
          </Button>
        )}
        {(local || added) && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={`${label} 저장소 메뉴`}
                title={`${label} 저장소 메뉴`}
                className="size-6 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
              >
                <MoreHorizontalIcon className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {canPublish && <DropdownMenuItem onSelect={() => openPublish(repo.name)}>GitHub 에 올리기…</DropdownMenuItem>}
              <DropdownMenuItem onSelect={remove}>목록에서 제거</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {/* 우클릭 메뉴는 키보드로 열 수 없다 → 같은 동작의 버튼을 둔다(AX-01, WCAG 2.1.1). 이름에 대상을 넣어 여러 개를 구분한다(AX-21) */}
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={`${label} 프로젝트 설정`}
          title={`${label} 프로젝트 설정`}
          onClick={openSettings}
          className="size-6 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
        >
          <SettingsIcon className="size-3.5" />
        </Button>
      </div>
      {!local && <BaseRepoDialog owner={repo.owner} repo={repo.name} open={baseOpen} onOpenChange={setBaseOpen} />}
      {local && (
        <>
          <NewTaskDialog id={repo.name} open={dialog === 'task'} onOpenChange={(o) => setDialog(o ? 'task' : null)} />
          <Dialog open={dialog === 'remove'} onOpenChange={(o) => setDialog(o ? 'remove' : null)}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>목록에서 제거 — {label}</DialogTitle>
                <DialogDescription>
                  이 앱의 목록에서만 뺍니다. 폴더({localRepo?.path})와 브랜치·작업 폴더는 지우지 않습니다. 앱 안의 작업 목록(번호·제목)은 사라지며, 폴더를 다시 열어도 돌아오지 않습니다.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" onClick={() => setDialog(null)}>
                  취소
                </Button>
                <Button
                  variant="destructive"
                  disabled={isPublishing(repo.name)}
                  onClick={() => {
                    setDialog(null)
                    unregisterLocalRepo(repo.name, tauri.ptyKill)
                  }}
                >
                  제거
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      )}
      <div id={childrenId} hidden={!expanded}>
        {expanded && (
          <div className="ml-4 border-l pl-1">
            {issues.isError && (
              <div className="flex items-center gap-2 px-2 py-1 text-xs text-destructive">
                <span className="flex-1">{githubErrorMessage(issues.error)}</span>
                <Button size="sm" variant="ghost" onClick={() => void issues.refetch()}>
                  재시도
                </Button>
              </div>
            )}
            {issues.isLoading && <div className="px-2 py-1 text-xs text-muted-foreground">이슈 불러오는 중…</div>}
            {agentsOnly && !issues.isLoading && shownEntries.length === 0 && <div className="px-2 py-1 text-xs text-muted-foreground">에이전트가 도는 이슈 없음</div>}
            {shownEntries.map(([issue, entry]) => (
              <IssueRow
                key={issue.key}
                issueId={worktreeId(repo.owner, repo.name, issue.key)}
                owner={repo.owner}
                repo={repo.name}
                issue={issue}
                hasWorktree={entry !== undefined}
                pathChanged={changed.has(issue.key)}
                selected={selectedId === worktreeId(repo.owner, repo.name, issue.key)}
              />
            ))}
            {local && (
              <button
                type="button"
                data-testid="add-task"
                onClick={() => setDialog('task')}
                className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-sm text-muted-foreground hover:bg-accent"
              >
                <PlusIcon className="size-3.5" /> 작업 추가
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
