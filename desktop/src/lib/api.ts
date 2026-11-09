import type { ApiClient } from '@minmo/api-client'

export const DEFAULT_SERVER = 'http://127.0.0.1:8787'

// STUB (Phase 6.1 Red): VITE_MINMO_SERVER(기본 DEFAULT_SERVER) + session store 토큰으로 api-client 생성
export function createAppApi(): ApiClient {
  throw new Error('not implemented')
}
