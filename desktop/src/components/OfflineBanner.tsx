import { useQueryClient } from '@tanstack/react-query'
import { WifiOffIcon } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { useDeps } from '../app/deps'
import { queryKeys } from '../lib/queryKeys'
import { useSessionStore } from '../store/session'
import { Button } from './ui/button'

export const HEALTHZ_POLL_MS = 10_000

/** status 'offline' 일 때 배너 + [다시 연결], healthz 10초 폴링 (CT-33, EC-17) */
export function OfflineBanner() {
  const { api } = useDeps()
  const queryClient = useQueryClient()
  const status = useSessionStore((s) => s.status)
  const setStatus = useSessionStore((s) => s.setStatus)
  const [checking, setChecking] = useState(false)
  const inFlight = useRef(false)

  const check = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    setChecking(true)
    try {
      await api.healthz()
      setStatus('online')
      // 오프라인 동안 실패한 서버 읽기만 다시 불러온다 — GitHub 목록·git 조회는 건드리지 않는다(EC-18, CR-16)
      for (const queryKey of queryKeys.serverAll) void queryClient.invalidateQueries({ queryKey })
    } catch {
      // 계속 offline — 다음 폴링에서 재확인
    } finally {
      inFlight.current = false
      setChecking(false)
    }
  }, [api, queryClient, setStatus])

  useEffect(() => {
    if (status !== 'offline') return
    const timer = setInterval(() => void check(), HEALTHZ_POLL_MS)
    return () => clearInterval(timer)
  }, [status, check])

  // live region 은 내용이 바뀌기 전부터 DOM 에 있어야 스크린 리더가 변화를 읽는다 → 빈 컨테이너를 상시 유지(AX)
  return (
    <div role="status">
      {status === 'offline' && (
        <div data-testid="offline-banner" className="flex items-center gap-3 border-t bg-amber-100 px-4 py-2 text-sm text-amber-950">
          <WifiOffIcon className="size-4" aria-hidden="true" />
          <span className="flex-1">서버에 연결할 수 없습니다 — 메모·설정 편집이 비활성화되고 마지막으로 불러온 내용을 표시합니다.</span>
          <Button size="sm" variant="outline" onClick={() => void check()} disabled={checking}>
            다시 연결
          </Button>
        </div>
      )}
    </div>
  )
}
