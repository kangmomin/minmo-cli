import { CopyIcon, ExternalLinkIcon, LogInIcon, Loader2Icon, ServerIcon } from 'lucide-react'
import { useEffect, useState } from 'react'

import { ThemeToggle } from '../../components/ThemeToggle'
import { Button } from '../../components/ui/button'
import { openServerSettings } from '../../store/server'
import { useSessionStore } from '../../store/session'
import { runtimeKind } from '../../lib/tauri'
import { AppVersion } from '../update/AppVersion'
import { useAuth } from './useAuth'

/** GitHub 기기 코드 로그인: [GitHub 로 로그인] → 코드 표시 + 브라우저 열기 → 승인하면 자동으로 로그인된다 */
export function LoginPage() {
  const auth = useAuth()
  const remote = runtimeKind() === 'remote'
  const pending = useSessionStore((s) => s.pendingLogin)
  const setNotice = useSessionStore((s) => s.setNotice)
  const [copied, setCopied] = useState('')
  // 새 코드를 받으면 이전 코드의 "복사했습니다" 안내를 지운다
  const userCode = pending?.userCode
  useEffect(() => setCopied(''), [userCode])

  async function copyCode() {
    if (!pending) return
    try {
      await navigator.clipboard.writeText(pending.userCode)
      setCopied('코드를 복사했습니다')
    } catch {
      setCopied('복사하지 못했습니다 — 직접 입력하세요')
    }
  }

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

        {auth.phase === 'pending' && pending ? (
          <div className="grid gap-3" data-testid="device-login">
            <p className="text-sm">브라우저에 열린 GitHub 페이지에 아래 코드를 입력하고 승인하세요. 승인하면 자동으로 로그인됩니다.</p>
            <div className="flex items-center gap-2">
              {/* 화면 낭독기가 "로그인 코드" 라는 이름과 함께 코드 글자를 읽게 한다 */}
              <p className="flex-1 rounded bg-muted px-3 py-2 text-center">
                <span className="sr-only">로그인 코드: </span>
                <code className="font-mono text-2xl font-semibold tracking-widest" data-testid="device-user-code">
                  {pending.userCode}
                </code>
              </p>
              <Button type="button" variant="outline" size="sm" onClick={() => void copyCode()}>
                <CopyIcon /> 복사
              </Button>
            </div>
            <p className="text-xs text-muted-foreground" role="status">
              {copied}
            </p>
            <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
              <Loader2Icon className="size-4 animate-spin" /> GitHub 승인을 기다리는 중…
            </p>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => void auth.openVerification()}>
                <ExternalLinkIcon /> 브라우저 다시 열기
              </Button>
              <Button variant="ghost" onClick={auth.cancelLogin}>
                취소
              </Button>
            </div>
            <p className="break-all text-xs text-muted-foreground">
              브라우저가 열리지 않으면 직접 여세요: <span className="font-mono">{pending.verificationUri}</span>
            </p>
          </div>
        ) : remote ? (
          // 원격 화면: 로그인은 호스트 PC 에서 한다(세션·GitHub 토큰은 호스트에만 둔다)
          <div className="grid gap-2 text-center">
            <p role="status" className="text-sm">
              호스트 PC 의 minmo 에서 먼저 GitHub 로 로그인하세요.
            </p>
            <Button variant="outline" onClick={() => window.location.reload()}>
              다시 확인
            </Button>
          </div>
        ) : (
          <Button onClick={() => void auth.startLogin()} disabled={auth.phase === 'restoring' || auth.phase === 'busy'}>
            {auth.phase === 'busy' ? <Loader2Icon className="animate-spin" /> : <LogInIcon />} GitHub로 로그인
          </Button>
        )}
        {!remote && (
          <Button variant="ghost" size="sm" onClick={openServerSettings}>
            <ServerIcon /> 서버 설정
          </Button>
        )}
      </div>
    </div>
  )
}
