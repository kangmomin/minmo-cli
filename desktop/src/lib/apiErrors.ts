import type { QueryClient } from '@tanstack/react-query'

import { ApiError } from '@minmo/api-client'
import { isOfflineError, isUnauthorized } from '@minmo/core'

import { useSessionStore } from '../store/session'

// 판정 함수는 원격 CLI 와 함께 쓰도록 @minmo/core 에 있다
export { isOfflineError, isUnauthorized, shouldRetry } from '@minmo/core'

// 서버 API 오류 공통 처리 (UI State Contract):
// - 401 unauthorized → 세션 삭제(clearSession) + queryClient 가 있으면 서버 읽기 캐시 삭제
// - isOfflineError(network_error / 5xx, E1 503 not_configured 제외) → status 'offline'
// - 그 외(4xx 전부) → 상태 변화 없음
export function handleApiError(err: unknown, opts?: { queryClient?: QueryClient }): void {
  if (!(err instanceof ApiError)) return
  if (isUnauthorized(err)) {
    expireSession(opts?.queryClient)
    return
  }
  if (isOfflineError(err)) useSessionStore.getState().setStatus('offline')
}

/** 세션 만료 공통 처리(서버 401·GitHub 토큰 거부 EC-02): 세션 삭제 → /login, 서버 읽기 캐시 삭제 */
export function expireSession(queryClient?: QueryClient): void {
  useSessionStore.getState().clearSession()
  queryClient?.clear()
}
