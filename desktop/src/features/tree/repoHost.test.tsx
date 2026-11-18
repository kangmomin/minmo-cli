// 저장소별 연결 호스트(#57) — 저장, 연결 확인 뒤에만 그 호스트로 보이기(HostGate), 트리·이슈 패널·프로젝트 설정
import { act, renderHook, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Effective, SettingsRecord } from '@minmo/api-client'
import { DEFAULT_SETTINGS } from '@minmo/core'
import type { GitHubIssue } from '@minmo/core'

import { HostGate } from '../../app/HostGate'
import { HostScope, useHost, useHostStatus } from '../../app/host'
import { Workspace } from '../../app/Workspace'
import { TooltipProvider } from '../../components/ui/tooltip'
import type { SshProbe } from '../../lib/tauri'
import { aliasOfHostId, hostIdOf, repoHostOf, useHostsStore } from '../../store/hosts'
import { useSessionStore } from '../../store/session'
import { useSetupStore } from '../../store/setup'
import { useUiStore } from '../../store/ui'
import { createFakeApi, createFakeGitHub, createFakeTauri, deferred } from '../../test/fakes'
import { makeDeps, makeWrapper, renderWithDeps } from '../../test/render'
import { WorktreeProvider } from '../issue/useWorktree'
import { consumeHash, deepLinkAlias, useDeepLinkOpen } from '../remote/deepLink'
import { SettingsDialog } from '../settings/SettingsDialog'
import { useHasWorktree } from './useVisibleRepos'

const PROBE: SshProbe = { platform: 'linux', home: '/home/dev', git: 'git version 2.43.0', tmux: false }
const ORG = { login: 'my-org', kind: 'org' as const, avatarUrl: null }
const WIDGETS = { owner: 'my-org', name: 'widgets', defaultBranch: 'main' }
const GADGETS = { owner: 'my-org', name: 'gadgets', defaultBranch: 'main' }
const issue = (number: number, title: string): GitHubIssue => ({ number, title, state: 'open', htmlUrl: `https://github.com/my-org/x/issues/${number}`, assignees: [] })

beforeEach(() => {
  localStorage.clear()
  useHostsStore.setState({ aliases: ['srv'], selected: null, probes: {}, connecting: {}, errors: {}, baseRepos: {}, baseDirs: {}, repoHosts: {} })
  useSessionStore.setState(useSessionStore.getInitialState(), true)
  useSessionStore.setState({ token: 'tok', status: 'online', me: { id: 'usr_x', githubLogin: 'octocat', avatarUrl: null } })
  useUiStore.setState({ expanded: {}, selectedIssueId: null, tab: 'terminal', worktreePathMap: {}, terminalIds: {}, treeAgentsOnly: false })
  useSetupStore.setState({ targets: {}, open: {}, script: {}, logs: {} })
})

describe('연결 호스트 저장', () => {
  it('저장소마다 호스트 id 로 저장하고(대소문자 무시), 해제하면 작업 호스트를 따른다', () => {
    const st = useHostsStore.getState()
    st.setRepoHost('My-Org', 'Widgets', hostIdOf('srv'))
    st.setRepoHost('my-org', 'gadgets', hostIdOf(null))
    expect(repoHostOf(useHostsStore.getState(), 'my-org', 'widgets')).toBe('ssh:srv')
    expect(repoHostOf(useHostsStore.getState(), 'my-org', 'gadgets')).toBe('local')
    // 이 PC 에 저장한다(앱을 다시 켜도 남는다)
    expect(JSON.parse(localStorage.getItem('minmo-hosts')!).state.repoHosts).toEqual({ 'my-org/widgets': 'ssh:srv', 'my-org/gadgets': 'local' })
    st.setRepoHost('my-org', 'gadgets', null)
    expect(repoHostOf(useHostsStore.getState(), 'my-org', 'gadgets')).toBeUndefined()
  })

  it('호스트를 목록에서 빼도 연결 호스트는 남는다 — 목록은 기기마다 따로지만 연결 호스트는 함께 쓴다', () => {
    useHostsStore.setState({ aliases: ['srv', 'other'], repoHosts: { 'a/1': 'ssh:srv', 'a/2': 'ssh:other' }, errors: { srv: { kind: 'auth', message: 'x' } } })
    useHostsStore.getState().remove('srv')
    expect(useHostsStore.getState()).toMatchObject({ aliases: ['other'], repoHosts: { 'a/1': 'ssh:srv', 'a/2': 'ssh:other' }, errors: {} })
  })

  it('호스트 id ↔ 별칭', () => {
    expect(aliasOfHostId('local')).toBeNull()
    expect(aliasOfHostId('ssh:srv')).toBe('srv')
    expect(aliasOfHostId('ssh:')).toBeUndefined()
    expect(aliasOfHostId('srv')).toBeUndefined()
  })
})

describe('HostGate', () => {
  function HostId() {
    return <span data-testid="host-id">{useHost().id}</span>
  }

  it('연결을 확인하기 전에는 내용 대신 상태를 보이고, 같은 호스트는 한 번만 접속한다 → 연결되면 그 호스트로 보인다', async () => {
    const probe = deferred<SshProbe>()
    const { tauri } = createFakeTauri({ sshProbe: () => probe.promise })
    renderWithDeps(
      <>
        <HostGate alias="srv">
          <HostId />
        </HostGate>
        <HostGate alias="srv">
          <HostId />
        </HostGate>
      </>,
      makeDeps({ tauri }),
    )
    expect(await screen.findAllByText('srv 에 연결하는 중…')).toHaveLength(2)
    expect(screen.queryByTestId('host-id')).toBeNull()
    expect(tauri.sshProbe).toHaveBeenCalledTimes(1)
    await act(async () => probe.resolve(PROBE))
    expect(screen.getAllByTestId('host-id').map((e) => e.textContent)).toEqual(['ssh:srv', 'ssh:srv'])
  })

  it('실패하면 다시 접속하지 않고 오류와 [다시 시도] 를 보인다 — 호스트 키 오류는 키를 등록하고 연결한다', async () => {
    const { tauri } = createFakeTauri({ sshProbe: async () => Promise.reject({ kind: 'host_key', message: 'Host key verification failed.' }) })
    renderWithDeps(
      <HostGate alias="srv">
        <HostId />
      </HostGate>,
      makeDeps({ tauri }),
    )
    expect(await screen.findByRole('alert')).toHaveTextContent('호스트 키')
    expect(tauri.sshProbe).toHaveBeenCalledTimes(1)
    tauri.sshProbe.mockResolvedValueOnce(PROBE)
    await userEvent.setup().click(screen.getByRole('button', { name: '호스트 키 등록하고 연결' }))
    expect(tauri.sshProbe).toHaveBeenLastCalledWith('srv', true)
    expect(await screen.findByTestId('host-id')).toHaveTextContent('ssh:srv')
  })

  it('연결 기록이 지워지면(호스트 정보 수정) 다시 접속한다', async () => {
    const { tauri } = createFakeTauri({ sshProbe: async () => PROBE })
    const { result } = renderHook(() => useHostStatus('srv'), { wrapper: makeWrapper(makeDeps({ tauri })) })
    await waitFor(() => expect(result.current.ready).toBe(true))
    act(() => useHostsStore.getState().clearProbe('srv'))
    await waitFor(() => expect(tauri.sshProbe).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(result.current.ready).toBe(true))
  })

  it('이 PC(null)는 바로 보인다', () => {
    const { tauri } = createFakeTauri()
    renderWithDeps(
      <HostGate alias={null}>
        <HostId />
      </HostGate>,
      makeDeps({ tauri }),
    )
    expect(screen.getByTestId('host-id')).toHaveTextContent('local')
    expect(tauri.sshProbe).not.toHaveBeenCalled()
  })
})

describe('트리 — 연결 호스트를 정한 저장소', () => {
  const wrap = (ui: ReactNode) => (
    <TooltipProvider>
      <WorktreeProvider>{ui}</WorktreeProvider>
    </TooltipProvider>
  )

  function renderTree(probe: Promise<SshProbe>) {
    const github = createFakeGitHub({
      listOwners: async () => [ORG],
      listRepos: async () => [WIDGETS, GADGETS],
      listIssues: async (_o, repo) => (repo === 'widgets' ? [issue(1, 'Bound')] : [issue(2, 'Follow')]),
      defaultBranch: async () => 'main',
    })
    const api = createFakeApi({ getEffective: async () => ({ values: { ...DEFAULT_SETTINGS }, sources: {} }) as unknown as Effective })
    const { tauri } = createFakeTauri({ sshProbe: () => probe })
    renderWithDeps(wrap(<Workspace />), makeDeps({ github, api, tauri }))
    return { tauri, user: userEvent.setup() }
  }

  it('작업 호스트가 이 PC 여도 그 저장소의 이슈는 연결 호스트에서 연다(연결 전에는 이슈 목록이 없다)', async () => {
    useHostsStore.getState().setRepoHost('my-org', 'widgets', 'ssh:srv')
    const probe = deferred<SshProbe>()
    const { tauri, user } = renderTree(probe.promise)
    await user.click(await screen.findByTestId('org-node-my-org'))

    // 연결 중: 이름·상태만, 펼칠 수 없다
    const pending = await screen.findByTestId('repo-pending-my-org/widgets')
    expect(within(pending).getByTestId('repo-host-badge')).toHaveTextContent('srv')
    expect(within(pending).getByRole('status')).toHaveTextContent('srv 에 연결하는 중…')
    expect(screen.queryByTestId('repo-node-my-org/widgets')).toBeNull()
    // 정하지 않은 저장소는 지금처럼(배지 없음)
    expect(within(screen.getByTestId('repo-node-my-org/gadgets')).queryByTestId('repo-host-badge')).toBeNull()

    await act(async () => probe.resolve(PROBE))
    const node = await screen.findByTestId('repo-node-my-org/widgets')
    expect(within(node).getByTestId('repo-host-badge')).toHaveTextContent('srv')
    await user.click(node)
    await user.click(await screen.findByTestId('issue-row-1'))

    await waitFor(() => expect(useUiStore.getState().selectedIssueId).toBe('ssh:srv|my-org/widgets#1'))
    await waitFor(() => expect(tauri.sshExec).toHaveBeenCalled())
    expect(tauri.sshExec.mock.calls.every(([alias]) => alias === 'srv')).toBe(true)
    // 이슈 패널도 그 호스트 기준(호스트 배지)
    expect(await screen.findByTestId('issue-host')).toHaveTextContent('srv')
  })

  it('정하지 않은 저장소는 작업 호스트(이 PC)에서 연다', async () => {
    useHostsStore.getState().setRepoHost('my-org', 'widgets', 'ssh:srv')
    const { tauri, user } = renderTree(new Promise(() => {}))
    await user.click(await screen.findByTestId('org-node-my-org'))
    await user.click(await screen.findByTestId('repo-node-my-org/gadgets'))
    await user.click(await screen.findByTestId('issue-row-2'))
    await waitFor(() => expect(useUiStore.getState().selectedIssueId).toBe('my-org/gadgets#2'))
    expect(tauri.sshExec).not.toHaveBeenCalled()
  })

  it('선택된 이슈의 호스트에 아직 연결하지 않았으면, 이 PC 로 바꾸지 않고 연결한 뒤에 패널을 보인다', async () => {
    const id = 'ssh:srv|my-org/widgets#1'
    useSetupStore.setState({ targets: { [id]: { owner: 'my-org', repo: 'widgets', key: '1', number: 1, title: 'Bound' } } })
    useUiStore.setState({ selectedIssueId: id })
    const probe = deferred<SshProbe>()
    renderTree(probe.promise)
    expect(await screen.findByTestId('issue-host-status')).toHaveTextContent('srv 에 연결하는 중…')
    expect(screen.queryByTestId('issue-host')).toBeNull()
    // 작업 탭(모든 이슈의 터미널을 든 곳)은 내리지 않는다
    expect(screen.getByRole('tab', { name: '터미널' })).toBeInTheDocument()
    await act(async () => probe.resolve(PROBE))
    expect(await screen.findByTestId('issue-host')).toHaveTextContent('srv')
  })
})

describe('useHasWorktree — 저장소가 지금 쓰는 호스트의 기록만 센다', () => {
  const wrapper = ({ children }: { children: ReactNode }) => {
    const Base = makeWrapper(makeDeps())
    return (
      <Base>
        <HostScope alias={null}>{children}</HostScope>
      </Base>
    )
  }

  it('연결 호스트를 정하면 그 호스트의 worktree 로, 아니면 작업 호스트의 worktree 로 판단한다', () => {
    useUiStore.setState({
      worktreePathMap: { 'ssh:srv|my-org/widgets#1': { path: '/w', branch: 'b' }, 'my-org/gadgets#2': { path: '/g', branch: 'b' } },
    })
    const { result, rerender } = renderHook(() => useHasWorktree(), { wrapper })
    expect(result.current('my-org', 'widgets')).toBe(false)
    expect(result.current('my-org', 'gadgets')).toBe(true)

    act(() => useHostsStore.setState({ repoHosts: { 'my-org/widgets': 'ssh:srv', 'my-org/gadgets': 'ssh:srv' } }))
    rerender()
    expect(result.current('my-org', 'widgets')).toBe(true)
    expect(result.current('my-org', 'gadgets')).toBe(false)
    expect(result.current('My-Org')).toBe(true)
    expect(result.current('other')).toBe(false)
  })
})

describe('프로젝트 설정 — 연결 호스트', () => {
  const EMPTY: SettingsRecord = {
    branchTemplate: null,
    etcBranchName: null,
    worktreePath: null,
    mainClonePath: null,
    postCreateScript: null,
    sparsePaths: null,
    postCreateScriptPosix: null,
    ignoredCopyExclude: null,
    updatedAt: null,
  }
  const GLOBAL: SettingsRecord = {
    ...EMPTY,
    branchTemplate: 'issue/{number}-{slug}',
    etcBranchName: 'etc',
    worktreePath: '~/minmo-workspaces/{owner}/{repo}/{branch}',
    mainClonePath: '~/minmo-workspaces/{owner}/{repo}/_main',
    postCreateScript: '',
    sparsePaths: '',
    postCreateScriptPosix: '',
    ignoredCopyExclude: 'node_modules',
    updatedAt: '2026-11-09T00:00:00.000Z',
  }

  function setup(probe: () => Promise<SshProbe>) {
    const api = createFakeApi({ getSettings: async (s) => (s.kind === 'global' ? GLOBAL : EMPTY) })
    const { tauri } = createFakeTauri({ sshProbe: probe })
    renderWithDeps(
      <SettingsDialog
        scope={{ kind: 'project', owner: 'my-org', repo: 'widgets' }}
        open
        onOpenChange={() => {}}
        previewIssue={{ owner: 'my-org', repo: 'widgets', key: '1', number: 1, title: 'Bound' }}
      />,
      makeDeps({ api, tauri, home: '/home/u', platform: 'linux' }),
    )
    return { tauri, user: userEvent.setup() }
  }

  it('고르면 바로 저장하고, 원본 위치·경로 미리보기가 그 호스트 기준이 된다', async () => {
    const { user } = setup(async () => PROBE)
    const select = await screen.findByLabelText('연결 호스트')
    expect(select).toHaveValue('')
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['작업 호스트 따름', '이 PC', 'srv'])
    expect(await screen.findByText('원본 위치 (이 PC)')).toBeInTheDocument()

    await user.selectOptions(select, 'ssh:srv')
    expect(repoHostOf(useHostsStore.getState(), 'my-org', 'widgets')).toBe('ssh:srv')
    expect(await screen.findByText('원본 위치 (srv)')).toBeInTheDocument()
    expect(await screen.findByTestId('preview-path')).toHaveTextContent('/home/dev/minmo-workspaces/my-org/widgets/')

    await user.selectOptions(select, '')
    expect(repoHostOf(useHostsStore.getState(), 'my-org', 'widgets')).toBeUndefined()
  })

  it('연결 호스트에 닿지 않으면 그 호스트의 값 대신 상태를 보이고, 연결 호스트는 계속 바꿀 수 있다', async () => {
    useHostsStore.setState({ aliases: [], repoHosts: { 'my-org/widgets': 'ssh:gone' } })
    const { user } = setup(async () => Promise.reject({ kind: 'unreachable', message: 'Could not resolve hostname gone' }))
    expect(await screen.findByTestId('settings-host-status')).toBeInTheDocument()
    expect(screen.queryByTestId('base-repo-section')).toBeNull()
    // 서버에 저장하는 설정은 호스트와 관계없으므로 그대로 쓴다. 그 호스트 기준인 경로 미리보기만 감춘다
    expect(await screen.findByLabelText('브랜치 템플릿')).toBeInTheDocument()
    expect(screen.queryByTestId('preview-path')).toBeNull()
    // 목록에 없는 호스트에 묶여 있어도 값이 비지 않는다
    const select = screen.getByLabelText('연결 호스트')
    expect(select).toHaveValue('ssh:gone')
    await user.selectOptions(select, 'local')
    expect(await screen.findByText('원본 위치 (이 PC)')).toBeInTheDocument()
  })

  it('연결 호스트를 바꿔도 아직 저장하지 않은 입력이 남는다', async () => {
    const { user } = setup(async () => PROBE)
    const branch = await screen.findByLabelText('브랜치 템플릿')
    await user.click(branch)
    await user.paste('feat/{number}')
    await user.selectOptions(screen.getByLabelText('연결 호스트'), 'ssh:srv')
    expect(await screen.findByText('원본 위치 (srv)')).toBeInTheDocument()
    expect(screen.getByLabelText('브랜치 템플릿')).toHaveValue('feat/{number}')
  })
})

describe('다른 PC 의 링크로 열기', () => {
  const TARGET = { owner: 'my-org', repo: 'widgets', key: '1', number: 1, title: 'Bound' }
  const linkTo = (paneId: string | null) => {
    localStorage.setItem('minmo-device-token', 'tok')
    const open = encodeURIComponent(JSON.stringify({ target: TARGET, paneId }))
    const win = { location: { hash: `#device=tok&open=${open}`, pathname: '/', search: '' }, history: { replaceState: vi.fn() }, dispatchEvent: vi.fn() }
    consumeHash(win as unknown as Window)
  }
  const renderDeepLink = (deps: ReturnType<typeof makeDeps>) => {
    const Base = makeWrapper(deps)
    renderHook(() => useDeepLinkOpen(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <Base>
          <WorktreeProvider>{children}</WorktreeProvider>
        </Base>
      ),
    })
  }

  it('열 호스트: 패널이 있으면 그 패널의 호스트, 없으면 연결 호스트, 그것도 없으면 이 PC', () => {
    expect(deepLinkAlias({ target: TARGET, paneId: 'ssh:other|my-org/widgets#1::2' })).toBe('other')
    expect(deepLinkAlias({ target: TARGET, paneId: 'my-org/widgets#1::2' })).toBeNull()
    expect(deepLinkAlias({ target: TARGET, paneId: null })).toBeNull()
    useHostsStore.getState().setRepoHost('my-org', 'widgets', 'ssh:srv')
    expect(deepLinkAlias({ target: TARGET, paneId: null })).toBe('srv')
  })

  it('연결 호스트를 정한 저장소는 연결한 뒤 그 호스트에서 연다(이 PC 에서 열지 않는다)', async () => {
    useHostsStore.getState().setRepoHost('my-org', 'widgets', 'ssh:srv')
    linkTo(null)
    const api = createFakeApi({ getEffective: async () => ({ values: { ...DEFAULT_SETTINGS }, sources: {} }) as unknown as Effective })
    const { tauri } = createFakeTauri({ sshProbe: async () => PROBE })
    renderDeepLink(makeDeps({ tauri, api, github: createFakeGitHub({ defaultBranch: async () => 'main' }) }))
    await waitFor(() => expect(useUiStore.getState().selectedIssueId).toBe('ssh:srv|my-org/widgets#1'))
    expect(tauri.sshProbe).toHaveBeenCalledWith('srv', false)
    await waitFor(() => expect(tauri.sshExec).toHaveBeenCalled())
    expect(tauri.gitRun).not.toHaveBeenCalled()
  })

  it('연결하지 못하면 열지 않는다', async () => {
    useHostsStore.getState().setRepoHost('my-org', 'widgets', 'ssh:srv')
    linkTo(null)
    const { tauri } = createFakeTauri({ sshProbe: async () => Promise.reject({ kind: 'unreachable', message: 'down' }) })
    renderDeepLink(makeDeps({ tauri }))
    await waitFor(() => expect(useHostsStore.getState().errors.srv).toMatchObject({ kind: 'unreachable' }))
    expect(useUiStore.getState().selectedIssueId).toBeNull()
    expect(tauri.gitRun).not.toHaveBeenCalled()
  })
})
