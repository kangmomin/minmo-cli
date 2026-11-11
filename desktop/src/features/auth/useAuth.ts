// F-01 로그인: E1 → opener → pendingLogin{state} → 딥링크(state 대조) → E3+E4 → 확정 / 실패 E5
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef } from 'react'

import { ApiError } from '@minmo/api-client'
import type { Me } from '@minmo/api-client'

import { useDeps } from '../../app/deps'
import type { AppDeps } from '../../app/deps'
import { handleApiError, isOfflineError, isUnauthorized } from '../../lib/apiErrors'
import { rememberGithubToken } from '../../lib/githubToken'
import { KEYCHAIN_KEYS } from '../../lib/tauri'
import { useNoteDraftStore } from '../../store/noteDrafts'
import { useSessionStore } from '../../store/session'
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

export const COLD_START_NOTICE = '앱이 꺼져 있었습니다 — 로그인을 다시 시도하세요'
export const KEYRING_FAILED_NOTICE = '세션이 저장되지 않음(재시작 시 재로그인) — OS 키체인에 접근할 수 없습니다'

/** 딥링크 error 코드 → UI 문구 (UI State Contract "딥링크 error") */
export function deepLinkErrorMessage(code: string): string {
  switch (code) {
    case 'access_denied':
      return 'GitHub 승인 취소됨'
    case 'invalid_state':
    case 'invalid_code':
      return '로그인 요청이 만료되었거나 올바르지 않습니다 — 다시 시도하세요'
    case 'github_unavailable':
      return 'GitHub 연결 실패 — 잠시 후 다시 시도하세요'
    default:
      return `로그인 실패(${code}) — 다시 시도`
  }
}

/** 딥링크 계약 `minmo://auth?…` — MINMO_DEEP_LINK 기본값 전제(env 로 바꾸면 여기도 함께 바꿔야 함) */
function isAuthDeepLink(url: URL): boolean {
  return (
    url.protocol === 'minmo:' &&
    url.host.toLowerCase() === 'auth' &&
    !url.username &&
    !url.password &&
    (url.pathname === '' || url.pathname === '/')
  )
}

/** E1 authorizeUrl 은 https 만 연다. loopback http(E2E githubmock)만 예외 */
function isAllowedAuthorizeUrl(raw: string): boolean {
  try {
    const u = new URL(raw)
    if (u.protocol === 'https:') return true
    return u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]')
  } catch {
    return false
  }
}

function apiMessage(err: unknown): AuthMessage {
  if (err instanceof ApiError) {
    if (err.code === 'github_oauth_not_configured') {
      return { code: err.code, message: 'GitHub OAuth App 이 설정되지 않았습니다 — 서버 설정에서 Client ID·Secret 을 입력하세요' }
    }
    if (isOfflineError(err)) return { code: err.code, message: `서버에 연결할 수 없습니다(${err.code}) — 서버 설정에서 상태를 확인하세요` }
    return { code: err.code, message: `로그인 실패(${err.code}) — 다시 시도` }
  }
  return { code: 'unknown', message: `로그인 실패 — ${err instanceof Error ? err.message : String(err)}` }
}

async function clearKeychain(tauri: AppDeps['tauri']) {
  rememberGithubToken(null)
  await Promise.all([
    tauri.keychainDelete(KEYCHAIN_KEYS.session).catch(() => undefined),
    tauri.keychainDelete(KEYCHAIN_KEYS.githubToken).catch(() => undefined),
  ])
}

/** 소비 컴포넌트용: 세션 상태 + 액션 */
export function useAuth(): UseAuthResult {
  const { api, tauri } = useDeps()
  const queryClient = useQueryClient()
  const restoring = useSessionStore((s) => s.restoring)
  const token = useSessionStore((s) => s.token)
  const pendingLogin = useSessionStore((s) => s.pendingLogin)
  const me = useSessionStore((s) => s.me)
  const error = useSessionStore((s) => s.authError)
  const notice = useSessionStore((s) => s.notice)

  const phase: AuthPhase = restoring ? 'restoring' : token ? 'authenticated' : pendingLogin ? 'pending' : 'anonymous'

  const startLogin = useCallback(async () => {
    const store = useSessionStore.getState()
    store.setAuthError(null)
    store.setNotice(null)
    let start
    try {
      start = await api.startLogin()
    } catch (e) {
      handleApiError(e)
      store.setAuthError(apiMessage(e))
      return
    }
    if (!isAllowedAuthorizeUrl(start.authorizeUrl)) {
      store.setAuthError({ code: 'invalid_authorize_url', message: '서버가 안전하지 않은 로그인 주소를 돌려주었습니다(https 아님)' })
      return
    }
    // 브라우저가 빠르게 돌아와도 대조할 수 있도록 먼저 pendingLogin 을 켠다
    store.setPendingLogin({ state: start.state, startedAt: Date.now() })
    try {
      await tauri.openUrl(start.authorizeUrl)
    } catch (e) {
      store.setPendingLogin(null)
      store.setAuthError({ code: 'open_failed', message: `브라우저를 열 수 없습니다 — ${e instanceof Error ? e.message : String(e)}` })
    }
  }, [api, tauri])

  const cancelLogin = useCallback(() => {
    const store = useSessionStore.getState()
    store.setPendingLogin(null)
    store.setAuthError(null)
  }, [])

  const logout = useCallback(async () => {
    // E5 실패(401·네트워크)도 로컬 로그아웃은 진행한다
    await api.logout().catch(() => undefined)
    useSessionStore.getState().clearSession()
    await clearKeychain(tauri)
    queryClient.clear()
  }, [api, tauri, queryClient])

  return { phase, me, error, notice, startLogin, cancelLogin, logout }
}

/** App 에 1회 마운트: 키체인 세션 복원(E3 검증) + onDeepLink 구독 */
export function useAuthController(): void {
  const deps = useDeps()
  const queryClient = useQueryClient()
  const ref = useRef({ deps, queryClient })
  ref.current = { deps, queryClient }
  /** 이미 처리한 pendingLogin state — deep-link·single-instance 중복 전달을 조용히 무시 */
  const consumed = useRef(new Set<string>())
  const restored = useRef(false)

  // 1) 키체인 세션 복원
  useEffect(() => {
    if (restored.current) return
    restored.current = true
    const { api, tauri } = ref.current.deps
    const store = useSessionStore.getState()
    store.setRestoring(true)
    void (async () => {
      try {
        const stored = await tauri.keychainGet(KEYCHAIN_KEYS.session).catch(() => null)
        if (!stored) return
        try {
          const me = await api.me({ token: stored })
          useSessionStore.getState().setSession(stored, me)
          useNoteDraftStore.getState().discardOtherUsers(me.id)
        } catch (e) {
          if (isUnauthorized(e)) {
            await clearKeychain(tauri)
            handleApiError(e, { queryClient: ref.current.queryClient })
          } else if (isOfflineError(e)) {
            // 서버 미연결: 토큰은 유지하고 연결되면 /me 를 다시 확인한다(EC-17)
            useSessionStore.setState({ token: stored })
            handleApiError(e)
          } else {
            useSessionStore.getState().setAuthError(apiMessage(e))
          }
        }
      } finally {
        useSessionStore.getState().setRestoring(false)
      }
    })()
  }, [])

  // 2) 딥링크 구독
  useEffect(() => {
    let unlisten: (() => void) | null = null
    let disposed = false

    async function confirm(candidate: string) {
      const { api, tauri } = ref.current.deps
      let me: Me
      let accessToken: string
      try {
        // 로그인 확정은 E3·E4 모두 성공한 뒤 (CT-35)
        me = await api.me({ token: candidate })
        accessToken = (await api.getGithubToken({ token: candidate })).accessToken
      } catch (e) {
        await api.logout({ token: candidate }).catch(() => undefined)
        if (isOfflineError(e)) handleApiError(e)
        useSessionStore.getState().setAuthError(apiMessage(e))
        return
      }
      const store = useSessionStore.getState()
      store.setSession(candidate, me)
      rememberGithubToken(accessToken)
      useNoteDraftStore.getState().discardOtherUsers(me.id)
      try {
        await tauri.keychainSet(KEYCHAIN_KEYS.session, candidate)
        await tauri.keychainSet(KEYCHAIN_KEYS.githubToken, accessToken)
      } catch {
        // keyring 실패 → 이번 실행 메모리에만 보관
        useSessionStore.getState().setNotice(KEYRING_FAILED_NOTICE)
      }
    }

    function handle(raw: string) {
      let url: URL
      try {
        url = new URL(raw)
      } catch {
        return
      }
      // CT-39: minmo://auth (path 없음 또는 /) 만 — 다른 host/path 는 session/state 가 맞아도 무시
      if (!isAuthDeepLink(url)) return
      const params = url.searchParams
      const state = params.get('state')
      const session = params.get('session')
      const error = params.get('error')
      if (!session && !error) return

      const store = useSessionStore.getState()
      const pending = store.pendingLogin
      if (state && consumed.current.has(state)) return

      if (!pending) {
        // 콜드 스타트(앱이 꺼져 있던 동안 도착) — 처리하지 않고 안내만
        if (!store.token) store.setNotice(COLD_START_NOTICE)
        return
      }
      if (Date.now() - pending.startedAt > PENDING_LOGIN_TTL_MS) {
        store.setPendingLogin(null)
        store.setNotice('로그인 대기 시간이 지났습니다 — 다시 시도하세요')
        return
      }

      if (error) {
        if (state && state !== pending.state) return
        if (state) {
          consumed.current.add(state)
          store.setPendingLogin(null)
        }
        // state 없는 error 는 메시지만 표시(pendingLogin 유지)
        store.setAuthError({ code: error, message: deepLinkErrorMessage(error) })
        return
      }

      // session= 은 state 일치가 필수 (login-CSRF/세션 주입 방어)
      if (!session || !state || state !== pending.state) return
      consumed.current.add(state)
      store.setPendingLogin(null)
      void confirm(session)
    }

    void ref.current.deps.tauri
      .onDeepLink((urls) => {
        for (const u of urls) handle(u)
      })
      .then((un) => {
        if (disposed) un()
        else unlisten = un
      })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  // 3) 세션이 사라지면(401·로그아웃) 키체인도 비운다
  useEffect(
    () =>
      useSessionStore.subscribe((s, prev) => {
        if (prev.token && !s.token) void clearKeychain(ref.current.deps.tauri)
      }),
    [],
  )

  // 4) 오프라인 상태로 복원된 세션은 연결되면 /me 로 확인한다
  const status = useSessionStore((s) => s.status)
  const token = useSessionStore((s) => s.token)
  const me = useSessionStore((s) => s.me)
  useEffect(() => {
    if (status !== 'online' || !token || me) return
    const { api } = ref.current.deps
    void api
      .me({ token })
      .then((m) => {
        if (useSessionStore.getState().token === token) useSessionStore.getState().setSession(token, m)
      })
      .catch((e: unknown) => handleApiError(e, { queryClient: ref.current.queryClient }))
  }, [status, token, me])
}
