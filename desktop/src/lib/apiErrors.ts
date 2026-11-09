import type { QueryClient } from '@tanstack/react-query'

import { ApiError } from '@minmo/api-client'

import { useSessionStore } from '../store/session'

/** network_error / server_error / 모든 5xx(internal 포함) — UI State "서버 미연결" */
export function isOfflineError(err: unknown): boolean {
  return err instanceof ApiError && (err.code === 'network_error' || err.code === 'server_error' || err.status >= 500)
}

export function isUnauthorized(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 401 || err.code === 'unauthorized')
}

// 서버 API 오류 공통 처리 (UI State Contract):
// - 401 unauthorized → 세션 삭제(clearSession) + queryClient 가 있으면 서버 읽기 캐시 삭제
// - network_error / server_error / 모든 5xx(internal 포함) → status 'offline'
// - 그 외 4xx → 상태 변화 없음
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

/** TanStack Query retry 정책: 4xx 0회, 네트워크(network_error) 1회 */
export function shouldRetry(failureCount: number, err: unknown): boolean {
  if (err instanceof ApiError) return err.code === 'network_error' && failureCount < 1
  return failureCount < 1
}
