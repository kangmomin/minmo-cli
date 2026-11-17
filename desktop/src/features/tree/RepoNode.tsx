import { useQuery } from '@tanstack/react-query'
import { ChevronDownIcon, ChevronRightIcon, FolderGit2Icon, FolderInputIcon, MoreHorizontalIcon, PlusIcon, SettingsIcon } from 'lucide-react'
import { useId, useMemo, useState } from 'react'

import { normalizePath } from '@minmo/api-client'
import type { SettingsScope } from '@minmo/api-client'

import { useDeps } from '../../app/deps'
import { HostGate, HostStatusNotice } from '../../app/HostGate'
import type { HostStatus } from '../../app/host'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '../../components/ui/context-menu'
import { Input } from '../../components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../../components/ui/dropdown-menu'
import type { GitHubRepo } from '@minmo/core'
import { queryKeys } from '../../lib/queryKeys'
import { cn } from '../../lib/utils'
import { issueBranchContext, issuePaths, lacksOrigin } from '@minmo/core'
import { useHost } from '../../app/host'
import { baseDirOf, baseRepoOf, repoAliasOf, useHostsStore, useOriginFolder } from '../../store/hosts'
import { isLocalOwner, useReposStore } from '../../store/repos'
import { useSessionStore } from '../../store/session'
import { useUiStore } from '../../store/ui'
import type { PreviewIssue } from '../settings/SettingsDialog'
import { BaseRepoDialog } from './BaseRepoDialog'
import { issueStatus, useAgentStore } from '../agents/agentStore'
import { IssueRow } from './IssueRow'
import { ISSUE_SEARCH_MIN, matchesIssue } from './issueSearch'
import { NewTaskDialog } from './LocalRepoDialogs'
import { NewIssueDialog } from './NewIssueDialog'
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

// Badge 기본 shrink-0 이면 좁은 폭에서 배지가 줄지 않아 이름이 0px 로 사라진다 — 이름(min-w-10)과 함께 줄고 … 를 보인다 (#70)
const shrinkBadge = 'block min-w-0 shrink truncate'

/**
 * 연결 호스트를 정한 저장소는 사이드바의 작업 호스트와 관계없이 그 호스트에서 연다. 연결을 확인하기 전에는
 * 이슈 목록을 보이지 않는다 — HostScope 가 연결 안 된 원격을 이 PC 로 바꾸므로 이 PC 에 worktree 를 만들 수 있다
 */
export function RepoNode(props: RepoNodeProps) {
  const { repo } = props
  const alias = useHostsStore((s) => repoAliasOf(s, repo.owner, repo.name))
  if (alias === undefined) return <RepoNodeBody {...props} />
  return (
    <HostGate alias={alias} pending={(status) => <PendingRepoNode {...props} alias={alias ?? ''} status={status} />}>
      <RepoNodeBody {...props} bound />
    </HostGate>
  )
}

function RepoHostBadge({ label }: { label: string }) {
  return (
    <Badge variant="secondary" className={cn('ml-1 px-1 py-0 text-[10px]', shrinkBadge)} title={`연결 호스트: ${label}`} data-testid="repo-host-badge">
      {label}
    </Badge>
  )
}

/** 연결 호스트에 아직 닿지 않은 저장소 — 이름·상태와 프로젝트 설정(연결 호스트 바꾸기)만 보인다 */
function PendingRepoNode({ repo, onOpenSettings, alias, status }: RepoNodeProps & { alias: string; status: HostStatus }) {
  const openSettings = () =>
    onOpenSettings({ kind: 'project', owner: repo.owner, repo: repo.name }, { owner: repo.owner, repo: repo.name, key: 'etc', number: null, title: '' })
  return (
    <div data-testid={`repo-pending-${repo.owner}/${repo.name}`}>
      <div className="group flex items-center">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden px-1 py-1 text-sm text-muted-foreground">
          <ChevronRightIcon className="size-3.5 opacity-40" />
          <FolderGit2Icon className="size-3.5" />
          <span className="min-w-10 truncate" title={repo.name}>
            {repo.name}
          </span>
          <RepoHostBadge label={alias} />
        </div>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={`${repo.name} 프로젝트 설정`}
          title={`${repo.name} 프로젝트 설정`}
          onClick={openSettings}
          className="size-6 shrink-0 text-muted-foreground"
        >
          <SettingsIcon className="size-3.5" />
        </Button>
      </div>
      <HostStatusNotice alias={alias} status={status} className="ml-4 grid gap-1.5 border-l py-1 pl-2 text-xs" testId="repo-host-status" />
    </div>
  )
}

function RepoNodeBody({ repo, hidden = false, onOpenSettings, bound = false }: RepoNodeProps & { bound?: boolean }) {
  const { api, tauri, home, platform } = useDeps()
  const host = useHost()
  const worktreeId = host.issueId
  const baseRepo = useHostsStore((s) => baseRepoOf(s, host.id, repo.owner, repo.name))
  const baseDir = useHostsStore((s) => baseDirOf(s, host.id))
  const origin = useOriginFolder(host.id, repo.owner, repo.name)
  const [baseOpen, setBaseOpen] = useState(false)
  // 로컬 저장소(GitHub 아님): 이슈 대신 앱 안의 작업을 쓰고, 폴더 자체가 기준 저장소다
  const local = isLocalOwner(repo.owner)
  const localRepo = useReposStore((s) => (local ? s.local[repo.name] : undefined))
  const added = useReposStore((s) => !local && s.added.some((a) => a.toLowerCase() === `${repo.owner}/${repo.name}`.toLowerCase()))
  const label = localRepo?.displayName ?? repo.name
  const [dialog, setDialog] = useState<null | 'task' | 'remove' | 'issue'>(null)
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
  const agentEntries = agentPanes
    ? entries.filter(([i]) => {
        const id = worktreeId(repo.owner, repo.name, i.key)
        return id === selectedId || issueStatus(agentPanes, id) !== null
      })
    : entries
  // 이슈 검색(번호·제목) — 이슈가 많은 저장소에서만 칸을 보인다. 검색어가 남아 있으면 이슈가 줄어도 칸을 둔다(지울 수 있게)
  const [search, setSearch] = useState('')
  const searching = search.trim() !== ''
  const searchable = entries.length - 1 > ISSUE_SEARCH_MIN || searching
  const shownEntries = searching ? agentEntries.filter(([i]) => matchesIssue(i, search)) : agentEntries
  // 로컬 저장소(GitHub 아님)는 이슈 대신 작업이라고 부른다
  const noun = local ? '작업' : '이슈'

  // F-08/EC-24: 펼칠 때 effective 로 현재 경로를 계산해 생성 당시 경로와 비교. 오프라인·캐시 없음이면 배지 생략
  const effective = useQuery({
    queryKey: queryKeys.effective(repo.owner, repo.name),
    queryFn: () => api.getEffective(repo.owner, repo.name),
    enabled: expanded && hasAnyWorktree && online,
  })

  const changed = useMemo(() => {
    const out = new Set<string>()
    const eff = effective.data?.values
    if (!eff) return out
    // 이슈 열기(useWorktree)처럼 원본 폴더(로컬·기준 저장소)를 메인 clone 으로 본다 — worktree 경로가 원본 기준 상대일 수 있다
    const v = { ...eff, mainClonePath: origin ?? eff.mainClonePath }
    for (const [issue, entry] of entries) {
      if (!entry) continue
      try {
        const { ctx } = issueBranchContext(
          v,
          { owner: repo.owner, repo: repo.name, key: issue.key, number: issue.number, title: issue.title },
          { home, platform },
          { checkEtcConflict: false },
        )
        const expected = issuePaths(v, ctx, baseDir).path
        if (normalizePath(expected, platform) !== normalizePath(entry.path, platform)) out.add(issue.key)
      } catch {
        // 템플릿 오류는 배지 판단에서 제외
      }
    }
    return out
  }, [effective.data, entries, repo.owner, repo.name, home, platform, baseDir, origin])

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
              className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden rounded px-1 py-1 text-left text-sm hover:bg-accent"
            >
              {expanded ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}
              <FolderGit2Icon className="size-3.5 text-muted-foreground" />
              <span className="min-w-10 truncate" title={localRepo?.path ?? label}>
                {label}
              </span>
              {bound && <RepoHostBadge label={host.label} />}
              {hidden && (
                <Badge variant="outline" className={cn('ml-1 px-1 py-0 text-[10px]', shrinkBadge)} title="표시 목록에서 뺐지만 로컬 worktree 가 있어 보입니다">
                  숨김
                </Badge>
              )}
              {baseRepo && !local && (
                <Badge variant="outline" className={cn('ml-1 px-1 py-0 text-[10px]', shrinkBadge)} title={`기준 저장소(${host.label}): ${baseRepo}`} data-testid="base-repo-badge">
                  기준 저장소
                </Badge>
              )}
            </button>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem onSelect={openSettings}>프로젝트 설정</ContextMenuItem>
            {!local && <ContextMenuItem onSelect={() => setDialog('issue')}>이슈 등록…</ContextMenuItem>}
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
            aria-label={`${repo.name} 이슈 등록`}
            title={`${repo.name} 이슈 등록`}
            onClick={() => setDialog('issue')}
            className="size-6 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          >
            <PlusIcon className="size-3.5" />
          </Button>
        )}
        {!local && (
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
      {!local && <NewIssueDialog owner={repo.owner} repo={repo.name} open={dialog === 'issue'} onOpenChange={(o) => setDialog(o ? 'issue' : null)} />}
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
            {searchable && (
              <div className="px-1 py-1">
                <Input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onKeyDown={(e) => {
                    // 검색어가 있을 때만 가로챈다 — 비어 있으면 Esc 는 평소대로(대화상자 닫기 등) 동작한다
                    if (e.key === 'Escape' && search !== '') {
                      e.stopPropagation()
                      setSearch('')
                    }
                  }}
                  placeholder={`${noun} 검색(번호·제목)`}
                  aria-label={`${label} ${noun} 검색`}
                  data-testid="issue-search"
                  spellCheck={false}
                  className="h-7 px-2 text-xs"
                />
              </div>
            )}
            {/* 결과 수는 스크린 리더에만 알린다. live region 은 결과가 바뀌기 전에 있어야 변화가 읽힌다 */}
            {searchable && (
              <p role="status" className="sr-only">
                {searching ? `검색 결과 ${shownEntries.length}개` : ''}
              </p>
            )}
            {searching && !issues.isLoading && shownEntries.length === 0 && (
              <div className="px-2 py-1 text-xs text-muted-foreground">{agentsOnly ? '에이전트가 도는 이슈 중 검색 결과 없음' : '검색 결과 없음'}</div>
            )}
            {agentsOnly && !searching && !issues.isLoading && shownEntries.length === 0 && <div className="px-2 py-1 text-xs text-muted-foreground">에이전트가 도는 이슈 없음</div>}
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
            <button
              type="button"
              data-testid={local ? 'add-task' : 'add-issue'}
              onClick={() => setDialog(local ? 'task' : 'issue')}
              className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-sm text-muted-foreground hover:bg-accent"
            >
              <PlusIcon className="size-3.5" /> {local ? '작업 추가' : '이슈 등록'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
