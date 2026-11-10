// 원격 호스트에 남기는 상태: 로그인 세션(0600)과 worktree 경로·마지막 effective 설정(오프라인 대비).
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import type { Effective } from '@minmo/api-client'
import type { WorktreeEntry, WorktreePathStore } from '@minmo/core'

export type Paths = {
  configDir: string
  credentials: string
  state: string
  /** SSH 역터널이 만드는 서버 소켓(이 PC 의 ~/.ssh/config RemoteForward) */
  socket: string
}

export function defaultPaths(env: NodeJS.ProcessEnv = process.env, home = homedir()): Paths {
  const configDir = join(env.XDG_CONFIG_HOME || join(home, '.config'), 'minmo')
  return {
    configDir,
    credentials: join(configDir, 'credentials.json'),
    state: join(configDir, 'state.json'),
    socket: env.MINMO_SOCKET || join(home, '.minmo', 'server.sock'),
  }
}

export type Credentials = { session: string; login: string; savedAt: string }

export type State = {
  worktrees: Record<string, WorktreeEntry>
  /** 소문자 "owner/repo" → 마지막으로 받은 effective — 터널이 끊겨도 이미 연 이슈는 다시 열 수 있게 */
  effective: Record<string, Effective>
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

/** 임시 파일에 쓰고 rename — 쓰다 끊겨도 기존 파일이 깨지지 않게 */
async function writeJson(path: string, data: unknown, mode?: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  // 같은 프로세스에서 쓰기가 겹쳐도 임시 파일이 섞이지 않게 고유 이름
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(tmp, JSON.stringify(data, null, 2) + '\n', { mode: mode ?? 0o644 })
  if (mode !== undefined) await chmod(tmp, mode)
  await rename(tmp, path)
}

export const loadCredentials = (p: Paths) => readJson<Credentials>(p.credentials)
export const saveCredentials = (p: Paths, c: Credentials) => writeJson(p.credentials, c, 0o600)
export async function clearCredentials(p: Paths): Promise<void> {
  await writeJson(p.credentials, {}, 0o600)
}

export async function loadState(p: Paths): Promise<State> {
  const s = await readJson<Partial<State>>(p.state)
  return { worktrees: s?.worktrees ?? {}, effective: s?.effective ?? {} }
}
let writes: Promise<void> = Promise.resolve()

/**
 * 상태 한 군데를 바꾼다: 메모리에 바로 반영하고, 파일은 다시 읽어 같은 변경만 얹어 쓴다.
 * 다른 minmo 프로세스(예: tmux 패널의 `minmo open`)가 그 사이 쓴 항목을 덮어쓰지 않게 하려는 것이다.
 */
export function updateState(p: Paths, state: State, change: (s: State) => void): Promise<void> {
  change(state)
  const next = writes.then(async () => {
    const fresh = await loadState(p)
    change(fresh)
    await writeJson(p.state, fresh)
  })
  writes = next.catch(() => undefined)
  return next
}

/** 파일의 최신 상태로 메모리를 맞춘다(TUI 가 tmux·편집기에서 돌아올 때) */
export async function reloadState(p: Paths, state: State): Promise<void> {
  await writes
  const fresh = await loadState(p)
  state.worktrees = fresh.worktrees
  state.effective = fresh.effective
}

/** worktree 서비스용 경로 저장소 — 바뀔 때마다 파일에 쓴다 */
export function statePathStore(p: Paths, state: State): WorktreePathStore {
  const persist = (change: (s: State) => void) => void updateState(p, state, change).catch(() => undefined)
  return {
    get: (id) => state.worktrees[id],
    set: (id, entry) =>
      persist((s) => {
        s.worktrees[id] = entry
      }),
    delete: (id) =>
      persist((s) => {
        delete s.worktrees[id]
      }),
  }
}
