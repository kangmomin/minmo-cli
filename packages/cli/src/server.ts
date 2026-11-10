// minmo 서버 연결. 원격 호스트에서는 SSH 역터널이 만든 Unix 소켓(~/.minmo/server.sock)을 우선 쓴다 —
// TCP 포트는 그 호스트의 다른 사용자도 접근할 수 있고, 포트 충돌 시 토큰이 엉뚱한 곳으로 갈 수 있어서다.
import { existsSync } from 'node:fs'
import { request } from 'node:http'

import { createApiClient } from '@minmo/api-client'
import type { ApiClient } from '@minmo/api-client'

export type ServerTarget = { kind: 'socket'; path: string } | { kind: 'tcp'; url: string }

export const DEFAULT_SERVER = 'http://127.0.0.1:8787'

export function resolveServer(socketPath: string, env: NodeJS.ProcessEnv = process.env, exists = existsSync): ServerTarget {
  if (env.MINMO_SERVER) return { kind: 'tcp', url: env.MINMO_SERVER }
  if (exists(socketPath)) return { kind: 'socket', path: socketPath }
  return { kind: 'tcp', url: DEFAULT_SERVER }
}

export function describeServer(t: ServerTarget): string {
  return t.kind === 'socket' ? `소켓 ${t.path}` : t.url
}

/** Unix 소켓으로 보내는 fetch — api-client 가 쓰는 범위(method·headers·문자열 body)만 지원한다 */
export function socketFetch(socketPath: string): typeof fetch {
  return (input, init) =>
    new Promise<Response>((resolve, reject) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      const headers: Record<string, string> = {}
      new Headers(init?.headers).forEach((v, k) => (headers[k] = v))
      const body = typeof init?.body === 'string' ? init.body : undefined
      if (body !== undefined) headers['content-length'] = String(Buffer.byteLength(body))
      const req = request({ socketPath, path: url.pathname + url.search, method: init?.method ?? 'GET', headers }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const resHeaders = new Headers()
          for (const [k, v] of Object.entries(res.headers)) {
            if (v !== undefined) resHeaders.set(k, Array.isArray(v) ? v.join(', ') : v)
          }
          const status = res.statusCode ?? 0
          // 204·304 는 body 를 가질 수 없다
          const payload = status === 204 || status === 304 ? null : Buffer.concat(chunks)
          resolve(new Response(payload, { status, headers: resHeaders }))
        })
        res.on('error', reject)
      })
      req.on('error', reject)
      req.setTimeout(30_000, () => req.destroy(new Error('서버 응답 시간 초과')))
      if (body !== undefined) req.write(body)
      req.end()
    })
}

export function createServerApi(target: ServerTarget, getToken: () => string | null): ApiClient {
  return target.kind === 'socket'
    ? createApiClient({ baseUrl: 'http://minmo', getToken, fetch: socketFetch(target.path) })
    : createApiClient({ baseUrl: target.url, getToken })
}
