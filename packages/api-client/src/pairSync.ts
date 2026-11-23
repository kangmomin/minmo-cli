// 설정 페어링 동기화 서버(server-sync/) 클라이언트. 메인 API 서버와 URL·토큰이 다르다.
import type { SyncDoc } from './types'

/** 페어 서버에 올리는 내용 — 서버는 해석하지 않는다. 실행되는 값(스크립트·경로·명령)은 담지 않는다 */
export type PairPayload = { doc: SyncDoc; repos: string[] }
export type PairState = { rev: number; payload: Partial<PairPayload>; updatedAt: number }
export type PairCreated = { pairId: string; pairCode: string; token: string; codeExpiresAt: number }

export class PairSyncError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    /** 409 일 때 서버의 현재 상태 */
    readonly state?: PairState,
  ) {
    super(`pair sync ${status} ${code}`)
  }
}

export interface PairSyncClient {
  create(): Promise<PairCreated>
  join(pairCode: string): Promise<{ pairId: string; token: string }>
  reissueCode(pairId: string, token: string): Promise<{ pairCode: string; codeExpiresAt: number }>
  get(pairId: string, token: string): Promise<PairState>
  /** baseRev 가 서버의 rev 와 다르면 PairSyncError(409, state) */
  put(pairId: string, token: string, baseRev: number, payload: PairPayload): Promise<PairState>
}

export function createPairSyncClient(baseUrl: string, fetchImpl: typeof fetch = (...a) => fetch(...a)): PairSyncClient {
  const base = baseUrl.replace(/\/+$/, '')
  async function call<T>(method: string, path: string, token?: string, body?: unknown): Promise<T> {
    const res = await fetchImpl(base + path, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) throw new PairSyncError(res.status, String(json.error ?? 'unknown'), res.status === 409 ? (json as unknown as PairState) : undefined)
    return json as T
  }
  return {
    create: () => call('POST', '/pairs'),
    join: (pairCode) => call('POST', '/pairs/join', undefined, { pairCode }),
    reissueCode: (id, token) => call('POST', `/pairs/${id}/code`, token),
    get: (id, token) => call('GET', `/pairs/${id}/state`, token),
    put: (id, token, baseRev, payload) => call('PUT', `/pairs/${id}/state`, token, { baseRev, payload }),
  }
}
