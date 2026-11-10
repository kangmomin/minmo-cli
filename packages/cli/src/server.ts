// minmo 서버 연결. 원격 호스트에서는 SSH 역터널이 만든 Unix 소켓(~/.minmo/server.sock)만 쓴다 —
// TCP 포트는 그 호스트의 다른 사용자도 열 수 있어, 소켓이 없을 때 127.0.0.1:8787 로 넘어가면
// 그 포트에서 듣는 아무 프로세스에게 세션 토큰을 보내게 된다. TCP 는 MINMO_SERVER 로 명시했을 때만 쓴다.
import { lstatSync } from 'node:fs'
import { request } from 'node:http'

import { createApiClient } from '@minmo/api-client'
import type { ApiClient } from '@minmo/api-client'

/** unset: Windows 에서 MINMO_SERVER 를 정하지 않음(Unix 소켓 역터널을 쓸 수 없다) */
export type ServerTarget = { kind: 'socket'; path: string } | { kind: 'tcp'; url: string } | { kind: 'unset' }

/**
 * MINMO_SERVER 가 있으면 그 주소, 아니면 역터널 소켓(없으면 연결 시 network_error — 토큰을 다른 곳에 보내지 않는다).
 * Windows 는 Node 가 Unix 소켓 파일에 붙지 못하므로 MINMO_SERVER 를 명시해야 한다(기본 포트로 넘어가지 않는다).
 */
export function resolveServer(socketPath: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): ServerTarget {
  if (env.MINMO_SERVER) return { kind: 'tcp', url: env.MINMO_SERVER }
  if (platform === 'win32') return { kind: 'unset' }
  return { kind: 'socket', path: socketPath }
}

export function describeServer(t: ServerTarget): string {
  return t.kind === 'socket' ? `소켓 ${t.path}` : t.kind === 'tcp' ? t.url : 'MINMO_SERVER 미설정'
}

export const WINDOWS_SERVER_HINT =
  'Windows 에서는 MINMO_SERVER 로 서버 주소를 정하세요 — 같은 PC: MINMO_SERVER=http://127.0.0.1:8787 · 원격: ~/.ssh/config 에 RemoteForward 127.0.0.1:18787 127.0.0.1:8787 + ExitOnForwardFailure yes 후 MINMO_SERVER=http://127.0.0.1:18787'

/** Unix 소켓으로 보내는 fetch — api-client 가 쓰는 범위(method·headers·문자열 body)만 지원한다 */
export function socketFetch(socketPath: string): typeof fetch {
  return (input, init) =>
    new Promise<Response>((resolve, reject) => {
      // 다른 사용자가 만든 소켓이면 토큰을 보내지 않는다(SSH 역터널 소켓은 접속한 사용자 소유)
      const uid = process.getuid?.()
      try {
        if (uid !== undefined && lstatSync(socketPath).uid !== uid) {
          reject(new Error(`소켓 소유자가 현재 사용자가 아닙니다: ${socketPath}`))
          return
        }
      } catch {
        // 없으면 아래 연결이 ENOENT 로 실패한다(오프라인으로 안내)
      }
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

/** 주소가 없으면 아무 데도 보내지 않고 연결 실패(network_error)로 끝낸다 */
const noServer: typeof fetch = () => Promise.reject(new Error('MINMO_SERVER 미설정'))

export function createServerApi(target: ServerTarget, getToken: () => string | null): ApiClient {
  if (target.kind === 'socket') return createApiClient({ baseUrl: 'http://minmo', getToken, fetch: socketFetch(target.path) })
  if (target.kind === 'tcp') return createApiClient({ baseUrl: target.url, getToken })
  return createApiClient({ baseUrl: 'http://minmo', getToken, fetch: noServer })
}
