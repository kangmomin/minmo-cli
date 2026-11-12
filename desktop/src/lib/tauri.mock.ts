// dev(VITE_TAURI_MOCK=1)·Playwright 용 인메모리 가짜 TauriApi.
// - git 은 worktree 서비스가 쓰는 명령만 최소 시뮬레이션한다(clone·worktree add/list/remove·ref 확인·status).
// - 브라우저 열기 등은 window.__MINMO_MOCK__ 로 노출해 E2E 가 확인한다.
import type { CloseAction, CmdResult, DirEntry, Platform, PtyDataEvent, ScriptLogEvent, ServerSettings, ServerStatus, SshHostInfo, SubagentFile, TauriApi, UpdateInfo, UpdateProgress, Peer, RemoteStatus, TailscaleLogEvent, TailscaleStatus } from './tauri'

export type TauriMockOptions = {
  home?: string
  platform?: Platform
}

export interface MinmoMockHandle {
  /** openUrl 로 연 URL 목록 (로그인 승인 주소 확인용) */
  openedUrls: string[]
  /** peerOpen 으로 연 다른 PC(와 열 곳) */
  openedPeers: { id: string; open: unknown }[]
  readonly keychain: Record<string, string>
  /** 창 닫기 버튼을 누른 것처럼 close-requested 를 보낸다 */
  emitCloseRequested(): void
  /** appClose 호출 기록 */
  closeCalls: { action: Exclude<CloseAction, 'ask'>; remember: boolean }[]
  /** 내장 서버 상태를 바꾸고 server-status 를 보낸다 */
  setServerStatus(s: ServerStatus): void
  readonly serverSettings: ServerSettings
  /** 다음 업데이트 확인 결과(null = 최신) */
  setAvailableUpdate(u: UpdateInfo | null): void
  /** appUpdateInstall 호출 횟수 */
  installCalls: number
  /** 다음 pickFolder 가 돌려줄 폴더(null = 취소) */
  pickedFolder: string | null
  /** 실행한 git 명령(인자 목록) */
  gitCalls: string[][]
  /** 터미널(PTY)로 보낸 입력 */
  ptyWrites: string[]
  /** n 번째(1부터)로 만든 터미널에 출력이 나온 것처럼 보낸다 */
  emitPty(n: number, data: string): void
  /** n 번째 터미널에서 도는 프로세스 이름(에이전트 감지용) */
  setPtyProcesses(n: number, names: string[]): void
  /** 작업 폴더(cwd)에서 도는 Claude Code 의 하위 에이전트 메타 파일을 정한다 */
  setSubagents(cwd: string, files: SubagentFile[]): void
  /** notify 로 띄운 알림 */
  notifications: { title: string; body: string }[]
  /** Tailscale 상태를 정한다(기본: 설치 안 됨) */
  setTailscale(patch: Partial<TailscaleStatus>): void
  /** 다음 [HTTPS 로 열기] 가 "tailnet 에서 먼저 켜야 한다"고 답하게 한다 */
  tailscaleEnableUrl: string | null
}

/** mock 서버 포트 — VITE_MINMO_SERVER(Playwright) 주소를 따른다 */
function mockServerPort(): number {
  try {
    const raw = import.meta.env.VITE_MINMO_SERVER
    return raw ? Number(new URL(raw).port) || 80 : 8787
  } catch {
    return 8787
  }
}

declare global {
  interface Window {
    __MINMO_MOCK__?: MinmoMockHandle
  }
}

export const ok = (stdout = ''): CmdResult => ({ code: 0, stdout, stderr: '' })
export const fail = (stderr: string, code = 1): CmdResult => ({ code, stdout: '', stderr })
const HASH = '0000000000000000000000000000000000000000'

// 새로고침해도 로그인 상태를 유지하도록 키체인만 sessionStorage 에 둔다(탭 수명)
const KEYCHAIN_STORAGE = 'minmo-mock-keychain'

function loadKeychain(): Map<string, string> {
  try {
    const raw = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(KEYCHAIN_STORAGE) : null
    return new Map(Object.entries(raw ? (JSON.parse(raw) as Record<string, string>) : {}))
  } catch {
    return new Map()
  }
}

export function createTauriMock(opts?: TauriMockOptions): TauriApi {
  const home = opts?.home ?? '/home/minmo'
  const platform = opts?.platform ?? 'linux'
  const keychain = loadKeychain()
  const persistKeychain = () => {
    try {
      sessionStorage.setItem(KEYCHAIN_STORAGE, JSON.stringify(Object.fromEntries(keychain)))
    } catch {
      // storage 불가 환경은 메모리만 사용
    }
  }

  let remote: RemoteStatus = { enabled: false, lan: false, port: 8790, addresses: [], devices: [{ id: 'd1', name: '내 휴대폰', createdMs: 1, lastSeenMs: 1, connected: false }], error: null }
  let peers: Peer[] = []
  // Tailscale: 설치 → 로그인(다음 상태 확인에서 연결됨) → HTTPS 흐름을 흉내 낸다
  let tailscale: TailscaleStatus = {
    state: 'missing',
    name: null,
    ips: [],
    httpsUrl: null,
    httpsConflict: false,
    install: { command: 'winget install --id Tailscale.Tailscale -e --source winget --accept-source-agreements --accept-package-agreements', auto: true, downloadUrl: 'https://tailscale.com/download' },
    installing: false,
    error: null,
  }
  let tailscaleLoginPending = false
  const tailscaleListeners = new Set<(e: TailscaleLogEvent) => void>()
  const paths = new Set<string>()
  // 파일 탭: "root\nrel" → 내용. worktree 를 만들면 README.md 가 생긴 것으로 본다
  const textFiles = new Map<string, string>()
  const dirs = new Set<string>()
  const fileKey = (root: string, rel: string) => `${root}\n${rel}`
  const seedFiles = (root: string) => {
    if ([...textFiles.keys()].some((k) => k.startsWith(`${root}\n`))) return
    textFiles.set(fileKey(root, 'README.md'), '# mock\n')
    textFiles.set(fileKey(root, 'src/index.ts'), "export const hello = 'world'\n")
  }
  const listEntries = (root: string, rel: string): DirEntry[] => {
    seedFiles(root)
    const prefix = rel === '' ? '' : `${rel}/`
    const seen = new Map<string, DirEntry['kind']>()
    const add = (path: string, leaf: DirEntry['kind']) => {
      if (!path.startsWith(prefix)) return
      const rest = path.slice(prefix.length)
      if (rest === '') return
      const [head, ...more] = rest.split('/')
      seen.set(head, more.length > 0 ? 'dir' : (seen.get(head) ?? leaf))
    }
    for (const k of textFiles.keys()) if (k.startsWith(`${root}\n`)) add(k.slice(root.length + 1), 'file')
    for (const k of dirs) if (k.startsWith(`${root}\n`)) add(k.slice(root.length + 1), 'dir')
    return [...seen].map(([name, kind]) => ({ name, kind })).sort((a, b) => Number(a.kind !== 'dir') - Number(b.kind !== 'dir') || a.name.localeCompare(b.name))
  }
  const versionOf = (content: string) => `v${content.length}:${[...content].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7)}`
  let appHosts: SshHostInfo[] = []
  const allHosts = (): SshHostInfo[] => [{ alias: 'mock-server', hostName: '10.0.0.5', user: 'dev', source: 'config', port: null, identityFile: null }, ...appHosts]
  const localFiles = new Map<string, string[]>()
  const repos = new Set<string>()
  /** worktree path → branch */
  const worktrees = new Map<string, string>()
  const branches = new Set<string>()
  /** `git init` 으로 만든 저장소 → origin 주소(없으면 null). clone 한 저장소는 여기 없다(origin 있음) */
  const origins = new Map<string, string | null>()
  /** worktree path → 그 worktree 를 만든 저장소 */
  const worktreeRepo = new Map<string, string>()
  const trustedHosts = new Set<string>()
  const ptyListeners = new Set<(e: PtyDataEvent) => void>()
  const scriptListeners = new Set<(e: ScriptLogEvent) => void>()
  const ptyCwd = new Map<string, string>()
  const ptyProcs = new Map<string, string[]>()
  const subagents = new Map<string, SubagentFile[]>()
  let ptySeq = 0
  const cancelled = new Set<string>()
  const closeListeners = new Set<() => void>()
  const serverListeners = new Set<(s: ServerStatus) => void>()
  let serverStatus: ServerStatus = { state: 'running', port: mockServerPort(), message: null }
  const server = { port: serverStatus.port, closeAction: 'ask' as CloseAction }
  const serverView = (): ServerSettings => ({
    port: server.port,
    closeAction: server.closeAction,
    warning: null,
  })
  let availableUpdate: UpdateInfo | null = null
  const progressListeners = new Set<(p: UpdateProgress) => void>()
  const emitServer = (next: ServerStatus) => {
    serverStatus = next
    for (const l of [...serverListeners]) l(next)
  }

  const handle: MinmoMockHandle = {
    openedUrls: [],
    openedPeers: [],
    get keychain() {
      return Object.fromEntries(keychain)
    },
    emitCloseRequested: () => {
      for (const l of [...closeListeners]) l()
    },
    closeCalls: [],
    setServerStatus: emitServer,
    get serverSettings() {
      return serverView()
    },
    setAvailableUpdate: (u) => {
      availableUpdate = u
    },
    installCalls: 0,
    pickedFolder: null,
    gitCalls: [],
    ptyWrites: [],
    emitPty: (n, data) => emitPty(`mock-pty-${n}`, data),
    setPtyProcesses: (n, names) => void ptyProcs.set(`mock-pty-${n}`, names),
    setSubagents: (cwd, files) => void subagents.set(cwd, files),
    notifications: [],
    setTailscale: (patch) => {
      tailscale = { ...tailscale, ...patch }
    },
    tailscaleEnableUrl: null,
  }
  if (typeof window !== 'undefined') window.__MINMO_MOCK__ = handle

  const emitPty = (id: string, data: string) => {
    for (const l of [...ptyListeners]) l({ id, data })
  }

  async function gitRun(args: string[], o?: { cwd?: string }): Promise<CmdResult> {
    const a = [...args]
    let cwd = o?.cwd
    const ci = a.indexOf('-C')
    if (ci >= 0) {
      cwd = a[ci + 1]
      a.splice(ci, 2)
    }
    const positional = (from: number) => a.slice(from).filter((x) => !x.startsWith('-'))
    handle.gitCalls.push([...args])
    switch (a[0]) {
      case 'init': {
        const target = a[a.length - 1]
        paths.add(target)
        repos.add(target)
        branches.add('main')
        origins.set(target, null)
        return ok()
      }
      case 'remote': {
        // worktree 에서 물어도 그 저장소의 원격을 답한다
        const repo = cwd && (origins.has(cwd) ? cwd : worktreeRepo.get(cwd))
        if (!repo || !origins.has(repo)) return ok()
        if (a[1] === 'add') {
          origins.set(repo, a[3] ?? '')
          return ok()
        }
        const url = origins.get(repo)
        return url ? ok(`${url}\n`) : fail("error: No such remote 'origin'", 2)
      }
      case 'push':
        return ok()
      case 'clone': {
        const target = a[a.length - 1]
        paths.add(target)
        repos.add(target)
        branches.add('main')
        return ok()
      }
      case 'rev-parse':
        if (a.includes('--git-dir')) {
          return cwd && (repos.has(cwd) || worktrees.has(cwd)) ? ok('.git\n') : fail('fatal: not a git repository', 128)
        }
        if (a.includes('--show-toplevel')) return cwd && repos.has(cwd) ? ok(`${cwd}\n${cwd}/.git\n`) : fail('fatal: not a git repository', 128)
        if (a.includes('--git-common-dir')) return ok(`${(cwd && worktreeRepo.get(cwd)) ?? [...repos][0] ?? cwd}/.git\n`)
        for (const x of a) {
          const m = /^refs\/heads\/(.+)$/.exec(x)
          if (m) return branches.has(m[1]) ? ok(HASH + '\n') : fail('', 1)
          if (/^refs\/remotes\/origin\/(.+)$/.test(x)) return x.endsWith('/main') ? ok(HASH + '\n') : fail('', 1)
        }
        return ok(HASH + '\n')
      case 'worktree': {
        if (a[1] === 'list') {
          return ok([...worktrees].map(([p, b]) => `worktree ${p}\nHEAD ${HASH}\nbranch refs/heads/${b}\n`).join('\n'))
        }
        if (a[1] === 'add') {
          const rest = a.slice(2)
          let nb: string | undefined
          const pos: string[] = []
          for (let i = 0; i < rest.length; i++) {
            if (rest[i] === '-b' || rest[i] === '-B') nb = rest[++i]
            else if (!rest[i].startsWith('-')) pos.push(rest[i])
          }
          const [path, commitish] = pos
          paths.add(path)
          worktrees.set(path, nb ?? commitish)
          if (cwd) worktreeRepo.set(path, cwd)
          if (nb) branches.add(nb)
          return ok()
        }
        if (a[1] === 'remove') {
          const path = positional(2).at(-1)
          if (path) {
            worktrees.delete(path)
            paths.delete(path)
          }
          return ok()
        }
        return ok()
      }
      case 'branch':
        if (a.includes('-D') || a.includes('-d')) for (const b of positional(1)) branches.delete(b)
        return ok()
      case 'status':
        return ok('')
      case 'rev-list':
        return ok('0\n')
      case 'diff':
        return ok('')
      case 'commit':
        return ok(`[mock ${HASH.slice(0, 7)}] commit`)
      case 'symbolic-ref':
        return ok(a.includes('HEAD') ? 'main\n' : 'origin/main\n')
      default:
        return ok()
    }
  }

  return {
    runtime: 'mock',
    gitRun,
    ghRun: async () => fail('gh: mock — not installed', 127),
    ghAvailable: async () => false,

    ptySpawn: async (req) => {
      const id = `mock-pty-${++ptySeq}`
      ptyCwd.set(id, req.cwd)
      const where = req.remote ? `${req.remote.host}:${req.cwd}${req.remote.session ? ` [tmux ${req.remote.session}]` : ''}` : req.cwd
      setTimeout(() => emitPty(id, `minmo mock terminal - ${where}\r\n$ `), 0)
      return id
    },
    ptyWrite: async (id, data) => {
      handle.ptyWrites.push(data)
      // 에코만 한다(Enter → 새 프롬프트)
      emitPty(id, data === '\r' ? '\r\n$ ' : data)
    },
    ptyResize: async () => {},
    ptyFind: async () => null,
    ptyList: async () => [...ptyCwd].map(([id, cwd]) => ({ id, key: null, cwd, host: null })),
    onPtyExit: async () => () => {},
    onPtyResized: async () => () => {},
    // 공유 상태·원격 접속은 mock 에서 쓰지 않는다(화면 상태는 평소처럼 브라우저 저장소에만 남는다)
    sharedGet: async () => ({ value: null, rev: 0 }),
    sharedSet: async (_key, _value, _origin, base) => base + 1,
    onSharedChanged: async () => () => {},
    remoteStatus: async () => remote,
    remoteConfigure: async (input) => {
      remote = { ...remote, ...input, addresses: (input.enabled ?? remote.enabled) ? [{ kind: 'local', url: `http://127.0.0.1:${input.port ?? remote.port}` }] : [] }
      return remote
    },
    remotePairStart: async () => ({ code: '123456', expiresInSec: 120 }),
    remotePairCancel: async () => {},
    remoteDeviceRemove: async (id) => {
      remote = { ...remote, devices: remote.devices.filter((d) => d.id !== id) }
      return remote
    },
    onRemoteChanged: async () => () => {},
    onRemoteRpc: async () => () => {},
    remoteRpcReply: async () => {},
    peersList: async () => peers,
    deviceName: async () => 'mock-pc (minmo)',
    peerAdd: async (input) => {
      if (input.code !== '123456') throw new Error('코드가 맞지 않습니다(남은 시도 4번)')
      peers = [...peers.filter((p) => p.url !== input.url), { id: `peer-${peers.length + 1}`, name: input.name || input.url, url: input.url, token: 'mock-peer-token' }]
      return peers
    },
    peerRemove: async (id) => {
      peers = peers.filter((p) => p.id !== id)
      return peers
    },
    agentsPublish: async () => {},
    onSyncApplied: async () => () => {},
    peerOpen: async (id, open) => {
      handle.openedPeers.push({ id, open: open ?? null })
    },
    tailscaleStatus: async () => {
      if (tailscaleLoginPending) {
        tailscaleLoginPending = false
        tailscale = { ...tailscale, state: 'running', name: 'mock-pc.tail0000.ts.net', ips: ['100.64.0.1'] }
      }
      return tailscale
    },
    tailscaleInstall: async () => {
      for (const line of ['Found Tailscale [Tailscale.Tailscale]', 'Successfully installed']) for (const l of [...tailscaleListeners]) l({ line, transient: false })
      tailscale = { ...tailscale, state: 'needs-login', install: null }
      return { exitCode: 0, cancelled: false }
    },
    tailscaleInstallCancel: async () => {},
    tailscaleLogin: async () => {
      tailscaleLoginPending = true
      return { url: 'https://login.tailscale.com/a/mock' }
    },
    tailscaleServe: async (on) => {
      const enableUrl = on ? handle.tailscaleEnableUrl : null
      handle.tailscaleEnableUrl = null
      if (!enableUrl) tailscale = { ...tailscale, httpsUrl: on ? 'https://mock-pc.tail0000.ts.net' : null }
      return { status: tailscale, enableUrl }
    },
    onTailscaleLog: async (cb) => {
      tailscaleListeners.add(cb)
      return () => {
        tailscaleListeners.delete(cb)
      }
    },
    ptyProcesses: async (id) => ptyProcs.get(id) ?? [],
    claudeSubagents: async (cwd) => subagents.get(cwd) ?? [],
    notify: async (title, body) => {
      handle.notifications.push({ title, body })
    },
    ptyKill: async (id) => {
      ptyCwd.delete(id)
    },
    // 원격 호스트: 호스트 하나(mock-server)가 이 mock 의 git·파일 상태를 함께 쓴다
    sshHosts: async () => allHosts(),
    // 앱에 등록한 호스트는 처음에 호스트 키가 없는 것으로 흉내 낸다(trustNew 로 등록)
    sshProbe: async (host, trustNew) => {
      const known = allHosts().find((h) => h.alias === host)
      if (!known) throw { kind: 'unreachable', message: `ssh: connect to host ${host}: Connection timed out` }
      if (known.source === 'app' && !trustNew && !trustedHosts.has(host)) throw { kind: 'host_key', message: 'Host key verification failed.' }
      trustedHosts.add(host)
      return { platform: 'linux', home: '/home/dev', git: 'git version 2.43.0', tmux: true }
    },
    sshHostSave: async (h) => {
      if (!/^[A-Za-z0-9._-]+$/.test(h.alias)) throw '이름은 영문·숫자와 . _ - 만 쓸 수 있습니다'
      appHosts = [...appHosts.filter((x) => x.alias !== h.alias), { ...h, source: 'app' }]
      return allHosts()
    },
    sshHostRemove: async (alias) => {
      appHosts = appHosts.filter((x) => x.alias !== alias)
      return allHosts()
    },
    sshExec: async (_host, argv, o) => {
      const [cmd, ...rest] = argv
      if (cmd === 'git') return gitRun(rest, o)
      if (cmd === 'test') return paths.has(rest[1]) ? ok() : fail('', 1)
      if (cmd === 'rm') {
        paths.delete(rest[rest.length - 1])
        repos.delete(rest[rest.length - 1])
        return ok()
      }
      // sh -s 스크립트: 파일 목록은 빈 목록, 복사는 0개
      return o?.stdin?.includes('sort') ? ok('') : ok('0')
    },
    sshScriptRun: async (_host, req) => {
      for (const l of [...scriptListeners]) l({ runId: req.runId, stream: 'stdout', line: '[mock] 원격 스크립트' })
      return { exitCode: 0, cancelled: false }
    },
    sshScriptCancel: async (runId) => {
      cancelled.add(runId)
    },

    ptyKillByCwd: async (path) => {
      let n = 0
      for (const [id, cwd] of [...ptyCwd]) {
        if (cwd === path || cwd.startsWith(path + '/') || cwd.startsWith(path + '\\')) {
          ptyCwd.delete(id)
          n++
        }
      }
      return n
    },
    onPtyData: async (cb) => {
      ptyListeners.add(cb)
      return () => {
        ptyListeners.delete(cb)
      }
    },

    scriptRun: async (req) => {
      const lines = req.script.split(/\r?\n/).filter((l) => l.trim() !== '')
      for (const line of lines) {
        await new Promise((r) => setTimeout(r, 50))
        if (cancelled.has(req.runId)) {
          cancelled.delete(req.runId)
          return { exitCode: null, cancelled: true }
        }
        for (const l of [...scriptListeners]) l({ runId: req.runId, stream: 'stdout', line: `[mock] ${line}` })
      }
      return { exitCode: 0, cancelled: false }
    },
    scriptCancel: async (runId) => {
      cancelled.add(runId)
    },
    onScriptLog: async (cb) => {
      scriptListeners.add(cb)
      return () => {
        scriptListeners.delete(cb)
      }
    },

    keychainGet: async (k) => keychain.get(k) ?? null,
    keychainSet: async (k, v) => {
      keychain.set(k, v)
      persistKeychain()
    },
    keychainDelete: async (k) => {
      keychain.delete(k)
      persistKeychain()
    },

    homeDir: async () => home,
    platform: async () => platform,
    pathExists: async (p) => paths.has(p),
    removeDir: async (p) => {
      paths.delete(p)
      repos.delete(p)
    },
    // 로컬 파일 보관 폴더: dev·Playwright 에서는 폴더별 인메모리 파일 목록으로 흉내 낸다
    copyTree: async (src, dst) => {
      const files = localFiles.get(src) ?? []
      const target = localFiles.get(dst) ?? []
      const added = files.filter((f) => !target.includes(f))
      localFiles.set(dst, [...target, ...added].sort())
      return added.length
    },
    listFiles: async (root) => [...(localFiles.get(root) ?? [])],
    copyFileInto: async (_srcRoot, rel, dstRoot) => {
      localFiles.set(dstRoot, [...new Set([...(localFiles.get(dstRoot) ?? []), rel])].sort())
    },
    removeFileIn: async (root, rel) => {
      localFiles.set(root, (localFiles.get(root) ?? []).filter((f) => f !== rel))
    },
    openDir: async () => {},
    listDir: async (root, rel) => listEntries(root, rel),
    readTextFile: async (root, rel) => {
      seedFiles(root)
      const content = textFiles.get(fileKey(root, rel))
      if (content === undefined) throw '파일이 아닙니다'
      return { content, version: versionOf(content) }
    },
    writeTextFile: async (root, rel, content, o) => {
      const cur = textFiles.get(fileKey(root, rel))
      if (o?.create && cur !== undefined) throw 'file_exists: 같은 이름이 이미 있습니다'
      if (o?.expected && cur !== undefined && versionOf(cur) !== o.expected) throw 'file_changed: 연 뒤에 파일이 바뀌었습니다'
      textFiles.set(fileKey(root, rel), content)
      return versionOf(content)
    },
    createDir: async (root, rel) => {
      dirs.add(fileKey(root, rel))
    },
    renamePath: async (root, from, to) => {
      for (const [k, v] of [...textFiles]) {
        const rel = k.slice(root.length + 1)
        if (k.startsWith(`${root}\n`) && (rel === from || rel.startsWith(`${from}/`))) {
          textFiles.delete(k)
          textFiles.set(fileKey(root, to + rel.slice(from.length)), v)
        }
      }
    },
    removePath: async (root, rel) => {
      for (const k of [...textFiles.keys()]) {
        const r = k.slice(root.length + 1)
        if (k.startsWith(`${root}\n`) && (r === rel || r.startsWith(`${rel}/`))) textFiles.delete(k)
      }
      dirs.delete(fileKey(root, rel))
    },

    openUrl: async (url) => {
      handle.openedUrls.push(url)
    },
    pickFolder: async () => handle.pickedFolder,

    serverStatus: async () => serverStatus,
    onServerStatus: async (cb) => {
      serverListeners.add(cb)
      return () => {
        serverListeners.delete(cb)
      }
    },
    serverSettingsGet: async () => serverView(),
    serverSettingsSave: async (input) => {
      if (input.port !== undefined) server.port = input.port
      if (input.closeAction !== undefined) server.closeAction = input.closeAction
      return serverView()
    },
    serverRestart: async () => emitServer({ state: 'running', port: server.port, message: null }),
    serverOpenLogDir: async () => {},
    onCloseRequested: async (cb) => {
      closeListeners.add(cb)
      return () => {
        closeListeners.delete(cb)
      }
    },
    appClose: async (action, remember) => {
      handle.closeCalls.push({ action, remember })
      if (remember) server.closeAction = action
    },

    appVersion: async () => '0.0.0-mock',
    appUpdateCheck: async () => availableUpdate,
    appUpdateInstall: async () => {
      handle.installCalls += 1
      for (const l of [...progressListeners]) l({ downloaded: 50, total: 100 })
    },
    onUpdateProgress: async (cb) => {
      progressListeners.add(cb)
      return () => {
        progressListeners.delete(cb)
      }
    },
  }
}
