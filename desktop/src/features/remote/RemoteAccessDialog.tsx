// 원격 접속 설정(이 PC 의 창에서만) — 켜기/끄기, 접속 주소, 기기 등록 코드, 등록된 기기 끊기
import { CopyIcon, SmartphoneIcon, Trash2Icon } from 'lucide-react'
import qrcode from 'qrcode-generator'
import { useCallback, useEffect, useId, useMemo, useState } from 'react'

import { useBaseDeps } from '../../app/deps'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../components/ui/dialog'
import type { RemoteAddress, RemoteStatus } from '../../lib/tauri'

const KIND_LABEL: Record<RemoteAddress['kind'], string> = { tailscale: 'Tailscale', lan: '같은 네트워크(LAN)', local: '이 PC' }

/** 다른 기기에서 열 주소 — Tailscale 을 먼저, 없으면 LAN(이 PC 전용 주소는 다른 기기에서 열 수 없다) */
export function shareableAddress(addresses: RemoteAddress[]): RemoteAddress | null {
  return addresses.find((a) => a.kind === 'tailscale') ?? addresses.find((a) => a.kind === 'lan') ?? null
}

function QrCode({ text }: { text: string }) {
  const svg = useMemo(() => {
    const qr = qrcode(0, 'M')
    qr.addData(text)
    qr.make()
    return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true })
  }, [text])
  // 라이브러리가 만든 SVG(입력은 주소 문자열뿐이고, 모듈 좌표만 들어간다)를 그대로 넣는다. 어두운 테마에서도 읽히게 흰 바탕을 둔다
  return <div role="img" aria-label={`접속 주소 QR 코드: ${text}`} className="size-36 shrink-0 rounded bg-white p-1" dangerouslySetInnerHTML={{ __html: svg }} />
}

function formatTime(ms: number): string {
  return ms > 0 ? new Date(ms).toLocaleString() : '-'
}

export function RemoteAccessDialog({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>원격 접속</DialogTitle>
          <DialogDescription>다른 PC 나 휴대폰의 브라우저에서 이 PC 의 minmo 를 씁니다. 등록한 기기는 이 PC 의 터미널을 조작할 수 있으니, 내 기기만 등록하세요.</DialogDescription>
        </DialogHeader>
        {open && <Body />}
      </DialogContent>
    </Dialog>
  )
}

function Body() {
  const uid = useId()
  const { tauri } = useBaseDeps()
  const [status, setStatus] = useState<RemoteStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pair, setPair] = useState<{ code: string; until: number } | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [port, setPort] = useState('')

  const run = useCallback(async (job: () => Promise<RemoteStatus>) => {
    setError(null)
    try {
      const s = await job()
      setStatus(s)
      setPort(String(s.port))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void run(() => tauri.remoteStatus())
    let stop: (() => void) | null = null
    let disposed = false
    // 기기가 등록·접속·끊기면 목록을 다시 읽는다. 등록이 끝났으면 코드는 이미 쓰였으므로 내린다
    void tauri
      .onRemoteChanged(() => {
        void tauri.remoteStatus().then((s) => {
          if (disposed) return
          setStatus((prev) => {
            if (prev && s.devices.length > prev.devices.length) setPair(null)
            return s
          })
        })
      })
      .then((un) => {
        if (disposed) un()
        else stop = un
      })
    return () => {
      disposed = true
      stop?.()
      // 창을 닫으면 쓰지 않은 등록 코드는 무효로 한다
      void tauri.remotePairCancel().catch(() => undefined)
    }
  }, [tauri, run])

  // 등록 코드의 남은 시간
  useEffect(() => {
    if (!pair) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [pair])
  const left = pair ? Math.max(0, Math.ceil((pair.until - now) / 1000)) : 0
  useEffect(() => {
    if (pair && left === 0) setPair(null)
  }, [pair, left])

  if (!status) return <p className="text-sm text-muted-foreground">{error ?? '불러오는 중…'}</p>

  const share = shareableAddress(status.addresses)
  const startPair = async () => {
    setError(null)
    try {
      const p = await tauri.remotePairStart()
      setNow(Date.now())
      setPair({ code: p.code, until: Date.now() + p.expiresInSec * 1000 })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="grid gap-4 text-sm">
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={status.enabled} onChange={(e) => void run(() => tauri.remoteConfigure({ enabled: e.target.checked }))} />
        <span className="font-medium">원격 접속 켜기</span>
      </label>

      {status.enabled && (
        <>
          <section className="grid gap-2" aria-labelledby={`${uid}-addr`}>
            <h3 id={`${uid}-addr`} className="font-medium">
              접속 주소
            </h3>
            <ul className="grid gap-1">
              {status.addresses.map((a) => (
                <li key={a.url} className="flex items-center gap-2">
                  <Badge variant="outline">{KIND_LABEL[a.kind]}</Badge>
                  <code className="flex-1 truncate font-mono text-xs">{a.url}</code>
                  <Button size="icon-sm" variant="ghost" aria-label={`${a.url} 복사`} onClick={() => void navigator.clipboard?.writeText(a.url).catch(() => undefined)}>
                    <CopyIcon />
                  </Button>
                </li>
              ))}
            </ul>
            {!status.addresses.some((a) => a.kind === 'tailscale') && (
              <p className="text-xs text-muted-foreground">Tailscale 주소가 없습니다. 이 PC 와 접속할 기기에 Tailscale 을 설치해 같은 계정으로 로그인하면, 어디서든 암호화된 연결로 접속할 수 있습니다.</p>
            )}
            <label className="flex items-start gap-2">
              <input type="checkbox" className="mt-0.5" checked={status.lan} onChange={(e) => void run(() => tauri.remoteConfigure({ lan: e.target.checked }))} />
              <span>
                같은 네트워크(LAN)에서도 접속 허용
                <span className="block text-xs text-muted-foreground">LAN 연결은 암호화되지 않습니다 — 같은 네트워크의 다른 사람이 내용을 엿볼 수 있습니다. 믿을 수 있는 네트워크에서만 켜세요.</span>
              </span>
            </label>
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                void run(() => tauri.remoteConfigure({ port: Number(port) }))
              }}
            >
              <label htmlFor={`${uid}-port`}>포트</label>
              <input id={`${uid}-port`} className="w-24 rounded border bg-transparent px-2 py-1 font-mono" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))} />
              <Button type="submit" size="sm" variant="outline" disabled={port === '' || Number(port) === status.port}>
                바꾸기
              </Button>
            </form>
            {status.error && (
              <p role="alert" className="text-destructive">
                {status.error}
              </p>
            )}
          </section>

          <section className="grid gap-2" aria-labelledby={`${uid}-pair`}>
            <h3 id={`${uid}-pair`} className="font-medium">
              기기 등록
            </h3>
            {pair ? (
              <div className="flex items-center gap-4 rounded border p-3">
                {share && <QrCode text={share.url} />}
                <div className="grid gap-1">
                  <p>
                    새 기기의 브라우저에서 <code className="font-mono text-xs">{share?.url ?? '위 주소'}</code> 를 열고 이 코드를 입력하세요.
                  </p>
                  <p className="font-mono text-3xl tracking-widest" aria-label={`등록 코드 ${pair.code.split('').join(' ')}`} data-testid="pair-code">
                    {pair.code}
                  </p>
                  <p className="text-xs text-muted-foreground" aria-live="off">
                    {left}초 남음 · 한 번만 쓸 수 있습니다
                  </p>
                </div>
              </div>
            ) : (
              <div>
                <Button size="sm" onClick={() => void startPair()}>
                  <SmartphoneIcon /> 기기 등록
                </Button>
              </div>
            )}
          </section>
        </>
      )}

      <section className="grid gap-2" aria-labelledby={`${uid}-dev`}>
        <h3 id={`${uid}-dev`} className="font-medium">
          등록된 기기
        </h3>
        {status.devices.length === 0 ? (
          <p className="text-muted-foreground">등록된 기기가 없습니다.</p>
        ) : (
          <ul className="grid gap-1">
            {status.devices.map((d) => (
              <li key={d.id} className="flex items-center gap-2" data-testid="remote-device">
                <span className="flex-1 truncate">
                  {d.name}
                  <span className="block text-xs text-muted-foreground">마지막 접속 {formatTime(d.lastSeenMs)}</span>
                </span>
                {d.connected && <Badge>접속 중</Badge>}
                <Button size="sm" variant="ghost" onClick={() => void run(() => tauri.remoteDeviceRemove(d.id))}>
                  <Trash2Icon /> 끊기
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
