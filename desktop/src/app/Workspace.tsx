import { LogOutIcon, ServerIcon, SettingsIcon, TerminalSquareIcon } from 'lucide-react'
import { useState } from 'react'

import type { SettingsScope } from '@minmo/api-client'

import { ThemeToggle } from '../components/ThemeToggle'
import { Button } from '../components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../components/ui/tooltip'
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
  useFontSizeShortcuts()
  const connection = useHostConnection()

  const selectedPreview: PreviewIssue | null = target ?? null

  // 사이드바·설정은 고른 호스트 기준, 오른쪽 이슈 패널은 그 이슈가 있는 호스트 기준이다
  // (사이드바에서 다른 호스트를 보는 동안에도 열어 둔 이슈와 터미널은 그대로 쓴다)
  return (
    <HostScope alias={connection.ready ? connection.selected : null}>
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-3 border-b px-4 py-2">
        <span className="font-semibold">minmo</span>
        <AppVersion />
        <span className="flex-1" />
        {auth.me && <span className="text-sm text-muted-foreground">{auth.me.githubLogin}</span>}
        <ThemeToggle />
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
        <Button variant="ghost" size="sm" onClick={() => void auth.logout()}>
          <LogOutIcon /> 로그아웃
        </Button>
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
          connection={connection}
          onOpenSettings={(scope, preview) => {
            // 선택된 이슈가 같은 저장소면 미리보기 기준으로 쓴다
            const sameRepo =
              target && scope.kind !== 'global' && target.owner === scope.owner && (scope.kind === 'org' || target.repo === scope.repo)
            setSettings({ scope, preview: sameRepo ? selectedPreview : (preview ?? selectedPreview) })
          }}
        />
        <main className="flex min-w-0 flex-1 flex-col">
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
