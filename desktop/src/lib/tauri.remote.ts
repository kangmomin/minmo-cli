// 원격 화면용 TauriApi — 다른 PC·휴대폰의 브라우저가 호스트(minmo 데스크톱 앱, src-tauri/src/remote.rs)에 붙어
// 같은 화면을 쓴다. 호출은 WebSocket 으로 호스트에 보내고, 터미널 출력 같은 이벤트도 그 연결로 받는다.
import type { TauriApi, Unlisten } from './tauri'
import { KEYCHAIN_KEYS, TAURI_EVENTS } from './tauri'

/** GitHub 토큰 자리에 넣어 보내는 표식 — 호스트가 실제 토큰으로 바꾼다(토큰은 호스트 밖으로 나오지 않는다). remote.rs 와 같아야 한다 */
export const TOKEN_SENTINEL = '__MINMO_HOST_GITHUB_TOKEN__'
/** 세션 토큰 자리 — /api 요청은 호스트가 자기 세션으로 바꿔 보낸다 */
export const SESSION_PLACEHOLDER = 'host-session'
export const DEVICE_HEADER = 'x-minmo-device'
const TOKEN_STORAGE = 'minmo-device-token'

export type RemoteLink = 'connecting' | 'open' | 'closed' | 'rejected'

export function storedDeviceToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_STORAGE)
  } catch {
    return null
  }
}

export function storeDeviceToken(token: string | null) {
  try {
    if (token === null) localStorage.removeItem(TOKEN_STORAGE)
    else localStorage.setItem(TOKEN_STORAGE, token)
  } catch {
    // 저장소를 쓸 수 없으면 이번 화면에서만 쓴다
  }
}

export class PairError extends Error {
  constructor(
    public code: 'pair_not_open' | 'pair_wrong_code' | 'not_enabled' | 'failed',
    /** 코드가 틀렸을 때 남은 시도 횟수 */
    public left?: number,
  ) {
    super(code)
  }
}

/** 호스트 화면에 띄운 6자리 코드로 이 기기를 등록하고 기기 토큰을 받는다 */
export async function pairDevice(origin: string, code: string, name: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await fetchImpl(`${origin}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, name }) })
  if (res.ok) return ((await res.json()) as { token: string }).token
  const text = await res.text()
  if (text === 'pair_not_open' || text === 'not_enabled') throw new PairError(text)
  try {
    const body = JSON.parse(text) as { error?: string; left?: number }
    if (body.error === 'pair_wrong_code') throw new PairError('pair_wrong_code', body.left)
  } catch (e) {
    if (e instanceof PairError) throw e
  }
  throw new PairError('failed')
}

type Pending = { resolve(v: unknown): void; reject(e: Error): void }
type WsLike = Pick<WebSocket, 'send' | 'close'> & { onopen: unknown; onmessage: unknown; onclose: unknown; onerror: unknown }

/** 호스트와의 연결 하나. 끊기면 기다리던 호출은 모두 실패하고, 다시 붙는 것은 쓰는 쪽(RemoteGate)이 정한다 */
export class RemoteConnection {
  private ws: WsLike | null = null
  private seq = 0
  private pending = new Map<number, Pending>()
  private listeners = new Map<string, Set<(payload: unknown) => void>>()
  private links = new Set<(s: RemoteLink) => void>()
  link: RemoteLink = 'closed'

  constructor(
    private url: string,
    private token: string,
    private create: (url: string) => WsLike = (u) => new WebSocket(u) as unknown as WsLike,
  ) {}

  onLink(cb: (s: RemoteLink) => void): Unlisten {
    this.links.add(cb)
    return () => this.links.delete(cb)
  }

  private setLink(s: RemoteLink) {
    this.link = s
    for (const cb of this.links) cb(s)
  }

  /** 붙고 기기 확인까지 끝나면 resolve. 토큰이 거절되면 'rejected' 로 reject */
  connect(): Promise<void> {
    this.setLink('connecting')
    return new Promise((resolve, reject) => {
      let settled = false
      const ws = this.create(this.url)
      this.ws = ws
      ws.onopen = () => ws.send(JSON.stringify({ auth: this.token }))
      ws.onmessage = (e: { data: unknown }) => {
        let msg: Record<string, unknown>
        try {
          msg = JSON.parse(String(e.data)) as Record<string, unknown>
        } catch {
          return
        }
        if ('auth' in msg) {
          settled = true
          if (msg.auth === true) {
            this.setLink('open')
            resolve()
          } else {
            this.setLink('rejected')
            ws.close()
            reject(new Error('rejected'))
          }
          return
        }
        if (typeof msg.event === 'string') {
          for (const cb of this.listeners.get(msg.event) ?? []) cb(msg.payload)
          return
        }
        const p = typeof msg.id === 'number' ? this.pending.get(msg.id) : undefined
        if (!p) return
        this.pending.delete(msg.id as number)
        if (msg.ok === true) p.resolve(msg.value)
        else p.reject(new Error(typeof msg.error === 'string' ? msg.error : '호출에 실패했습니다'))
      }
      ws.onclose = () => {
        if (this.ws !== ws) return
        this.ws = null
        for (const p of this.pending.values()) p.reject(new Error('호스트와의 연결이 끊겼습니다'))
        this.pending.clear()
        if (this.link !== 'rejected') this.setLink('closed')
        if (!settled) reject(new Error('closed'))
      }
      ws.onerror = () => undefined
    })
  }

  close() {
    const ws = this.ws
    this.ws = null
    ws?.close()
  }

  call<T>(method: string, args: unknown[]): Promise<T> {
    const ws = this.ws
    if (!ws || this.link !== 'open') return Promise.reject(new Error('호스트와 연결되어 있지 않습니다'))
    const id = ++this.seq
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      ws.send(JSON.stringify({ id, method, args }))
    })
  }

  on<T>(event: string, cb: (payload: T) => void): Unlisten {
    const set = this.listeners.get(event) ?? new Set()
    this.listeners.set(event, set)
    const fn = cb as (payload: unknown) => void
    set.add(fn)
    return () => set.delete(fn)
  }
}

/** on* 메서드 → 호스트가 전달하는 이벤트 이름. 여기에 없는 on* 은 원격 화면에서 일어나지 않는 일이다(창 닫기 등) */
const EVENTS: Partial<Record<keyof TauriApi, string>> = {
  onPtyData: TAURI_EVENTS.ptyData,
  onPtyExit: TAURI_EVENTS.ptyExit,
  onPtyResized: TAURI_EVENTS.ptyResized,
  onScriptLog: TAURI_EVENTS.scriptLog,
  onSharedChanged: TAURI_EVENTS.sharedChanged,
  onSyncApplied: TAURI_EVENTS.syncApplied,
}

const hostOnly = (what: string) => async (): Promise<never> => {
  throw new Error(`${what}은(는) 호스트 PC 의 화면에서만 할 수 있습니다`)
}

/**
 * 호스트에 그대로 보내는 호출은 따로 적지 않는다(이름과 인자를 그대로 전달 — 무엇을 허용할지는 호스트가 정한다).
 * 여기서 직접 처리하는 것은 이 기기에서 일어나야 하는 일(알림·링크 열기)과 호스트 화면에서만 할 수 있는 일이다.
 */
export function createRemoteTauri(conn: RemoteConnection): TauriApi {
  const local: Partial<TauriApi> = {
    runtime: 'remote',
    // 세션·GitHub 토큰은 호스트가 갖는다 — 이 기기는 자리 표시만 쓴다
    keychainGet: async (key) => (key === KEYCHAIN_KEYS.session ? SESSION_PLACEHOLDER : key === KEYCHAIN_KEYS.githubToken ? TOKEN_SENTINEL : null),
    keychainSet: async () => undefined,
    keychainDelete: async () => undefined,
    notify: async (title, body) => {
      // 브라우저 알림은 HTTPS(또는 localhost)에서만 된다 — 안 되면 조용히 넘어간다
      if (typeof Notification === 'undefined') return
      let permission = Notification.permission
      if (permission === 'default') permission = await Notification.requestPermission().catch(() => 'denied' as const)
      if (permission === 'granted') new Notification(title, { body })
    },
    openUrl: async (url) => {
      window.open(url, '_blank', 'noopener,noreferrer')
    },
    pickFolder: async () => null,
    openDir: hostOnly('폴더 열기'),
    serverStatus: async () => ({ state: 'external', port: 0, message: null }),
    onServerStatus: async () => () => {},
    serverSettingsGet: async () => ({ port: 0, closeAction: 'tray', warning: null }),
    serverSettingsSave: hostOnly('서버 설정'),
    serverRestart: hostOnly('서버 다시 시작'),
    serverOpenLogDir: hostOnly('로그 폴더 열기'),
    onCloseRequested: async () => () => {},
    appClose: async () => undefined,
    appUpdateCheck: async () => null,
    appUpdateInstall: hostOnly('업데이트'),
    onUpdateProgress: async () => () => {},
    sshHostSave: hostOnly('호스트 등록'),
    sshHostRemove: hostOnly('호스트 삭제'),
    remoteStatus: async () => ({ enabled: true, lan: false, port: 0, addresses: [], devices: [], error: null }),
    remoteConfigure: hostOnly('원격 접속 설정'),
    remotePairStart: hostOnly('기기 등록'),
    remotePairCancel: async () => undefined,
    remoteDeviceRemove: hostOnly('기기 끊기'),
    onRemoteChanged: async () => () => {},
    onRemoteRpc: async () => () => {},
    remoteRpcReply: async () => undefined,
    // 다른 PC 등록과 통합 현황은 데스크톱 앱에서만 한다
    peersList: async () => [],
    deviceName: async () => '',
    peerAdd: hostOnly('다른 PC 등록'),
    peerRemove: hostOnly('다른 PC 삭제'),
    peerOpen: hostOnly('다른 PC 열기'),
    agentsPublish: async () => undefined,
  }
  return new Proxy(local as TauriApi, {
    get(target, prop) {
      if (typeof prop !== 'string') return undefined
      if (prop in target) return target[prop as keyof TauriApi]
      // await 나 Promise 판별(then 조회)에 호출로 답하지 않게
      if (prop === 'then') return undefined
      const event = EVENTS[prop as keyof TauriApi]
      if (event) return async (cb: (payload: unknown) => void) => conn.on(event, cb)
      if (prop.startsWith('on')) return async () => () => {}
      return (...args: unknown[]) => conn.call(prop, args)
    },
  })
}

/**
 * 이 화면의 요청을 호스트로 돌린다: minmo 서버(/api)와 GitHub API(/gh)는 호스트가 대신 요청한다.
 * 기기 토큰을 붙이고, api.github.com 으로 가는 요청은 같은 출처의 /gh 로 바꾼다.
 */
export function remoteFetch(origin: string, token: () => string | null, base: typeof fetch = fetch): typeof fetch {
  const GITHUB = 'https://api.github.com'
  return async (input, init) => {
    const original = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const url = original.startsWith(GITHUB) ? `${origin}/gh${original.slice(GITHUB.length)}` : original
    if (!url.startsWith(`${origin}/api`) && !url.startsWith(`${origin}/gh`)) return base(input, init)
    const headers = new Headers(init?.headers ?? (typeof input === 'object' && 'headers' in input ? input.headers : undefined))
    const t = token()
    if (t) headers.set(DEVICE_HEADER, t)
    return base(url, { ...init, headers })
  }
}
