// dev(VITE_TAURI_MOCK=1)·Playwright 용 인메모리 가짜 TauriApi.
// - git 은 worktree 서비스가 쓰는 명령만 최소 시뮬레이션한다(clone·worktree add/list/remove·ref 확인·status).
// - 딥링크·브라우저 열기는 window.__MINMO_MOCK__ 로 노출해 E2E 가 조작한다.
import type { CmdResult, PtyDataEvent, ScriptLogEvent, TauriApi } from './tauri'

export type TauriMockOptions = {
  home?: string
  platform?: 'win32' | 'darwin' | 'linux'
}

export interface MinmoMockHandle {
  /** openUrl 로 연 URL 목록 (로그인 authorizeUrl 확인용) */
  openedUrls: string[]
  emitDeepLink(...urls: string[]): void
  readonly keychain: Record<string, string>
}

declare global {
  interface Window {
    __MINMO_MOCK__?: MinmoMockHandle
  }
}

const ok = (stdout = ''): CmdResult => ({ code: 0, stdout, stderr: '' })
const fail = (stderr: string, code = 1): CmdResult => ({ code, stdout: '', stderr })
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

  const paths = new Set<string>()
  const repos = new Set<string>()
  /** worktree path → branch */
  const worktrees = new Map<string, string>()
  const branches = new Set<string>()
  const deepLinkListeners = new Set<(urls: string[]) => void>()
  const ptyListeners = new Set<(e: PtyDataEvent) => void>()
  const scriptListeners = new Set<(e: ScriptLogEvent) => void>()
  const ptyCwd = new Map<string, string>()
  let ptySeq = 0
  const cancelled = new Set<string>()

  const handle: MinmoMockHandle = {
    openedUrls: [],
    emitDeepLink: (...urls) => {
      for (const l of [...deepLinkListeners]) l(urls)
    },
    get keychain() {
      return Object.fromEntries(keychain)
    },
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
    switch (a[0]) {
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
        if (a.includes('--git-common-dir')) return ok(`${[...repos][0] ?? cwd}/.git\n`)
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
        return ok('origin/main\n')
      default:
        return ok()
    }
  }

  return {
    gitRun,
    ghRun: async () => fail('gh: mock — not installed', 127),
    ghAvailable: async () => false,

    ptySpawn: async (req) => {
      const id = `mock-pty-${++ptySeq}`
      ptyCwd.set(id, req.cwd)
      setTimeout(() => emitPty(id, `minmo mock terminal - ${req.cwd}\r\n$ `), 0)
      return id
    },
    ptyWrite: async (id, data) => {
      // 에코만 한다(Enter → 새 프롬프트)
      emitPty(id, data === '\r' ? '\r\n$ ' : data)
    },
    ptyResize: async () => {},
    ptyKill: async (id) => {
      ptyCwd.delete(id)
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

    openUrl: async (url) => {
      handle.openedUrls.push(url)
    },
    onDeepLink: async (cb) => {
      deepLinkListeners.add(cb)
      return () => {
        deepLinkListeners.delete(cb)
      }
    },
  }
}
