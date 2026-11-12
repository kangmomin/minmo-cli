// F-01 로그인(GitHub 기기 코드 방식): E1 로 코드를 받아 보여 주고 브라우저를 연다 → 사용자가 승인할 때까지 E2 를 주기적으로 확인
// → 세션을 받으면 E3+E4 로 확정 / 실패하면 E5 로 그 세션을 지운다
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
  /** 진행 중인 로그인의 승인 페이지를 브라우저로 다시 연다 */
  openVerification(): Promise<void>
  logout(): Promise<void>
}

export const KEYRING_FAILED_NOTICE = '세션이 저장되지 않음(재시작 시 재로그인) — OS 키체인에 접근할 수 없습니다'
export const LOGIN_EXPIRED_MESSAGE = '코드가 만료되었습니다 — 다시 로그인하세요'
export const LOGIN_DENIED_MESSAGE = 'GitHub 에서 승인을 거부했습니다'

/** 승인 페이지는 github.com 의 기기 코드 주소만 연다. loopback http(E2E githubmock)만 예외 */
export function isAllowedVerificationUri(raw: string): boolean {
  try {
    const u = new URL(raw)
    if (u.protocol === 'https:') return u.hostname === 'github.com' && u.pathname === '/login/device'
    return u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]')
  } catch {
    return false
  }
}

function apiMessage(err: unknown): AuthMessage {
  if (err instanceof ApiError) {
    if (err.code === 'github_oauth_not_configured') {
      return { code: err.code, message: '이 앱에는 GitHub 로그인 설정(Client ID)이 들어 있지 않습니다 — 최신 버전으로 업데이트하세요' }
    }
    if (err.code === 'github_unavailable') return { code: err.code, message: 'GitHub 에 연결하지 못했습니다 — 잠시 후 다시 시도하세요' }
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

  const openVerification = useCallback(async () => {
    const store = useSessionStore.getState()
    const pending = store.pendingLogin
    if (!pending) return
    try {
      await tauri.openUrl(pending.verificationUri)
    } catch (e) {
      // 코드는 유효하다 — 직접 주소를 열어 입력할 수 있게 로그인은 계속 기다린다
      store.setAuthError({ code: 'open_failed', message: `브라우저를 열 수 없습니다(${e instanceof Error ? e.message : String(e)}) — ${pending.verificationUri} 를 직접 여세요` })
    }
  }, [tauri])

  const startLogin = useCallback(async () => {
    const store = useSessionStore.getState()
    store.setAuthError(null)
    store.setNotice(null)
    let start
    try {
      start = await api.startDeviceLogin()
    } catch (e) {
      handleApiError(e)
      store.setPendingLogin(null)
      store.setAuthError(apiMessage(e))
      return
    }
    if (!isAllowedVerificationUri(start.verificationUri)) {
      store.setPendingLogin(null)
      store.setAuthError({ code: 'invalid_verification_uri', message: '서버가 GitHub 가 아닌 승인 주소를 돌려주었습니다' })
      return
    }
    const now = Date.now()
    store.setPendingLogin({
      deviceId: start.deviceId,
      userCode: start.userCode,
      verificationUri: start.verificationUri,
      interval: start.interval,
      startedAt: now,
      expiresAt: now + start.expiresIn * 1000,
    })
    await openVerification()
  }, [api, openVerification])

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

  return { phase, me, error, notice, startLogin, cancelLogin, openVerification, logout }
}

/** App 에 1회 마운트: 키체인 세션 복원(E3 검증) + 진행 중인 기기 코드 로그인의 승인 확인 */
export function useAuthController(): void {
  const deps = useDeps()
  const queryClient = useQueryClient()
  const ref = useRef({ deps, queryClient })
  ref.current = { deps, queryClient }
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

  // 2) 기기 코드 로그인: 서버가 알려 준 간격으로 승인 여부를 확인한다
  const deviceId = useSessionStore((s) => s.pendingLogin?.deviceId ?? null)
  useEffect(() => {
    if (deviceId === null) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    /** 이 로그인이 아직 진행 중인가(취소·다른 로그인 시작이면 false) */
    const current = () => {
      const p = useSessionStore.getState().pendingLogin
      return !stopped && p !== null && p.deviceId === deviceId ? p : null
    }
    const fail = (message: AuthMessage) => {
      const store = useSessionStore.getState()
      store.setPendingLogin(null)
      store.setAuthError(message)
    }

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

    const schedule = (seconds: number) => {
      timer = setTimeout(() => void tick(), Math.max(1, seconds) * 1000)
    }

    async function tick() {
      const pending = current()
      if (!pending) return
      if (Date.now() >= pending.expiresAt) {
        fail({ code: 'device_code_expired', message: LOGIN_EXPIRED_MESSAGE })
        return
      }
      const { api } = ref.current.deps
      try {
        const res = await api.pollDeviceLogin(deviceId!)
        if (res.status === 'ok') {
          if (!current()) {
            // 그 사이 취소했다 — 만들어진 세션은 쓰지 않으므로 지운다
            await api.logout({ token: res.session }).catch(() => undefined)
            return
          }
          useSessionStore.getState().setPendingLogin(null)
          await confirm(res.session)
          return
        }
        if (current()) schedule(res.interval)
      } catch (e) {
        if (!current()) return
        if (e instanceof ApiError && e.code === 'access_denied') return fail({ code: e.code, message: LOGIN_DENIED_MESSAGE })
        if (e instanceof ApiError && e.code === 'device_code_expired') return fail({ code: e.code, message: LOGIN_EXPIRED_MESSAGE })
        // 서버·GitHub 의 일시 오류는 코드가 살아 있는 동안 계속 확인한다
        if (isOfflineError(e)) handleApiError(e)
        schedule(pending.interval)
      }
    }

    schedule(useSessionStore.getState().pendingLogin?.interval ?? 5)
    return () => {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [deviceId])

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
