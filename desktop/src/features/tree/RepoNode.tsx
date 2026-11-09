import { useQuery } from '@tanstack/react-query'
import { ChevronDownIcon, ChevronRightIcon, FolderGit2Icon, SettingsIcon } from 'lucide-react'
import { useId, useMemo } from 'react'

import { normalizePath, renderPath } from '@minmo/api-client'
import type { SettingsScope } from '@minmo/api-client'

import { useDeps } from '../../app/deps'
import { Button } from '../../components/ui/button'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '../../components/ui/context-menu'
import type { GitHubRepo } from '../../lib/github'
import { queryKeys } from '../../lib/queryKeys'
import { issueBranchContext, worktreeId } from '../../lib/worktree'
import { useSessionStore } from '../../store/session'
import { useUiStore } from '../../store/ui'
import type { PreviewIssue } from '../settings/SettingsDialog'
import { IssueRow } from './IssueRow'
import { githubErrorMessage, useIssues } from './useTree'

export interface RepoNodeProps {
  repo: GitHubRepo
  onOpenSettings(scope: SettingsScope, preview: PreviewIssue | null): void
}

export function RepoNode({ repo, onOpenSettings }: RepoNodeProps) {
  const { api, home, platform } = useDeps()
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
    [issues.issues, map, repo.owner, repo.name],
  )
  const hasAnyWorktree = entries.some(([, e]) => e !== undefined)

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
              <span className="truncate">{repo.name}</span>
            </button>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem onSelect={openSettings}>프로젝트 설정</ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
        {/* 우클릭 메뉴는 키보드로 열 수 없다 → 같은 동작의 버튼을 둔다(AX-01, WCAG 2.1.1) */}
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="프로젝트 설정"
          title="프로젝트 설정"
          onClick={openSettings}
          className="size-6 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
        >
          <SettingsIcon className="size-3.5" />
        </Button>
      </div>
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
            {entries.map(([issue, entry]) => (
              <IssueRow
                key={issue.key}
                owner={repo.owner}
                repo={repo.name}
                issue={issue}
                hasWorktree={entry !== undefined}
                pathChanged={changed.has(issue.key)}
                selected={selectedId === worktreeId(repo.owner, repo.name, issue.key)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
