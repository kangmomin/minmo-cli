// F-01 로그인(GitHub 기기 코드) — 코드 표시·브라우저 열기·승인 확인 주기·확정(E3·E4)·거부/만료/취소·세션 복원
import { act, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ApiClient, DeviceLoginPoll, Me } from '@minmo/api-client'

import { KEYCHAIN_KEYS } from '../../lib/tauri'
import type { TauriApi } from '../../lib/tauri'
import { useSessionStore } from '../../store/session'
import { apiError, createFakeApi, createFakeTauri } from '../../test/fakes'
import { makeDeps, makeQueryClient, renderHookWithDeps } from '../../test/render'
import { LOGIN_DENIED_MESSAGE, LOGIN_EXPIRED_MESSAGE, isAllowedVerificationUri, useAuth, useAuthController } from './useAuth'

const ME: Me = { id: 'usr_00000000-0000-0000-0000-000000000001', githubLogin: 'octocat', avatarUrl: null }
const VERIFY_URL = 'https://github.com/login/device'
const START = { deviceId: 'dev-1', userCode: 'WDJB-MJHT', verificationUri: VERIFY_URL, expiresIn: 900, interval: 5 }

function setup(apiOverrides: Partial<ApiClient> = {}, tauriOverrides: Partial<TauriApi> = {}, queryClient = makeQueryClient()) {
  const fake = createFakeTauri(tauriOverrides)
  const api = createFakeApi({
    startDeviceLogin: async () => START,
    pollDeviceLogin: async () => ({ status: 'pending', interval: 5 }),
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

/** 가짜 시계를 ms 만큼 돌리고 그 사이의 비동기 처리를 끝낸다 */
const tick = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms))

/** [GitHub 로 로그인] 을 누른 상태(코드를 받아 승인을 기다리는 중)로 만든다 */
async function startPending(t: ReturnType<typeof setup>) {
  await act(async () => {
    await t.result.current.startLogin()
  })
  expect(t.result.current.phase).toBe('pending')
}

/** 차례로 돌려줄 확인 응답 */
function polls(...results: (DeviceLoginPoll | Error)[]) {
  let n = 0
  return async () => {
    const r = results[Math.min(n++, results.length - 1)]
    if (r instanceof Error) throw r
    return r
  }
}

beforeEach(() => {
  useSessionStore.setState(useSessionStore.getInitialState(), true)
})
afterEach(() => {
  vi.useRealTimers()
})

describe('로그인 시작', () => {
  it('코드·승인 주소를 받아 대기 상태가 되고 GitHub 의 기기 코드 페이지를 브라우저로 연다', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-12T00:00:00Z'))
    const t = setup()
    await startPending(t)
    expect(t.tauri.openUrl).toHaveBeenCalledWith(VERIFY_URL)
    expect(useSessionStore.getState().pendingLogin).toEqual({
      deviceId: 'dev-1',
      userCode: 'WDJB-MJHT',
      verificationUri: VERIFY_URL,
      interval: 5,
      startedAt: Date.parse('2026-11-12T00:00:00Z'),
      expiresAt: Date.parse('2026-11-12T00:15:00Z'),
    })
  })

  it('승인 주소는 github.com 의 기기 코드 페이지만(loopback http 는 E2E 용 예외)', async () => {
    expect(isAllowedVerificationUri('https://github.com/login/device')).toBe(true)
    expect(isAllowedVerificationUri('http://127.0.0.1:8790/login/device')).toBe(true)
    for (const bad of ['https://evil.example/login/device', 'https://github.com.evil.example/login/device', 'https://github.com/other', 'http://github.com/login/device', 'javascript:alert(1)', '']) {
      expect(isAllowedVerificationUri(bad), bad).toBe(false)
    }
    const t = setup({ startDeviceLogin: async () => ({ ...START, verificationUri: 'https://evil.example/login/device' }) })
    await act(async () => {
      await t.result.current.startLogin()
    })
    expect(t.tauri.openUrl).not.toHaveBeenCalled()
    expect(t.result.current.phase).toBe('anonymous')
    expect(t.result.current.error?.code).toBe('invalid_verification_uri')
  })

  it('브라우저를 열지 못해도 코드는 유효하다 — 대기를 유지하고 직접 열 주소를 알린다', async () => {
    const t = setup(
      {},
      {
        openUrl: async () => {
          throw new Error('no browser')
        },
      },
    )
    await startPending(t)
    expect(t.result.current.error?.message).toContain(VERIFY_URL)
  })
})

describe('승인 확인', () => {
  it('서버가 알려 준 간격으로 확인하고, 승인되면 E3·E4(받은 세션) 후 확정해 키체인에 저장한다', async () => {
    vi.useFakeTimers()
    const t = setup({ pollDeviceLogin: polls({ status: 'pending', interval: 5 }, { status: 'pending', interval: 10 }, { status: 'ok', session: 'cand-token' }) })
    await startPending(t)
    await tick(4999)
    expect(t.api.pollDeviceLogin).not.toHaveBeenCalled()
    await tick(1)
    expect(t.api.pollDeviceLogin).toHaveBeenCalledTimes(1)
    expect(t.api.pollDeviceLogin).toHaveBeenCalledWith('dev-1')
    await tick(5000)
    expect(t.api.pollDeviceLogin).toHaveBeenCalledTimes(2)
    // 간격이 10초로 늘었다(slow_down)
    await tick(9999)
    expect(t.api.pollDeviceLogin).toHaveBeenCalledTimes(2)
    await tick(1)
    expect(t.api.pollDeviceLogin).toHaveBeenCalledTimes(3)
    expect(t.api.me).toHaveBeenCalledWith({ token: 'cand-token' })
    expect(t.api.getGithubToken).toHaveBeenCalledWith({ token: 'cand-token' })
    expect(t.result.current.phase).toBe('authenticated')
    expect(t.result.current.me).toEqual(ME)
    expect(t.tauri.keychainSet).toHaveBeenCalledWith(KEYCHAIN_KEYS.session, 'cand-token')
    expect(t.tauri.keychainSet).toHaveBeenCalledWith(KEYCHAIN_KEYS.githubToken, 'gho_x')
    // 확정 뒤에는 더 확인하지 않는다
    await tick(60_000)
    expect(t.api.pollDeviceLogin).toHaveBeenCalledTimes(3)
  })

  it('거부하면 대기를 끝내고 안내한다 · 코드가 만료돼도 같다', async () => {
    vi.useFakeTimers()
    const denied = setup({ pollDeviceLogin: polls(apiError(400, 'access_denied')) })
    await startPending(denied)
    await tick(5000)
    expect(denied.result.current.phase).toBe('anonymous')
    expect(denied.result.current.error?.message).toBe(LOGIN_DENIED_MESSAGE)
    denied.unmount()

    useSessionStore.setState(useSessionStore.getInitialState(), true)
    const expired = setup({ pollDeviceLogin: polls(apiError(400, 'device_code_expired')) })
    await startPending(expired)
    await tick(5000)
    expect(expired.result.current.phase).toBe('anonymous')
    expect(expired.result.current.error?.message).toBe(LOGIN_EXPIRED_MESSAGE)
  })

  it('만료 시각(15분)이 지나면 서버에 묻지 않고 대기를 끝낸다', async () => {
    vi.useFakeTimers()
    const t = setup({ startDeviceLogin: async () => ({ ...START, expiresIn: 8 }) })
    await startPending(t)
    await tick(5000)
    expect(t.api.pollDeviceLogin).toHaveBeenCalledTimes(1)
    await tick(5000)
    expect(t.api.pollDeviceLogin).toHaveBeenCalledTimes(1)
    expect(t.result.current.phase).toBe('anonymous')
    expect(t.result.current.error?.message).toBe(LOGIN_EXPIRED_MESSAGE)
  })

  it('서버·GitHub 의 일시 오류는 대기를 유지하고 계속 확인한다', async () => {
    vi.useFakeTimers()
    const t = setup({ pollDeviceLogin: polls(apiError(502, 'github_unavailable'), apiError(0, 'network_error'), { status: 'ok', session: 'cand-token' }) })
    await startPending(t)
    await tick(5000)
    await tick(5000)
    expect(t.result.current.phase).toBe('pending')
    await tick(5000)
    expect(t.result.current.phase).toBe('authenticated')
  })

  it('취소하면 더 확인하지 않는다 · 확인 도중 취소했는데 승인이 돌아오면 그 세션을 지운다', async () => {
    vi.useFakeTimers()
    const t = setup()
    await startPending(t)
    act(() => t.result.current.cancelLogin())
    expect(t.result.current.phase).toBe('anonymous')
    await tick(60_000)
    expect(t.api.pollDeviceLogin).not.toHaveBeenCalled()
    t.unmount()

    useSessionStore.setState(useSessionStore.getInitialState(), true)
    let resolve!: (v: DeviceLoginPoll) => void
    const late = setup({ pollDeviceLogin: () => new Promise<DeviceLoginPoll>((r) => (resolve = r)) })
    await startPending(late)
    await tick(5000)
    act(() => late.result.current.cancelLogin())
    await act(async () => {
      resolve({ status: 'ok', session: 'late-token' })
      await Promise.resolve()
    })
    await tick(0)
    expect(late.api.logout).toHaveBeenCalledWith({ token: 'late-token' })
    expect(useSessionStore.getState().token).toBeNull()
    expect(late.api.me).not.toHaveBeenCalled()
  })

  it('[브라우저 다시 열기] 는 같은 승인 주소를 다시 연다', async () => {
    const t = setup()
    await startPending(t)
    await act(async () => {
      await t.result.current.openVerification()
    })
    expect(t.tauri.openUrl).toHaveBeenCalledTimes(2)
    expect(t.tauri.openUrl).toHaveBeenLastCalledWith(VERIFY_URL)
  })
})

describe('CT-35 로그인 확정', () => {
  const approved = () => polls({ status: 'ok', session: 'cand-token' })

  it('E3 실패 → E5(받은 세션)로 세션 폐기, 로그인 미확정', async () => {
    vi.useFakeTimers()
    const t = setup({
      pollDeviceLogin: approved(),
      me: async () => {
        throw apiError(500, 'internal')
      },
    })
    await startPending(t)
    await tick(5000)
    expect(t.api.logout).toHaveBeenCalledWith({ token: 'cand-token' })
    expect(useSessionStore.getState().token).toBeNull()
    expect(t.result.current.phase).not.toBe('authenticated')
    expect(t.tauri.keychainSet).not.toHaveBeenCalledWith(KEYCHAIN_KEYS.session, 'cand-token')
  })

  it('E4 실패 → E5 로 세션 폐기, 로그인 미확정', async () => {
    vi.useFakeTimers()
    const t = setup({
      pollDeviceLogin: approved(),
      getGithubToken: async () => {
        throw apiError(401, 'unauthorized')
      },
    })
    await startPending(t)
    await tick(5000)
    expect(t.api.logout).toHaveBeenCalledWith({ token: 'cand-token' })
    expect(useSessionStore.getState().token).toBeNull()
  })

  it('keyring 저장 실패 → 이번 실행 메모리에만 세션 보관 + "세션이 저장되지 않음" 배너', async () => {
    vi.useFakeTimers()
    const t = setup(
      { pollDeviceLogin: approved() },
      {
        keychainSet: async () => {
          throw new Error('keyring unavailable')
        },
      },
    )
    await startPending(t)
    await tick(5000)
    expect(t.result.current.phase).toBe('authenticated')
    expect(useSessionStore.getState().token).toBe('cand-token')
    expect(t.result.current.notice).toContain('세션이 저장되지 않음')
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
      startDeviceLogin: async () => {
        throw apiError(503, 'github_oauth_not_configured')
      },
    })
    await act(async () => {
      await t.result.current.startLogin().catch(() => undefined)
    })
    await waitFor(() => expect(t.result.current.error?.message).toBe('이 앱에는 GitHub 로그인 설정(Client ID)이 들어 있지 않습니다 — 최신 버전으로 업데이트하세요'))
    expect(useSessionStore.getState().status).toBe('online')
  })

  it('E1 의 다른 503(server_error) 은 offline', async () => {
    useSessionStore.setState({ status: 'online' })
    const t = setup({
      startDeviceLogin: async () => {
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
      startDeviceLogin: async () => {
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
