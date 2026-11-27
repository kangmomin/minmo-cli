import { AppWindowIcon, ListTreeIcon, LogOutIcon, SettingsIcon } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'

import { Button } from '../components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../components/ui/tooltip'
import { AgentsButton, AgentsOverview, useLocalRows } from '../features/agents/AgentsOverview'
import { useNotifyClick } from '../features/agents/navigate'
import { useAgentTracker } from '../features/agents/useAgentTracker'
import { useWindowViewBroadcast } from '../features/agents/windowView'
import { ensureDefaultOpen, homeOf } from '../features/issue/defaultOpen'
import { useLegacyE2eCleanup } from '../features/issue/legacyE2eCleanup'
import { useDeepLinkOpen } from '../features/remote/deepLink'
import { useAgentPublisher, usePeerAgents } from '../features/remote/peerAgents'
import { usePeerSync } from '../features/remote/peerSync'
import { usePairSync } from '../features/pairSync/pairSync'
import { useSharedTerminals } from '../features/remote/useRemoteHost'
import { useBaseDeps } from './deps'
import { useAuth } from '../features/auth/useAuth'
import { IssueHeader } from '../features/issue/IssueHeader'
import { AppVersion } from '../features/update/AppVersion'
import { WorkTabs } from '../features/issue/WorkTabs'
import { WorktreeSetupLog } from '../features/issue/WorktreeSetupLog'
import type { PreviewIssue } from '../features/settings/ScopeSettings'
import { SettingsPage } from '../features/settings/SettingsPage'
import { Sidebar } from '../features/tree/Sidebar'
import { UsageBar } from '../features/usage/UsageBar'
import { NEW_WINDOW_KEY, useNewWindowShortcut, useTerminalOpenShortcut } from '../features/terminal/keys'
import { openWindow } from '../features/tree/openWindow'
import { isDefaultIssueId, isDefaultTarget } from '../lib/defaultWorkspace'
import { useFontSizeShortcuts } from '../lib/fontSize'
import { repoAliasOf, useHostsStore } from '../store/hosts'
import { openSettings } from '../store/settingsPage'
import type { SettingsTarget } from '../store/settingsPage'
import { HostStatusNotice } from './HostGate'
import { HostScope, aliasOfIssue, useHostConnection, useHostStatus } from './host'
import { useSessionStore } from '../store/session'
import { useSetupStore } from '../store/setup'
import { useUiStore } from '../store/ui'

/** 메인 레이아웃 (D-27): 상단 바 / 좌 트리 / 우 IssueHeader + 탭(터미널·변경·메모). 하단 OfflineBanner 는 App 이 둔다 */
export function Workspace() {
  const auth = useAuth()
  const notice = useSessionStore((s) => s.notice)
  const setNotice = useSessionStore((s) => s.setNotice)
  const selectedId = useUiStore((s) => s.selectedIssueId)
  const target = useSetupStore((s) => (selectedId ? s.targets[selectedId] : undefined))
  const openState = useSetupStore((s) => (selectedId ? s.open[selectedId] : undefined))
  const [agentsOpen, setAgentsOpen] = useState(false)
  // 좁은 화면(휴대폰)에서는 트리와 작업 화면을 한 번에 하나만 보인다 — 이슈를 고르면(같은 이슈를 다시 골라도) 작업 화면으로 넘어간다.
  // effect 가 아니라 고른 그 렌더에서 넘긴다: 자식(터미널)의 포커스 요청은 이 컴포넌트의 effect 보다 먼저 처리되므로,
  // effect 로 넘기면 터미널이 아직 가려진 채 포커스를 받지 못한다(#78)
  const selectSeq = useUiStore((s) => s.selectSeq)
  const [showTree, setShowTree] = useState(() => !useUiStore.getState().selectedIssueId)
  const [seenSelectSeq, setSeenSelectSeq] = useState(selectSeq)
  if (seenSelectSeq !== selectSeq) {
    setSeenSelectSeq(selectSeq)
    if (selectedId) setShowTree(false)
  }
  useFontSizeShortcuts()
  useTerminalOpenShortcut()
  const baseDeps = useBaseDeps()
  const baseTauri = baseDeps.tauri
  const queryClient = useQueryClient()
  useSharedTerminals(baseTauri)
  const isHost = baseTauri.runtime !== 'remote'
  // 범위 없는 새 창(#105) — 원격 화면에서는 띄우지 않는다
  const openBlankWindow = useMemo(() => (isHost ? () => openWindow(baseTauri, null, null) : null), [isHost, baseTauri])
  useNewWindowShortcut(openBlankWindow)
  // 여러 PC: 등록한 다른 PC 의 현황을 받아 합치고, 이 PC 의 현황은 올려 둔다
  usePeerAgents(baseTauri)
  useAgentPublisher(baseTauri, useLocalRows())
  usePeerSync(baseTauri, { tauri: baseTauri, api: baseDeps.api, queryClient })
  usePairSync(baseTauri, { api: baseDeps.api, onApplied: () => void queryClient.invalidateQueries() })
  useDeepLinkOpen()
  // 열어 둔 모든 터미널의 에이전트 상태를 추적한다(이슈 행·패널·현황·알림)
  useAgentTracker()
  // 열린 작업 폴더에서 지운 기능이 남긴 결과 폴더(.minmo/e2e)를 정리한다(#111)
  useLegacyE2eCleanup()
  // 이 창이 보는 이슈를 다른 창(알림을 띄우는 주 창)에 알린다
  useWindowViewBroadcast()
  // 그 알림을 누르면 해당 터미널로 간다
  useNotifyClick()
  const connection = useHostConnection()

  // Why: 기본은 저장소가 없어 설정 미리보기 기준이 되지 않는다
  const selectedPreview: PreviewIssue | null = target && !isDefaultTarget(target) ? target : null
  const issueAlias = selectedId ? aliasOfIssue(selectedId) : null
  // 고른 이슈의 호스트에 아직 연결하지 않았으면 연결한다(앱을 다시 켠 뒤, 호스트 정보를 고친 뒤 등)
  const issueHost = useHostStatus(issueAlias)
  // Why: 다시 켠 뒤·새 창에서는 열기 상태·targets 가 비어 있다 — 기본이 골라져 있으면 호스트가 준비될 때 다시 만든다.
  // 선택·작업 탭은 바꾸지 않는다(좁은 화면이 다시 연결될 때마다 작업 화면으로 넘어가지 않게)
  const openPhase = openState?.phase
  const baseHome = baseDeps.home
  useEffect(() => {
    if (!selectedId || !isDefaultIssueId(selectedId) || !issueHost.ready) return
    if (openPhase === undefined || openPhase === 'error') ensureDefaultOpen(selectedId, homeOf(issueAlias, baseHome))
  }, [selectedId, issueAlias, issueHost.ready, openPhase, baseHome])

  const topSettingsTarget = (): SettingsTarget | null => {
    // Why: 기본은 저장소가 없다 — 조직·프로젝트 범위를 만들 수 없어 전역만 보인다
    if (!target || isDefaultTarget(target)) return null
    const bound = repoAliasOf(useHostsStore.getState(), target.owner, target.repo)
    const projectHost = bound === undefined ? (connection.ready ? connection.selected : null) : bound
    // Why: 프로젝트 범위의 원본 위치·미리보기는 projectHost 기준이다 — 고른 이슈가 다른 호스트에 있으면 조직까지만 준다
    const context: SettingsTarget['context'] =
      issueAlias === projectHost ? { kind: 'project', owner: target.owner, repo: target.repo } : { kind: 'org', owner: target.owner }
    return { context, preview: selectedPreview }
  }

  // 사이드바·설정은 고른 호스트 기준, 오른쪽 이슈 패널은 그 이슈가 있는 호스트 기준이다
  // (사이드바에서 다른 호스트를 보는 동안에도 열어 둔 이슈와 터미널은 그대로 쓴다)
  return (
    <HostScope alias={connection.ready ? connection.selected : null}>
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2 max-md:px-2">
        <Button variant="ghost" size="icon-sm" className="md:hidden" aria-label={showTree ? '작업 화면 보기' : '이슈 목록 보기'} aria-pressed={showTree} onClick={() => setShowTree((v) => !v)}>
          <ListTreeIcon />
        </Button>
        <span className="font-semibold">minmo</span>
        <AppVersion />
        <span className="flex-1" />
        {auth.me && <span className="text-sm text-muted-foreground">{auth.me.githubLogin}</span>}
        <AgentsButton onClick={() => setAgentsOpen(true)} />
        {openBlankWindow && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="새 창" onClick={openBlankWindow}>
                <AppWindowIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>새 창 ({NEW_WINDOW_KEY})</TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="설정"
              data-settings-trigger
              onClick={() => openSettings({ target: topSettingsTarget(), scope: { kind: 'global' } })}
            >
              <SettingsIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent>설정</TooltipContent>
        </Tooltip>
        {/* 로그인·로그아웃은 호스트 PC 에서 한다 */}
        {isHost && (
          <Button variant="ghost" size="sm" onClick={() => void auth.logout()}>
            <LogOutIcon /> 로그아웃
          </Button>
        )}
      </header>

      {notice && (
        <div className="flex items-center gap-2 bg-amber-100 px-4 py-1.5 text-sm text-amber-950 dark:bg-amber-950 dark:text-amber-100" role="status">
          <span className="flex-1">{notice}</span>
          <button type="button" className="text-xs underline" onClick={() => setNotice(null)}>
            닫기
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <Sidebar
          className={showTree ? 'max-md:w-full' : 'max-md:hidden'}
          connection={connection}
          onOpenSettings={(scope, preview) => {
            // Why: 트리는 조직·저장소 범위만 넘긴다 — 전역은 상단 ⚙ 로 연다
            if (scope.kind === 'global') return
            // 선택된 이슈가 같은 저장소면 미리보기 기준으로 쓴다
            const sameRepo = target && target.owner === scope.owner && (scope.kind === 'org' || target.repo === scope.repo)
            openSettings({ section: 'workspace', target: { context: scope, preview: sameRepo ? selectedPreview : (preview ?? selectedPreview) }, scope })
          }}
        />
        <main className={`flex min-w-0 flex-1 flex-col ${showTree ? 'max-md:hidden' : ''}`}>
          {target && selectedId ? (
            <HostScope alias={issueAlias}>
              {/* 연결 전에는 HostScope 가 이 PC 로 바뀌어 id 가 맞지 않고 [다시 열기] 가 이 PC 에서 연다 — 연결 상태를 대신 보인다 */}
              {issueHost.ready ? (
                <>
                  <IssueHeader target={target} state={openState} />
                  {/* key: 접힘 상태가 다른 이슈로 이어지지 않게 이슈마다 새로 마운트한다(CR-13) */}
                  <WorktreeSetupLog key={selectedId} target={target} />
                </>
              ) : (
                <HostStatusNotice alias={issueAlias ?? ''} status={issueHost} className="grid gap-2 border-b p-4 text-sm" testId="issue-host-status" />
              )}
              {/* 터미널 탭은 모든 이슈의 터미널을 들고 있어 항상 둔다(내리면 다른 호스트의 터미널·에이전트 추적도 끊긴다).
                  연결 전에는 이 이슈의 작업 상태만 감춘다 */}
              <WorkTabs target={target} issueId={selectedId} state={issueHost.ready ? openState : undefined} />
            </HostScope>
          ) : (
            <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
              왼쪽 트리에서 이슈(또는 ★기타)를 선택하세요
            </div>
          )}
        </main>
      </div>
      {/* 사이드바에서 고른 호스트(바깥 HostScope)의 값을 보인다 */}
      <UsageBar />

      <AgentsOverview open={agentsOpen} onOpenChange={setAgentsOpen} />
      <SettingsPage />
    </div>
    </HostScope>
  )
}
