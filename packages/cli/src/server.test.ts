import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_SERVER_URL } from '@minmo/core'
import { afterEach, describe, expect, it } from 'vitest'

import { serverErrorMessage } from './errors'
import { createServerApi, resolveServer, socketFetch } from './server'

describe('서버 경로 선택', () => {
  it('MINMO_SERVER → 명시한 MINMO_SOCKET → 배포된 서버 — 로컬 포트(127.0.0.1:8787)로는 넘어가지 않는다', () => {
    expect(resolveServer({ MINMO_SERVER: 'http://x:1', MINMO_SOCKET: '/s.sock' }, 'linux')).toEqual({ kind: 'tcp', url: 'http://x:1' })
    expect(resolveServer({ MINMO_SOCKET: '/s.sock' }, 'linux')).toEqual({ kind: 'socket', path: '/s.sock' })
    expect(resolveServer({}, 'linux')).toEqual({ kind: 'tcp', url: DEFAULT_SERVER_URL })
    expect(DEFAULT_SERVER_URL.startsWith('https://')).toBe(true)
  })

  it('Windows 는 Unix 소켓을 쓸 수 없어 MINMO_SOCKET 을 무시하고, 주소를 정하지 않아도 배포된 서버에 붙는다', () => {
    expect(resolveServer({ MINMO_SERVER: 'http://x:1' }, 'win32')).toEqual({ kind: 'tcp', url: 'http://x:1' })
    expect(resolveServer({ MINMO_SOCKET: '/s.sock' }, 'win32')).toEqual({ kind: 'tcp', url: DEFAULT_SERVER_URL })
    expect(resolveServer({}, 'win32')).toEqual({ kind: 'tcp', url: DEFAULT_SERVER_URL })
  })

  it('연결 실패 안내는 서버 경로에 맞춘다 — 배포된 서버는 네트워크, 소켓은 SSH 역터널', async () => {
    const err = await createServerApi({ kind: 'socket', path: socketPath() }, () => 'tok')
      .me()
      .catch((e: unknown) => e)
    expect(serverErrorMessage(err, { kind: 'tcp', url: DEFAULT_SERVER_URL })).toContain('네트워크 연결')
    expect(serverErrorMessage(err, { kind: 'socket', path: '/s.sock' })).toContain('SSH 역터널')
  })
})

// Windows 는 Unix 소켓 대신 named pipe 로 같은 경로(socketPath)를 검증한다
const socketPath = () =>
  process.platform === 'win32' ? `\\\\?\\pipe\\minmo-test-${process.pid}-${Date.now()}` : join(tmpdir(), `minmo-test-${process.pid}-${Date.now()}.sock`)

describe('소켓 fetch (SSH 역터널)', () => {
  let server: Server | null = null
  afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())))

  it('method·헤더·JSON body 를 보내고 상태·헤더·본문을 받는다, 204 는 body 없음', async () => {
    const path = socketPath()
    const seen: { method?: string; url?: string; auth?: string; body?: string }[] = []
    server = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body })
        if (req.method === 'DELETE') {
          res.writeHead(204).end()
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ repos: ['a/b'], updatedAt: null }))
      })
    })
    await new Promise<void>((r) => server!.listen(path, r))

    const api = createServerApi({ kind: 'socket', path }, () => 'tok')
    await expect(api.putVisibleRepos({ repos: ['a/b'] })).resolves.toEqual({ repos: ['a/b'], updatedAt: null })
    await expect(api.revokeSession('x')).resolves.toBeUndefined()
    expect(seen[0]).toEqual({ method: 'PUT', url: '/me/visible-repos', auth: 'Bearer tok', body: JSON.stringify({ repos: ['a/b'] }) })
    expect(seen[1]).toMatchObject({ method: 'DELETE', url: '/me/sessions/x' })
  })

  it('소켓이 없으면 network_error(오프라인)로 바뀐다', async () => {
    const api = createServerApi({ kind: 'socket', path: socketPath() }, () => 'tok')
    await expect(api.healthz()).rejects.toMatchObject({ code: 'network_error' })
    expect(typeof socketFetch).toBe('function')
  })
})
