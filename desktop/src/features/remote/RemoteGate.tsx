// 원격 화면의 문지기 — 호스트에 붙고(처음이면 기기 등록) 나서 앱을 띄운다. 끊기면 다시 붙는다.
import { useEffect, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'

import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { setTauri } from '../../lib/tauri'
import { PairError, RemoteConnection, createRemoteTauri, pairDevice, remoteFetch, storeDeviceToken, storedDeviceToken } from '../../lib/tauri.remote'

type Phase = 'connecting' | 'pair' | 'ready' | 'lost'

const RETRY_MS = [1000, 2000, 4000, 8000]
const LAG_RELOAD_KEY = 'minmo-lag-reload'
const LAG_RELOAD_MIN_MS = 30_000

/** 놓친 출력 때문에 새로 고친 지 얼마 안 됐으면 false */
export function reloadAllowed(now: number = Date.now()): boolean {
  try {
    const last = Number(sessionStorage.getItem(LAG_RELOAD_KEY) ?? 0)
    if (now - last < LAG_RELOAD_MIN_MS) return false
    sessionStorage.setItem(LAG_RELOAD_KEY, String(now))
    return true
  } catch {
    return false
  }
}

/** 기기 이름의 기본값 — 호스트의 기기 목록에서 알아볼 수 있게 */
export function defaultDeviceName(ua: string = navigator.userAgent): string {
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows PC' : /Linux/.test(ua) ? 'Linux PC' : '기기'
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : ''
  return browser ? `${os} · ${browser}` : os
}

export function pairErrorMessage(e: unknown): string {
  if (e instanceof PairError) {
    if (e.code === 'pair_wrong_code') return e.left ? `코드가 맞지 않습니다(남은 시도 ${e.left}번)` : '코드를 여러 번 틀려 무효가 되었습니다 — 호스트에서 새 코드를 받으세요'
    if (e.code === 'pair_not_open') return '등록 코드가 만료되었거나 이미 사용되었습니다 — 호스트의 [원격 접속] 에서 새 코드를 받으세요'
    if (e.code === 'not_enabled') return '호스트에서 원격 접속이 꺼져 있습니다'
  }
  return '호스트에 연결할 수 없습니다'
}

export function RemoteGate({ children, origin = window.location.origin }: { children: ReactNode; origin?: string }) {
  const [phase, setPhase] = useState<Phase>('connecting')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [code, setCode] = useState('')
  const [name, setName] = useState(defaultDeviceName)
  const everReady = useRef(false)
  // 토큰이 바뀌면(등록 직후) 다시 붙는다
  const [token, setToken] = useState(storedDeviceToken)

  useEffect(() => {
    if (!token) {
      setPhase('pair')
      return
    }
    let stopped = false
    let conn: RemoteConnection | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    let attempt = 0
    const wsUrl = `${origin.replace(/^http/, 'ws')}/ws`

    const connect = () => {
      if (stopped) return
      const c = new RemoteConnection(wsUrl, token)
      conn = c
      c.onLink((link) => {
        if (stopped || conn !== c) return
        if (link === 'rejected') {
          // 호스트에서 이 기기를 끊었거나 원격 접속을 껐다
          storeDeviceToken(null)
          setError('이 기기의 등록이 해제되었습니다. 다시 등록하세요')
          setToken(null)
        } else if (link === 'closed') {
          setPhase(everReady.current ? 'lost' : 'connecting')
          timer = setTimeout(connect, RETRY_MS[Math.min(attempt++, RETRY_MS.length - 1)])
        }
      })
      c.connect()
        .then(() => {
          if (stopped || conn !== c) return
          // 끊겼다 다시 붙으면 화면을 새로 띄운다 — 그 사이의 터미널 출력·상태 변경을 놓쳤으므로 처음부터 다시 맞춘다
          if (everReady.current) return window.location.reload()
          attempt = 0
          everReady.current = true
          globalThis.fetch = remoteFetch(origin, storedDeviceToken, globalThis.fetch.bind(globalThis))
          // 호스트가 보낸 이벤트(터미널 출력 등)가 너무 밀려 일부를 놓쳤다 — 화면을 새로 띄워 지난 출력부터 다시 맞춘다.
          // 느린 연결에서 되풀이되지 않게 한동안은 한 번만 한다
          c.on('lagged', () => {
            if (reloadAllowed()) window.location.reload()
          })
          setTauri(createRemoteTauri(c))
          setPhase('ready')
        })
        .catch(() => undefined)
    }
    setPhase('connecting')
    connect()
    return () => {
      stopped = true
      clearTimeout(timer)
      conn?.close()
    }
  }, [origin, token])

  async function onPair(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const t = await pairDevice(origin, code.replace(/\D/g, ''), name.trim())
      storeDeviceToken(t)
      setToken(t)
    } catch (err) {
      setError(pairErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  if (phase === 'ready' || phase === 'lost') {
    return (
      <>
        {children}
        {phase === 'lost' && (
          <div role="alert" className="fixed inset-x-0 top-0 z-[100] bg-destructive px-4 py-2 text-center text-sm text-white">
            호스트와의 연결이 끊겼습니다 — 다시 연결하는 중…
          </div>
        )}
      </>
    )
  }

  return (
    <main className="flex h-full items-center justify-center p-6">
      {phase === 'connecting' ? (
        <p className="text-sm text-muted-foreground">호스트에 연결하는 중…</p>
      ) : (
        <form onSubmit={onPair} className="grid w-full max-w-sm gap-4">
          <div>
            <h1 className="text-lg font-semibold">minmo — 기기 등록</h1>
            <p className="mt-1 text-sm text-muted-foreground">호스트 PC 의 minmo 에서 [원격 접속] → [기기 등록] 을 눌러 나온 6자리 코드를 입력하세요.</p>
          </div>
          <div className="grid gap-1">
            <Label htmlFor="pair-code">등록 코드</Label>
            <Input id="pair-code" value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={7} placeholder="123456" className="font-mono text-lg tracking-widest" autoFocus required />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="pair-name">이 기기의 이름</Label>
            <Input id="pair-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" disabled={busy || code.replace(/\D/g, '').length !== 6}>
            {busy ? '등록하는 중…' : '등록'}
          </Button>
        </form>
      )}
    </main>
  )
}
