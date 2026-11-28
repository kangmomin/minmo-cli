// 트리의 이슈 테이커 입구 — GitHub 저장소 메뉴·줄 버튼으로 대화상자 열기, 켜진 저장소 [테이커] 배지, 로컬 저장소·주 창 밖에서는 없음
import { fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TooltipProvider } from '../../components/ui/tooltip'
import { useHostsStore } from '../../store/hosts'
import { LOCAL_OWNER, useReposStore } from '../../store/repos'
import { useSessionStore } from '../../store/session'
import { useUiStore } from '../../store/ui'
import { createFakeApi, createFakeGitHub } from '../../test/fakes'
import { makeDeps, renderWithDeps } from '../../test/render'
import { WorktreeProvider } from '../issue/useWorktree'
import { TAKER_STORAGE_KEY, useTakerStore } from '../taker/takerStore'
import type { TakerRepoConfig } from '../taker/takerStore'
import { TakerActionsProvider } from '../taker/useIssueTaker'
import type { TakerActions } from '../taker/useIssueTaker'
import { registerLocalRepo } from './localRepos'
import { Sidebar } from './Sidebar'

const ME = { login: 'me', kind: 'user' as const, avatarUrl: null }

const cfg = (o: Partial<TakerRepoConfig> = {}): TakerRepoConfig => ({
  enabled: true,
  author: 'me',
  catchUp: false,
  steps: [{ kind: 'claude', command: 'claude {prompt}', prompt: '/common:ready-for-impl {issue}' }],
  baseline: 10,
  ...o,
})

const fakeActions = (): TakerActions => ({ stop: vi.fn(), restart: vi.fn(), nextStep: vi.fn(() => 'started' as const) })

function renderTree(o: { actions?: TakerActions | null } = {}) {
  const actions = o.actions === undefined ? fakeActions() : o.actions
  const github = createFakeGitHub({ listOwners: async () => [ME], listRepos: async () => [{ owner: 'me', name: 'alpha', defaultBranch: 'main' }] })
  const api = createFakeApi({ getVisibleRepos: async () => ({ repos: null, updatedAt: null }) })
  renderWithDeps(
    <TooltipProvider>
      <WorktreeProvider>
        <TakerActionsProvider value={actions}>
          <Sidebar onOpenSettings={() => {}} />
        </TakerActionsProvider>
      </WorktreeProvider>
    </TooltipProvider>,
    makeDeps({ github, api }),
  )
  return { user: userEvent.setup() }
}

const repoNode = () => screen.findByTestId('repo-node-me/alpha')

beforeEach(() => {
  localStorage.clear()
  useSessionStore.setState(useSessionStore.getInitialState(), true)
  useSessionStore.setState({ token: 'tok', status: 'online', me: { id: 'usr_x', githubLogin: 'me', avatarUrl: null } })
  useHostsStore.setState({ aliases: [], selected: null, probes: {}, connecting: {}, errors: {}, baseRepos: {}, baseDirs: {}, repoHosts: {} })
  useReposStore.setState({ added: [], local: {}, nicknames: {} })
  useUiStore.setState({ expanded: { 'org:me': true }, selectedIssueId: null, worktreePathMap: {}, terminalIds: {} })
  useTakerStore.setState({ repos: {}, taken: {}, runs: [], lastCheck: {} })
})
afterEach(() => {
  useTakerStore.setState({ repos: {}, taken: {}, runs: [], lastCheck: {} })
  localStorage.removeItem(TAKER_STORAGE_KEY)
})

describe('저장소 메뉴 → 이슈 테이커', () => {
  it('AC-01 GitHub 저장소를 우클릭하면 "이슈 테이커…" 가 있고, 누르면 "이슈 테이커 — {이름}" 대화상자가 열린다', async () => {
    const { user } = renderTree()
    fireEvent.contextMenu(await repoNode())
    await user.click(await screen.findByRole('menuitem', { name: '이슈 테이커…' }))
    expect(await screen.findByRole('dialog', { name: '이슈 테이커 — alpha' })).toBeInTheDocument()
  })

  it('UI-1 줄의 "{이름} 이슈 테이커" 버튼을 키보드로 눌러도 대화상자가 열린다', async () => {
    const { user } = renderTree()
    await repoNode()
    const button = screen.getByRole('button', { name: 'alpha 이슈 테이커' })
    button.focus()
    await user.keyboard('{Enter}')
    expect(await screen.findByRole('dialog', { name: '이슈 테이커 — alpha' })).toBeInTheDocument()
  })

  it('AC-03 켜진 저장소 줄에는 [테이커] 배지(title "이슈 테이커 켜짐")가 보인다', async () => {
    useTakerStore.setState({ repos: { 'me/alpha': cfg() } })
    renderTree()
    const badge = within(await repoNode()).getByText('테이커')
    expect(badge).toHaveAttribute('title', '이슈 테이커 켜짐')
  })

  it('AC-13 꺼진 저장소에는 [테이커] 배지가 없다', async () => {
    useTakerStore.setState({ repos: { 'me/alpha': cfg({ enabled: false }) } })
    renderTree()
    const node = await repoNode()
    expect(node).toHaveTextContent('alpha')
    expect(within(node).queryByText('테이커')).toBeNull()
  })

  it('AC-01 로컬 저장소(작업)에는 이슈 테이커 메뉴·버튼이 없다', async () => {
    const id = registerLocalRepo('local', '/src/my-app')
    const { user } = renderTree()
    const node = await screen.findByTestId(`repo-node-${LOCAL_OWNER}/${id}`)
    expect(screen.getByRole('button', { name: 'my-app 작업 추가' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'my-app 이슈 테이커' })).toBeNull()
    fireEvent.contextMenu(node)
    await screen.findByRole('menuitem', { name: '프로젝트 설정' })
    expect(screen.queryByRole('menuitem', { name: '이슈 테이커…' })).toBeNull()
    await user.keyboard('{Escape}')
  })

  it('EC-16 actions 가 없으면(보조 창·원격 화면) 메뉴·버튼·배지가 없다', async () => {
    useTakerStore.setState({ repos: { 'me/alpha': cfg() } })
    renderTree({ actions: null })
    const node = await repoNode()
    expect(screen.getByRole('button', { name: 'alpha 프로젝트 설정' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'alpha 이슈 테이커' })).toBeNull()
    expect(within(node).queryByText('테이커')).toBeNull()
    fireEvent.contextMenu(node)
    await screen.findByRole('menuitem', { name: '프로젝트 설정' })
    expect(screen.queryByRole('menuitem', { name: '이슈 테이커…' })).toBeNull()
  })
})
