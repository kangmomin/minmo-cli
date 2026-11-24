import { ArrowDownWideNarrowIcon, BotIcon, ListFilterIcon, ServerCogIcon } from 'lucide-react'
import { useMemo, useState } from 'react'

import type { GitHubOwner, GitHubRepo } from '@minmo/core'

import type { SettingsScope } from '@minmo/api-client'

import { HostStatusNotice } from '../../app/HostGate'
import { useHost } from '../../app/host'
import type { useHostConnection } from '../../app/host'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { ScrollArea } from '../../components/ui/scroll-area'
import { useHostsStore } from '../../store/hosts'
import { usePeersStore } from '../../store/peers'
import { useBaseDeps } from '../../app/deps'
import { LOCAL_OWNER, splitFullName, useReposStore } from '../../store/repos'
import { useUiStore } from '../../store/ui'
import { HostsDialog } from '../hosts/HostsDialog'
import type { PreviewIssue } from '../settings/SettingsDialog'
import { AddRepoMenu } from './AddRepoMenu'
import { PublishDialog } from './LocalRepoDialogs'
import { OrgNode } from './OrgNode'
import { PublishContext } from './publishContext'
import { RefreshButton } from './RefreshButton'
import { SidebarFrame } from './SidebarFrame'
import { githubErrorMessage, useGitHubSource, useOwners } from './useTree'
import { useOwnerFilter, useRepoSelection } from './useVisibleRepos'
import { VisibleReposDialog } from './VisibleReposDialog'

type HostConnection = ReturnType<typeof useHostConnection>

const LOCAL_ONLY: HostConnection = { selected: null, ready: true, connecting: false, error: null, connect: async () => {} }

export interface SidebarProps {
  /** 볼 호스트 선택·연결 상태(app/host.tsx useHostConnection). 없으면 이 PC 만 */
  connection?: HostConnection
  onOpenSettings(scope: SettingsScope, preview: PreviewIssue | null): void
}

/** 좌측 트리: 개인 계정(첫 노드) → 조직 → 저장소 → ★기타 + 이슈 (AC-03) */
/** 호스트 선택 값에서 다른 PC 를 가리는 접두어(SSH 호스트 별칭과 겹치지 않는다) */
const PEER_PREFIX = 'peer:'

export function Sidebar({ connection = LOCAL_ONLY, onOpenSettings, className }: SidebarProps & { className?: string }) {
  const aliases = useHostsStore((s) => s.aliases)
  const peers = usePeersStore((s) => s.peers)
  const { tauri } = useBaseDeps()
  const [hostsOpen, setHostsOpen] = useState(false)
  const { selected } = connection
  const owners = useOwners()
  const source = useGitHubSource()
  const ownerFilter = useOwnerFilter()
  const filtering = useRepoSelection() !== null
  const [filterOpen, setFilterOpen] = useState(false)
  const agentsOnly = useUiStore((s) => s.treeAgentsOnly)
  const setAgentsOnly = useUiStore((s) => s.setTreeAgentsOnly)
  const sortByStatus = useUiStore((s) => s.treeSortByStatus)
  const setSortByStatus = useUiStore((s) => s.setTreeSortByStatus)
  const [publishId, setPublishId] = useState<string | null>(null)
  const host = useHost()
  const added = useReposStore((s) => s.added)
  const localRepos = useReposStore((s) => s.local)
  // 직접 추가한 GitHub 저장소를 소유자별로 묶는다(소유자 이름은 대소문자를 가리지 않는다)
  const addedByOwner = useMemo(() => {
    const map = new Map<string, { login: string; repos: GitHubRepo[] }>()
    for (const full of added) {
      const [owner, name] = splitFullName(full)
      const entry = map.get(owner.toLowerCase()) ?? { login: owner, repos: [] }
      entry.repos.push({ owner, name, defaultBranch: '' })
      map.set(owner.toLowerCase(), entry)
    }
    return map
  }, [added])
  // 로컬 저장소는 폴더가 있는 호스트를 볼 때만 보인다
  const localList = useMemo(
    () =>
      Object.entries(localRepos)
        .filter(([, r]) => r.hostId === host.id)
        .map(([id, r]) => ({ repo: { owner: LOCAL_OWNER, name: id, defaultBranch: '' }, label: r.displayName }))
        .sort((a, b) => a.label.localeCompare(b.label))
        .map((x) => x.repo),
    [localRepos, host.id],
  )
  const shownOwners = owners.data?.filter((o) => ownerFilter(o.login) || addedByOwner.has(o.login.toLowerCase()))
  // 내 계정·조직이 아닌 소유자의 저장소(협업·공개 저장소)
  const foreignOwners: { owner: GitHubOwner; repos: GitHubRepo[] }[] = owners.data
    ? [...addedByOwner.entries()]
        .filter(([key]) => !owners.data.some((o) => o.login.toLowerCase() === key))
        .map(([, e]) => ({ owner: { login: e.login, kind: 'org' as const, avatarUrl: null }, repos: e.repos }))
    : []

  return (
    <SidebarFrame className={className}>
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <select
          aria-label="작업 호스트"
          data-testid="host-select"
          className="h-7 min-w-0 flex-1 rounded border bg-background px-1.5 text-sm"
          value={selected ?? ''}
          onChange={(e) => {
            // 다른 PC(minmo 가 깔린 PC)는 그 PC 의 화면을 별도 창으로 연다 — 이 창의 호스트 선택은 그대로 둔다
            if (e.target.value.startsWith(PEER_PREFIX)) return void tauri.peerOpen(e.target.value.slice(PEER_PREFIX.length)).catch(() => undefined)
            void connection.connect(e.target.value === '' ? null : e.target.value)
          }}
        >
          <option value="">이 PC</option>
          {aliases.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
          {peers.length > 0 && (
            <optgroup label="다른 PC (새 창으로 열기)">
              {peers.map((p) => (
                <option key={p.id} value={PEER_PREFIX + p.id}>
                  {p.name}
                </option>
              ))}
            </optgroup>
          )}
          {/* 목록에서 뺀 호스트가 아직 선택돼 있어도 값이 비지 않게 */}
          {selected !== null && !aliases.includes(selected) && <option value={selected}>{selected}</option>}
        </select>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="원격 호스트 관리"
          title="원격 호스트 관리(SSH 프로필)"
          onClick={() => setHostsOpen(true)}
        >
          <ServerCogIcon />
        </Button>
      </div>
      <HostsDialog open={hostsOpen} onOpenChange={setHostsOpen} />
      {/* 버튼이 여럿이라 좁은 사이드바에서 밀려 나가지 않게 줄바꿈을 허용한다 */}
      <div className="flex flex-wrap items-center gap-x-1 gap-y-1 border-b px-3 py-2">
        <span className="min-w-0 flex-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">GitHub</span>
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
        <Button
          variant={agentsOnly ? 'secondary' : 'ghost'}
          size="icon-sm"
          aria-label="에이전트가 있는 이슈만"
          aria-pressed={agentsOnly}
          title={agentsOnly ? '에이전트가 있는 이슈만 보는 중 — 누르면 모두 보기' : '에이전트가 있는 이슈만 보기'}
          onClick={() => setAgentsOnly(!agentsOnly)}
        >
          <BotIcon />
        </Button>
        <Button
          variant={sortByStatus ? 'secondary' : 'ghost'}
          size="icon-sm"
          aria-label="에이전트 상태 순으로 정렬"
          aria-pressed={sortByStatus}
          title={sortByStatus ? '에이전트 상태 순(입력 대기 → 끝남 → 작업 중 → 대기 중)으로 보는 중 — 누르면 기본 순서' : '에이전트 상태 순으로 정렬'}
          onClick={() => setSortByStatus(!sortByStatus)}
        >
          <ArrowDownWideNarrowIcon />
        </Button>
        <AddRepoMenu />
        <RefreshButton />
      </div>
      <VisibleReposDialog open={filterOpen} onOpenChange={setFilterOpen} />
      {publishId !== null && <PublishDialog id={publishId} open onOpenChange={(o) => !o && setPublishId(null)} />}
      {!connection.ready && selected !== null && (
        <HostStatusNotice
          alias={selected}
          status={{ connecting: connection.connecting, error: connection.error, connect: (trustNew) => connection.connect(selected, trustNew) }}
        >
          <Button size="sm" variant="ghost" onClick={() => void connection.connect(null)}>
            이 PC 로 전환
          </Button>
        </HostStatusNotice>
      )}
      <ScrollArea className={connection.ready ? 'min-h-0 flex-1' : 'hidden'}>
        <PublishContext.Provider value={setPublishId}>
          {/* 오른쪽 여백을 더 둔다 — 내용 위에 겹쳐 뜨는 세로 스크롤바(10px)가 행 끝 버튼을 가리지 않게(AC-02) */}
          <div className="py-2 pl-2 pr-3">
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
            {localList.length > 0 && (
              <OrgNode
                owner={{ login: LOCAL_OWNER, kind: 'org', avatarUrl: null }}
                label="로컬 저장소"
                extra={localList}
                fixed
                onOpenSettings={onOpenSettings}
              />
            )}
            {owners.data && owners.data.length > 0 && shownOwners?.length === 0 && foreignOwners.length === 0 && (
              <p className="p-2 text-xs text-muted-foreground">표시하도록 고른 저장소가 없습니다 — 위의 필터 버튼에서 고르세요.</p>
            )}
            {shownOwners?.map((o) => (
              <OrgNode key={o.login} owner={o} extra={addedByOwner.get(o.login.toLowerCase())?.repos} onOpenSettings={onOpenSettings} />
            ))}
            {foreignOwners.map(({ owner, repos }) => (
              <OrgNode key={owner.login} owner={owner} extra={repos} fixed onOpenSettings={onOpenSettings} />
            ))}
          </div>
        </PublishContext.Provider>
      </ScrollArea>
    </SidebarFrame>
  )
}
