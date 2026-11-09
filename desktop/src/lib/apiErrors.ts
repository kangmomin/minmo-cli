import type { QueryClient } from '@tanstack/react-query'

// STUB (Phase 6.1 Red)
// 서버 API 오류 공통 처리 (UI State Contract):
// - 401 unauthorized → 세션 삭제(clearSession) + queryClient 가 있으면 서버 읽기 캐시 삭제
// - network_error / server_error / 모든 5xx(internal 포함) → status 'offline'
// - 그 외 4xx → 상태 변화 없음
export function handleApiError(_err: unknown, _opts?: { queryClient?: QueryClient }): void {
  throw new Error('not implemented')
}
