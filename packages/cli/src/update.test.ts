// 새 버전 알림·minmo update — 버전 비교, 하루 캐시, 알림 조건, npm 설치·실패 안내
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CliError } from './errors'
import { buildProgram } from './program'
import { CHECK_INTERVAL_MS, NPMRC_HINT, PACKAGE, cachePath, fetchLatest, isNewer, latestVersion, notifyUpdate, npmInstall, parseVersion, updateCmd } from './update'

const release = (tag: string, status = 200) => vi.fn(async () => new Response(JSON.stringify({ tag_name: tag }), { status }))

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'minmo-update-test-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('버전', () => {
  it('parseVersion·isNewer', () => {
    expect(parseVersion('v0.4.1')).toEqual([0, 4, 1])
    expect(parseVersion('0.0.0-dev')).toBeNull()
    expect(isNewer('0.4.1', '0.4.0')).toBe(true)
    expect(isNewer('0.10.0', '0.9.9')).toBe(true)
    expect(isNewer('1.0.0', '0.99.0')).toBe(true)
    expect(isNewer('0.4.0', '0.4.0')).toBe(false)
    expect(isNewer('0.3.9', '0.4.0')).toBe(false)
    expect(isNewer('0.4.1', '0.0.0-dev')).toBe(false)
  })

  it('fetchLatest: 태그에서 v 를 뗀 버전, 실패는 null', async () => {
    expect(await fetchLatest(release('v0.4.1'))).toBe('0.4.1')
    expect(await fetchLatest(release('v0.4.1', 404))).toBeNull()
    expect(await fetchLatest(release('nightly'))).toBeNull()
    expect(
      await fetchLatest(async () => {
        throw new Error('offline')
      }),
    ).toBeNull()
  })
})

describe('latestVersion — 하루 캐시', () => {
  it('하루 안에는 다시 묻지 않고, 지나면 다시 묻는다', async () => {
    const fetch = release('v0.4.1')
    const now = 1_000_000
    expect(await latestVersion({ configDir: dir, fetch, now })).toBe('0.4.1')
    expect(JSON.parse(await readFile(cachePath(dir), 'utf8'))).toEqual({ checkedAt: now, latest: '0.4.1' })
    expect(await latestVersion({ configDir: dir, fetch, now: now + CHECK_INTERVAL_MS - 1 })).toBe('0.4.1')
    expect(fetch).toHaveBeenCalledTimes(1)
    await latestVersion({ configDir: dir, fetch, now: now + CHECK_INTERVAL_MS })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('확인에 실패하면 이전 값을 유지하고 시각만 남긴다', async () => {
    await latestVersion({ configDir: dir, fetch: release('v0.4.1'), now: 0 })
    const down = vi.fn(async () => new Response('', { status: 503 }))
    expect(await latestVersion({ configDir: dir, fetch: down, now: CHECK_INTERVAL_MS })).toBe('0.4.1')
    expect(await latestVersion({ configDir: dir, fetch: down, now: CHECK_INTERVAL_MS + 1 })).toBe('0.4.1')
    expect(down).toHaveBeenCalledTimes(1)
  })
})

describe('notifyUpdate', () => {
  const base = (over: Partial<Parameters<typeof notifyUpdate>[0]> = {}) => {
    const write = vi.fn()
    const fetch = release('v0.4.1')
    return { write, fetch, deps: { version: '0.4.0', configDir: dir, env: {}, isTTY: true, write, fetch, ...over } }
  }

  it('새 버전이 있으면 알린다', async () => {
    const { write, deps } = base()
    await notifyUpdate(deps)
    expect(write).toHaveBeenCalledWith('새 버전 v0.4.1 이 있습니다(현재 v0.4.0) — minmo update 로 업데이트하세요.')
  })

  it.each([
    ['터미널이 아니면', { isTTY: false }],
    ['MINMO_NO_UPDATE_CHECK=1 이면', { env: { MINMO_NO_UPDATE_CHECK: '1' } }],
    ['개발 빌드면', { version: '0.0.0-dev' }],
  ])('%s 묻지도 알리지도 않는다', async (_l, over) => {
    const { write, fetch, deps } = base(over)
    await notifyUpdate(deps)
    expect(fetch).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
  })

  it('최신이면 조용하다', async () => {
    const { write, deps } = base({ version: '0.4.1' })
    await notifyUpdate(deps)
    expect(write).not.toHaveBeenCalled()
  })
})

describe('minmo update', () => {
  const deps = (tag: string, code = 0) => {
    const out = vi.fn()
    const run = vi.fn(async () => code)
    return { out, run, d: { version: '0.4.0', fetch: release(tag), run, out, platform: 'linux' as const } }
  }

  it('npm 명령 — Windows 는 셸로(npm.cmd)', () => {
    expect(npmInstall('linux')).toEqual({ cmd: 'npm', args: ['i', '-g', `${PACKAGE}@latest`], shell: false })
    expect(npmInstall('win32').shell).toBe(true)
  })

  it('--check 는 버전만 보여 준다', async () => {
    const { out, run, d } = deps('v0.4.1')
    await updateCmd(d, { check: true })
    expect(out).toHaveBeenCalledWith('현재 v0.4.0 · 최신 v0.4.1 — minmo update 로 업데이트하세요')
    expect(run).not.toHaveBeenCalled()
  })

  it('새 버전이 있으면 npm 으로 설치한다', async () => {
    const { out, run, d } = deps('v0.4.1')
    await updateCmd(d)
    expect(run).toHaveBeenCalledWith('npm', ['i', '-g', '@kangmomin/minmo-cli@latest'], false)
    expect(out).toHaveBeenLastCalledWith('v0.4.1 로 업데이트했습니다')
  })

  it('이미 최신이면 설치하지 않는다', async () => {
    const { out, run, d } = deps('v0.4.0')
    await updateCmd(d)
    expect(run).not.toHaveBeenCalled()
    expect(out).toHaveBeenCalledWith('이미 최신 버전입니다(v0.4.0)')
  })

  it('npm 이 실패하면 ~/.npmrc 설정을 안내한다', async () => {
    const { d } = deps('v0.4.1', 1)
    const err = await updateCmd(d).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CliError)
    expect((err as Error).message).toContain(NPMRC_HINT)
  })

  it('명령어로 연결된다(컨텍스트 없이)', async () => {
    const update = vi.fn(async () => {})
    const createCtx = vi.fn()
    const program = buildProgram({ createCtx, runTui: vi.fn(), version: '0.4.0', update }).exitOverride()
    await program.parseAsync(['node', 'minmo', 'update', '--check'])
    expect(update).toHaveBeenCalledWith({ check: true })
    expect(createCtx).not.toHaveBeenCalled()
  })
})
