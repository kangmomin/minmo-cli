// 새 프로젝트 · 폴더 열기 · GitHub 저장소 추가 · 로컬 저장소의 작업 · GitHub 에 올리기
import { renderHook, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Effective } from '@minmo/api-client'
import { DEFAULT_SETTINGS, GitHubError } from '@minmo/core'

import { hostOf } from '../../app/host'
import { TooltipProvider } from '../../components/ui/tooltip'
import type { TauriApi } from '../../lib/tauri'
import { baseRepoOf, useHostsStore } from '../../store/hosts'
import { LOCAL_OWNER, newLocalId, useReposStore } from '../../store/repos'
import { useSessionStore } from '../../store/session'
import { useSetupStore } from '../../store/setup'
import { useUiStore } from '../../store/ui'
import { createFakeApi, createFakeGitHub, createFakeTauri, fail, ok } from '../../test/fakes'
import { makeDeps, makeWrapper, renderWithDeps } from '../../test/render'
import { WorktreeProvider, useIssueActions } from '../issue/useWorktree'
import { AddGitHubRepoDialog, NewProjectDialog, OpenFolderDialog } from './AddRepoDialogs'
import { registerLocalRepo, unregisterLocalRepo } from './localRepos'
import { PublishError, githubNameOf, publishRepo, resetPublish } from './publishRepo'
import { Sidebar } from './Sidebar'
import { githubRepoOfRemote, parseGitHubRepo, resolveInputPath } from './verifyRepoFolder'

type Git = (args: string[]) => Promise<ReturnType<typeof ok>>

beforeEach(() => {
  localStorage.clear()
  useHostsStore.setState({ aliases: [], selected: null, probes: {}, connecting: null, error: null, baseRepos: {} })
  useReposStore.setState({ added: [], local: {}, lastParent: {} })
  useSessionStore.setState(useSessionStore.getInitialState(), true)
  useSessionStore.setState({ token: 'tok', status: 'online' })
  useSetupStore.setState(useSetupStore.getInitialState(), true)
  useUiStore.setState({ expanded: {}, worktreePathMap: {}, selectedIssueId: null, terminalIds: {}, panes: {} })
})

const localIds = () => Object.keys(useReposStore.getState().local)

/** 일반 저장소처럼 답하는 git. origin·커밋 유무를 바꿀 수 있다 */
function repoGit(o: { origin?: string | null; commits?: boolean; commitFails?: string } = {}): Git {
  return async (args) => {
    if (args.includes('--show-toplevel')) return ok(`${args[1]}\n${args[1]}/.git\n`)
    if (args.includes('get-url')) return o.origin ? ok(`${o.origin}\n`) : fail("error: No such remote 'origin'", 2)
    if (args.includes('rev-parse') && args.includes('HEAD')) return o.commits === false ? fail('', 1) : ok('abc\n')
    if (args.includes('commit')) return o.commitFails ? fail(o.commitFails, 128) : ok()
    return ok()
  }
}

describe('주소·이름 해석', () => {
  it('githubRepoOfRemote: github.com 주소만 GitHub 저장소로 본다', () => {
    expect(githubRepoOfRemote('https://github.com/acme/app.git\n')).toEqual({ owner: 'acme', name: 'app' })
    expect(githubRepoOfRemote('git@github.com:acme/app.git')).toEqual({ owner: 'acme', name: 'app' })
    expect(githubRepoOfRemote('ssh://git@github.com/acme/app')).toEqual({ owner: 'acme', name: 'app' })
    expect(githubRepoOfRemote('https://token@github.com/acme/app.git')).toEqual({ owner: 'acme', name: 'app' })
    // GitLab·사내 서버·ssh 별칭은 GitHub 저장소가 아니다
    expect(githubRepoOfRemote('https://gitlab.com/group/app.git')).toBeNull()
    expect(githubRepoOfRemote('git@gh-work:acme/app.git')).toBeNull()
    expect(githubRepoOfRemote('https://github.com.evil.example/acme/app')).toBeNull()
  })

  it('parseGitHubRepo: owner/name 과 주소', () => {
    expect(parseGitHubRepo(' acme/app ')).toEqual({ owner: 'acme', name: 'app' })
    expect(parseGitHubRepo('https://github.com/acme/app')).toEqual({ owner: 'acme', name: 'app' })
    expect(parseGitHubRepo('acme')).toBeNull()
    expect(parseGitHubRepo('a/b/c')).toBeNull()
  })

  it('newLocalId: 서버 이름 규칙에 맞는 소문자 + 임의 꼬리', () => {
    expect(newLocalId('My App (새 버전)', () => 0.5)).toBe('my-app-8000')
    expect(newLocalId('한글폴더', () => 0)).toBe('repo-0000')
    expect(newLocalId('..hidden..', () => 0)).toMatch(/^hidden-0000$/)
    expect(githubNameOf('My App!')).toBe('My-App')
  })
})

describe('repos store · ui.rekey', () => {
  it('작업 번호는 1부터 이어지고, 닫아도 번호가 유지된다', () => {
    const id = useReposStore.getState().addLocal({ hostId: 'local', path: '/src/app', displayName: 'app' })
    expect(useReposStore.getState().addTask(id, '첫 작업')).toBe(1)
    expect(useReposStore.getState().addTask(id, '둘째')).toBe(2)
    useReposStore.getState().setTaskState(id, 1, 'closed')
    expect(useReposStore.getState().addTask(id, '셋째')).toBe(3)
    expect(useReposStore.getState().local[id].tasks.map((t) => [t.number, t.state])).toEqual([
      [1, 'closed'],
      [2, 'open'],
      [3, 'open'],
    ])
  })

  it('목록에서 제거: 기준 저장소 기록과 작업 폴더 기록도 지운다(다른 저장소는 그대로)', () => {
    const id = registerLocalRepo('local', '/src/app')
    useUiStore.setState({ worktreePathMap: { [`${LOCAL_OWNER}/${id}#1`]: { path: '/w/1', branch: 'b' }, 'acme/app#1': { path: '/w/x', branch: 'x' } } })
    expect(baseRepoOf(useHostsStore.getState(), 'local', LOCAL_OWNER, id)).toBe('/src/app')
    unregisterLocalRepo(id)
    expect(localIds()).toEqual([])
    expect(baseRepoOf(useHostsStore.getState(), 'local', LOCAL_OWNER, id)).toBeUndefined()
    expect(Object.keys(useUiStore.getState().worktreePathMap)).toEqual(['acme/app#1'])
  })

  it('목록에서 제거: 열려 있던 그 저장소의 작업은 닫는다(터미널 종료·선택 해제)', () => {
    const id = registerLocalRepo('local', '/src/app')
    const issueId = `${LOCAL_OWNER}/${id}#1`
    useUiStore.setState({ worktreePathMap: { [issueId]: { path: '/w/1', branch: 'b' } }, selectedIssueId: issueId, terminalIds: { [`${issueId}::1`]: 'pty-3', 'acme/app#1::1': 'pty-9' } })
    useSetupStore.getState().setOpen(issueId, { phase: 'ready', path: '/w/1', branch: 'b', pathChanged: false })
    const ptyKill = vi.fn(async () => {})
    unregisterLocalRepo(id, ptyKill)
    expect(ptyKill.mock.calls).toEqual([['pty-3']])
    expect(useUiStore.getState().selectedIssueId).toBeNull()
    expect(useSetupStore.getState().open).toEqual({})
  })

  it('resolveInputPath: 루트(/, C:\\)도 상위 폴더로 쓸 수 있다', () => {
    expect(resolveInputPath('/', { home: '/home/u', platform: 'linux' })).toEqual({ path: '/' })
    expect(resolveInputPath('C:\\', { home: 'C:\\Users\\u', platform: 'win32' })).toEqual({ path: 'C:\\' })
    expect(resolveInputPath('~/src/', { home: '/home/u', platform: 'linux' })).toEqual({ path: '/home/u/src' })
    expect(resolveInputPath('src', { home: '/home/u', platform: 'linux' })).toHaveProperty('error')
  })

  it('rekey: 작업 폴더 기록·펼침을 옮기고, 그 이슈의 패널과 선택은 비운다', () => {
    useUiStore.setState({ worktreePathMap: { 'a#1': { path: '/w/1', branch: 'b1' }, 'z#9': { path: '/w/9', branch: 'b9' } }, expanded: { 'repo:a': true }, selectedIssueId: 'a#1' })
    useUiStore.getState().ensurePanes('a#1')
    useUiStore.setState({ terminalIds: { 'a#1::1': 'pty-1', 'z#9::1': 'pty-9' } })
    useUiStore.getState().rekey({ 'a#1': 'b#1' }, { 'repo:a': 'repo:b' })
    const s = useUiStore.getState()
    expect(s.worktreePathMap).toEqual({ 'b#1': { path: '/w/1', branch: 'b1' }, 'z#9': { path: '/w/9', branch: 'b9' } })
    expect(s.expanded).toEqual({ 'repo:b': true })
    expect(s.panes).toEqual({})
    expect(s.terminalIds).toEqual({ 'z#9::1': 'pty-9' })
    expect(s.selectedIssueId).toBeNull()
  })
})

describe('새 프로젝트', () => {
  function setup(o: { exists?: boolean; git?: Git; platform?: 'linux' | 'win32'; pick?: string | null } = {}) {
    const { tauri } = createFakeTauri({ gitRun: o.git ?? repoGit(), pathExists: async () => o.exists ?? false, pickFolder: async () => o.pick ?? null })
    const onOpenChange = vi.fn()
    renderWithDeps(<NewProjectDialog open onOpenChange={onOpenChange} />, makeDeps({ tauri, home: o.platform === 'win32' ? 'C:\\Users\\u' : '/home/u', platform: o.platform ?? 'linux' }))
    return { tauri, user: userEvent.setup(), onOpenChange }
  }

  it('폴더를 만들어 git init → 빈 첫 커밋 → 로컬 저장소로 등록(폴더가 기준 저장소)', async () => {
    const { tauri, user, onOpenChange } = setup()
    await user.type(screen.getByLabelText('프로젝트 이름(폴더 이름)'), 'my-app')
    const parent = screen.getByLabelText('만들 위치(상위 폴더)')
    expect(parent).toHaveValue('~')
    await user.clear(parent)
    await user.type(parent, '~/src')
    await user.click(screen.getByRole('button', { name: '만들기' }))
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    const calls = tauri.gitRun.mock.calls.map(([a]) => a)
    expect(calls[0]).toEqual(['init', '-b', 'main', '/home/u/src/my-app'])
    expect(calls[1]).toEqual(['-C', '/home/u/src/my-app', 'commit', '--allow-empty', '-m', 'Initial commit'])
    const [id] = localIds()
    expect(id).toMatch(/^my-app-[0-9a-f]{4}$/)
    expect(useReposStore.getState().local[id]).toMatchObject({ hostId: 'local', path: '/home/u/src/my-app', displayName: 'my-app', tasks: [] })
    expect(baseRepoOf(useHostsStore.getState(), 'local', LOCAL_OWNER, id)).toBe('/home/u/src/my-app')
    expect(useUiStore.getState().expanded).toMatchObject({ [`org:${LOCAL_OWNER}`]: true, [`repo:${LOCAL_OWNER}/${id}`]: true })
    // 다음에 같은 위치를 먼저 보여 준다
    expect(useReposStore.getState().lastParent.local).toBe('~/src')
  })

  it('이미 있는 폴더·쓸 수 없는 이름은 만들지 않는다', async () => {
    const { tauri, user } = setup({ exists: true })
    await user.type(screen.getByLabelText('프로젝트 이름(폴더 이름)'), 'a/b')
    await user.click(screen.getByRole('button', { name: '만들기' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('쓸 수 없는 글자')
    await user.clear(screen.getByLabelText('프로젝트 이름(폴더 이름)'))
    await user.type(screen.getByLabelText('프로젝트 이름(폴더 이름)'), 'app')
    await user.click(screen.getByRole('button', { name: '만들기' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('이미 있는 폴더입니다: /home/u/app'))
    expect(tauri.gitRun).not.toHaveBeenCalled()
    expect(localIds()).toEqual([])
  })

  it('첫 커밋이 실패하면(user.name 없음 등) 등록하지 않고 안내한다', async () => {
    const { user } = setup({ git: repoGit({ commitFails: 'fatal: unable to auto-detect email address' }) })
    await user.type(screen.getByLabelText('프로젝트 이름(폴더 이름)'), 'app')
    await user.click(screen.getByRole('button', { name: '만들기' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('user.name·user.email'))
    expect(localIds()).toEqual([])
  })

  it('Windows: 폴더 선택 창에서 고른 위치에 만든다', async () => {
    const { tauri, user } = setup({ platform: 'win32', pick: 'D:\\work' })
    await user.type(screen.getByLabelText('프로젝트 이름(폴더 이름)'), 'app')
    await user.click(screen.getByRole('button', { name: '찾아보기' }))
    await waitFor(() => expect(screen.getByLabelText('만들 위치(상위 폴더)')).toHaveValue('D:\\work'))
    await user.click(screen.getByRole('button', { name: '만들기' }))
    await waitFor(() => expect(localIds()).toHaveLength(1))
    expect(tauri.gitRun.mock.calls[0][0]).toEqual(['init', '-b', 'main', 'D:\\work\\app'])
  })
})

describe('폴더 열기', () => {
  function setup(git: Git, github = createFakeGitHub()) {
    const { tauri } = createFakeTauri({ gitRun: git })
    const onOpenChange = vi.fn()
    renderWithDeps(<OpenFolderDialog open onOpenChange={onOpenChange} />, makeDeps({ tauri, github }))
    return { tauri, github, user: userEvent.setup(), onOpenChange }
  }
  const openPath = async (user: ReturnType<typeof userEvent.setup>, path = '/src/app') => {
    await user.type(screen.getByLabelText('저장소 폴더'), path)
    await user.click(screen.getByRole('button', { name: '열기' }))
  }

  it('origin 이 GitHub 저장소면 그 저장소를 목록에 더하고 폴더를 기준 저장소로 쓴다(GitHub 표기로)', async () => {
    const github = createFakeGitHub({ getRepo: async () => ({ owner: 'Acme', name: 'App', defaultBranch: 'main' }) })
    const { user, onOpenChange } = setup(repoGit({ origin: 'git@github.com:acme/app.git' }), github)
    await openPath(user)
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    expect(github.getRepo).toHaveBeenCalledWith('acme', 'app')
    expect(useReposStore.getState().added).toEqual(['Acme/App'])
    expect(baseRepoOf(useHostsStore.getState(), 'local', 'acme', 'app')).toBe('/src/app')
    expect(localIds()).toEqual([])
  })

  it('origin 이 없거나 GitHub 가 아니면 로컬 저장소로 연다', async () => {
    const github = createFakeGitHub()
    const { user, onOpenChange } = setup(repoGit({ origin: 'https://gitlab.com/group/app.git' }), github)
    await openPath(user)
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    expect(github.getRepo).not.toHaveBeenCalled()
    expect(useReposStore.getState().added).toEqual([])
    expect(useReposStore.getState().local[localIds()[0]]).toMatchObject({ path: '/src/app', displayName: 'app' })
  })

  it('GitHub 에서 확인할 수 없는 저장소는 물어본 뒤 로컬 저장소로 연다', async () => {
    const github = createFakeGitHub({
      getRepo: async () => {
        throw new GitHubError('not_found', { status: 404 })
      },
    })
    const { user, onOpenChange } = setup(repoGit({ origin: 'https://github.com/gone/app.git' }), github)
    await openPath(user)
    expect(await screen.findByText(/확인하지 못했습니다/)).toBeInTheDocument()
    expect(localIds()).toEqual([])
    await user.click(screen.getByRole('button', { name: '이슈 없이 로컬 저장소로 열기' }))
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    expect(localIds()).toHaveLength(1)
  })

  it('커밋이 없는 저장소는 물어본 뒤 빈 첫 커밋을 만들고 연다', async () => {
    const { tauri, user, onOpenChange } = setup(repoGit({ commits: false }))
    await openPath(user)
    expect(await screen.findByText(/커밋이 하나도 없는 저장소/)).toBeInTheDocument()
    expect(tauri.gitRun.mock.calls.some(([a]) => a.includes('commit'))).toBe(false)
    await user.click(screen.getByRole('button', { name: '빈 첫 커밋 만들고 열기' }))
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    expect(tauri.gitRun).toHaveBeenCalledWith(['-C', '/src/app', 'commit', '--allow-empty', '-m', 'Initial commit'])
    expect(localIds()).toHaveLength(1)
  })

  it('이미 열어 둔 폴더는 다시 등록하지 않는다 · git 저장소가 아니면 거부', async () => {
    const id = registerLocalRepo('local', '/src/app')
    const { user, onOpenChange } = setup(async (args) => (args[1] === '/src/app' ? repoGit()(args) : fail('fatal: not a git repository', 128)))
    await openPath(user, '/tmp/nope')
    expect(await screen.findByRole('alert')).toHaveTextContent('git 저장소(작업 폴더)가 아닙니다')
    await user.clear(screen.getByLabelText('저장소 폴더'))
    await openPath(user, '/src/app/')
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    expect(localIds()).toEqual([id])
  })
})

describe('GitHub 저장소 추가', () => {
  it('확인한 저장소만 GitHub 표기로 더한다', async () => {
    const github = createFakeGitHub({
      getRepo: async (o, n) => {
        if (n === 'nope') throw new GitHubError('not_found', { status: 404 })
        return { owner: 'Other', name: 'Lib', defaultBranch: 'main' }
      },
    })
    const onOpenChange = vi.fn()
    renderWithDeps(<AddGitHubRepoDialog open onOpenChange={onOpenChange} />, makeDeps({ github }))
    const user = userEvent.setup()
    await user.type(screen.getByLabelText('저장소'), 'other/nope')
    await user.click(screen.getByRole('button', { name: '추가' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('찾을 수 없거나 볼 권한이 없습니다: other/nope')
    await user.clear(screen.getByLabelText('저장소'))
    await user.type(screen.getByLabelText('저장소'), 'https://github.com/other/lib')
    await user.click(screen.getByRole('button', { name: '추가' }))
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    expect(useReposStore.getState().added).toEqual(['Other/Lib'])
    expect(useUiStore.getState().expanded).toMatchObject({ 'org:Other': true, 'repo:Other/Lib': true })
  })
})

describe('트리', () => {
  const ME = { login: 'me', kind: 'user' as const, avatarUrl: null }
  function renderSidebar(o: { visible?: string[] | null; tauri?: TauriApi } = {}) {
    const github = createFakeGitHub({
      listOwners: async () => [ME],
      listRepos: async () => [
        { owner: 'me', name: 'alpha', defaultBranch: 'main' },
        { owner: 'me', name: 'zeta', defaultBranch: 'main' },
      ],
    })
    const api = createFakeApi({ getVisibleRepos: async () => ({ repos: o.visible ?? null, updatedAt: null }) })
    renderWithDeps(
      <TooltipProvider>
        <WorktreeProvider>
          <Sidebar onOpenSettings={() => {}} />
        </WorktreeProvider>
      </TooltipProvider>,
      makeDeps({ github, api, ...(o.tauri ? { tauri: o.tauri } : {}) }),
    )
    return { github, user: userEvent.setup() }
  }

  it('로컬 저장소: "로컬 저장소" 아래에 폴더명으로 보이고, 이슈 대신 기타 + 작업을 보인다(GitHub 이슈 조회 없음)', async () => {
    const id = registerLocalRepo('local', '/src/my-app')
    useReposStore.getState().addTask(id, '로그인 화면')
    useReposStore.getState().addTask(id, '닫은 작업')
    useReposStore.getState().setTaskState(id, 2, 'closed')
    const { github, user } = renderSidebar()
    expect(await screen.findByTestId(`org-node-${LOCAL_OWNER}`)).toHaveTextContent('로컬 저장소')
    const repo = screen.getByTestId(`repo-node-${LOCAL_OWNER}/${id}`)
    expect(repo).toHaveTextContent('my-app')
    expect(screen.getByTestId('issue-row-etc')).toBeInTheDocument()
    expect(screen.getByTestId('issue-row-1')).toHaveTextContent('#1로그인 화면')
    // 닫은 작업은 작업 폴더가 없으면 숨긴다
    expect(screen.queryByTestId('issue-row-2')).toBeNull()
    expect(github.listIssues).not.toHaveBeenCalled()

    await user.click(screen.getByTestId('add-task'))
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText('제목'), '새 작업')
    await user.click(within(dialog).getByRole('button', { name: '추가' }))
    expect(await screen.findByTestId('issue-row-3')).toHaveTextContent('새 작업')
  })

  it('다른 호스트의 로컬 저장소는 보이지 않는다', async () => {
    useReposStore.getState().addLocal({ hostId: 'ssh:srv', path: '/srv/app', displayName: 'remote-app' })
    renderSidebar()
    await screen.findByTestId('org-node-me')
    expect(screen.queryByTestId(`org-node-${LOCAL_OWNER}`)).toBeNull()
  })

  it('직접 추가한 GitHub 저장소: 내 소유자 아래에 합치고, 남의 소유자는 따로 노드를 만든다(전체 목록은 불러오지 않는다)', async () => {
    useReposStore.setState({ added: ['me/collab', 'Other/Lib'] })
    useUiStore.setState({ expanded: { 'org:me': true, 'org:Other': true } })
    const { github } = renderSidebar()
    expect(await screen.findByTestId('repo-node-me/collab')).toBeInTheDocument()
    expect(screen.getAllByTestId(/^repo-node-me\//).map((n) => n.getAttribute('data-testid'))).toEqual(['repo-node-me/alpha', 'repo-node-me/collab', 'repo-node-me/zeta'])
    expect(screen.getByTestId('repo-node-Other/Lib')).toBeInTheDocument()
    expect(github.listRepos).toHaveBeenCalledTimes(1)
    expect(github.listRepos).toHaveBeenCalledWith(ME)
  })

  it('"보이는 저장소" 로 숨긴 소유자·저장소라도 직접 추가한 것은 보인다', async () => {
    useReposStore.setState({ added: ['me/zeta'] })
    useUiStore.setState({ expanded: { 'org:me': true } })
    renderSidebar({ visible: ['someone/else'] })
    expect(await screen.findByTestId('repo-node-me/zeta')).toBeInTheDocument()
    expect(screen.queryByTestId('repo-node-me/alpha')).toBeNull()
    expect(within(screen.getByTestId('repo-node-me/zeta')).queryByText('숨김')).toBeNull()
  })

  it('"+" 메뉴(키보드) → 새 프로젝트 대화상자', async () => {
    const { user } = renderSidebar()
    const add = await screen.findByRole('button', { name: '저장소 추가' })
    add.focus()
    await user.keyboard('{Enter}')
    await user.click(await screen.findByRole('menuitem', { name: /새 프로젝트/ }))
    expect(await screen.findByRole('dialog')).toHaveTextContent('새 프로젝트')
  })
})

describe('로컬 저장소에서 작업 열기(worktree)', () => {
  it('clone·GitHub 조회 없이 그 폴더에서, 현재 브랜치를 기준으로 작업 폴더를 만든다', async () => {
    const id = registerLocalRepo('local', '/src/app')
    const { tauri } = createFakeTauri({
      pathExists: async (p) => p === '/src/app',
      gitRun: async (args) => {
        if (args.includes('get-url')) return fail("error: No such remote 'origin'", 2)
        if (args.includes('symbolic-ref')) return ok('trunk\n')
        if (args.includes('--verify')) return fail('', 1)
        return ok()
      },
    })
    const api = createFakeApi({ getEffective: async () => ({ values: { ...DEFAULT_SETTINGS }, sources: {} }) as unknown as Effective })
    const github = createFakeGitHub()
    const Base = makeWrapper(makeDeps({ tauri, api, github }))
    const wrapper = ({ children }: { children: ReactNode }) => (
      <Base>
        <WorktreeProvider>{children}</WorktreeProvider>
      </Base>
    )
    const { result } = renderHook(() => useIssueActions(), { wrapper })
    await result.current.open({ owner: LOCAL_OWNER, repo: id, key: '1', number: 1, title: 'First task' })
    const issueId = `${LOCAL_OWNER}/${id}#1`
    await waitFor(() => expect(useSetupStore.getState().open[issueId]).toMatchObject({ phase: 'ready', branch: 'issue/1-first-task' }))
    const calls = tauri.gitRun.mock.calls.map(([a]) => a)
    expect(calls.some((a) => a.includes('clone') || a.includes('fetch'))).toBe(false)
    const add = calls.find((a) => a.includes('worktree') && a.includes('add'))!
    expect(add.slice(0, 2)).toEqual(['-C', '/src/app'])
    expect(add.at(-1)).toBe('refs/heads/trunk')
    expect(github.defaultBranch).not.toHaveBeenCalled()
    expect(useUiStore.getState().worktreePathMap[issueId]?.path).toBe(`/home/u/minmo-workspaces/${LOCAL_OWNER}/${id}/issue--1-first-task`)
  })
})

describe('GitHub 에 올리기', () => {
  const host = hostOf(null)
  function setup(o: { pushFails?: boolean; issueNumbers?: number[]; existing?: { number: number; title: string; state: 'open' | 'closed'; htmlUrl: string }[]; onCreateIssue?: () => void } = {}) {
    const id = registerLocalRepo('local', '/src/app')
    useReposStore.getState().addTask(id, '첫 작업')
    useReposStore.getState().addTask(id, '닫은 작업')
    useReposStore.getState().setTaskState(id, 2, 'closed')
    useUiStore.setState({
      worktreePathMap: { [`${LOCAL_OWNER}/${id}#1`]: { path: '/w/1', branch: 'issue/1-x' }, [`${LOCAL_OWNER}/${id}#etc`]: { path: '/w/etc', branch: 'etc' } },
      selectedIssueId: `${LOCAL_OWNER}/${id}#1`,
      terminalIds: { [`${LOCAL_OWNER}/${id}#1::1`]: 'pty-7' },
    })
    let origin: string | null = null
    const state = { pushFails: o.pushFails ?? false }
    const { tauri } = createFakeTauri({
      gitRun: async (args) => {
        if (args.includes('get-url')) return origin ? ok(`${origin}\n`) : fail("error: No such remote 'origin'", 2)
        if (args.includes('remote') && args.includes('add')) {
          origin = args.at(-1)!
          return ok()
        }
        if (args.includes('remote') && args.includes('remove')) {
          origin = null
          return ok()
        }
        if (args.includes('symbolic-ref')) return ok('trunk\n')
        if (args.includes('push')) return state.pushFails ? fail('fatal: Authentication failed', 128) : ok()
        return ok()
      },
    })
    const numbers = [...(o.issueNumbers ?? [1, 2])]
    const created: { number: number; title: string; state: 'open' | 'closed'; htmlUrl: string }[] = [...(o.existing ?? [])]
    const github = createFakeGitHub({
      getRepo: async () => {
        throw new GitHubError('not_found', { status: 404 })
      },
      createRepo: async (input) => ({ owner: input.org ?? 'me', name: input.name, defaultBranch: 'main' }),
      listIssues: async () => [...created],
      createIssue: async (_o, _r, title) => {
        const issue = { number: numbers.shift()!, title, state: 'open' as const, htmlUrl: '' }
        created.push(issue)
        o.onCreateIssue?.()
        return issue
      },
    })
    const notes: Record<string, string> = { [`${LOCAL_OWNER}/${id}/1`]: '메모 1', [`${LOCAL_OWNER}/${id}/etc`]: '' }
    const api = createFakeApi({
      getNotes: async (o2, r, k) => ({ body: notes[`${o2}/${r}/${k}`] ?? '', updatedAt: null }),
      putNotes: async (o2, r, k, input) => {
        notes[`${o2}/${r}/${k}`] = input.body
        return { body: input.body, updatedAt: 't' }
      },
      getSettings: async () => ({ ...Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map((k) => [k, null])), branchTemplate: 'task/{number}', updatedAt: 't' }) as never,
      putSettings: async (_s, input) => ({ ...input, updatedAt: 't' }) as never,
    })
    const input = { id, owner: 'me', isOrg: false, name: 'app', private: true }
    return { id, tauri, github, api, notes, input, state }
  }

  it('저장소 생성 → origin → push → 작업을 같은 번호의 이슈로 → 메모·설정 복사 → 트리 항목 전환', async () => {
    const t = setup()
    const steps: string[] = []
    await expect(publishRepo(t, host, t.input, (s) => steps.push(s))).resolves.toEqual({ owner: 'me', name: 'app' })
    expect(steps).toEqual(['create', 'remote', 'push', 'issues', 'copy', 'switch'])
    expect(t.github.createRepo).toHaveBeenCalledWith({ org: null, name: 'app', private: true })
    const git = t.tauri.gitRun.mock.calls.map(([a]) => a)
    expect(git).toContainEqual(['-C', '/src/app', 'remote', 'add', 'origin', 'https://github.com/me/app.git'])
    // 저장소의 현재 브랜치를 먼저 보내 GitHub 의 기본 브랜치가 되게 한다
    expect(git.filter((a) => a.includes('push'))).toEqual([
      ['-C', '/src/app', 'push', '-u', 'origin', 'trunk'],
      ['-C', '/src/app', 'push', '-u', 'origin', '--all'],
    ])
    expect(t.github.createIssue.mock.calls.map((c) => c[2])).toEqual(['첫 작업', '닫은 작업'])
    expect(t.github.closeIssue).toHaveBeenCalledWith('me', 'app', 2)
    expect(t.notes['me/app/1']).toBe('메모 1')
    expect(t.api.putSettings).toHaveBeenCalledWith({ kind: 'project', owner: 'me', repo: 'app' }, expect.objectContaining({ branchTemplate: 'task/{number}' }))
    // 전환: 로컬 항목은 사라지고 GitHub 저장소로, 폴더는 기준 저장소로 남는다
    expect(localIds()).toEqual([])
    expect(useReposStore.getState().added).toEqual(['me/app'])
    expect(baseRepoOf(useHostsStore.getState(), 'local', 'me', 'app')).toBe('/src/app')
    expect(baseRepoOf(useHostsStore.getState(), 'local', LOCAL_OWNER, t.id)).toBeUndefined()
    expect(useUiStore.getState().worktreePathMap).toEqual({ 'me/app#1': { path: '/w/1', branch: 'issue/1-x' }, 'me/app#etc': { path: '/w/etc', branch: 'etc' } })
    expect(useUiStore.getState().selectedIssueId).toBeNull()
    expect(t.tauri.ptyKill).toHaveBeenCalledWith('pty-7')
  })

  it('push 가 실패하면 로컬 저장소로 남고, 다시 실행하면 만든 저장소로 이어서 끝낸다(저장소를 또 만들지 않는다)', async () => {
    const t = setup({ pushFails: true })
    const err = await publishRepo(t, host, t.input).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PublishError)
    expect((err as PublishError).step).toBe('push')
    expect((err as PublishError).message).toContain('Authentication failed')
    expect(localIds()).toEqual([t.id])
    expect(useReposStore.getState().local[t.id].publish).toEqual({ owner: 'me', name: 'app', private: true })
    expect(t.github.createIssue).not.toHaveBeenCalled()

    t.state.pushFails = false
    // 다시 누를 때 입력이 달라도 이전에 만든 저장소로 이어 간다
    await expect(publishRepo(t, host, { ...t.input, name: 'other' })).resolves.toEqual({ owner: 'me', name: 'app' })
    expect(t.github.createRepo).toHaveBeenCalledTimes(1)
    expect(t.tauri.gitRun.mock.calls.filter(([a]) => a.includes('remote') && a.includes('add'))).toHaveLength(1)
    expect(localIds()).toEqual([])
  })

  it('이어서 올릴 때 이전에 만든 이슈(번호·제목 같음)는 다시 만들지 않고, 닫은 작업만 닫는다', async () => {
    const t = setup({ existing: [{ number: 1, title: '첫 작업', state: 'open', htmlUrl: '' }], issueNumbers: [2] })
    await expect(publishRepo(t, host, t.input)).resolves.toEqual({ owner: 'me', name: 'app' })
    expect(t.github.createIssue.mock.calls.map((c) => c[2])).toEqual(['닫은 작업'])
    expect(t.github.closeIssue).toHaveBeenCalledWith('me', 'app', 2)
  })

  it('작업과 맞지 않는 이슈가 이미 있으면 이슈를 더 만들지 않고 멈춘다(다시 눌러도 늘지 않는다)', async () => {
    const t = setup({ existing: [{ number: 1, title: '남이 만든 이슈', state: 'open', htmlUrl: '' }] })
    for (let i = 0; i < 2; i++) {
      const err = (await publishRepo(t, host, t.input).catch((e: unknown) => e)) as PublishError
      expect(err.step).toBe('issues')
      expect(err.message).toContain('맞지 않는 이슈 #1')
    }
    expect(t.github.createIssue).not.toHaveBeenCalled()
    expect(localIds()).toEqual([t.id])
  })

  it('번호가 어긋나 멈춘 뒤에는 다시 눌러도 이슈를 더 만들지 않는다 · [처음부터 다시] 는 붙인 origin 을 떼고 기록을 지운다', async () => {
    const t = setup({ issueNumbers: [1, 5] })
    await publishRepo(t, host, t.input).catch(() => undefined)
    await publishRepo(t, host, t.input).catch(() => undefined)
    expect(t.github.createIssue).toHaveBeenCalledTimes(2)
    await resetPublish(t.tauri, t.id)
    expect(useReposStore.getState().local[t.id].publish).toBeUndefined()
    expect(t.tauri.gitRun).toHaveBeenCalledWith(['-C', '/src/app', 'remote', 'remove', 'origin'])
  })

  it('동시에 두 번 실행되지 않는다 · 다른 호스트의 저장소는 올리지 않는다', async () => {
    const t = setup()
    const first = publishRepo(t, host, t.input)
    await expect(publishRepo(t, host, t.input)).rejects.toThrow('이미 올리는 중입니다')
    await first
    expect(t.github.createRepo).toHaveBeenCalledTimes(1)

    const other = setup()
    await expect(publishRepo(other, hostOf('srv'), other.input)).rejects.toThrow('다른 호스트')
    expect(other.github.createRepo).not.toHaveBeenCalled()
  })

  it('올리는 동안 작업이 바뀌면 전환하지 않고, 이어서 올리면 바뀐 작업까지 반영한다', async () => {
    let added = false
    const t = setup({
      issueNumbers: [1, 2, 3],
      onCreateIssue: () => {
        if (!added) useReposStore.getState().addTask(localIds()[0], '도중에 추가')
        added = true
      },
    })
    const err = (await publishRepo(t, host, t.input).catch((e: unknown) => e)) as PublishError
    expect(err.step).toBe('switch')
    expect(localIds()).toEqual([t.id])
    await expect(publishRepo(t, host, t.input)).resolves.toEqual({ owner: 'me', name: 'app' })
    expect(t.github.createIssue.mock.calls.map((c) => c[2])).toEqual(['첫 작업', '닫은 작업', '도중에 추가'])
  })

  it('이슈 번호가 작업 번호와 다르면 전환하지 않고 멈춘다', async () => {
    const t = setup({ issueNumbers: [1, 5] })
    const err = (await publishRepo(t, host, t.input).catch((e: unknown) => e)) as PublishError
    expect(err.step).toBe('issues')
    expect(err.message).toContain('작업 #2 이 이슈 #5')
    expect(localIds()).toEqual([t.id])
    expect(useUiStore.getState().worktreePathMap).toHaveProperty(`${LOCAL_OWNER}/${t.id}#1`)
    expect(t.api.putNotes).not.toHaveBeenCalled()
  })

  it('같은 이름의 GitHub 저장소가 있거나 origin 이 이미 있으면 만들지 않는다', async () => {
    const t = setup()
    t.github.getRepo.mockResolvedValueOnce({ owner: 'me', name: 'app', defaultBranch: 'main' })
    await expect(publishRepo(t, host, t.input)).rejects.toThrow('이미 있는 GitHub 저장소입니다: me/app')
    await t.tauri.gitRun(['-C', '/src/app', 'remote', 'add', 'origin', 'https://gitlab.com/g/app.git'])
    await expect(publishRepo(t, host, t.input)).rejects.toThrow('이미 origin 원격이 있는 저장소입니다')
    expect(t.github.createRepo).not.toHaveBeenCalled()
  })
})
