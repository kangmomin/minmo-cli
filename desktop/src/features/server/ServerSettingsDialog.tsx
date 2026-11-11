import { CopyIcon, ExternalLinkIcon } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import type { FormEvent } from 'react'

import { Button } from '../../components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { RadioGroup, RadioGroupItem } from '../../components/ui/radio-group'
import { getTauri } from '../../lib/tauri'
import type { CloseAction, ServerSettings, ServerSettingsInput, TauriApi } from '../../lib/tauri'
import { useServerStore } from '../../store/server'
import { CLOSE_OPTIONS, OAUTH_APP_NEW_URL, parsePort, statusText } from './serverSettings'

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

export interface ServerSettingsDialogProps {
  tauri?: TauriApi
  /** 포트를 바꾼 뒤 새 포트로 다시 붙는다(기본: 창 새로 고침) */
  onPortChanged?: () => void
}

/** 내장 서버 설정 — 포트·GitHub OAuth App·창 닫기. 열림 상태는 store(openServerSettings)로 어디서든 연다 */
export function ServerSettingsDialog({ tauri = getTauri(), onPortChanged = () => window.location.reload() }: ServerSettingsDialogProps) {
  const open = useServerStore((s) => s.settingsOpen)
  const setOpen = useServerStore((s) => s.setSettingsOpen)
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>서버 설정</DialogTitle>
          <DialogDescription>minmo 서버는 앱과 함께 이 PC 에서 실행됩니다. 원격 CLI 도 SSH 로 이 서버를 씁니다.</DialogDescription>
        </DialogHeader>
        {open && <ServerSettingsBody tauri={tauri} onDone={() => setOpen(false)} onPortChanged={onPortChanged} />}
      </DialogContent>
    </Dialog>
  )
}

function ServerSettingsBody({ tauri, onDone, onPortChanged }: { tauri: TauriApi; onDone(): void; onPortChanged(): void }) {
  const uid = useId()
  const fid = (name: string) => `${uid}-${name}`
  const status = useServerStore((s) => s.status)
  const [loaded, setLoaded] = useState<ServerSettings | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [port, setPort] = useState('')
  const [clientId, setClientId] = useState('')
  const [secret, setSecret] = useState('')
  const [closeAction, setCloseAction] = useState<CloseAction>('ask')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let alive = true
    tauri
      .serverSettingsGet()
      .then((s) => {
        if (!alive) return
        setLoaded(s)
        setPort(String(s.port))
        setClientId(s.githubClientId)
        setCloseAction(s.closeAction)
      })
      .catch((e: unknown) => alive && setLoadError(errorText(e)))
    return () => {
      alive = false
    }
  }, [tauri])

  if (loadError) {
    return (
      <p className="rounded bg-destructive/10 p-2 text-sm text-destructive" role="alert">
        서버 설정을 불러오지 못했습니다: {loadError}
      </p>
    )
  }
  if (!loaded) return <p className="text-sm text-muted-foreground">불러오는 중…</p>

  const parsedPort = parsePort(port)
  const callbackUrl = `http://127.0.0.1:${parsedPort ?? loaded.port}/auth/github/callback`

  async function copy(text: string, done: string) {
    try {
      await navigator.clipboard.writeText(text)
      setNotice(done)
    } catch {
      setNotice('복사하지 못했습니다 — 직접 선택해 복사하세요')
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!loaded) return
    setError(null)
    if (parsedPort === null) {
      setError('포트는 1024~65535 사이의 숫자여야 합니다')
      return
    }
    const input: ServerSettingsInput = {}
    if (parsedPort !== loaded.port) input.port = parsedPort
    if (clientId.trim() !== loaded.githubClientId) input.githubClientId = clientId.trim()
    if (secret.trim()) input.githubClientSecret = secret.trim()
    if (closeAction !== loaded.closeAction) input.closeAction = closeAction
    if (Object.keys(input).length === 0) {
      onDone()
      return
    }
    setSaving(true)
    try {
      await tauri.serverSettingsSave(input)
      if (input.port !== undefined) {
        onPortChanged()
        return
      }
      onDone()
    } catch (err) {
      setError(`저장하지 못했습니다: ${errorText(err)}`)
    } finally {
      setSaving(false)
    }
  }

  const portChanged = parsedPort !== null && parsedPort !== loaded.port

  return (
    <form onSubmit={(e) => void onSubmit(e)} className="grid gap-5">
      {loaded.warning && (
        <p className="rounded bg-amber-100 p-2 text-sm text-amber-950 dark:bg-amber-950 dark:text-amber-100" role="status">
          {loaded.warning}
        </p>
      )}

      <section className="grid gap-2" aria-labelledby={fid('server')}>
        <h3 id={fid('server')} className="text-sm font-semibold">
          서버
        </h3>
        <p className="text-sm" data-testid="server-status">
          상태: {statusText(status)}
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <div className="grid gap-1">
            <Label htmlFor={fid('port')}>포트</Label>
            <Input id={fid('port')} inputMode="numeric" className="w-28" value={port} onChange={(e) => setPort(e.target.value)} aria-describedby={fid('port-hint')} />
          </div>
          <Button type="button" variant="outline" size="sm" onClick={() => void tauri.serverRestart()}>
            다시 시작
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => void tauri.serverOpenLogDir()}>
            로그 폴더 열기
          </Button>
        </div>
        <p id={fid('port-hint')} className="text-xs text-muted-foreground">
          {portChanged
            ? '저장하면 서버를 새 포트로 다시 시작하고 창을 새로 고칩니다. OAuth App 의 callback URL 과 원격 CLI 의 SSH RemoteForward 도 새 포트로 바꾸세요.'
            : '이 PC 에서만 접속할 수 있습니다(127.0.0.1).'}
        </p>
      </section>

      <section className="grid gap-2" aria-labelledby={fid('oauth')}>
        <h3 id={fid('oauth')} className="text-sm font-semibold">
          GitHub OAuth App
        </h3>
        <p className="text-xs text-muted-foreground">
          GitHub 로그인에 쓸 OAuth App 을 등록하고 값을 넣으세요. 등록할 때 Authorization callback URL 에 아래 주소를 넣고, Homepage URL 은 아무 주소나(예:
          http://127.0.0.1:{parsedPort ?? loaded.port}) 써도 됩니다. 조직 저장소가 보이지 않으면 그 조직의 Third-party access 에서 앱을 승인하세요.
        </p>
        <div className="flex items-center gap-2">
          <code className="flex-1 truncate rounded bg-muted px-2 py-1 text-xs" data-testid="callback-url">
            {callbackUrl}
          </code>
          <Button type="button" size="sm" variant="outline" onClick={() => void copy(callbackUrl, 'callback URL 을 복사했습니다')}>
            <CopyIcon /> 복사
          </Button>
        </div>
        <div>
          <Button type="button" size="sm" variant="ghost" onClick={() => void tauri.openUrl(OAUTH_APP_NEW_URL).catch(() => setNotice('브라우저를 열 수 없습니다'))}>
            <ExternalLinkIcon /> GitHub 에서 OAuth App 등록
          </Button>
        </div>
        <div className="grid gap-1">
          <Label htmlFor={fid('client-id')}>Client ID</Label>
          <Input id={fid('client-id')} value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" spellCheck={false} />
        </div>
        <div className="grid gap-1">
          <Label htmlFor={fid('client-secret')}>Client Secret</Label>
          <Input
            id={fid('client-secret')}
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder={loaded.hasClientSecret ? '저장됨 — 바꾸려면 새 값을 입력' : '아직 없음'}
            autoComplete="off"
          />
          <p className="text-xs text-muted-foreground">Secret 은 OS 키체인에 저장하며 다시 보여 주지 않습니다.</p>
        </div>
      </section>

      <section className="grid gap-2" aria-labelledby={fid('close')}>
        <h3 id={fid('close')} className="text-sm font-semibold">
          창을 닫을 때
        </h3>
        <RadioGroup aria-labelledby={fid('close')} value={closeAction} onValueChange={(v) => setCloseAction(v as CloseAction)} className="flex flex-wrap gap-4">
          {CLOSE_OPTIONS.map((o) => (
            <div key={o.value} className="flex items-center gap-2">
              <RadioGroupItem id={fid(`close-${o.value}`)} value={o.value} />
              <Label htmlFor={fid(`close-${o.value}`)}>{o.label}</Label>
            </div>
          ))}
        </RadioGroup>
        <p className="text-xs text-muted-foreground">트레이로 최소화하면 창을 닫아도 서버가 계속 실행되어 원격 CLI 를 쓸 수 있습니다. 트레이 메뉴의 [종료]로 끝냅니다.</p>
      </section>

      {error && (
        <p className="rounded bg-destructive/10 p-2 text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      <p className="sr-only" role="status">
        {notice}
      </p>
      {notice && <p className="text-xs text-muted-foreground">{notice}</p>}

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onDone}>
          취소
        </Button>
        <Button type="submit" disabled={saving}>
          저장
        </Button>
      </DialogFooter>
    </form>
  )
}
