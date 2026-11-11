import { useEffect } from 'react'

import { DEFAULT_PORT } from '../../lib/api'
import type { ServerStatus, TauriApi, Unlisten } from '../../lib/tauri'
import { useServerStore } from '../../store/server'

/** 내장 서버 상태를 구독해 store 에 둔다(앱 루트에서 한 번). 이벤트를 먼저 구독하고 현재 상태를 읽는다 */
export function useServerStatusSubscription(tauri: TauriApi): ServerStatus | null {
  const status = useServerStore((s) => s.status)
  const setStatus = useServerStore((s) => s.setStatus)

  useEffect(() => {
    let alive = true
    // 구독 뒤 도착한 이벤트가 더 최신이므로, 그 뒤에 온 조회 결과로 덮어쓰지 않는다
    let gotEvent = false
    let unlisten: Unlisten | null = null
    void tauri
      .onServerStatus((s) => {
        if (!alive) return
        gotEvent = true
        setStatus(s)
      })
      .then((u) => {
        if (alive) unlisten = u
        else u()
      })
    tauri
      .serverStatus()
      .then((s) => {
        if (alive && !gotEvent) setStatus(s)
      })
      .catch((e: unknown) => {
        if (alive && !gotEvent) {
          setStatus({ state: 'failed', port: DEFAULT_PORT, message: `서버 상태를 확인할 수 없습니다: ${e instanceof Error ? e.message : String(e)}` })
        }
      })
    return () => {
      alive = false
      unlisten?.()
    }
  }, [tauri, setStatus])

  return status
}

/** 앱이 붙을 수 있는 상태(내장 서버 실행 중 또는 debug 외부 서버) */
export const isServerReady = (s: ServerStatus | null) => s?.state === 'running' || s?.state === 'external'
