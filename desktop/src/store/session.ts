import { create } from 'zustand'

import type { Me } from '@minmo/api-client'

export type ConnectionStatus = 'online' | 'offline'
export type PendingLogin = { state: string; startedAt: number }
export type AuthMessage = { code: string; message: string }

export interface SessionState {
  token: string | null
  me: Me | null
  /** 서버 연결 상태 (OfflineBanner·mutation 비활성 판단) */
  status: ConnectionStatus
  /** E1 호출로 켠 로그인 대기(10분 TTL, 메모리) */
  pendingLogin: PendingLogin | null
  /** 키체인 복원 진행 중 */
  restoring: boolean
  /** 로그인 화면 오류(딥링크 error·E1 503 등) */
  authError: AuthMessage | null
  /** 안내 배너(콜드 스타트·keyring 저장 실패 등) */
  notice: string | null

  setSession(token: string, me: Me): void
  clearSession(): void
  setPendingLogin(p: PendingLogin | null): void
  setStatus(s: ConnectionStatus): void
  setRestoring(v: boolean): void
  setAuthError(e: AuthMessage | null): void
  setNotice(n: string | null): void
}

// STUB (Phase 6.1 Red): 상태 모양만 고정, 액션은 no-op — 6.2 에서 구현
export const useSessionStore = create<SessionState>()(() => ({
  token: null,
  me: null,
  status: 'online',
  pendingLogin: null,
  restoring: false,
  authError: null,
  notice: null,
  setSession: () => {},
  clearSession: () => {},
  setPendingLogin: () => {},
  setStatus: () => {},
  setRestoring: () => {},
  setAuthError: () => {},
  setNotice: () => {},
}))
