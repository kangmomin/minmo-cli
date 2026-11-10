import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CopyIcon } from 'lucide-react'
import { useEffect, useId, useState } from 'react'

import type { CliCode, SessionInfo } from '@minmo/api-client'

import { useDeps } from '../../app/deps'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../components/ui/dialog'
import { queryKeys } from '../../lib/queryKeys'
import { useSessionStore } from '../../store/session'
import { SSH_CONFIG_EXAMPLE, SSH_SERVER_NOTE } from './sshConfig'

export interface CliAccessDialogProps {
  open: boolean
  onOpenChange(open: boolean): void
}

export function CliAccessDialog({ open, onOpenChange }: CliAccessDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>원격 CLI 접속</DialogTitle>
          <DialogDescription>
            원격 서버에 minmo CLI 를 설치하고 SSH 로 접속해 이슈·worktree 를 관리합니다. 원격 CLI 는 SSH 역터널로 이 PC 의 서버를 씁니다.
          </DialogDescription>
        </DialogHeader>
        {open && <CliAccessBody />}
      </DialogContent>
    </Dialog>
  )
}

function remaining(expiresAt: string, now: number): string {
  const ms = Date.parse(expiresAt) - now
  if (ms <= 0) return ''
  const s = Math.ceil(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function CliAccessBody() {
  const { api } = useDeps()
  const uid = useId()
  const offline = useSessionStore((s) => s.status === 'offline')
  const [code, setCode] = useState<CliCode | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [status, setStatus] = useState('')
  const [error, setError] = useState<string | null>(null)
  const issue = useMutation({ mutationFn: () => api.issueCliCode() })

  useEffect(() => {
    if (!code) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [code])

  const left = code ? remaining(code.expiresAt, now) : ''
  const command = code ? `minmo login ${code.code}` : ''

  async function onIssue() {
    setError(null)
    try {
      setCode(await issue.mutateAsync())
      setNow(Date.now())
      setStatus('로그인 코드를 발급했습니다')
    } catch (e) {
      setError(`코드 발급 실패 — ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  async function copy(text: string, done: string) {
    try {
      await navigator.clipboard.writeText(text)
      setStatus(done)
    } catch {
      setError('클립보드에 복사할 수 없습니다 — 직접 선택해 복사하세요')
    }
  }

  return (
    <div className="grid gap-5">
      <section aria-labelledby={`${uid}-code`} className="grid gap-2">
        <h3 id={`${uid}-code`} className="text-sm font-medium">
          1. 로그인 코드
        </h3>
        {code && left ? (
          <div className="flex flex-wrap items-center gap-3">
            <code className="rounded bg-muted px-3 py-1.5 text-lg font-semibold tracking-widest" data-testid="cli-code">
              {code.code}
            </code>
            <span className="text-xs text-muted-foreground">{left} 남음 · 1회용</span>
            <Button size="sm" variant="outline" onClick={() => void copy(command, '로그인 명령을 복사했습니다')}>
              <CopyIcon /> 명령 복사
            </Button>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">{code ? '코드가 만료됐습니다 — 다시 발급하세요.' : '원격에서 `minmo login <코드>` 로 로그인합니다. 코드는 10분간 1회만 쓸 수 있습니다.'}</p>
        )}
        <div>
          <Button size="sm" onClick={() => void onIssue()} disabled={offline || issue.isPending}>
            {code ? '새 코드 발급' : '코드 발급'}
          </Button>
        </div>
      </section>

      <section aria-labelledby={`${uid}-ssh`} className="grid gap-2">
        <h3 id={`${uid}-ssh`} className="text-sm font-medium">
          2. SSH 설정 (이 PC 의 ~/.ssh/config)
        </h3>
        <pre className="overflow-x-auto rounded bg-muted p-3 text-xs" data-testid="ssh-config">
          {SSH_CONFIG_EXAMPLE}
        </pre>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => void copy(SSH_CONFIG_EXAMPLE, 'SSH 설정 예시를 복사했습니다')}>
            <CopyIcon /> 설정 복사
          </Button>
          <span className="text-xs text-muted-foreground">
            `ssh my-server` 로 접속한 뒤 `minmo` 를 실행합니다. 원격에 `~/.minmo` 폴더가 있어야 합니다(`minmo doctor` 로 확인).
          </span>
        </div>
        <p className="text-xs text-muted-foreground">{SSH_SERVER_NOTE}</p>
      </section>

      <SessionsSection uid={uid} setStatus={setStatus} setError={setError} />

      <p role="status" className="text-xs text-muted-foreground">
        {status}
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}

function SessionsSection(props: { uid: string; setStatus(s: string): void; setError(e: string | null): void }) {
  const { api } = useDeps()
  const queryClient = useQueryClient()
  const sessions = useQuery({ queryKey: queryKeys.sessions, queryFn: () => api.listSessions() })
  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeSession(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.sessions }),
  })

  // 데스크탑 세션은 이름이 없어 종류 배지와 겹치지 않게 로그인 날짜로 구분한다
  const name = (s: SessionInfo) => s.label ?? `${new Date(s.createdAt).toLocaleDateString()} 로그인`

  async function onRevoke(s: SessionInfo) {
    props.setError(null)
    try {
      await revoke.mutateAsync(s.id)
      props.setStatus(`${name(s)} 세션을 끊었습니다`)
    } catch (e) {
      props.setError(`세션 끊기 실패 — ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return (
    <section aria-labelledby={`${props.uid}-sessions`} className="grid gap-2">
      <h3 id={`${props.uid}-sessions`} className="text-sm font-medium">
        3. 로그인된 기기
      </h3>
      {sessions.isLoading && <p className="text-xs text-muted-foreground">불러오는 중…</p>}
      {sessions.isError && <p className="text-xs text-destructive">세션 목록을 불러올 수 없습니다</p>}
      <ul className="grid gap-1">
        {sessions.data?.sessions.map((s) => (
          <li key={s.id} className="flex items-center gap-2 rounded bg-muted px-2 py-1 text-sm">
            <Badge variant={s.kind === 'cli' ? 'secondary' : 'outline'}>{s.kind === 'cli' ? 'CLI' : '데스크탑'}</Badge>
            <span className="min-w-0 flex-1 truncate">{name(s)}</span>
            <span className="text-xs text-muted-foreground">
              {s.current ? '이 기기' : s.lastUsedAt ? `최근 ${new Date(s.lastUsedAt).toLocaleString()}` : '사용 기록 없음'}
            </span>
            {!s.current && (
              <Button size="sm" variant="ghost" aria-label={`${name(s)} 세션 끊기`} disabled={revoke.isPending} onClick={() => void onRevoke(s)}>
                끊기
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
