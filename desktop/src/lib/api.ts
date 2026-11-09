import { createApiClient } from '@minmo/api-client'
import type { ApiClient } from '@minmo/api-client'

import { useSessionStore } from '../store/session'

export const DEFAULT_SERVER = 'http://127.0.0.1:8787'

export function serverBaseUrl(): string {
  return import.meta.env.VITE_MINMO_SERVER || DEFAULT_SERVER
}

/** VITE_MINMO_SERVER(기본 DEFAULT_SERVER) + session store 토큰으로 api-client 생성 */
export function createAppApi(): ApiClient {
  return createApiClient({
    baseUrl: serverBaseUrl(),
    getToken: () => useSessionStore.getState().token,
  })
}
