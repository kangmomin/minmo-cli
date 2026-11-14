// Tailscale 설치·로그인·HTTPS 도우미(이 PC 의 창에서만). 상태에 따라 다음 할 일 하나를 버튼으로 보여 준다.
// 실행되는 명령은 앱(src-tauri/src/tailscale.rs)이 정해 둔 것뿐이고, 설치는 버튼을 눌렀을 때만 한다.
import { CopyIcon, DownloadIcon, ExternalLinkIcon, LockIcon, LogInIcon } from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'

import { useBaseDeps } from '../../app/deps'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import type { TailscaleLogEvent, TailscaleStatus } from '../../lib/tauri'

const LOG_LIMIT = 200

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** 진행 막대는 앞의 진행 막대 줄을 덮어쓴다(수백 줄로 쌓이지 않게) */
export function appendLog(log: TailscaleLogEvent[], e: TailscaleLogEvent): TailscaleLogEvent[] {
  const last = log[log.length - 1]
  const next = last?.transient && e.transient ? [...log.slice(0, -1), e] : [...log, e]
  return next.slice(-LOG_LIMIT)
}

function Copyable({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-2">
      <code className="min-w-0 flex-1 rounded bg-muted px-2 py-1 font-mono text-xs break-all">{text}</code>
      <Button size="icon-sm" variant="ghost" aria-label={`${text} 복사`} onClick={() => void navigator.clipboard?.writeText(text).catch(() => undefined)}>
        <CopyIcon />
      </Button>
    </div>
  )
}

type Props = {
  remoteEnabled: boolean
  /** 상태가 바뀔 때마다 알린다 — 접속 주소 목록·QR 이 HTTPS 주소를 쓴다 */
  onStatus(status: TailscaleStatus): void
  /** 상태를 다시 확인하는 간격(연결된 뒤에는 4배로 늦춘다) */
  pollMs?: number
}

export function TailscaleSection({ remoteEnabled, onStatus, pollMs = 3000 }: Props) {
  const uid = useId()
  const { tauri } = useBaseDeps()
  const [st, setSt] = useState<TailscaleStatus | null>(null)
  const [busy, setBusy] = useState<'install' | 'login' | 'serve' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pollError, setPollError] = useState<string | null>(null)
  // 버튼으로 한 일의 결과가 그 전에 떠난 상태 확인의 답에 덮이지 않게, 일이 시작·끝날 때마다 올린다
  const epoch = useRef(0)
  const [log, setLog] = useState<TailscaleLogEvent[]>([])
  const [loginUrl, setLoginUrl] = useState<string | null>(null)
  const [enableUrl, setEnableUrl] = useState<string | null>(null)

  const apply = useCallback(
    (s: TailscaleStatus) => {
      setSt(s)
      onStatus(s)
      if (s.state === 'running') setLoginUrl(null)
      if (s.httpsUrl) setEnableUrl(null)
    },
    [onStatus],
  )

  // 설치·로그인은 앱 밖(설치 프로그램·브라우저)에서 끝나므로 상태를 주기적으로 다시 확인해 스스로 다음 단계로 넘어간다
  const settled = st?.state === 'running'
  const host = tauri.runtime !== 'remote'
  useEffect(() => {
    if (!host) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      const at = epoch.current
      try {
        const s = await tauri.tailscaleStatus()
        if (!disposed && at === epoch.current) {
          apply(s)
          setPollError(null)
        }
      } catch (e) {
        if (!disposed) setPollError(message(e))
      }
      if (!disposed) timer = setTimeout(() => void tick(), settled ? pollMs * 4 : pollMs)
    }
    void tick()
    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, [tauri, host, apply, pollMs, settled])

  useEffect(() => {
    let stop: (() => void) | null = null
    let disposed = false
    void tauri
      .onTailscaleLog((e) => setLog((prev) => appendLog(prev, e)))
      .then((un) => {
        if (disposed) un()
        else stop = un
      })
    return () => {
      disposed = true
      stop?.()
    }
  }, [tauri])

  const act = async (kind: NonNullable<typeof busy>, job: () => Promise<void>) => {
    setBusy(kind)
    setError(null)
    // 설치는 오래 걸리고 그동안 상태 확인이 다음 단계를 알려 줘야 하므로 막지 않는다
    if (kind !== 'install') epoch.current++
    try {
      await job()
    } catch (e) {
      setError(message(e))
    } finally {
      epoch.current++
      setBusy(null)
    }
  }
  const open = (url: string) => void tauri.openUrl(url).catch(() => setError('브라우저를 열지 못했습니다 — 주소를 복사해 직접 여세요.'))

  const install = () =>
    act('install', async () => {
      setLog([])
      const r = await tauri.tailscaleInstall()
      if (!r.cancelled && r.exitCode !== 0) setError(`설치하지 못했습니다(종료 코드 ${r.exitCode}). 아래 출력을 확인하거나 설치 페이지에서 직접 설치하세요.`)
      apply(await tauri.tailscaleStatus())
    })
  const login = () =>
    act('login', async () => {
      const { url } = await tauri.tailscaleLogin()
      setLoginUrl(url)
      // 열지 못해도(허용되지 않은 주소 등) 아래에 주소를 보여 주므로 직접 열 수 있다
      if (url) await tauri.openUrl(url).catch(() => undefined)
      apply(await tauri.tailscaleStatus())
    })
  const serve = (on: boolean) =>
    act('serve', async () => {
      setEnableUrl(null)
      const r = await tauri.tailscaleServe(on)
      apply(r.status)
      setEnableUrl(r.enableUrl)
    })

  // 붙은 기기의 화면에서는 쓰지 않는다(설치·네트워크 설정은 그 PC 앞에서)
  if (!host) return null

  const heading = (
    <h3 id={`${uid}-ts`} className="flex items-center gap-2 font-medium">
      Tailscale
      {st?.state === 'running' && <Badge>연결됨</Badge>}
    </h3>
  )
  const shownError = error ?? pollError
  const alert = shownError && (
    <p role="alert" className="text-destructive">
      {shownError}
    </p>
  )
  const logView = log.length > 0 && (
    <pre aria-label="설치 출력" className="max-h-32 overflow-auto rounded bg-muted p-2 font-mono text-xs whitespace-pre-wrap" data-testid="tailscale-log">
      {log.map((l) => l.line).join('\n')}
    </pre>
  )

  if (!st) {
    return (
      <section className="grid gap-2 border-t pt-3" aria-labelledby={`${uid}-ts`}>
        {heading}
        {alert ?? <p className="text-xs text-muted-foreground">Tailscale 상태를 확인하는 중…</p>}
      </section>
    )
  }

  let body: React.ReactNode
  if (st.state === 'missing') {
    const plan = st.install
    body = (
      <>
        <p className="text-xs text-muted-foreground">Tailscale 을 쓰면 같은 네트워크가 아니어도 암호화된 연결로 이 PC 에 접속할 수 있습니다. 접속할 기기(휴대폰 등)에도 Tailscale 앱을 설치해 같은 계정으로 로그인하세요.</p>
        {plan?.command && (
          <div className="grid gap-1">
            <span className="text-xs text-muted-foreground">{plan.auto ? '[Tailscale 설치] 를 누르면 이 명령을 실행합니다. 설치 프로그램이 관리자 권한을 물을 수 있습니다.' : '터미널에서 이 명령으로 설치할 수 있습니다(관리자 암호가 필요해 앱이 대신 실행하지 않습니다).'}</span>
            <Copyable text={plan.command} />
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {plan?.auto &&
            (busy === 'install' || st.installing ? (
              <>
                <span className="text-xs text-muted-foreground" role="status">
                  설치하는 중…
                </span>
                <Button size="sm" variant="outline" onClick={() => void tauri.tailscaleInstallCancel().catch(() => undefined)}>
                  취소
                </Button>
              </>
            ) : (
              <Button size="sm" onClick={() => void install()}>
                <DownloadIcon /> Tailscale 설치
              </Button>
            ))}
          <Button size="sm" variant={plan?.auto ? 'ghost' : 'outline'} onClick={() => open(plan?.downloadUrl ?? 'https://tailscale.com/download')}>
            <ExternalLinkIcon /> 설치 페이지 열기
          </Button>
        </div>
      </>
    )
  } else if (st.state === 'running') {
    body = (
      <>
        <p className="text-xs text-muted-foreground">
          이 PC: <span className="font-mono">{st.name ?? st.ips[0] ?? '-'}</span>
          {st.name && st.ips.length > 0 && <span className="font-mono"> · {st.ips.join(', ')}</span>}
        </p>
        {st.httpsUrl ? (
          <div className="grid gap-1">
            <span className="text-xs text-muted-foreground">HTTPS 로 열려 있습니다(같은 tailnet 의 기기만 접속할 수 있습니다).</span>
            <Copyable text={st.httpsUrl} />
            <div>
              <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void serve(false)}>
                HTTPS 끄기
              </Button>
            </div>
          </div>
        ) : st.httpsConflict ? (
          <p className="text-xs text-muted-foreground">이 PC 의 443 포트에 이미 다른 tailscale serve 설정이 있어, 그 설정을 지우지 않도록 HTTPS 버튼을 쓰지 않습니다.</p>
        ) : remoteEnabled ? (
          <div className="grid gap-1">
            <span className="text-xs text-muted-foreground">휴대폰에서 "홈 화면에 추가"와 브라우저 알림을 쓰려면 HTTPS 주소가 필요합니다. 같은 tailnet 안에서만 열립니다(인터넷에 공개하지 않습니다).</span>
            <div>
              <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void serve(true)}>
                <LockIcon /> HTTPS 로 열기
              </Button>
            </div>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">원격 접속을 켜면 HTTPS 주소로도 열 수 있습니다.</p>
        )}
        {enableUrl && (
          <div className="grid gap-1" data-testid="tailscale-enable">
            <span className="text-xs">이 tailnet 에서 HTTPS 가 꺼져 있습니다. 아래 Tailscale 관리 화면에서 켠 뒤 [HTTPS 로 열기] 를 다시 누르세요.</span>
            <Copyable text={enableUrl} />
            <div>
              <Button size="sm" variant="outline" onClick={() => open(enableUrl)}>
                <ExternalLinkIcon /> 설정 페이지 열기
              </Button>
            </div>
          </div>
        )}
      </>
    )
  } else if (st.state === 'needs-approval') {
    body = <p className="text-xs text-muted-foreground">로그인은 됐지만 tailnet 관리자가 이 기기를 승인해야 합니다. 승인되면 여기가 스스로 바뀝니다.</p>
  } else {
    const stopped = st.state === 'stopped'
    body = (
      <>
        <p className="text-xs text-muted-foreground">
          {st.state === 'unavailable'
            ? 'Tailscale 은 설치되어 있지만 서비스가 응답하지 않습니다. Tailscale 앱을 실행한 뒤 다시 시도하세요.'
            : stopped
              ? 'Tailscale 이 꺼져 있습니다.'
              : st.state === 'needs-login'
                ? 'Tailscale 이 설치되어 있습니다. 로그인하면 이 PC 의 Tailscale 주소가 접속 주소에 나옵니다.'
                : 'Tailscale 이 연결을 준비하고 있습니다.'}
        </p>
        {st.error && <p className="font-mono text-xs break-all text-muted-foreground">{st.error}</p>}
        <div>
          <Button size="sm" disabled={busy !== null} onClick={() => void login()}>
            <LogInIcon /> {stopped ? 'Tailscale 연결' : 'Tailscale 로그인'}
          </Button>
        </div>
        {loginUrl && (
          <div className="grid gap-1" data-testid="tailscale-login-url">
            <span className="text-xs">브라우저에서 로그인을 마치면 여기가 스스로 바뀝니다. 브라우저가 열리지 않았으면 이 주소를 여세요.</span>
            <Copyable text={loginUrl} />
          </div>
        )}
      </>
    )
  }

  return (
    <section className="grid gap-2 border-t pt-3" aria-labelledby={`${uid}-ts`} data-testid="tailscale" data-state={st.state}>
      {heading}
      {body}
      {(busy === 'install' || st.state === 'missing') && logView}
      {alert}
    </section>
  )
}
