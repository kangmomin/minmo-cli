// 새 버전 알림·`minmo update` — 최신 버전은 GitHub Releases(공개 저장소, 토큰 없이)로 확인하고
// 하루 한 번만 묻는다. 설치는 GitHub Packages 의 npm 패키지로 한다(~/.npmrc 에 레지스트리·토큰 필요).
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { CliError } from './errors'

export const PACKAGE = '@kangmomin/minmo-cli'
export const RELEASES_API = 'https://api.github.com/repos/kangmomin/minmo-cli/releases/latest'
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 2_000

export const NPMRC_HINT = [
  'GitHub Packages 설정을 확인하세요 — ~/.npmrc:',
  '  @kangmomin:registry=https://npm.pkg.github.com',
  '  //npm.pkg.github.com/:_authToken=<read:packages 권한 토큰>',
  '(gh 를 쓰면: gh auth refresh -s read:packages 후 토큰 자리에 $(gh auth token))',
].join('\n')

type Fetch = (input: string, init?: RequestInit) => Promise<Response>

/** "v0.4.1" → [0,4,1]. 숫자 세 개가 아니면 null(개발 빌드 0.0.0-dev 등은 비교하지 않는다) */
export function parseVersion(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/** latest 가 current 보다 새 버전인가 */
export function isNewer(latest: string, current: string): boolean {
  const a = parseVersion(latest)
  const b = parseVersion(current)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]
  return false
}

/** 최신 릴리즈 버전(태그의 v 없이) — 실패·시간 초과는 null */
export async function fetchLatest(fetchFn: Fetch, timeoutMs = FETCH_TIMEOUT_MS): Promise<string | null> {
  try {
    const res = await fetchFn(RELEASES_API, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'minmo-cli' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) {
      // 본문을 읽지 않으면 연결이 남아, 곧이어 process.exit 할 때 Windows 의 libuv 가 멈춘다(assertion)
      await res.body?.cancel().catch(() => undefined)
      return null
    }
    const body = (await res.json()) as { tag_name?: unknown }
    const tag = typeof body.tag_name === 'string' ? body.tag_name : ''
    return parseVersion(tag) ? tag.replace(/^v/, '') : null
  } catch {
    return null
  }
}

export type UpdateCache = { checkedAt: number; latest: string | null }

export const cachePath = (configDir: string) => join(configDir, 'update-check.json')

async function readCache(path: string): Promise<UpdateCache | null> {
  try {
    const c = JSON.parse(await readFile(path, 'utf8')) as Partial<UpdateCache>
    return typeof c.checkedAt === 'number' ? { checkedAt: c.checkedAt, latest: typeof c.latest === 'string' ? c.latest : null } : null
  } catch {
    return null
  }
}

async function writeCache(path: string, cache: UpdateCache): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(cache))
  } catch {
    // 캐시는 없어도 된다
  }
}

/** 캐시가 하루 안이면 그 값, 아니면 새로 묻고 저장한다 */
export async function latestVersion(o: { configDir: string; fetch: Fetch; now?: number }): Promise<string | null> {
  const now = o.now ?? Date.now()
  const path = cachePath(o.configDir)
  const cached = await readCache(path)
  if (cached && now - cached.checkedAt < CHECK_INTERVAL_MS) return cached.latest
  const latest = await fetchLatest(o.fetch)
  // 확인에 실패해도 시각을 남겨 매 명령마다 기다리지 않게 한다(이전에 알던 값은 유지)
  await writeCache(path, { checkedAt: now, latest: latest ?? cached?.latest ?? null })
  return latest ?? cached?.latest ?? null
}

export const updateNotice = (current: string, latest: string) => `새 버전 v${latest} 이 있습니다(현재 v${current}) — minmo update 로 업데이트하세요.`

export type NotifyDeps = {
  version: string
  configDir: string
  env: NodeJS.ProcessEnv
  isTTY: boolean
  write(line: string): void
  fetch: Fetch
  now?: number
}

/** 명령이 끝난 뒤 새 버전을 알린다 — 터미널(TTY)일 때만, MINMO_NO_UPDATE_CHECK=1 이면 끈다 */
export async function notifyUpdate(d: NotifyDeps): Promise<void> {
  if (!d.isTTY || d.env.MINMO_NO_UPDATE_CHECK === '1' || !parseVersion(d.version)) return
  const latest = await latestVersion({ configDir: d.configDir, fetch: d.fetch, now: d.now })
  if (latest && isNewer(latest, d.version)) d.write(updateNotice(d.version, latest))
}

/** npm 전역 설치 명령 — Windows 의 npm 은 .cmd 라 셸로 실행한다(인자는 고정값) */
export function npmInstall(platform: NodeJS.Platform = process.platform) {
  return { cmd: 'npm', args: ['i', '-g', `${PACKAGE}@latest`], shell: platform === 'win32' }
}

export type RunCommand = (cmd: string, args: string[], shell: boolean) => Promise<number>

export const runInherited: RunCommand = (cmd, args, shell) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'inherit', shell })
    child.on('error', () => resolve(127))
    child.on('close', (code) => resolve(code ?? 1))
  })

export type UpdateDeps = {
  version: string
  fetch: Fetch
  run: RunCommand
  out(line: string): void
  platform?: NodeJS.Platform
}

/** `minmo update [--check]` */
export async function updateCmd(d: UpdateDeps, opts: { check?: boolean } = {}): Promise<void> {
  const latest = await fetchLatest(d.fetch)
  if (opts.check) {
    if (!latest) throw new CliError('최신 버전을 확인하지 못했습니다(GitHub 에 연결할 수 없음)')
    d.out(isNewer(latest, d.version) ? `현재 v${d.version} · 최신 v${latest} — minmo update 로 업데이트하세요` : `최신 버전입니다(v${d.version})`)
    return
  }
  if (latest && !isNewer(latest, d.version) && parseVersion(d.version)) {
    d.out(`이미 최신 버전입니다(v${d.version})`)
    return
  }
  const { cmd, args, shell } = npmInstall(d.platform)
  d.out(`${cmd} ${args.join(' ')}`)
  const code = await d.run(cmd, args, shell)
  if (code !== 0) throw new CliError(`업데이트에 실패했습니다(npm 종료 코드 ${code}).\n${NPMRC_HINT}`)
  d.out(latest ? `v${latest} 로 업데이트했습니다` : '업데이트했습니다')
}
