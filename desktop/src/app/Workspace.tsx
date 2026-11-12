import { ArrowLeftIcon, ListTreeIcon, LogOutIcon, MonitorSmartphoneIcon, ServerIcon, SettingsIcon, TerminalSquareIcon } from 'lucide-react'
import { useEffect, useState } from 'react'

import type { SettingsScope } from '@minmo/api-client'

import { ThemeToggle } from '../components/ThemeToggle'
import { Button } from '../components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../components/ui/tooltip'
import { AgentsButton, AgentsOverview, useLocalRows } from '../features/agents/AgentsOverview'
import { useAgentTracker } from '../features/agents/useAgentTracker'
import { useDeepLinkOpen } from '../features/remote/deepLink'
import { useAgentPublisher, usePeerAgents } from '../features/remote/peerAgents'
import { PeerView } from '../features/remote/PeerView'
import { RemoteAccessDialog } from '../features/remote/RemoteAccessDialog'
import { usePeersStore } from '../store/peers'
import { useSharedTerminals } from '../features/remote/useRemoteHost'
import { useBaseDeps } from './deps'
import { useAuth } from '../features/auth/useAuth'
import { CliAccessDialog } from '../features/cli/CliAccessDialog'
import { IssueHeader } from '../features/issue/IssueHeader'
import { AppVersion } from '../features/update/AppVersion'
import { WorkTabs } from '../features/issue/WorkTabs'
import { WorktreeSetupLog } from '../features/issue/WorktreeSetupLog'
import { SettingsDialog } from '../features/settings/SettingsDialog'
import type { PreviewIssue } from '../features/settings/SettingsDialog'
import { Sidebar } from '../features/tree/Sidebar'
import { useFontSizeShortcuts } from '../lib/fontSize'
import { openServerSettings } from '../store/server'
import { HostScope, aliasOfIssue, useHostConnection } from './host'
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
  // 좁은 화면(휴대폰)에서는 트리와 작업 화면을 한 번에 하나만 보인다 — 이슈를 고르면 작업 화면으로 넘어간다
  const [showTree, setShowTree] = useState(true)
  useEffect(() => {
    if (selectedId) setShowTree(false)
  }, [selectedId])
  useFontSizeShortcuts()
  const baseTauri = useBaseDeps().tauri
  useSharedTerminals(baseTauri)
  // 원격으로 붙은 화면에서는 이 PC 전용 설정(원격 접속·서버·원격 CLI)을 보이지 않는다
  const isHost = baseTauri.runtime !== 'remote'
  // 여러 PC: 등록한 다른 PC 의 현황을 받아 합치고, 이 PC 의 현황은 올려 둔다. 다른 PC 를 고르면 그 PC 의 화면을 이 안에 연다
  usePeerAgents(baseTauri)
  useAgentPublisher(baseTauri, useLocalRows())
  useDeepLinkOpen()
  const peers = usePeersStore((s) => s.peers)
  const activePeer = usePeersStore((s) => s.peers.find((p) => p.id === s.activeId) ?? null)
  const peerOpen = usePeersStore((s) => s.open)
  const setActivePeer = usePeersStore((s) => s.setActive)
  // 열어 둔 모든 터미널의 에이전트 상태를 추적한다(이슈 행·패널·현황·알림)
  useAgentTracker()
  const connection = useHostConnection()

  const selectedPreview: PreviewIssue | null = target ?? null

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
        {isHost && peers.length > 0 && (
          <>
            {activePeer && (
              <Button variant="ghost" size="sm" onClick={() => setActivePeer(null)}>
                <ArrowLeftIcon /> 이 PC
              </Button>
            )}
            <select aria-label="PC" data-testid="peer-select" className="h-7 max-w-40 rounded border bg-background px-1.5 text-sm" value={activePeer?.id ?? ''} onChange={(e) => setActivePeer(e.target.value === '' ? null : e.target.value)}>
              <option value="">이 PC</option>
              {peers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </>
        )}
        <AppVersion />
        <span className="flex-1" />
        {auth.me && <span className="text-sm text-muted-foreground">{auth.me.githubLogin}</span>}
        <AgentsButton onClick={() => setAgentsOpen(true)} />
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

      {/* 다른 PC 를 열어도 이 PC 의 화면(터미널 등)은 내리지 않고 가려만 둔다 — 돌아오면 그대로다 */}
      {activePeer && <PeerView key={activePeer.id} peer={activePeer} open={peerOpen} />}
      <div className={activePeer ? 'hidden' : 'flex min-h-0 flex-1'}>
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
            <HostScope alias={aliasOfIssue(selectedId)}>
              <IssueHeader target={target} state={openState} />
              {/* key: 접힘 상태가 다른 이슈로 이어지지 않게 이슈마다 새로 마운트한다(CR-13) */}
              <WorktreeSetupLog key={selectedId} target={target} />
              <WorkTabs target={target} state={openState} />
            </HostScope>
          ) : (
            <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
              왼쪽 트리에서 이슈(또는 ★기타)를 선택하세요
            </div>
          )}
        </main>
      </div>

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
