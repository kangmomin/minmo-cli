// F-01 로그인: E1 → opener → pendingLogin{state} → 딥링크(state 대조) → E3+E4 → 확정 / 실패 E5
import type { Me } from '@minmo/api-client'

import type { AuthMessage } from '../../store/session'

export type AuthPhase = 'restoring' | 'anonymous' | 'pending' | 'authenticated'

export interface UseAuthResult {
  phase: AuthPhase
  me: Me | null
  error: AuthMessage | null
  notice: string | null
  startLogin(): Promise<void>
  cancelLogin(): void
  logout(): Promise<void>
}

export const PENDING_LOGIN_TTL_MS = 10 * 60 * 1000

const notImplemented = (): never => {
  throw new Error('not implemented')
}

// STUB (Phase 6.1 Red)
/** 딥링크 error 코드 → UI 문구 (UI State Contract "딥링크 error") */
export function deepLinkErrorMessage(_code: string): string {
  return notImplemented()
}

/** 소비 컴포넌트용: 세션 상태 + 액션 */
export function useAuth(): UseAuthResult {
  return notImplemented()
}

/** App 에 1회 마운트: 키체인 세션 복원(E3 검증) + onDeepLink 구독 */
export function useAuthController(): void {
  notImplemented()
}
