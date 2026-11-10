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
import { useApplyTheme } from './lib/theme'

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
  const [queryClient] = useState(createAppQueryClient)
  const [deps, setDeps] = useState<AppDeps | null>(null)
  const [bootError, setBootError] = useState<string | null>(null)
  useApplyTheme()

  useEffect(() => {
    let cancelled = false
    createAppDeps(queryClient)
      .then((d) => !cancelled && setDeps(d))
      .catch((e: unknown) => !cancelled && setBootError(e instanceof Error ? e.message : String(e)))
    return () => {
      cancelled = true
    }
  }, [queryClient])

  if (bootError) return <p className="p-6 text-sm text-destructive">앱을 시작할 수 없습니다: {bootError}</p>
  if (!deps) return null

  return (
    <QueryClientProvider client={queryClient}>
      <DepsProvider value={deps}>
        <TooltipProvider>
          <Root />
        </TooltipProvider>
      </DepsProvider>
    </QueryClientProvider>
  )
}
