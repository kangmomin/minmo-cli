import { LogInIcon, Loader2Icon, ServerIcon } from 'lucide-react'
import { useEffect, useState } from 'react'

import { ThemeToggle } from '../../components/ThemeToggle'
import { Button } from '../../components/ui/button'
import { openServerSettings } from '../../store/server'
import { useSessionStore } from '../../store/session'
import { AppVersion } from '../update/AppVersion'
import { useAuth } from './useAuth'

/** UI State "로그인 대기": 2분이 지나면 시간 초과 안내 (pendingLogin 자체 TTL 은 10분) */
export const LOGIN_WAIT_TIMEOUT_MS = 2 * 60 * 1000

export function LoginPage() {
  const auth = useAuth()
  const pending = useSessionStore((s) => s.pendingLogin)
  const setNotice = useSessionStore((s) => s.setNotice)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!pending) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [pending])

  const timedOut = pending !== null && now - pending.startedAt > LOGIN_WAIT_TIMEOUT_MS
  const oauthMissing = auth.error?.code === 'github_oauth_not_configured'

  // 첫 실행: OAuth App 값이 없으면 로그인 시도 때 서버 설정을 바로 연다
  useEffect(() => {
    if (oauthMissing) openServerSettings()
  }, [oauthMissing, auth.error])

  return (
    <div className="relative flex h-full items-center justify-center bg-muted/40" data-testid="login-page">
      <div className="absolute top-2 right-2">
        <ThemeToggle />
      </div>
      <div className="grid w-full max-w-sm gap-4 rounded-lg border bg-background p-8 shadow-sm">
        <div>
          <div className="flex items-baseline gap-1">
            <h1 className="text-xl font-semibold">minmo</h1>
            <AppVersion />
          </div>
          <p className="text-sm text-muted-foreground">GitHub 이슈 단위 작업 공간</p>
        </div>

        {auth.notice && (
          <div className="flex items-start gap-2 rounded bg-amber-100 p-2 text-sm text-amber-950 dark:bg-amber-950 dark:text-amber-100" role="status">
            <span className="flex-1">{auth.notice}</span>
            <button type="button" className="text-xs underline" onClick={() => setNotice(null)}>
              닫기
            </button>
          </div>
        )}
        {auth.error && (
          <p className="rounded bg-destructive/10 p-2 text-sm text-destructive" role="alert">
            {auth.error.message}
          </p>
        )}

        {auth.phase === 'pending' ? (
          <div className="grid gap-3">
            <p className="flex items-center gap-2 text-sm">
              {timedOut ? (
                '시간 초과 — 다시 시도'
              ) : (
                <>
                  <Loader2Icon className="size-4 animate-spin" /> 브라우저에서 GitHub 승인 중…
                </>
              )}
            </p>
            <div className="flex gap-2">
              <Button variant="outline" onClick={auth.cancelLogin}>
                취소
              </Button>
              <Button onClick={() => void auth.startLogin()}>다시 시도</Button>
            </div>
          </div>
        ) : (
          <Button onClick={() => void auth.startLogin()} disabled={auth.phase === 'restoring'}>
            <LogInIcon /> GitHub로 로그인
          </Button>
        )}
        <Button variant={oauthMissing ? 'outline' : 'ghost'} size="sm" onClick={openServerSettings}>
          <ServerIcon /> 서버 설정
        </Button>
      </div>
    </div>
  )
}
