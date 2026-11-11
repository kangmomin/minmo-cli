// 원격 호스트 — id 규칙, 호스트 영역의 deps, 사이드바 전환·연결 실패 안내, 호스트 관리 대화상자, 원격 터미널 요청
import { act, renderHook, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { worktreeId } from '@minmo/core'

import { useDeps } from '../../app/deps'
import { HostScope, aliasOfIssue, hostOf, useHost, useHostConnection } from '../../app/host'
import { TooltipProvider } from '../../components/ui/tooltip'
import type { SshProbe } from '../../lib/tauri'
import { useHostsStore } from '../../store/hosts'
import { useSessionStore } from '../../store/session'
import { useUiStore } from '../../store/ui'
import { createFakeApi, createFakeGitHub, createFakeTauri, deferred } from '../../test/fakes'
import { makeDeps, makeWrapper, renderWithDeps } from '../../test/render'
import { Sidebar } from '../tree/Sidebar'
import { useRefreshTree } from '../tree/useTree'
import { HostsDialog } from './HostsDialog'

const PROBE: SshProbe = { platform: 'linux', home: '/home/dev', git: 'git version 2.43.0', tmux: true }

beforeEach(() => {
  localStorage.clear()
  useHostsStore.setState({ aliases: [], selected: null, probes: {}, connecting: null, error: null })
  useSessionStore.setState(useSessionStore.getInitialState(), true)
  useSessionStore.setState({ token: 'tok', status: 'online' })
  useUiStore.setState({ expanded: {}, worktreePathMap: {}, selectedIssueId: null })
})

describe('호스트 id', () => {
  it('이 PC 는 core id 그대로, 원격은 ssh:<별칭>| 접두사', () => {
    const local = hostOf(null)
    const remote = hostOf('my-server', true)
    expect(local.issueId('acme', 'app', '1')).toBe(worktreeId('acme', 'app', '1'))
    expect(remote.issueId('acme', 'app', '1')).toBe(`ssh:my-server|${worktreeId('acme', 'app', '1')}`)
    expect(local.owns(local.issueId('acme', 'app', '1'))).toBe(true)
    expect(local.owns(remote.issueId('acme', 'app', '1'))).toBe(false)
    expect(remote.owns(remote.issueId('acme', 'app', '1'))).toBe(true)
    // 별칭이 다른 별칭의 접두사여도 섞이지 않는다
    expect(hostOf('my').owns(remote.issueId('acme', 'app', '1'))).toBe(false)
    expect(aliasOfIssue(remote.issueId('acme', 'app', '1'))).toBe('my-server')
    expect(aliasOfIssue(local.issueId('acme', 'app', '1'))).toBeNull()
  })
})

describe('HostScope', () => {
  function wrapper(alias: string | null, deps = makeDeps()) {
    const Base = makeWrapper(deps)
    return ({ children }: { children: ReactNode }) => (
      <Base>
        <HostScope alias={alias}>{children}</HostScope>
      </Base>
    )
  }

  it('연결을 확인한 원격 영역에서는 home·platform·git 이 원격 것', async () => {
    useHostsStore.setState({ probes: { 'my-server': { ...PROBE, platform: 'darwin', home: '/Users/dev' } } })
    const { tauri } = createFakeTauri()
    const { result } = renderHook(() => ({ deps: useDeps(), host: useHost() }), { wrapper: wrapper('my-server', makeDeps({ tauri })) })
    expect(result.current.host.alias).toBe('my-server')
    expect(result.current.deps.home).toBe('/Users/dev')
    expect(result.current.deps.platform).toBe('darwin')
    await result.current.deps.tauri.gitRun(['status'])
    expect(tauri.sshExec).toHaveBeenCalledWith('my-server', ['git', 'status'], expect.anything())
    expect(tauri.gitRun).not.toHaveBeenCalled()
  })

  it('확인하지 못한 원격은 이 PC 로 둔다(원격 명령을 보내지 않는다)', () => {
    const { result } = renderHook(() => ({ deps: useDeps(), host: useHost() }), { wrapper: wrapper('my-server') })
    expect(result.current.host.alias).toBeNull()
    expect(result.current.deps.home).toBe('/home/u')
  })
})

describe('useHostConnection', () => {
  it('원격을 고르면 확인 후 전환하고, 실패하면 오류를 남긴다', async () => {
    const probe = deferred<SshProbe>()
    const { tauri } = createFakeTauri({ sshProbe: () => probe.promise })
    const { result } = renderHook(() => useHostConnection(), { wrapper: makeWrapper(makeDeps({ tauri })) })
    expect(result.current.ready).toBe(true)

    act(() => void result.current.connect('my-server'))
    await waitFor(() => expect(result.current.connecting).toBe(true))
    expect(result.current.ready).toBe(false)
    await act(async () => probe.resolve(PROBE))
    expect(result.current).toMatchObject({ selected: 'my-server', ready: true, connecting: false, error: null })

    tauri.sshProbe.mockRejectedValueOnce({ kind: 'auth', message: 'Permission denied (publickey).' })
    await act(() => result.current.connect('other'))
    expect(result.current).toMatchObject({ selected: 'other', ready: false, error: { kind: 'auth' } })

    await act(() => result.current.connect(null))
    expect(result.current).toMatchObject({ selected: null, ready: true, error: null })
  })

  it('지난 실행에서 고른 원격은 시작할 때 다시 연결한다', async () => {
    useHostsStore.setState({ aliases: ['my-server'], selected: 'my-server' })
    const { tauri } = createFakeTauri({ sshProbe: async () => PROBE })
    const { result } = renderHook(() => useHostConnection(), { wrapper: makeWrapper(makeDeps({ tauri })) })
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(tauri.sshProbe).toHaveBeenCalledWith('my-server')
  })
})

describe('사이드바 호스트 전환', () => {
  function Harness() {
    const connection = useHostConnection()
    return (
      <HostScope alias={connection.ready ? connection.selected : null}>
        <TooltipProvider>
          <Sidebar connection={connection} onOpenSettings={() => {}} />
        </TooltipProvider>
      </HostScope>
    )
  }

  function setup(sshProbe: (host: string) => Promise<SshProbe>) {
    useHostsStore.setState({ aliases: ['my-server'] })
    const { tauri } = createFakeTauri({ sshProbe })
    const github = createFakeGitHub({ listOwners: async () => [{ login: 'acme', kind: 'org' as const, avatarUrl: null }], listRepos: async () => [] })
    renderWithDeps(<Harness />, makeDeps({ tauri, github, api: createFakeApi() }))
    return { tauri, user: userEvent.setup() }
  }

  it('목록에 "이 PC" 와 추가한 호스트가 있고, 고르면 연결한다', async () => {
    const { tauri, user } = setup(async () => PROBE)
    const select = screen.getByRole('combobox', { name: '작업 호스트' })
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['이 PC', 'my-server'])
    await user.selectOptions(select, 'my-server')
    await waitFor(() => expect(useHostsStore.getState().probes['my-server']).toEqual(PROBE))
    expect(tauri.sshProbe).toHaveBeenCalledWith('my-server')
    expect(screen.queryByTestId('host-unavailable')).toBeNull()
  })

  it('연결 실패 → 원인 안내 + [다시 시도] · [이 PC 로 전환]', async () => {
    const sshProbe = vi.fn<(h: string) => Promise<SshProbe>>().mockRejectedValue({ kind: 'host_key', message: 'Host key verification failed.' })
    const { user } = setup(sshProbe)
    await user.selectOptions(screen.getByRole('combobox', { name: '작업 호스트' }), 'my-server')
    expect(await screen.findByRole('alert')).toHaveTextContent('`ssh my-server` 로 한 번 접속')

    sshProbe.mockResolvedValueOnce(PROBE)
    await user.click(screen.getByRole('button', { name: '다시 시도' }))
    await waitFor(() => expect(screen.queryByTestId('host-unavailable')).toBeNull())

    sshProbe.mockRejectedValueOnce({ kind: 'unreachable', message: 'timed out' })
    await user.selectOptions(screen.getByRole('combobox', { name: '작업 호스트' }), '')
    expect(useHostsStore.getState().selected).toBeNull()
  })
})

describe('새로고침', () => {
  it('지금 보는 호스트의 worktree 기록만 확인한다 — 다른 호스트의 기록은 지우지 않는다', async () => {
    const local = hostOf(null).issueId('acme', 'app', '1')
    const remote = hostOf('my-server', true).issueId('acme', 'app', '2')
    useUiStore.setState({ worktreePathMap: { [local]: { path: 'C:\\w\\1', branch: 'a' }, [remote]: { path: '/w/2', branch: 'b' } } })
    const { tauri } = createFakeTauri({ pathExists: async () => false })
    const { result } = renderHook(() => useRefreshTree(), { wrapper: makeWrapper(makeDeps({ tauri })) })
    await act(() => result.current())
    expect(tauri.pathExists).toHaveBeenCalledTimes(1)
    expect(tauri.pathExists).toHaveBeenCalledWith('C:\\w\\1')
    expect(Object.keys(useUiStore.getState().worktreePathMap)).toEqual([remote])
  })
})

describe('HostsDialog', () => {
  it('ssh 설정의 호스트를 보여 주고 연결 확인·추가·빼기를 한다', async () => {
    const { tauri } = createFakeTauri({
      sshHosts: async () => [
        { alias: 'my-server', hostName: '10.0.0.5', user: 'dev' },
        { alias: 'bad', hostName: null, user: null },
      ],
      sshProbe: async (h) => {
        if (h === 'bad') throw { kind: 'unsupported_os', message: '지원하지 않는 OS: FreeBSD' }
        return PROBE
      },
    })
    const user = userEvent.setup()
    renderWithDeps(<HostsDialog open onOpenChange={() => {}} />, makeDeps({ tauri }))

    const row = await screen.findByTestId('ssh-host-my-server')
    expect(row).toHaveTextContent('dev@10.0.0.5')
    await user.click(within(row).getByRole('button', { name: '연결 확인' }))
    expect(await within(row).findByText('연결됨 — Linux · git 2.43.0 · tmux 있음')).toBeInTheDocument()

    await user.click(within(row).getByRole('button', { name: '추가' }))
    expect(useHostsStore.getState().aliases).toEqual(['my-server'])
    await user.click(within(row).getByRole('button', { name: '빼기' }))
    expect(useHostsStore.getState().aliases).toEqual([])

    const bad = screen.getByTestId('ssh-host-bad')
    await user.click(within(bad).getByRole('button', { name: '연결 확인' }))
    expect(await within(bad).findByText(/Linux·macOS 만 지원/)).toBeInTheDocument()
  })

  it('설정에 호스트가 없으면 안내한다 · 설정에서 사라진 호스트는 뺄 수 있다', async () => {
    const { tauri } = createFakeTauri({ sshHosts: async () => [] })
    const { unmount } = renderWithDeps(<HostsDialog open onOpenChange={() => {}} />, makeDeps({ tauri }))
    expect(await screen.findByText(/Host 항목이 없습니다/)).toBeInTheDocument()
    unmount()

    useHostsStore.setState({ aliases: ['gone'], selected: 'gone' })
    const user = userEvent.setup()
    renderWithDeps(<HostsDialog open onOpenChange={() => {}} />, makeDeps({ tauri }))
    const row = await screen.findByTestId('ssh-host-gone')
    expect(row).toHaveTextContent('더 이상 없는 호스트')
    await user.click(within(row).getByRole('button', { name: '빼기' }))
    expect(useHostsStore.getState()).toMatchObject({ aliases: [], selected: null })
  })
})
