// 새 창 보기(#105) — 트리 행의 "새 창으로 열기", 사용자 정의 그룹, 범위 창의 트리
import { renderHook, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TooltipProvider } from '../../components/ui/tooltip'
import type { TauriApi } from '../../lib/tauri'
import { encodeScope } from '../../lib/windowScope'
import type { WindowScope } from '../../lib/windowScope'
import { LOCAL_OWNER, useReposStore } from '../../store/repos'
import { useSessionStore } from '../../store/session'
import { useUiStore } from '../../store/ui'
import { createFakeApi, createFakeGitHub, createFakeTauri } from '../../test/fakes'
import { makeDeps, renderWithDeps } from '../../test/render'
import { WorktreeProvider } from '../issue/useWorktree'
import { createTerminalKeyHandler, isNewWindowKey, useNewWindowShortcut } from '../terminal/keys'
import { Sidebar } from './Sidebar'

const ACME = { login: 'Acme', kind: 'org' as const, avatarUrl: null }
const BETA = { login: 'Beta', kind: 'org' as const, avatarUrl: null }
const REPOS: Record<string, { owner: string; name: string; defaultBranch: string }[]> = {
  Acme: [
    { owner: 'Acme', name: 'api', defaultBranch: 'main' },
    { owner: 'Acme', name: 'web', defaultBranch: 'main' },
  ],
  Beta: [{ owner: 'Beta', name: 'tools', defaultBranch: 'main' }],
}

beforeEach(() => {
  useSessionStore.setState(useSessionStore.getInitialState(), true)
  useSessionStore.setState({ token: 'tok', status: 'online' })
  useUiStore.setState({ expanded: { 'org:Acme': true }, worktreePathMap: {} })
  useReposStore.setState({ added: [], local: {}, nicknames: {}, groups: {} })
})

afterEach(() => {
  window.history.replaceState(null, '', '/')
})

function setup(opts: { scope?: WindowScope; tauri?: Partial<TauriApi>; visible?: string[] } = {}) {
  if (opts.scope) window.history.replaceState(null, '', `/?window=ws&scope=${encodeScope(opts.scope)}`)
  const windowOpen = vi.fn(async () => {})
  const tauri = createFakeTauri({ windowOpen, ...opts.tauri }).tauri
  const api = createFakeApi({ getVisibleRepos: async () => ({ repos: opts.visible ?? null, updatedAt: null }) })
  const github = createFakeGitHub({ listOwners: async () => [ACME, BETA], listRepos: async (owner: { login: string }) => REPOS[owner.login] ?? [] })
  renderWithDeps(
    <TooltipProvider>
      <WorktreeProvider>
        <Sidebar onOpenSettings={() => {}} />
      </WorktreeProvider>
    </TooltipProvider>,
    makeDeps({ api, github, tauri }),
  )
  return { user: userEvent.setup(), windowOpen }
}

describe('트리 행의 새 창으로 열기', () => {
  it('조직·저장소 행의 버튼이 그 범위와 제목으로 새 창을 연다', async () => {
    const { user, windowOpen } = setup()
    await screen.findByTestId('repo-node-Acme/api')
    await user.click(screen.getByRole('button', { name: 'Acme 새 창으로 열기' }))
    expect(windowOpen).toHaveBeenLastCalledWith(encodeScope({ kind: 'org', owner: 'Acme' }), 'Acme')
    await user.click(screen.getByRole('button', { name: 'api 새 창으로 열기' }))
    expect(windowOpen).toHaveBeenLastCalledWith(encodeScope({ kind: 'repo', owner: 'Acme', repo: 'api' }), 'Acme/api')
  })

  it('창을 열 수 없으면 상단 안내로 알린다', async () => {
    const { user } = setup({ tauri: { windowOpen: async () => Promise.reject(new Error('boom')) } })
    await user.click(await screen.findByRole('button', { name: 'Acme 새 창으로 열기' }))
    await waitFor(() => expect(useSessionStore.getState().notice).toBe('새 창을 열 수 없습니다 — boom'))
  })

  it('원격으로 붙은 화면에는 버튼이 없다', async () => {
    setup({ tauri: { runtime: 'remote' } })
    await screen.findByTestId('repo-node-Acme/api')
    expect(screen.queryByRole('button', { name: /새 창으로 열기/ })).toBeNull()
  })
})

describe('사용자 정의 그룹', () => {
  it('그룹을 만들면 트리 맨 위에 그룹 노드가 생기고, 여러 조직의 저장소를 보인다', async () => {
    const { user, windowOpen } = setup()
    await user.click(await screen.findByRole('button', { name: '그룹 만들기' }))
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText('그룹 이름'), '  백엔드 ')
    await user.click(within(dialog).getByRole('button', { name: 'Acme 저장소 펼치기' }))
    await user.click(await within(dialog).findByLabelText('api'))
    await user.click(within(dialog).getByRole('button', { name: 'Beta 저장소 펼치기' }))
    await user.click(await within(dialog).findByLabelText('tools'))
    await user.click(within(dialog).getByRole('button', { name: '저장' }))

    const [id] = Object.keys(useReposStore.getState().groups)
    expect(useReposStore.getState().groups[id]).toEqual({ name: '백엔드', repos: ['Acme/api', 'Beta/tools'] })
    const node = await screen.findByTestId(`group-node-${id}`)
    await user.click(node)
    // 그룹 아래와 Acme 조직 아래에 같은 저장소가 둘 다 보인다
    expect(screen.getAllByTestId('repo-node-Acme/api')).toHaveLength(2)
    expect(screen.getByTestId('repo-node-Beta/tools')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '백엔드 새 창으로 열기' }))
    expect(windowOpen).toHaveBeenLastCalledWith(encodeScope({ kind: 'group', id }), '백엔드')
  })

  it('이름이 비면 저장할 수 없다', async () => {
    const { user } = setup()
    await user.click(await screen.findByRole('button', { name: '그룹 만들기' }))
    expect(within(await screen.findByRole('dialog')).getByRole('button', { name: '저장' })).toBeDisabled()
  })

  it('편집에서 이름을 바꾸고, 두 번 눌러 지운다', async () => {
    useReposStore.setState({ groups: { g1: { name: 'old', repos: ['Acme/web'] } } })
    const { user } = setup()
    await user.click(await screen.findByRole('button', { name: 'old 그룹 편집' }))
    let dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByLabelText('Acme/web')).toBeChecked()
    const name = within(dialog).getByLabelText('그룹 이름')
    await user.clear(name)
    await user.type(name, 'new')
    await user.click(within(dialog).getByRole('button', { name: '저장' }))
    expect(useReposStore.getState().groups.g1.name).toBe('new')

    await user.click(await screen.findByRole('button', { name: 'new 그룹 편집' }))
    dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: '그룹 삭제' }))
    expect(useReposStore.getState().groups.g1).toBeDefined()
    await user.click(within(dialog).getByRole('button', { name: '정말 삭제' }))
    expect(useReposStore.getState().groups).toEqual({})
    await waitFor(() => expect(screen.queryByTestId('group-node-g1')).toBeNull())
  })
})

describe('범위 창의 트리', () => {
  it('조직 창: 그 조직만 펼친 채 보이고 그룹은 보이지 않는다', async () => {
    useReposStore.setState({ groups: { g1: { name: 'grp', repos: ['Acme/api'] } } })
    useUiStore.setState({ expanded: {} })
    setup({ scope: { kind: 'org', owner: 'Beta' } })
    expect(await screen.findByTestId('repo-node-Beta/tools')).toBeInTheDocument()
    expect(screen.queryByTestId('org-node-Acme')).toBeNull()
    expect(screen.queryByTestId('group-node-g1')).toBeNull()
  })

  it('조직 창은 "보이는 저장소" 필터로 뺀 저장소도 보인다', async () => {
    setup({ scope: { kind: 'org', owner: 'Acme' }, visible: ['Beta/tools'] })
    expect(await screen.findByTestId('repo-node-Acme/web')).toBeInTheDocument()
    expect(screen.getByTestId('repo-node-Acme/api')).toBeInTheDocument()
  })

  it('저장소 창: 그 저장소 하나만 보인다', async () => {
    setup({ scope: { kind: 'repo', owner: 'Acme', repo: 'web' } })
    expect(await screen.findByTestId('repo-node-Acme/web')).toBeInTheDocument()
    expect(screen.queryByTestId('repo-node-Acme/api')).toBeNull()
    expect(screen.queryByTestId('org-node-Beta')).toBeNull()
  })

  it('로컬 저장소 창: 로컬 저장소 노드 아래 그 저장소만', async () => {
    useReposStore.setState({ local: { 'proj-0001': { hostId: 'local', path: '/p', displayName: 'proj', tasks: [] }, 'other-0002': { hostId: 'local', path: '/o', displayName: 'other', tasks: [] } } })
    setup({ scope: { kind: 'repo', owner: LOCAL_OWNER, repo: 'proj-0001' } })
    expect(await screen.findByTestId(`repo-node-${LOCAL_OWNER}/proj-0001`)).toBeInTheDocument()
    expect(screen.queryByTestId(`repo-node-${LOCAL_OWNER}/other-0002`)).toBeNull()
  })

  it('다른 호스트의 로컬 저장소는 그룹에도, 저장소 창에도 보이지 않는다', async () => {
    useReposStore.setState({
      local: { 'here-0001': { hostId: 'local', path: '/h', displayName: 'here', tasks: [] }, 'far-0002': { hostId: 'ssh:srv', path: '/f', displayName: 'far', tasks: [] } },
      groups: { g1: { name: 'grp', repos: [`${LOCAL_OWNER}/here-0001`, `${LOCAL_OWNER}/far-0002`] } },
    })
    useUiStore.setState({ expanded: { 'group:g1': true } })
    setup()
    expect(await screen.findAllByTestId(`repo-node-${LOCAL_OWNER}/here-0001`)).not.toHaveLength(0)
    expect(screen.queryByTestId(`repo-node-${LOCAL_OWNER}/far-0002`)).toBeNull()
  })

  it('저장소 창: 다른 호스트의 로컬 저장소면 안내만 한다', async () => {
    useReposStore.setState({ local: { 'far-0002': { hostId: 'ssh:srv', path: '/f', displayName: 'far', tasks: [] } } })
    setup({ scope: { kind: 'repo', owner: LOCAL_OWNER, repo: 'far-0002' } })
    expect(await screen.findByText(/지금 고른 호스트에 없습니다/)).toBeInTheDocument()
  })

  it('그룹 창: 그 그룹만 보이고, 그룹이 지워지면 안내한다', async () => {
    useReposStore.setState({ groups: { g1: { name: 'grp', repos: ['Beta/tools'] } } })
    setup({ scope: { kind: 'group', id: 'g1' } })
    expect(await screen.findByTestId('repo-node-Beta/tools')).toBeInTheDocument()
    expect(screen.queryByTestId('org-node-Acme')).toBeNull()
    useReposStore.getState().removeGroup('g1')
    expect(await screen.findByText(/이 그룹이 삭제되었습니다/)).toBeInTheDocument()
  })
})

describe('Ctrl+Shift+N', () => {
  const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })

  it('새 창 키만 고른다(한글 IME 는 물리 키로)', () => {
    expect(isNewWindowKey(key({ key: 'N', ctrlKey: true, shiftKey: true }))).toBe(true)
    expect(isNewWindowKey(key({ key: 'ㅜ', code: 'KeyN', ctrlKey: true, shiftKey: true }))).toBe(true)
    expect(isNewWindowKey(key({ key: 'n', ctrlKey: true }))).toBe(false)
    expect(isNewWindowKey(key({ key: 'N', ctrlKey: true, shiftKey: true, altKey: true }))).toBe(false)
  })

  it('창을 열고, 대화상자가 열려 있거나 원격 화면(open=null)이면 하지 않는다', () => {
    const open = vi.fn()
    const { unmount } = renderHook(() => useNewWindowShortcut(open))
    window.dispatchEvent(key({ key: 'N', ctrlKey: true, shiftKey: true }))
    expect(open).toHaveBeenCalledTimes(1)
    const dialog = document.body.appendChild(Object.assign(document.createElement('div'), { role: 'dialog' }))
    dialog.setAttribute('role', 'dialog')
    window.dispatchEvent(key({ key: 'N', ctrlKey: true, shiftKey: true }))
    expect(open).toHaveBeenCalledTimes(1)
    dialog.remove()
    unmount()
    renderHook(() => useNewWindowShortcut(null))
    window.dispatchEvent(key({ key: 'N', ctrlKey: true, shiftKey: true }))
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('터미널이 셸로 보내지 않는다', () => {
    const handler = createTerminalKeyHandler(() => {})
    expect(handler(key({ key: 'N', ctrlKey: true, shiftKey: true }))).toBe(false)
    expect(handler(key({ key: 'n', ctrlKey: true }))).toBe(true)
  })
})
