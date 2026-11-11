import { createApiClient } from '@minmo/api-client'
import type { ApiClient } from '@minmo/api-client'

import { useSessionStore } from '../store/session'

export const DEFAULT_PORT = 8787
export const DEFAULT_SERVER = `http://127.0.0.1:${DEFAULT_PORT}`

/** API 주소: VITE_MINMO_SERVER(개발·E2E 의 외부 서버)가 있으면 그것, 없으면 내장 서버 포트 */
export function serverBaseUrl(port: number = DEFAULT_PORT): string {
  return import.meta.env.VITE_MINMO_SERVER || `http://127.0.0.1:${port}`
}

/** 주소의 포트(원격 CLI SSH 설정 안내용) */
export function portOf(baseUrl: string | null): number {
  if (!baseUrl) return DEFAULT_PORT
  try {
    const u = new URL(baseUrl)
    return Number(u.port) || (u.protocol === 'https:' ? 443 : 80)
  } catch {
    return DEFAULT_PORT
  }
}

/** 서버 주소 + session store 토큰으로 api-client 생성 */
export function createAppApi(baseUrl: string = serverBaseUrl()): ApiClient {
  return createApiClient({
    baseUrl,
    getToken: () => useSessionStore.getState().token,
  })
}
