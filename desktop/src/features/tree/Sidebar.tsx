import { ListFilterIcon } from 'lucide-react'
import { useState } from 'react'

import type { SettingsScope } from '@minmo/api-client'

import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { ScrollArea } from '../../components/ui/scroll-area'
import type { PreviewIssue } from '../settings/SettingsDialog'
import { OrgNode } from './OrgNode'
import { RefreshButton } from './RefreshButton'
import { githubErrorMessage, useGitHubSource, useOwners } from './useTree'
import { useOwnerFilter, useRepoSelection } from './useVisibleRepos'
import { VisibleReposDialog } from './VisibleReposDialog'

export interface SidebarProps {
  onOpenSettings(scope: SettingsScope, preview: PreviewIssue | null): void
}

/** 좌측 트리: 개인 계정(첫 노드) → 조직 → 저장소 → ★기타 + 이슈 (AC-03) */
export function Sidebar({ onOpenSettings }: SidebarProps) {
  const owners = useOwners()
  const source = useGitHubSource()
  const ownerFilter = useOwnerFilter()
  const filtering = useRepoSelection() !== null
  const [filterOpen, setFilterOpen] = useState(false)
  const shownOwners = owners.data?.filter((o) => ownerFilter(o.login))

  return (
    <aside className="flex h-full w-72 shrink-0 flex-col border-r" aria-label="이슈 트리">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <span className="flex-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">GitHub</span>
        {source.data === 'rest' && (
          <Badge variant="outline" title="gh CLI 가 없거나 인증되지 않아 서버 토큰으로 REST 를 호출합니다">
            gh 미사용(REST)
          </Badge>
        )}
        <Button
          variant={filtering ? 'secondary' : 'ghost'}
          size="icon-sm"
          aria-label="표시할 저장소"
          title={filtering ? '표시할 저장소(골라 둔 저장소만 보는 중)' : '표시할 저장소'}
          onClick={() => setFilterOpen(true)}
        >
          <ListFilterIcon />
        </Button>
        <RefreshButton />
      </div>
      <VisibleReposDialog open={filterOpen} onOpenChange={setFilterOpen} />
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-2">
          {owners.isLoading && (
            <div className="space-y-2 p-2" aria-label="트리 불러오는 중">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-4 animate-pulse rounded bg-muted" />
              ))}
            </div>
          )}
          {owners.isError && (
            <div className="flex items-center gap-2 rounded bg-destructive/10 px-2 py-1 text-xs text-destructive">
              <span className="flex-1">{githubErrorMessage(owners.error)}</span>
              <Button size="sm" variant="ghost" onClick={() => void owners.refetch()}>
                재시도
              </Button>
            </div>
          )}
          {owners.data && owners.data.length > 0 && shownOwners?.length === 0 && (
            <p className="p-2 text-xs text-muted-foreground">표시하도록 고른 저장소가 없습니다 — 위의 필터 버튼에서 고르세요.</p>
          )}
          {shownOwners?.map((o) => <OrgNode key={o.login} owner={o} onOpenSettings={onOpenSettings} />)}
        </div>
      </ScrollArea>
    </aside>
  )
}
