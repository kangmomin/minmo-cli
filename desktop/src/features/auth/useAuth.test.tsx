// F-01 로그인·딥링크 — 근거: CT-04, CT-26, CT-35, 딥링크 계약, UI State Contract(로그인 대기·딥링크 error·E1 503·keyring 실패)
import { act, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ApiClient, Me } from '@minmo/api-client'

import { KEYCHAIN_KEYS } from '../../lib/tauri'
import type { TauriApi } from '../../lib/tauri'
import { useSessionStore } from '../../store/session'
import { apiError, createFakeApi, createFakeTauri, flush } from '../../test/fakes'
import { makeDeps, makeQueryClient, renderHookWithDeps } from '../../test/render'
import { PENDING_LOGIN_TTL_MS, deepLinkErrorMessage, useAuth, useAuthController } from './useAuth'

const ME: Me = { id: 'usr_00000000-0000-0000-0000-000000000001', githubLogin: 'octocat', avatarUrl: null }
const AUTH_URL = 'https://github.com/login/oauth/authorize?client_id=x&state=s1'

function setup(apiOverrides: Partial<ApiClient> = {}, tauriOverrides: Partial<TauriApi> = {}, queryClient = makeQueryClient()) {
  const fake = createFakeTauri(tauriOverrides)
  const api = createFakeApi({
    startLogin: async () => ({ authorizeUrl: AUTH_URL, state: 's1' }),
    me: async () => ME,
    getGithubToken: async () => ({ accessToken: 'gho_x' }),
    logout: async () => undefined,
    ...apiOverrides,
  })
  const deps = makeDeps({ api, tauri: fake.tauri })
  const r = renderHookWithDeps(
    () => {
      useAuthController()
      return useAuth()
    },
    deps,
    queryClient,
  )
  return { ...r, api, tauri: fake.tauri, fake }
}

/** 앱이 E1 을 호출해 pendingLogin{state:'s1'} 이 켜진 상태로 만든다 */
async function startPending(t: ReturnType<typeof setup>) {
  await act(async () => {
    await t.result.current.startLogin()
  })
  await waitFor(() => expect(t.result.current.phase).toBe('pending'))
  await waitFor(() => expect(t.fake.deepLinkListenerCount()).toBeGreaterThan(0))
}

beforeEach(() => {
  useSessionStore.setState(useSessionStore.getInitialState(), true)
})
afterEach(() => {
  vi.useRealTimers()
})

describe('E1 로그인 시작 (UI State "로그인 대기")', () => {
  it('authorizeUrl 을 브라우저로 열고 pendingLogin{state} 를 켠다', async () => {
    const t = setup()
    await startPending(t)
    expect(t.api.startLogin).toHaveBeenCalledTimes(1)
    expect(t.tauri.openUrl).toHaveBeenCalledWith(AUTH_URL)
    expect(useSessionStore.getState().pendingLogin?.state).toBe('s1')
  })

  it('authorizeUrl 이 https 가 아니면(loopback http 제외) 열지 않는다', async () => {
    const t = setup({ startLogin: async () => ({ authorizeUrl: 'http://evil.example/login', state: 's1' }) })
    await act(async () => {
      await t.result.current.startLogin().catch(() => undefined)
    })
    expect(t.tauri.openUrl).not.toHaveBeenCalled()
    expect(useSessionStore.getState().pendingLogin).toBeNull()
    expect(t.result.current.error).not.toBeNull()
  })

  it('loopback http(E2E githubmock) 는 예외로 허용', async () => {
    const url = 'http://127.0.0.1:8790/login/oauth/authorize?state=s1'
    const t = setup({ startLogin: async () => ({ authorizeUrl: url, state: 's1' }) })
    await act(async () => {
      await t.result.current.startLogin()
    })
    expect(t.tauri.openUrl).toHaveBeenCalledWith(url)
  })

  it('E1 503 github_oauth_not_configured → 설정 안내 문구', async () => {
    const t = setup({
      startLogin: async () => {
        throw apiError(503, 'github_oauth_not_configured')
      },
    })
    await act(async () => {
      await t.result.current.startLogin().catch(() => undefined)
    })
    await waitFor(() => expect(t.result.current.error?.message).toContain('MINMO_GITHUB_CLIENT_ID'))
    expect(t.tauri.openUrl).not.toHaveBeenCalled()
  })
})

describe('CT-35 딥링크 처리', () => {
  it('pendingLogin 중 state 일치 session= → E3·E4(후보 토큰) 후 확정, keychain 저장', async () => {
    const t = setup()
    await startPending(t)
    act(() => t.fake.emitDeepLink('minmo://auth?session=cand-token&state=s1'))
    await waitFor(() => expect(t.result.current.phase).toBe('authenticated'))
    expect(t.api.me).toHaveBeenCalledWith({ token: 'cand-token' })
    expect(t.api.getGithubToken).toHaveBeenCalledWith({ token: 'cand-token' })
    expect(t.result.current.me).toEqual(ME)
    expect(useSessionStore.getState().token).toBe('cand-token')
    expect(useSessionStore.getState().pendingLogin).toBeNull()
    expect(t.tauri.keychainSet).toHaveBeenCalledWith(KEYCHAIN_KEYS.session, 'cand-token')
    expect(t.tauri.keychainSet).toHaveBeenCalledWith(KEYCHAIN_KEYS.githubToken, 'gho_x')
  })

  it('pendingLogin 없이 수신(콜드 스타트) → 무시하고 "앱이 꺼져 있었습니다" 안내', async () => {
    const t = setup()
    await waitFor(() => expect(t.fake.deepLinkListenerCount()).toBeGreaterThan(0))
    act(() => t.fake.emitDeepLink('minmo://auth?session=cand-token&state=s1'))
    await flush()
    expect(t.api.me).not.toHaveBeenCalled()
    expect(useSessionStore.getState().token).toBeNull()
    expect(t.result.current.phase).toBe('anonymous')
    await waitFor(() => expect(t.result.current.notice).toContain('앱이 꺼져 있었습니다'))
  })

  it('state 불일치 session= → 무시 (login-CSRF 방어)', async () => {
    const t = setup()
    await startPending(t)
    act(() => t.fake.emitDeepLink('minmo://auth?session=evil-token&state=attacker'))
    await flush()
    expect(t.api.me).not.toHaveBeenCalled()
    expect(t.api.getGithubToken).not.toHaveBeenCalled()
    expect(useSessionStore.getState().token).toBeNull()
    expect(t.tauri.keychainSet).not.toHaveBeenCalled()
  })

  it('pendingLogin 만료(10분 TTL) 후 수신 → 무시', async () => {
    const t = setup()
    await waitFor(() => expect(t.fake.deepLinkListenerCount()).toBeGreaterThan(0))
    act(() => {
      useSessionStore.setState({ pendingLogin: { state: 's1', startedAt: Date.now() - PENDING_LOGIN_TTL_MS - 1000 } })
    })
    act(() => t.fake.emitDeepLink('minmo://auth?session=cand-token&state=s1'))
    await flush()
    expect(t.api.me).not.toHaveBeenCalled()
    expect(useSessionStore.getState().token).toBeNull()
  })

  it('중복 전달(deep-link + single-instance) → pendingLogin 즉시 소비, E3 1회', async () => {
    const t = setup()
    await startPending(t)
    act(() => {
      t.fake.emitDeepLink('minmo://auth?session=cand-token&state=s1')
      t.fake.emitDeepLink('minmo://auth?session=cand-token&state=s1')
    })
    await waitFor(() => expect(t.result.current.phase).toBe('authenticated'))
    await flush()
    expect(t.api.me).toHaveBeenCalledTimes(1)
  })

  it('E3 실패 → E5(후보 토큰)로 세션 폐기, 로그인 미확정', async () => {
    const t = setup({
      me: async () => {
        throw apiError(500, 'internal')
      },
    })
    await startPending(t)
    act(() => t.fake.emitDeepLink('minmo://auth?session=cand-token&state=s1'))
    await waitFor(() => expect(t.api.logout).toHaveBeenCalledWith({ token: 'cand-token' }))
    expect(useSessionStore.getState().token).toBeNull()
    expect(t.result.current.phase).not.toBe('authenticated')
    expect(t.tauri.keychainSet).not.toHaveBeenCalledWith(KEYCHAIN_KEYS.session, 'cand-token')
  })

  it('E4 실패 → E5 로 세션 폐기, 로그인 미확정', async () => {
    const t = setup({
      getGithubToken: async () => {
        throw apiError(401, 'unauthorized')
      },
    })
    await startPending(t)
    act(() => t.fake.emitDeepLink('minmo://auth?session=cand-token&state=s1'))
    await waitFor(() => expect(t.api.logout).toHaveBeenCalledWith({ token: 'cand-token' }))
    expect(useSessionStore.getState().token).toBeNull()
  })

  it('keyring 저장 실패 → 이번 실행 메모리에만 세션 보관 + "세션이 저장되지 않음" 배너', async () => {
    const t = setup(
      {},
      {
        keychainSet: async () => {
          throw new Error('keyring unavailable')
        },
      },
    )
    await startPending(t)
    act(() => t.fake.emitDeepLink('minmo://auth?session=cand-token&state=s1'))
    await waitFor(() => expect(t.result.current.phase).toBe('authenticated'))
    expect(useSessionStore.getState().token).toBe('cand-token')
    await waitFor(() => expect(t.result.current.notice).toContain('세션이 저장되지 않음'))
  })
})

describe('CT-26 딥링크 error=', () => {
  it('pendingLogin 중 state 일치 error=access_denied → "승인 취소됨", API 호출 없음', async () => {
    const t = setup()
    await startPending(t)
    act(() => t.fake.emitDeepLink('minmo://auth?error=access_denied&state=s1'))
    await waitFor(() => expect(t.result.current.error?.code).toBe('access_denied'))
    expect(t.result.current.error?.message).toContain('승인 취소됨')
    expect(t.api.me).not.toHaveBeenCalled()
    expect(t.result.current.phase).not.toBe('authenticated')
  })

  it('pendingLogin 중 state 없는 error= → 메시지만 표시', async () => {
    const t = setup()
    await startPending(t)
    act(() => t.fake.emitDeepLink('minmo://auth?error=invalid_state'))
    await waitFor(() => expect(t.result.current.error?.code).toBe('invalid_state'))
    expect(t.api.me).not.toHaveBeenCalled()
  })

  it.each([
    ['access_denied', '승인 취소됨'],
    ['invalid_state', '다시 시도'],
    ['invalid_code', '다시 시도'],
    ['github_unavailable', 'GitHub 연결 실패'],
    ['missing_code', '로그인 실패(missing_code)'],
    ['internal', '로그인 실패(internal)'],
    ['something_else', '로그인 실패(something_else)'],
  ])('deepLinkErrorMessage(%s) ⊃ "%s"', (code, text) => {
    expect(deepLinkErrorMessage(code)).toContain(text)
  })
})

describe('CT-04 세션 없음/401 → 로그인 화면, 세션·서버 읽기 캐시 삭제', () => {
  it('키체인 세션 복원 시 /me 401 → 세션 삭제·키체인 삭제·쿼리 캐시 삭제', async () => {
    const qc = makeQueryClient()
    qc.setQueryData(['settings', 'global'], { cached: true })
    const fake = createFakeTauri()
    fake.keychain.set(KEYCHAIN_KEYS.session, 'stored-token')
    const api = createFakeApi({
      me: async () => {
        throw apiError(401, 'unauthorized')
      },
      logout: async () => undefined,
    })
    const r = renderHookWithDeps(
      () => {
        useAuthController()
        return useAuth()
      },
      makeDeps({ api, tauri: fake.tauri }),
      qc,
    )
    await waitFor(() => expect(api.me).toHaveBeenCalled())
    await waitFor(() => expect(r.result.current.phase).toBe('anonymous'))
    expect(useSessionStore.getState().token).toBeNull()
    expect(fake.tauri.keychainDelete).toHaveBeenCalledWith(KEYCHAIN_KEYS.session)
    expect(qc.getQueryData(['settings', 'global'])).toBeUndefined()
  })

  it('키체인 세션 복원 성공 → authenticated', async () => {
    const fake = createFakeTauri()
    fake.keychain.set(KEYCHAIN_KEYS.session, 'stored-token')
    const api = createFakeApi({ me: async () => ME, getGithubToken: async () => ({ accessToken: 'gho_x' }) })
    const r = renderHookWithDeps(
      () => {
        useAuthController()
        return useAuth()
      },
      makeDeps({ api, tauri: fake.tauri }),
    )
    await waitFor(() => expect(r.result.current.phase).toBe('authenticated'))
    expect(useSessionStore.getState().token).toBe('stored-token')
    expect(r.result.current.me).toEqual(ME)
  })

  it('로그아웃: E5 가 401 이어도 성공으로 취급 → 세션·키체인·캐시 삭제', async () => {
    const qc = makeQueryClient()
    const t = setup(
      {
        logout: async () => {
          throw apiError(401, 'unauthorized')
        },
      },
      {},
      qc,
    )
    act(() => {
      useSessionStore.setState({ token: 'tok', me: ME })
    })
    qc.setQueryData(['notes', 'o', 'r', '1'], { body: 'x', updatedAt: null })
    await act(async () => {
      await t.result.current.logout()
    })
    expect(useSessionStore.getState().token).toBeNull()
    expect(t.tauri.keychainDelete).toHaveBeenCalledWith(KEYCHAIN_KEYS.session)
    expect(qc.getQueryData(['notes', 'o', 'r', '1'])).toBeUndefined()
    expect(t.result.current.phase).toBe('anonymous')
  })
})

describe('CT-38(v2.5) E1 503 github_oauth_not_configured 는 offline 아님', () => {
  it('전용 문구만 표시, status online 유지(배너 없음)', async () => {
    useSessionStore.setState({ status: 'online' })
    const t = setup({
      startLogin: async () => {
        throw apiError(503, 'github_oauth_not_configured')
      },
    })
    await act(async () => {
      await t.result.current.startLogin().catch(() => undefined)
    })
    await waitFor(() => expect(t.result.current.error?.message).toBe('서버에 GitHub OAuth가 설정되지 않았습니다(MINMO_GITHUB_CLIENT_ID)'))
    expect(useSessionStore.getState().status).toBe('online')
  })

  it('E1 의 다른 503(server_error) 은 offline', async () => {
    useSessionStore.setState({ status: 'online' })
    const t = setup({
      startLogin: async () => {
        throw apiError(503, 'server_error')
      },
    })
    await act(async () => {
      await t.result.current.startLogin().catch(() => undefined)
    })
    await waitFor(() => expect(useSessionStore.getState().status).toBe('offline'))
  })

  it('E1 미지 4xx(http_error) → online 유지 + 로그인 실패 문구', async () => {
    useSessionStore.setState({ status: 'online' })
    const t = setup({
      startLogin: async () => {
        throw apiError(429, 'http_error')
      },
    })
    await act(async () => {
      await t.result.current.startLogin().catch(() => undefined)
    })
    await waitFor(() => expect(t.result.current.error?.message).toContain('로그인 실패(http_error)'))
    expect(useSessionStore.getState().status).toBe('online')
  })
})

describe('CT-39(v2.5) 딥링크는 minmo://auth (path 없음 또는 /) 만 처리', () => {
  it.each([
    'minmo://evil?session=cand-token&state=s1',
    'minmo://auth/x?session=cand-token&state=s1',
    'minmo://AUTHX?session=cand-token&state=s1',
    'other://auth?session=cand-token&state=s1',
  ])('%s → 무시(state 가 맞아도), pendingLogin 유지', async (link) => {
    const t = setup()
    await startPending(t)
    act(() => t.fake.emitDeepLink(link))
    await flush()
    expect(t.api.me).not.toHaveBeenCalled()
    expect(useSessionStore.getState().token).toBeNull()
    expect(useSessionStore.getState().pendingLogin?.state).toBe('s1')
  })

  it('다른 host 의 error= 도 무시', async () => {
    const t = setup()
    await startPending(t)
    act(() => t.fake.emitDeepLink('minmo://evil?error=access_denied&state=s1'))
    await flush()
    expect(t.result.current.error).toBeNull()
    expect(useSessionStore.getState().pendingLogin?.state).toBe('s1')
  })

  it('minmo://auth/?session=… (path "/") 는 처리', async () => {
    const t = setup()
    await startPending(t)
    act(() => t.fake.emitDeepLink('minmo://auth/?session=cand-token&state=s1'))
    await waitFor(() => expect(t.result.current.phase).toBe('authenticated'))
    expect(t.api.me).toHaveBeenCalledWith({ token: 'cand-token' })
  })
})
