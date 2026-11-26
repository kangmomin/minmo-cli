import { AppWindowIcon, ListTreeIcon, LogOutIcon, MonitorSmartphoneIcon, ServerIcon, SettingsIcon, TerminalSquareIcon } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'

import type { SettingsScope } from '@minmo/api-client'

import { ThemeToggle } from '../components/ThemeToggle'
import { Button } from '../components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../components/ui/tooltip'
import { AgentsButton, AgentsOverview, useLocalRows } from '../features/agents/AgentsOverview'
import { useNotifyClick } from '../features/agents/navigate'
import { useAgentTracker } from '../features/agents/useAgentTracker'
import { useWindowViewBroadcast } from '../features/agents/windowView'
import { useLegacyE2eCleanup } from '../features/issue/legacyE2eCleanup'
import { useDeepLinkOpen } from '../features/remote/deepLink'
import { useAgentPublisher, usePeerAgents } from '../features/remote/peerAgents'
import { usePeerSync } from '../features/remote/peerSync'
import { usePairSync } from '../features/pairSync/pairSync'
import { RemoteAccessDialog } from '../features/remote/RemoteAccessSettings'
import { useSharedTerminals } from '../features/remote/useRemoteHost'
import { useBaseDeps } from './deps'
import { useAuth } from '../features/auth/useAuth'
import { CliAccessDialog } from '../features/cli/CliAccessSettings'
import { IssueHeader } from '../features/issue/IssueHeader'
import { AppVersion } from '../features/update/AppVersion'
import { WorkTabs } from '../features/issue/WorkTabs'
import { WorktreeSetupLog } from '../features/issue/WorktreeSetupLog'
import { SettingsDialog } from '../features/settings/ScopeSettings'
import type { PreviewIssue } from '../features/settings/ScopeSettings'
import { Sidebar } from '../features/tree/Sidebar'
import { UsageBar } from '../features/usage/UsageBar'
import { NEW_WINDOW_KEY, useNewWindowShortcut, useTerminalOpenShortcut } from '../features/terminal/keys'
import { openWindow } from '../features/tree/openWindow'
import { useFontSizeShortcuts } from '../lib/fontSize'
import { openServerSettings } from '../store/server'
import { HostStatusNotice } from './HostGate'
import { HostScope, aliasOfIssue, useHostConnection, useHostStatus } from './host'
import { useSessionStore } from '../store/session'
import { useSetupStore } from '../store/setup'
import { useUiStore } from '../store/ui'

type SettingsTarget = { scope: SettingsScope; preview: PreviewIssue | null }

/** 메인 레이아웃 (D-27): 상단 바 / 좌 트리 / 우 IssueHeader + 탭(터미널·변경·메모). 하단 OfflineBanner 는 App 이 둔다 */
export function Workspace() {
  const auth = useAuth()
  const notice = useSessionStore((s) => s.notice)
  const setNotice = useSessionStore((s) => s.setNotice)
  const selectedId = useUiStore((s) => s.selectedIssueId)
  const target = useSetupStore((s) => (selectedId ? s.targets[selectedId] : undefined))
  const openState = useSetupStore((s) => (selectedId ? s.open[selectedId] : undefined))
  const [settings, setSettings] = useState<SettingsTarget | null>(null)
  const [cliOpen, setCliOpen] = useState(false)
  const [agentsOpen, setAgentsOpen] = useState(false)
  const [remoteOpen, setRemoteOpen] = useState(false)
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
  // 원격으로 붙은 화면에서는 이 PC 전용 설정(원격 접속·서버·원격 CLI)을 보이지 않는다
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

  const selectedPreview: PreviewIssue | null = target ?? null
  const issueAlias = selectedId ? aliasOfIssue(selectedId) : null
  // 고른 이슈의 호스트에 아직 연결하지 않았으면 연결한다(앱을 다시 켠 뒤, 호스트 정보를 고친 뒤 등)
  const issueHost = useHostStatus(issueAlias)

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
        <ThemeToggle />
        {isHost && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="원격 접속" onClick={() => setRemoteOpen(true)}>
                <MonitorSmartphoneIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>원격 접속(다른 PC·휴대폰)</TooltipContent>
          </Tooltip>
        )}
        {isHost && (
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="원격 CLI 접속" onClick={() => setCliOpen(true)}>
                  <TerminalSquareIcon />
                </Button>
              </TooltipTrigger>
              <TooltipContent>원격 CLI 접속</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="서버 설정" onClick={openServerSettings}>
                  <ServerIcon />
                </Button>
              </TooltipTrigger>
              <TooltipContent>서버 설정</TooltipContent>
            </Tooltip>
          </>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="전역 설정"
              onClick={() => setSettings({ scope: { kind: 'global' }, preview: selectedPreview })}
            >
              <SettingsIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent>전역 설정</TooltipContent>
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
            // 선택된 이슈가 같은 저장소면 미리보기 기준으로 쓴다
            const sameRepo =
              target && scope.kind !== 'global' && target.owner === scope.owner && (scope.kind === 'org' || target.repo === scope.repo)
            setSettings({ scope, preview: sameRepo ? selectedPreview : (preview ?? selectedPreview) })
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

      <CliAccessDialog open={cliOpen} onOpenChange={setCliOpen} />
      <RemoteAccessDialog open={remoteOpen} onOpenChange={setRemoteOpen} />
      <AgentsOverview open={agentsOpen} onOpenChange={setAgentsOpen} />

      {settings && (
        <SettingsDialog
          scope={settings.scope}
          open
          onOpenChange={(o) => {
            if (!o) setSettings(null)
          }}
          previewIssue={settings.preview}
        />
      )}
    </div>
    </HostScope>
  )
}
