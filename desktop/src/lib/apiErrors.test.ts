// 계약 v2.5 UI State "서버 미연결" — offline 판정은 code 가 아닌 status 기준 (CT-33 개정 · CT-38)
import { beforeEach, describe, expect, it } from 'vitest'

import { useSessionStore } from '../store/session'
import { apiError } from '../test/fakes'
import { handleApiError, isOfflineError } from './apiErrors'

beforeEach(() => {
  useSessionStore.setState(useSessionStore.getInitialState(), true)
  useSessionStore.setState({ token: 'tok', status: 'online' })
})

describe('CT-33(v2.5) offline 판정은 status 기준', () => {
  it.each([
    ['network_error', apiError(0, 'network_error')],
    ['500 internal', apiError(500, 'internal')],
    ['502 server_error(비JSON)', apiError(502, 'server_error')],
    ['502 github_unavailable', apiError(502, 'github_unavailable')],
    ['503 server_error(E1 외 503)', apiError(503, 'server_error')],
  ])('%s → offline', (_l, err) => {
    expect(isOfflineError(err)).toBe(true)
    handleApiError(err)
    expect(useSessionStore.getState().status).toBe('offline')
  })

  it.each([
    ['400 http_error(미지 코드)', apiError(400, 'http_error')],
    ['429 http_error(프록시 비JSON)', apiError(429, 'http_error')],
    ['403 http_error', apiError(403, 'http_error')],
    // 4xx 는 code 와 무관하게 offline 아님 — 과거 fallback 이 4xx 에 server_error 를 붙이던 경로 방어
    ['418 server_error', apiError(418, 'server_error')],
    ['404 not_found', apiError(404, 'not_found')],
  ])('%s → online 유지', (_l, err) => {
    expect(isOfflineError(err)).toBe(false)
    handleApiError(err)
    expect(useSessionStore.getState().status).toBe('online')
  })

  it('CT-38: E1 503 github_oauth_not_configured → online 유지(서버는 응답 중)', () => {
    const err = apiError(503, 'github_oauth_not_configured')
    expect(isOfflineError(err)).toBe(false)
    handleApiError(err)
    expect(useSessionStore.getState().status).toBe('online')
  })

  it('github_oauth_not_configured 코드라도 503 이 아니면 예외가 아니다(500 → offline)', () => {
    expect(isOfflineError(apiError(500, 'github_oauth_not_configured'))).toBe(true)
  })
})
