import { QueryClientProvider } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import { createAppDeps, createAppQueryClient } from './app/createDeps'
import { DepsProvider } from './app/deps'
import type { AppDeps } from './app/deps'
import { Workspace } from './app/Workspace'
import { OfflineBanner } from './components/OfflineBanner'
import { TooltipProvider } from './components/ui/tooltip'
import { LoginPage } from './features/auth/LoginPage'
import { useAuth, useAuthController } from './features/auth/useAuth'
import { WorktreeProvider } from './features/issue/useWorktree'
import { CloseDialog } from './features/app/CloseDialog'
import { ServerSettingsDialog } from './features/server/ServerSettingsDialog'
import { ServerStartScreen } from './features/server/ServerStartScreen'
import { isServerReady, useServerStatusSubscription } from './features/server/useServerStatus'
import { serverBaseUrl } from './lib/api'
import { getTauri } from './lib/tauri'
import { useApplyTheme } from './lib/theme'
import { useServerStore } from './store/server'

export type Route = '/login' | '/'

/**
 * 라우트: 인증되면 "/", 아니면 "/login". 라우팅 라이브러리 없이 인증 단계로 결정하고 주소만 맞춘다
 * (Tauri 정적 자산에서 새로고침해도 index.html 하나로 동작).
 */
function routeFor(phase: ReturnType<typeof useAuth>['phase']): Route | null {
  if (phase === 'restoring') return null
  return phase === 'authenticated' ? '/' : '/login'
}

function Root() {
  useAuthController()
  const { phase } = useAuth()
  const route = routeFor(phase)

  useEffect(() => {
    if (route && window.location.pathname !== route) window.history.replaceState(null, '', route)
  }, [route])

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1 flex-col">
        {route === null && <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">세션 확인 중…</div>}
        {route === '/login' && <LoginPage />}
        {route === '/' && (
          <WorktreeProvider>
            <Workspace />
          </WorktreeProvider>
        )}
      </div>
      <OfflineBanner />
    </div>
  )
}

export function App() {
  const tauri = getTauri()
  const [queryClient] = useState(createAppQueryClient)
  const [deps, setDeps] = useState<AppDeps | null>(null)
  const [bootError, setBootError] = useState<string | null>(null)
  const status = useServerStatusSubscription(tauri)
  const baseUrl = useServerStore((s) => s.baseUrl)
  const setBaseUrl = useServerStore((s) => s.setBaseUrl)
  useApplyTheme()

  // 서버가 처음 준비되면 그 주소로 붙는다. 이후 재시작(같은 포트)은 그대로 쓰고, 포트를 바꾸면 창을 새로 고친다
  useEffect(() => {
    if (!baseUrl && status && isServerReady(status)) setBaseUrl(serverBaseUrl(status.port))
  }, [baseUrl, status, setBaseUrl])

  useEffect(() => {
    if (!baseUrl) return
    let cancelled = false
    createAppDeps(queryClient, baseUrl)
      .then((d) => !cancelled && setDeps(d))
      .catch((e: unknown) => !cancelled && setBootError(e instanceof Error ? e.message : String(e)))
    return () => {
      cancelled = true
    }
  }, [queryClient, baseUrl])

  let body
  if (bootError) body = <p className="p-6 text-sm text-destructive">앱을 시작할 수 없습니다: {bootError}</p>
  else if (!deps) body = <ServerStartScreen status={status} tauri={tauri} />
  else
    body = (
      <QueryClientProvider client={queryClient}>
        <DepsProvider value={deps}>
          <TooltipProvider>
            <Root />
          </TooltipProvider>
        </DepsProvider>
      </QueryClientProvider>
    )

  return (
    <>
      {body}
      {/* 서버 설정·닫기 대화상자는 서버에 붙기 전(시작 실패 화면)에도 쓸 수 있어야 한다 */}
      <ServerSettingsDialog tauri={tauri} />
      <CloseDialog tauri={tauri} />
    </>
  )
}
