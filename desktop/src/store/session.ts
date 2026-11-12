import { create } from 'zustand'

import type { Me } from '@minmo/api-client'

export type ConnectionStatus = 'online' | 'offline'
/** 진행 중인 기기 코드 로그인 — 사용자가 verificationUri 에서 userCode 를 입력해 승인한다 */
export type PendingLogin = { deviceId: string; userCode: string; verificationUri: string; /** 확인 간격(초) */ interval: number; startedAt: number; /** 코드 만료 시각(ms) */ expiresAt: number }
export type AuthMessage = { code: string; message: string }

export interface SessionState {
  token: string | null
  me: Me | null
  /** 서버 연결 상태 (OfflineBanner·mutation 비활성 판단) */
  status: ConnectionStatus
  /** E1 호출로 켠 로그인 대기(코드 만료까지, 메모리) */
  pendingLogin: PendingLogin | null
  /** 로그인 시작 요청 중이거나 승인 뒤 확정(E3·E4)하는 중 — 그동안 로그인 버튼을 막는다 */
  loginBusy: boolean
  /** 키체인 복원 진행 중 */
  restoring: boolean
  /** 로그인 화면 오류(승인 거부·코드 만료·E1 실패 등) */
  authError: AuthMessage | null
  /** 안내 배너(keyring 저장 실패 등) */
  notice: string | null

  setSession(token: string, me: Me): void
  clearSession(): void
  setPendingLogin(p: PendingLogin | null): void
  setLoginBusy(v: boolean): void
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
  loginBusy: false,
  restoring: false,
  authError: null,
  notice: null,
  setSession: (token, me) => set({ token, me, authError: null, pendingLogin: null }),
  // 연결 상태(status)는 세션과 무관하므로 유지한다
  clearSession: () => set({ token: null, me: null }),
  setPendingLogin: (pendingLogin) => set({ pendingLogin }),
  setLoginBusy: (loginBusy) => set({ loginBusy }),
  setStatus: (status) => set({ status }),
  setRestoring: (restoring) => set({ restoring }),
  setAuthError: (authError) => set({ authError }),
  setNotice: (notice) => set({ notice }),
}))
