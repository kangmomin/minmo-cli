import { useEffect, useId, useRef, useState } from 'react'
import type { FormEvent } from 'react'

import { Button } from '../../components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { RadioGroup, RadioGroupItem } from '../../components/ui/radio-group'
import { getTauri } from '../../lib/tauri'
import type { CloseAction, ServerSettings, ServerSettingsInput, TauriApi } from '../../lib/tauri'
import { useServerStore } from '../../store/server'
import { AppUpdateSection } from '../update/AppUpdateSection'
import { CLOSE_OPTIONS, parsePort, statusText } from './serverSettings'

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

export interface ServerSettingsDialogProps {
  tauri?: TauriApi
}

/** 내장 서버 설정 — 포트·GitHub OAuth App·창 닫기. 열림 상태는 store(openServerSettings)로 어디서든 연다 */
export function ServerSettingsDialog({ tauri = getTauri() }: ServerSettingsDialogProps) {
  const open = useServerStore((s) => s.settingsOpen)
  const setOpen = useServerStore((s) => s.setSettingsOpen)
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>서버 설정</DialogTitle>
          <DialogDescription>minmo 서버는 앱과 함께 이 PC 에서 실행됩니다. 원격 CLI 도 SSH 로 이 서버를 씁니다.</DialogDescription>
        </DialogHeader>
        {open && <ServerSettingsForm tauri={tauri} onDone={() => setOpen(false)} />}
      </DialogContent>
    </Dialog>
  )
}

/** Why: 대화상자와 설정 화면이 함께 쓴다 — onDone 이 있으면 대화상자(저장·취소 후 닫음), 없으면 설정 화면(열린 채 저장 결과를 보인다) */
export function ServerSettingsForm({ tauri, onDone }: { tauri: TauriApi; onDone?: () => void }) {
  const uid = useId()
  const fid = (name: string) => `${uid}-${name}`
  const status = useServerStore((s) => s.status)
  const [loaded, setLoaded] = useState<ServerSettings | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [port, setPort] = useState('')
  const [closeAction, setCloseAction] = useState<CloseAction>('ask')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const saveButton = useRef<HTMLButtonElement>(null)
  // Why: 저장 중에는 [저장] 이 disabled 라 포커스를 잃는다 — 저장이 끝나 다시 쓸 수 있게 된 뒤 되돌린다
  const focusSave = useRef(false)
  useEffect(() => {
    if (saving || !focusSave.current) return
    focusSave.current = false
    saveButton.current?.focus()
  }, [saving])

  useEffect(() => {
    let alive = true
    tauri
      .serverSettingsGet()
      .then((s) => {
        if (!alive) return
        setLoaded(s)
        setPort(String(s.port))
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
  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!loaded) return
    setError(null)
    if (parsedPort === null) {
      setSaved(false)
      setError('포트는 1024~65535 사이의 숫자여야 합니다')
      return
    }
    const input: ServerSettingsInput = {}
    if (parsedPort !== loaded.port) input.port = parsedPort
    if (closeAction !== loaded.closeAction) input.closeAction = closeAction
    if (Object.keys(input).length === 0) {
      onDone?.()
      return
    }
    setSaved(false)
    setSaving(true)
    try {
      // 포트가 바뀌면 서버가 새 포트로 다시 시작되고, 앱(App)이 running 을 보고 새 주소로 다시 붙는다
      const next = await tauri.serverSettingsSave(input)
      if (onDone) {
        onDone()
        return
      }
      // Why: 열린 채 다시 저장할 수 있어, 바뀐 값을 가리는 기준은 서버가 돌려준 값이어야 한다
      setLoaded(next)
      setPort(String(next.port))
      setCloseAction(next.closeAction)
      setSaved(true)
      focusSave.current = true
    } catch (err) {
      setError(`저장하지 못했습니다: ${errorText(err)}`)
    } finally {
      setSaving(false)
    }
  }

  const portChanged = parsedPort !== null && parsedPort !== loaded.port
  // 배포 빌드는 내장 서버를 띄우지 않는다 — 포트·다시 시작·로그는 쓸 곳이 없다
  const hosted = !!status?.url

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
        {!hosted && (
          <>
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
                ? '저장하면 서버를 새 포트로 다시 시작하고 다시 연결합니다(열린 터미널은 닫힙니다). OAuth App 의 callback URL 과 원격 CLI 의 SSH RemoteForward 도 새 포트로 바꾸세요.'
                : '이 PC 에서만 접속할 수 있습니다(127.0.0.1).'}
            </p>
          </>
        )}
      </section>

      <AppUpdateSection tauri={tauri} headingId={fid('app')} />

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

      <DialogFooter className="items-center">
        {onDone ? (
          <Button type="button" variant="ghost" onClick={onDone}>
            취소
          </Button>
        ) : (
          // Why: live region 은 미리 렌더해 두어야 변화가 읽힌다
          <p className="mr-auto text-sm text-muted-foreground" role="status">
            {saved ? '저장했습니다' : ''}
          </p>
        )}
        <Button ref={saveButton} type="submit" disabled={saving}>
          저장
        </Button>
      </DialogFooter>
    </form>
  )
}
