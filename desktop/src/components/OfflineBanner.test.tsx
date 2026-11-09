// 서버 연결 상태 (공통) — 근거: CT-33, EC-17, UI State Contract "서버 미연결"
// (network_error·모든 5xx 1회 → offline, healthz 10초 폴링, [다시 연결], healthz 200 → 즉시 해제)
//
// 접근성 계약(6.2 구현이 유지): 배너 data-testid="offline-banner", 버튼 "다시 연결".
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Health } from '@minmo/api-client'

import { handleApiError } from '../lib/apiErrors'
import { useSessionStore } from '../store/session'
import { apiError, createFakeApi } from '../test/fakes'
import { makeDeps, renderWithDeps } from '../test/render'
import { HEALTHZ_POLL_MS, OfflineBanner } from './OfflineBanner'

const networkDown = async (): Promise<Health> => {
  throw apiError(0, 'network_error')
}

function setup(healthz: () => Promise<Health>) {
  const api = createFakeApi({ healthz })
  renderWithDeps(<OfflineBanner />, makeDeps({ api }))
  return { api }
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  useSessionStore.setState(useSessionStore.getInitialState(), true)
  useSessionStore.setState({ token: 'tok', status: 'online' })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('CT-33 handleApiError → 연결 상태', () => {
  it.each([
    ['network_error', apiError(0, 'network_error')],
    ['server_error(5xx 비JSON)', apiError(502, 'server_error')],
    ['internal(500)', apiError(500, 'internal')],
    ['github_unavailable(502)', apiError(502, 'github_unavailable')],
  ])('%s 1회 → offline', (_l, err) => {
    handleApiError(err)
    expect(useSessionStore.getState().status).toBe('offline')
  })

  it('4xx(400 invalid_template) 는 연결 상태를 바꾸지 않는다', () => {
    handleApiError(apiError(400, 'invalid_template', { field: 'branchTemplate' }))
    expect(useSessionStore.getState().status).toBe('online')
  })

  it('401 → 세션 삭제(로그인 화면)', () => {
    useSessionStore.setState({ me: { id: 'usr_x', githubLogin: 'o', avatarUrl: null } })
    handleApiError(apiError(401, 'unauthorized'))
    expect(useSessionStore.getState().token).toBeNull()
    expect(useSessionStore.getState().me).toBeNull()
    expect(useSessionStore.getState().status).toBe('online')
  })
})

describe('CT-33 OfflineBanner', () => {
  it('online 이면 배너 없음, healthz 폴링도 하지 않음', async () => {
    const { api } = setup(async () => ({ status: 'ok' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HEALTHZ_POLL_MS * 2)
    })
    expect(screen.queryByTestId('offline-banner')).toBeNull()
    expect(api.healthz).not.toHaveBeenCalled()
  })

  it('fetch 실패(network_error) → 배너 + [다시 연결]', async () => {
    setup(networkDown)
    act(() => handleApiError(apiError(0, 'network_error')))
    expect(await screen.findByTestId('offline-banner')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '다시 연결' })).toBeInTheDocument()
  })

  it('offline 중 healthz 를 10초 간격으로 폴링, 200 이면 즉시 해제', async () => {
    let up = false
    const { api } = setup(async () => {
      if (!up) throw apiError(0, 'network_error')
      return { status: 'ok' }
    })
    act(() => useSessionStore.setState({ status: 'offline' }))
    await screen.findByTestId('offline-banner')
    const before = api.healthz.mock.calls.length

    await act(async () => {
      await vi.advanceTimersByTimeAsync(HEALTHZ_POLL_MS)
    })
    await waitFor(() => expect(api.healthz.mock.calls.length).toBeGreaterThan(before))
    expect(screen.getByTestId('offline-banner')).toBeInTheDocument()

    up = true
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HEALTHZ_POLL_MS)
    })
    await waitFor(() => expect(screen.queryByTestId('offline-banner')).toBeNull())
    expect(useSessionStore.getState().status).toBe('online')
  })

  it('폴링 간격은 10초 — 10초 전에는 추가 healthz 없음', async () => {
    const { api } = setup(networkDown)
    act(() => useSessionStore.setState({ status: 'offline' }))
    await screen.findByTestId('offline-banner')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    const base = api.healthz.mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HEALTHZ_POLL_MS - 1000)
    })
    expect(api.healthz.mock.calls.length).toBe(base)
    expect(HEALTHZ_POLL_MS).toBe(10_000)
  })

  it('[다시 연결] → 즉시 healthz, 성공하면 배너 해제', async () => {
    let up = false
    const { api } = setup(async () => {
      if (!up) throw apiError(0, 'network_error')
      return { status: 'ok' }
    })
    act(() => useSessionStore.setState({ status: 'offline' }))
    await screen.findByTestId('offline-banner')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    up = true
    const before = api.healthz.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: '다시 연결' }))
    await waitFor(() => expect(api.healthz.mock.calls.length).toBeGreaterThan(before))
    await waitFor(() => expect(screen.queryByTestId('offline-banner')).toBeNull())
    expect(useSessionStore.getState().status).toBe('online')
  })
})
