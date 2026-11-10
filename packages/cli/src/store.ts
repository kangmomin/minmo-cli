// 원격 호스트에 남기는 것:
// - credentials.json(0600): 로그인 세션
// - config.json: 모드(server|local)와 로컬 모드에서 바꾼 설정·보일 저장소(사용자가 고친 값)
// - state.json: worktree 경로·서버에서 받은 값의 사본(지워도 다시 받으면 되는 기계 상태)
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import type { Effective, SettingsField, SettingsValues } from '@minmo/api-client'
import type { WorktreeEntry, WorktreePathStore } from '@minmo/core'

import { CliError } from './errors'

export type Paths = {
  configDir: string
  credentials: string
  config: string
  state: string
  /** SSH 역터널이 만드는 서버 소켓(이 PC 의 ~/.ssh/config RemoteForward) */
  socket: string
}

export function defaultPaths(env: NodeJS.ProcessEnv = process.env, home = homedir(), platform: NodeJS.Platform = process.platform): Paths {
  // Windows 는 관례대로 %APPDATA%\minmo (XDG_CONFIG_HOME 이 있으면 그것)
  const base = env.XDG_CONFIG_HOME || (platform === 'win32' && env.APPDATA ? env.APPDATA : join(home, '.config'))
  const configDir = join(base, 'minmo')
  return {
    configDir,
    credentials: join(configDir, 'credentials.json'),
    config: join(configDir, 'config.json'),
    state: join(configDir, 'state.json'),
    socket: env.MINMO_SOCKET || join(home, '.minmo', 'server.sock'),
  }
}

export type Credentials = { session: string; login: string; savedAt: string }

export type Mode = 'server' | 'local'

/** 한 scope 에서 로컬로 바꾼 값 — 없는 키는 아래 층(서버 사본·기본값)을 쓴다 */
export type LocalScope = Partial<Record<SettingsField, string>>

export type LocalSettings = {
  global: LocalScope
  /** 소문자 owner → 값 */
  orgs: Record<string, LocalScope>
  /** 소문자 "owner/repo" → 값 */
  projects: Record<string, LocalScope>
  /** 없으면 서버 사본, null 이면 전체 표시 */
  visibleRepos?: string[] | null
}

export type Config = { mode: Mode; local: LocalSettings }

/** 서버 모드에서 받은 값 — 로컬 모드의 기본값이 된다 */
export type ServerCopy = {
  global?: SettingsValues
  /** 소문자 owner → 서버 조직 설정 중 값이 있는 필드(받은 조직만) */
  orgs?: Record<string, LocalScope>
  /** 없으면 받은 적 없음, null 이면 서버도 전체 표시 */
  visibleRepos?: string[] | null
  /** 마지막 전체 갱신(`minmo mode local`) 시각 */
  syncedAt?: string
}

export type State = {
  worktrees: Record<string, WorktreeEntry>
  /** 소문자 "owner/repo" → 마지막으로 받은 effective — 터널이 끊겨도 열 수 있고, 로컬 모드의 서버 사본이 된다 */
  effective: Record<string, Effective>
  serverCopy: ServerCopy
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
  return { worktrees: s?.worktrees ?? {}, effective: s?.effective ?? {}, serverCopy: s?.serverCopy ?? {} }
}

export async function loadConfig(p: Paths): Promise<Config> {
  let c: ({ mode?: unknown; local?: Partial<LocalSettings> } & Record<string, unknown>) | null
  try {
    c = await readJson(p.config)
  } catch (e) {
    // 사용자가 손으로 고칠 수 있는 파일이라 스택 대신 고칠 곳을 알려 준다
    throw new CliError(`설정 파일을 읽을 수 없습니다: ${p.config} (${e instanceof Error ? e.message : String(e)}) — 고치거나 지운 뒤 다시 실행하세요`)
  }
  const l = c?.local ?? {}
  const local: LocalSettings = { global: l.global ?? {}, orgs: l.orgs ?? {}, projects: l.projects ?? {} }
  if (l.visibleRepos !== undefined) local.visibleRepos = l.visibleRepos
  // 모르는 키는 그대로 둔다(다시 쓸 때 지우지 않게)
  return { ...c, mode: c?.mode === 'local' ? 'local' : 'server', local }
}

let writes: Promise<void> = Promise.resolve()

/**
 * 파일 한 군데를 바꾼다: 메모리에 바로 반영하고, 파일은 다시 읽어 같은 변경만 얹어 쓴다.
 * 다른 minmo 프로세스(예: tmux 패널의 `minmo open`)가 그 사이 쓴 항목을 덮어쓰지 않게 하려는 것이다.
 */
function updateFile<T>(path: string, load: () => Promise<T>, mem: T, change: (s: T) => void): Promise<void> {
  change(mem)
  const next = writes.then(async () => {
    const fresh = await load()
    change(fresh)
    await writeJson(path, fresh)
  })
  writes = next.catch(() => undefined)
  return next
}

export const updateState = (p: Paths, state: State, change: (s: State) => void) => updateFile(p.state, () => loadState(p), state, change)
export const updateConfig = (p: Paths, config: Config, change: (c: Config) => void) => updateFile(p.config, () => loadConfig(p), config, change)

/** 파일의 최신 상태로 메모리를 맞춘다(TUI 가 tmux·편집기에서 돌아올 때 — 그 사이 다른 minmo 가 바꿨을 수 있다) */
export async function reloadState(p: Paths, state: State, config?: Config): Promise<void> {
  await writes
  Object.assign(state, await loadState(p))
  if (config) config.local = (await loadConfig(p)).local
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
