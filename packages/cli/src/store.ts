// 원격 호스트에 남기는 것: credentials.json(0600) — 로그인 세션.
// 이전 버전이 남긴 config.json·state.json(로컬 모드·worktree 기록)은 더 읽지 않는다.
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export type Paths = {
  configDir: string
  credentials: string
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
    socket: env.MINMO_SOCKET || join(home, '.minmo', 'server.sock'),
  }
}

export type Credentials = { session: string; login: string; savedAt: string }

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

/** 임시 파일에 쓰고 rename — 쓰다 끊겨도 기존 파일이 깨지지 않게 */
async function writeJson(path: string, data: unknown, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  // 같은 프로세스에서 쓰기가 겹쳐도 임시 파일이 섞이지 않게 고유 이름
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(tmp, JSON.stringify(data, null, 2) + '\n', { mode })
  await chmod(tmp, mode)
  await rename(tmp, path)
}

export const loadCredentials = (p: Paths) => readJson<Credentials>(p.credentials)
export const saveCredentials = (p: Paths, c: Credentials) => writeJson(p.credentials, c, 0o600)
export async function clearCredentials(p: Paths): Promise<void> {
  await writeJson(p.credentials, {}, 0o600)
}
