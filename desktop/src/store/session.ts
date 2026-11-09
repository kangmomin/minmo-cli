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

// 세션 토큰은 메모리에만 둔다(영속은 OS 키체인 — useAuth 담당). persist 미들웨어를 쓰지 않는다.
export const useSessionStore = create<SessionState>()((set) => ({
  token: null,
  me: null,
  status: 'online',
  pendingLogin: null,
  restoring: false,
  authError: null,
  notice: null,
  setSession: (token, me) => set({ token, me, authError: null, pendingLogin: null }),
  // 연결 상태(status)는 세션과 무관하므로 유지한다
  clearSession: () => set({ token: null, me: null }),
  setPendingLogin: (pendingLogin) => set({ pendingLogin }),
  setStatus: (status) => set({ status }),
  setRestoring: (restoring) => set({ restoring }),
  setAuthError: (authError) => set({ authError }),
  setNotice: (notice) => set({ notice }),
}))
