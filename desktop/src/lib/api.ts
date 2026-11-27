import { createApiClient } from '@minmo/api-client'
import type { ApiClient } from '@minmo/api-client'

import { useServerStore } from '../store/server'
import { useSessionStore } from '../store/session'
import { runtimeKind } from './tauri'

export const DEFAULT_PORT = 8787
export const DEFAULT_SERVER = `http://127.0.0.1:${DEFAULT_PORT}`

/** API 주소: VITE_MINMO_SERVER(개발·E2E 의 외부 서버) → 앱이 알려 준 주소(배포 빌드) → 내장 서버 포트 */
export function serverBaseUrl(port: number = DEFAULT_PORT, url?: string | null): string {
  // 원격 화면: 호스트가 /api 로 받은 요청을 자기 서버에 대신 보낸다
  if (runtimeKind() === 'remote') return `${window.location.origin}/api`
  return import.meta.env.VITE_MINMO_SERVER || url || `http://127.0.0.1:${port}`
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
    // 원격 화면은 호스트 PC 가 /api 에서 자기 식별자를 붙인다(store 의 값은 null)
    getPcId: () => useServerStore.getState().pcId,
  })
}
