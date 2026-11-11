// 원격 호스트 — id 규칙, 호스트 영역의 deps, 사이드바 전환·연결 실패 안내, 호스트 관리 대화상자, 원격 터미널 요청
import { act, renderHook, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { worktreeId } from '@minmo/core'

import { useDeps } from '../../app/deps'
import { HostScope, aliasOfIssue, coreIdOf, hostOf, useHost, useHostConnection } from '../../app/host'
import { TooltipProvider } from '../../components/ui/tooltip'
import type { SshHostInfo, SshHostInput, SshProbe } from '../../lib/tauri'
import { useHostsStore } from '../../store/hosts'
import { useSessionStore } from '../../store/session'
import { useUiStore } from '../../store/ui'
import { createFakeApi, createFakeGitHub, createFakeTauri, deferred } from '../../test/fakes'
import { makeDeps, makeWrapper, renderWithDeps } from '../../test/render'
import { Sidebar } from '../tree/Sidebar'
import { useRefreshTree } from '../tree/useTree'
import { HostsDialog } from './HostsDialog'

const PROBE: SshProbe = { platform: 'linux', home: '/home/dev', git: 'git version 2.43.0', tmux: true }
const cfg = (alias: string, hostName: string | null = null, user: string | null = null): SshHostInfo => ({ alias, hostName, user, source: 'config', port: null, identityFile: null })

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
    expect(coreIdOf(remote.issueId('acme', 'app', '1'))).toBe(worktreeId('acme', 'app', '1'))
    expect(coreIdOf(local.issueId('acme', 'app', '1'))).toBe(worktreeId('acme', 'app', '1'))
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
    expect(tauri.sshProbe).toHaveBeenCalledWith('my-server', false)
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
    expect(tauri.sshProbe).toHaveBeenCalledWith('my-server', false)
    expect(screen.queryByTestId('host-unavailable')).toBeNull()
  })

  it('연결 실패 → 원인 안내 + [다시 시도] · [이 PC 로 전환]', async () => {
    const sshProbe = vi.fn<(h: string) => Promise<SshProbe>>().mockRejectedValue({ kind: 'host_key', message: 'Host key verification failed.' })
    const { user } = setup(sshProbe)
    await user.selectOptions(screen.getByRole('combobox', { name: '작업 호스트' }), 'my-server')
    expect(await screen.findByRole('alert')).toHaveTextContent('처음 접속하는 호스트이거나')
    // 사용자가 고르면 호스트 키를 등록하고 연결한다(자동으로 하지 않는다)
    expect(screen.getByRole('button', { name: '호스트 키 등록하고 연결' })).toBeInTheDocument()

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

describe('연결 확인 값', () => {
  it('실행 중에는 처음 확인한 값을 유지한다(열린 터미널이 다시 만들어지지 않게)', () => {
    useHostsStore.getState().setProbe('my-server', { ...PROBE, tmux: false })
    useHostsStore.getState().setProbe('my-server', PROBE)
    expect(useHostsStore.getState().probes['my-server'].tmux).toBe(false)
  })
})

describe('HostsDialog', () => {
  it('ssh 설정의 호스트를 보여 주고 연결 확인·추가·빼기를 한다', async () => {
    const { tauri } = createFakeTauri({
      sshHosts: async () => [cfg('my-server', '10.0.0.5', 'dev'), cfg('bad')],
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

  it('호스트를 직접 등록한다 — 등록하면 작업 호스트 목록에 들어가고, 수정·삭제할 수 있다', async () => {
    let saved: SshHostInfo[] = []
    const { tauri } = createFakeTauri({
      sshHosts: async () => saved,
      sshHostSave: async (h: SshHostInput) => {
        if (h.alias === 'bad name') throw '이름은 영문·숫자와 . _ - 만 쓸 수 있습니다'
        saved = [...saved.filter((x) => x.alias !== h.alias), { ...h, source: 'app' }]
        return saved
      },
      sshHostRemove: async (alias) => (saved = saved.filter((x) => x.alias !== alias)),
    })
    const user = userEvent.setup()
    renderWithDeps(<HostsDialog open onOpenChange={() => {}} />, makeDeps({ tauri }))
    await user.click(await screen.findByRole('button', { name: '호스트 직접 등록' }))
    const form = screen.getByRole('form', { name: '호스트 직접 등록' })
    await user.type(within(form).getByLabelText('이름'), 'bad name')
    await user.type(within(form).getByLabelText('호스트 주소'), '10.0.0.9')
    await user.type(within(form).getByLabelText('사용자'), 'ubuntu')
    await user.clear(within(form).getByLabelText('포트'))
    await user.type(within(form).getByLabelText('포트'), '70000')
    await user.click(within(form).getByRole('button', { name: '등록' }))
    expect(within(form).getByRole('alert')).toHaveTextContent('포트는 1~65535')
    expect(tauri.sshHostSave).not.toHaveBeenCalled()

    await user.clear(within(form).getByLabelText('포트'))
    await user.type(within(form).getByLabelText('포트'), '2222')
    await user.click(within(form).getByRole('button', { name: '등록' }))
    // 서버(Rust) 검증 오류는 폼에 그대로 보여 준다
    expect(await within(form).findByRole('alert')).toHaveTextContent('영문·숫자')

    await user.clear(within(form).getByLabelText('이름'))
    await user.type(within(form).getByLabelText('이름'), 'office-dev')
    await user.type(within(form).getByLabelText('키 파일 (선택)'), '~/.ssh/id_ed25519')
    await user.click(within(form).getByRole('button', { name: '등록' }))
    const row = await screen.findByTestId('ssh-host-office-dev')
    expect(tauri.sshHostSave).toHaveBeenLastCalledWith({ alias: 'office-dev', hostName: '10.0.0.9', user: 'ubuntu', port: 2222, identityFile: '~/.ssh/id_ed25519' })
    expect(row).toHaveTextContent('ubuntu@10.0.0.9:2222')
    expect(row).toHaveTextContent('앱에 등록')
    expect(useHostsStore.getState().aliases).toEqual(['office-dev'])

    // 수정: 이름은 바꿀 수 없다
    await user.click(within(row).getByRole('button', { name: '수정' }))
    const edit = screen.getByRole('form', { name: '호스트 수정' })
    expect(within(edit).getByLabelText('이름')).toBeDisabled()
    await user.click(within(edit).getByRole('button', { name: '취소' }))

    await user.click(within(screen.getByTestId('ssh-host-office-dev')).getByRole('button', { name: 'office-dev 등록 삭제' }))
    await waitFor(() => expect(screen.queryByTestId('ssh-host-office-dev')).toBeNull())
    expect(useHostsStore.getState().aliases).toEqual([])
  })

  it('처음 접속하는 호스트 → [호스트 키 등록하고 연결] 로 등록 후 연결', async () => {
    const sshProbe = vi.fn(async (_h: string, trustNew?: boolean): Promise<SshProbe> => {
      if (!trustNew) throw { kind: 'host_key', message: 'Host key verification failed.' }
      return PROBE
    })
    const { tauri } = createFakeTauri({ sshHosts: async () => [cfg('new-host')], sshProbe })
    const user = userEvent.setup()
    renderWithDeps(<HostsDialog open onOpenChange={() => {}} />, makeDeps({ tauri }))
    const row = await screen.findByTestId('ssh-host-new-host')
    await user.click(within(row).getByRole('button', { name: '연결 확인' }))
    await user.click(await within(row).findByRole('button', { name: '호스트 키 등록하고 연결' }))
    expect(await within(row).findByText(/^연결됨/)).toBeInTheDocument()
    expect(sshProbe).toHaveBeenLastCalledWith('new-host', true)
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
