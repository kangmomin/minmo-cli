import { ApiError } from '@minmo/api-client'

/**
 * UI State "서버 미연결"(계약 v2.5): offline 판정은 code 가 아닌 status 기준.
 * network_error 또는 status>=500(internal 포함). 4xx 는 코드와 무관하게 offline 아님.
 * 예외: 503 github_oauth_not_configured(E1) — 서버는 응답 중이므로 전용 문구만 표시한다(CT-38).
 */
export function isOfflineError(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false
  if (err.code === 'network_error') return true
  if (err.status === 503 && err.code === 'github_oauth_not_configured') return false
  return err.status >= 500
}

export function isUnauthorized(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 401 || err.code === 'unauthorized')
}

/** retry 정책: 4xx 0회, 네트워크(network_error) 1회 */
export function shouldRetry(failureCount: number, err: unknown): boolean {
  if (err instanceof ApiError) return err.code === 'network_error' && failureCount < 1
  return failureCount < 1
}
