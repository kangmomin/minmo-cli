import { BuildingIcon, ChevronDownIcon, ChevronRightIcon, HardDriveIcon, SettingsIcon, UserIcon } from 'lucide-react'
import { useId } from 'react'

import type { SettingsScope } from '@minmo/api-client'

import { Button } from '../../components/ui/button'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '../../components/ui/context-menu'
import type { GitHubOwner, GitHubRepo } from '@minmo/core'
import { isLocalOwner } from '../../store/repos'
import { useUiStore } from '../../store/ui'
import type { PreviewIssue } from '../settings/SettingsDialog'
import { RepoNode } from './RepoNode'
import { githubErrorMessage, useRepos } from './useTree'
import { useRepoFilter } from './useVisibleRepos'

export interface OrgNodeProps {
  owner: GitHubOwner
  /** 직접 추가한 저장소 — GitHub 목록과 합쳐 보이고 "보이는 저장소" 필터로 숨기지 않는다 */
  extra?: GitHubRepo[]
  /** true 면 GitHub 목록을 불러오지 않고 extra 만 보인다(내 것이 아닌 소유자·로컬 저장소) */
  fixed?: boolean
  /** 표시 이름(기본: login) */
  label?: string
  onOpenSettings(scope: SettingsScope, preview: PreviewIssue | null): void
}

/**
 * 조직(개인 계정 포함) 노드 — ⚙ 버튼·컨텍스트 메뉴 "조직 설정" (개인 계정의 org scope = 사용자 login).
 * 트리는 disclosure 패턴(버튼 aria-expanded + aria-controls)으로 탐색한다.
 */
export function OrgNode({ owner, extra, fixed = false, label = owner.login, onOpenSettings }: OrgNodeProps) {
  const nodeId = `org:${owner.login}`
  const expanded = useUiStore((s) => !!s.expanded[nodeId])
  const setExpanded = useUiStore((s) => s.setExpanded)
  const repos = useRepos(owner, expanded && !fixed)
  const repoFilter = useRepoFilter()
  const isExtra = (r: GitHubRepo) => !!extra?.some((x) => x.name.toLowerCase() === r.name.toLowerCase())
  const listed = fixed ? [] : repos.data
  const shown = listed && [
    ...listed.filter((r) => !isExtra(r)).map((r) => ({ repo: r, ...repoFilter(r.owner, r.name) })),
    ...(extra ?? []).map((r) => ({ repo: r, show: true, hidden: false })),
  ]
    .filter((x) => x.show)
    // 추가한 저장소가 섞일 때만 이름순으로 다시 놓는다(GitHub 목록은 이미 정렬돼 있다)
    .sort((a, b) => (fixed || !extra?.length ? 0 : a.repo.name.localeCompare(b.repo.name)))
  const total = (listed?.length ?? 0) + (extra?.length ?? 0)
  const local = isLocalOwner(owner.login)
  const childrenId = useId()
  const openSettings = () => onOpenSettings({ kind: 'org', owner: owner.login }, null)
  const settingsLabel = local ? '로컬 저장소 공통 설정' : '조직 설정'

  return (
    <div>
      <div className="group flex items-center">
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <button
              type="button"
              data-testid={`org-node-${owner.login}`}
              aria-expanded={expanded}
              aria-controls={childrenId}
              onClick={() => setExpanded(nodeId, !expanded)}
              className="flex min-w-0 flex-1 items-center gap-1 rounded px-1 py-1 text-left text-sm font-medium hover:bg-accent"
            >
              {expanded ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}
              {local ? <HardDriveIcon className="size-3.5" /> : owner.kind === 'user' ? <UserIcon className="size-3.5" /> : <BuildingIcon className="size-3.5" />}
              <span className="truncate">{label}</span>
            </button>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem onSelect={openSettings}>{settingsLabel}</ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
        {/* 우클릭 메뉴는 키보드로 열 수 없다 → 같은 동작의 버튼을 둔다(AX-01, WCAG 2.1.1). 이름에 대상을 넣어 여러 개를 구분한다(AX-21) */}
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={`${label} ${settingsLabel}`}
          title={`${label} ${settingsLabel}`}
          onClick={openSettings}
          className="size-6 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
        >
          <SettingsIcon className="size-3.5" />
        </Button>
      </div>
      <div id={childrenId} hidden={!expanded}>
        {expanded && (
          <div className="ml-3">
            {repos.isLoading && <div className="px-2 py-1 text-xs text-muted-foreground">저장소 불러오는 중…</div>}
            {repos.isError && (
              <div className="flex items-center gap-2 px-2 py-1 text-xs text-destructive">
                <span className="flex-1">{githubErrorMessage(repos.error)}</span>
                <Button size="sm" variant="ghost" onClick={() => void repos.refetch()}>
                  재시도
                </Button>
              </div>
            )}
            {listed && total === 0 && <div className="px-2 py-1 text-xs text-muted-foreground">저장소 없음</div>}
            {total > 0 && shown?.length === 0 && (
              <div className="px-2 py-1 text-xs text-muted-foreground">표시하도록 고른 저장소 없음</div>
            )}
            {shown?.map(({ repo: r, hidden }) => (
              <RepoNode key={`${r.owner}/${r.name}`} repo={r} hidden={hidden} onOpenSettings={onOpenSettings} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
