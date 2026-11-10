import { BuildingIcon, ChevronDownIcon, ChevronRightIcon, SettingsIcon, UserIcon } from 'lucide-react'
import { useId } from 'react'

import type { SettingsScope } from '@minmo/api-client'

import { Button } from '../../components/ui/button'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '../../components/ui/context-menu'
import type { GitHubOwner } from '../../lib/github'
import { useUiStore } from '../../store/ui'
import type { PreviewIssue } from '../settings/SettingsDialog'
import { RepoNode } from './RepoNode'
import { githubErrorMessage, useRepos } from './useTree'

export interface OrgNodeProps {
  owner: GitHubOwner
  onOpenSettings(scope: SettingsScope, preview: PreviewIssue | null): void
}

/**
 * 조직(개인 계정 포함) 노드 — ⚙ 버튼·컨텍스트 메뉴 "조직 설정" (개인 계정의 org scope = 사용자 login).
 * 트리는 disclosure 패턴(버튼 aria-expanded + aria-controls)으로 탐색한다.
 */
export function OrgNode({ owner, onOpenSettings }: OrgNodeProps) {
  const nodeId = `org:${owner.login}`
  const expanded = useUiStore((s) => !!s.expanded[nodeId])
  const setExpanded = useUiStore((s) => s.setExpanded)
  const repos = useRepos(owner, expanded)
  const childrenId = useId()
  const openSettings = () => onOpenSettings({ kind: 'org', owner: owner.login }, null)

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
              {owner.kind === 'user' ? <UserIcon className="size-3.5" /> : <BuildingIcon className="size-3.5" />}
              <span className="truncate">{owner.login}</span>
            </button>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem onSelect={openSettings}>조직 설정</ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
        {/* 우클릭 메뉴는 키보드로 열 수 없다 → 같은 동작의 버튼을 둔다(AX-01, WCAG 2.1.1). 이름에 대상을 넣어 여러 개를 구분한다(AX-21) */}
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={`${owner.login} 조직 설정`}
          title={`${owner.login} 조직 설정`}
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
            {repos.data?.length === 0 && <div className="px-2 py-1 text-xs text-muted-foreground">저장소 없음</div>}
            {repos.data?.map((r) => (
              <RepoNode key={`${r.owner}/${r.name}`} repo={r} onOpenSettings={onOpenSettings} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
