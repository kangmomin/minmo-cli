// 지운 기능(E2E 큐, #92)이 작업 폴더에 남긴 .minmo/e2e 정리 (#111 CT-05)
import { act } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_CORE_ID } from '../../lib/defaultWorkspace'
import type { DirEntry, SshProbe } from '../../lib/tauri'
import { useHostsStore } from '../../store/hosts'
import { useSetupStore } from '../../store/setup'
import { createFakeTauri, ok } from '../../test/fakes'
import { makeDeps, renderHookWithDeps } from '../../test/render'
import { cleanupLegacyE2e, resetLegacyE2eCleanup, useLegacyE2eCleanup } from './legacyE2eCleanup'

const PATH = '/w/o-r-1'
const MINMO_DIR: DirEntry = { name: '.minmo', kind: 'dir' }

/** rel 별 listDir 결과(Error 면 실패) — 기본은 작업 폴더에 .minmo 폴더가 있고 그 안이 빈 상태 */
function ops(opts: { root?: DirEntry[] | Error; minmo?: DirEntry[] | Error; git?: boolean | Error; removeE2e?: Error } = {}) {
  const pick = <T>(v: T | Error): Promise<T> => (v instanceof Error ? Promise.reject(v) : Promise.resolve(v))
  return {
    listDir: vi.fn(async (_root: string, rel: string) => pick(rel === '' ? (opts.root ?? [MINMO_DIR]) : (opts.minmo ?? []))),
    pathExists: vi.fn(async (_path: string) => pick(opts.git ?? false)),
    removePath: vi.fn(async (_root: string, rel: string) => {
      if (rel === '.minmo/e2e' && opts.removeE2e) throw opts.removeE2e
    }),
  }
}

const removed = (o: ReturnType<typeof ops>) => o.removePath.mock.calls.map((c) => c[1])

describe('cleanupLegacyE2e', () => {
  it('.minmo/e2e 를 지우고, .minmo 가 비었고 .git 이 없으면 .minmo 도 지운다', async () => {
    const o = ops()
    await cleanupLegacyE2e(o, PATH)
    expect(o.removePath.mock.calls).toEqual([
      [PATH, '.minmo/e2e'],
      [PATH, '.minmo'],
    ])
    expect(o.listDir).toHaveBeenCalledWith(PATH, '.minmo')
    expect(o.pathExists).toHaveBeenCalledWith(`${PATH}/.minmo/.git`)
  })

  it('EC-01 .minmo 가 없으면 아무것도 지우지 않는다', async () => {
    const o = ops({ root: [{ name: 'src', kind: 'dir' }] })
    await cleanupLegacyE2e(o, PATH)
    expect(o.removePath).not.toHaveBeenCalled()
  })

  it('.minmo 가 링크면 아무것도 지우지 않는다', async () => {
    const o = ops({ root: [{ name: '.minmo', kind: 'link' }] })
    await cleanupLegacyE2e(o, PATH)
    expect(o.removePath).not.toHaveBeenCalled()
  })

  it('작업 폴더 목록을 읽지 못하면 아무것도 지우지 않는다', async () => {
    const o = ops({ root: new Error('ssh: unreachable') })
    await expect(cleanupLegacyE2e(o, PATH)).resolves.toBeUndefined()
    expect(o.removePath).not.toHaveBeenCalled()
  })

  it('EC-02 .minmo/e2e 를 지우지 못해도 오류를 내지 않고, 남은 것이 있으면 .minmo 는 그대로 둔다', async () => {
    const o = ops({ removeE2e: new Error('permission denied'), minmo: [{ name: 'e2e', kind: 'dir' }] })
    await expect(cleanupLegacyE2e(o, PATH)).resolves.toBeUndefined()
    expect(removed(o)).toEqual(['.minmo/e2e'])
  })

  it('EC-03 .minmo 에 다른 파일이 있으면 .minmo 는 그대로 둔다', async () => {
    const o = ops({ minmo: [{ name: 'notes.md', kind: 'file' }] })
    await cleanupLegacyE2e(o, PATH)
    expect(removed(o)).toEqual(['.minmo/e2e'])
  })

  it('EC-04 .minmo 목록을 읽지 못하면 .minmo 는 그대로 둔다', async () => {
    const o = ops({ minmo: new Error('read failed') })
    await expect(cleanupLegacyE2e(o, PATH)).resolves.toBeUndefined()
    expect(removed(o)).toEqual(['.minmo/e2e'])
  })

  it('.minmo/.git 이 있으면(목록에는 보이지 않는다) .minmo 는 그대로 둔다', async () => {
    const o = ops({ git: true })
    await cleanupLegacyE2e(o, PATH)
    expect(removed(o)).toEqual(['.minmo/e2e'])
  })

  it('.minmo/.git 을 확인하지 못하면 .minmo 는 그대로 둔다', async () => {
    const o = ops({ git: new Error('ssh: failed') })
    await expect(cleanupLegacyE2e(o, PATH)).resolves.toBeUndefined()
    expect(removed(o)).toEqual(['.minmo/e2e'])
  })
})

describe('useLegacyE2eCleanup', () => {
  const PROBE: SshProbe = { platform: 'linux', home: '/home/dev', git: 'git version 2.43.0', tmux: false }
  const LOCAL = 'o/r#1'
  const LOCAL2 = 'o/r#2'
  const REMOTE = 'ssh:dev|o/r#3'
  const ready = (id: string, path: string) => act(() => useSetupStore.getState().setOpen(id, { phase: 'ready', path, branch: 'b', pathChanged: false }))

  beforeEach(() => {
    resetLegacyE2eCleanup()
    useSetupStore.setState({ open: {}, logs: {} })
    useHostsStore.setState({ probes: {} })
  })

  function setup() {
    const { tauri } = createFakeTauri({ listDir: vi.fn(async (_root: string, rel: string) => (rel === '' ? [MINMO_DIR] : [])), sshExec: vi.fn(async () => ok('')) })
    renderHookWithDeps(() => useLegacyE2eCleanup(), makeDeps({ tauri }))
    return tauri
  }

  it('작업 폴더가 열리면 한 번 정리하고, 같은 폴더를 다시 열어도 다시 하지 않는다', async () => {
    const tauri = setup()
    ready(LOCAL, '/w/1')
    await vi.waitFor(() => expect(tauri.removePath).toHaveBeenCalledWith('/w/1', '.minmo/e2e'))
    const before = vi.mocked(tauri.removePath).mock.calls.length
    act(() => useSetupStore.getState().setOpen(LOCAL, { phase: 'opening' }))
    ready(LOCAL, '/w/1')
    // 다른 이슈가 열리면 그 폴더만 정리한다
    ready(LOCAL2, '/w/2')
    await vi.waitFor(() => expect(tauri.removePath).toHaveBeenCalledWith('/w/2', '.minmo/e2e'))
    const paths = vi.mocked(tauri.removePath).mock.calls.slice(before).map((c) => c[0])
    expect(paths.every((p) => p === '/w/2')).toBe(true)
  })

  it('준비 로그만 늘어나면 다시 훑지 않는다', async () => {
    const tauri = setup()
    ready(LOCAL, '/w/1')
    await vi.waitFor(() => expect(tauri.removePath).toHaveBeenCalledWith('/w/1', '.minmo'))
    const listed = vi.mocked(tauri.listDir).mock.calls.length
    act(() => useSetupStore.getState().appendLog({ issueId: LOCAL, step: 'script', status: 'start' }))
    await act(async () => {})
    expect(vi.mocked(tauri.listDir).mock.calls.length).toBe(listed)
  })

  it('원격 이슈인데 연결 정보가 없으면 이 PC 에서 지우지 않고, 연결되면 원격에서 정리한다', async () => {
    const tauri = setup()
    ready(REMOTE, '/home/dev/w/3')
    await act(async () => {})
    expect(tauri.listDir).not.toHaveBeenCalled()
    expect(tauri.removePath).not.toHaveBeenCalled()
    act(() => useHostsStore.getState().setProbe('dev', PROBE))
    // 원격 ops 는 ssh 로 스크립트를 돌린다 — 그 호스트·작업 폴더로 부른다
    await vi.waitFor(() => expect(tauri.sshExec).toHaveBeenCalled())
    const call = vi.mocked(tauri.sshExec).mock.calls[0]
    expect(call[0]).toBe('dev')
    expect(call[1]).toContain('/home/dev/w/3')
    expect(tauri.listDir).not.toHaveBeenCalled()
    expect(tauri.removePath).not.toHaveBeenCalled()
  })

  // #120 EC-13 — 기본의 작업 폴더는 그 호스트의 홈이다. 홈의 ~/.minmo 는 지운 기능의 결과 폴더가 아니다
  it('EC-13 기본(작업 폴더 = 홈)은 정리하지 않는다 — 다른 이슈의 작업 폴더는 그대로 정리한다', async () => {
    const tauri = setup()
    ready(DEFAULT_CORE_ID, '/home/u')
    ready(LOCAL, '/w/1')
    await vi.waitFor(() => expect(tauri.removePath).toHaveBeenCalledWith('/w/1', '.minmo/e2e'))
    await act(async () => {})
    expect(vi.mocked(tauri.listDir).mock.calls.map((c) => c[0])).not.toContain('/home/u')
    expect(vi.mocked(tauri.removePath).mock.calls.map((c) => c[0])).not.toContain('/home/u')
  })

  it('정리가 실패해도 오류가 밖으로 나오지 않는다', async () => {
    const { tauri } = createFakeTauri({ listDir: vi.fn(async () => Promise.reject(new Error('boom'))) })
    renderHookWithDeps(() => useLegacyE2eCleanup(), makeDeps({ tauri }))
    ready(LOCAL, '/w/1')
    await vi.waitFor(() => expect(tauri.listDir).toHaveBeenCalled())
    expect(tauri.removePath).not.toHaveBeenCalled()
  })
})
