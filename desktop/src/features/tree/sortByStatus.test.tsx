// 트리 이슈 목록을 에이전트 상태가 급한 순으로 정렬 (#98)
import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Effective } from '@minmo/api-client'
import { DEFAULT_SETTINGS } from '@minmo/core'
import type { GitHubClient, GitHubIssue } from '@minmo/core'

import { Workspace } from '../../app/Workspace'
import { TooltipProvider } from '../../components/ui/tooltip'
import { useSessionStore } from '../../store/session'
import { useSetupStore } from '../../store/setup'
import { useUiStore } from '../../store/ui'
import { createFakeApi, createFakeGitHub } from '../../test/fakes'
import { makeDeps, renderWithDeps } from '../../test/render'
import { statusRank, useAgentStore } from '../agents/agentStore'
import type { PaneAgent } from '../agents/agentStore'
import { WorktreeProvider } from '../issue/useWorktree'
import { ISSUE_SEARCH_MIN } from './issueSearch'

const ORG = { login: 'my-org', kind: 'org' as const, avatarUrl: null }
const REPO = { owner: 'my-org', name: 'widgets', defaultBranch: 'main' }
const issue = (number: number): GitHubIssue => ({ number, title: `Task ${number}`, state: 'open', htmlUrl: `https://github.com/my-org/widgets/issues/${number}`, assignees: [] })
const pane = (key: string, o: Partial<PaneAgent>): PaneAgent => ({
  paneId: `my-org/widgets#${key}::1`,
  issueId: `my-org/widgets#${key}`,
  agent: 'claude',
  program: 'claude',
  label: '',
  activity: 'idle',
  unseen: false,
  lastOutputAt: 0,
  since: 0,
  waitingSince: null,
  ...o,
})

beforeEach(() => {
  localStorage.clear()
  useSessionStore.setState(useSessionStore.getInitialState(), true)
  useSessionStore.setState({ token: 'tok', status: 'online', me: { id: 'usr_x', githubLogin: 'octocat', avatarUrl: null } })
  // #3 만 worktree 가 있다 — 기본 순서: 기타 → #3 → #5 #4 #2 #1
  useUiStore.setState({
    expanded: {},
    selectedIssueId: null,
    tab: 'terminal',
    worktreePathMap: { 'my-org/widgets#3': { path: '/w/3', branch: 'issue/3' } },
    terminalIds: {},
    treeAgentsOnly: false,
    treeSortByStatus: false,
  })
  useSetupStore.setState({ targets: {}, open: {}, script: {}, logs: {} })
  useAgentStore.getState().clear()
  for (const p of [
    pane('1', { unseen: true }), // 끝남
    pane('2', { activity: 'working' }),
    pane('4', { activity: 'attention' }),
    pane('5', {}), // 대기 중
  ])
    useAgentStore.getState().set(p.paneId, p)
})

const wrap = (ui: ReactNode) => (
  <TooltipProvider>
    <WorktreeProvider>{ui}</WorktreeProvider>
  </TooltipProvider>
)

async function renderTree(numbers = [1, 2, 3, 4, 5], overrides: Partial<GitHubClient> = {}) {
  const github = createFakeGitHub({ listOwners: async () => [ORG], listRepos: async () => [REPO], listIssues: async () => numbers.map(issue), ...overrides })
  const api = createFakeApi({ getEffective: async () => ({ values: { ...DEFAULT_SETTINGS }, sources: {} }) as unknown as Effective })
  renderWithDeps(wrap(<Workspace />), makeDeps({ github, api }))
  const user = userEvent.setup()
  await user.click(await screen.findByTestId('org-node-my-org'))
  await user.click(await screen.findByTestId('repo-node-my-org/widgets'))
  await screen.findByTestId('issue-row-1')
  return user
}

const rows = () => [...document.querySelectorAll('[data-testid^="issue-row-"]')].map((e) => e.getAttribute('data-testid')!.replace('issue-row-', ''))

describe('statusRank', () => {
  it('입력 대기 → 끝남 → 작업 중 → 대기 중 → 에이전트 없음', () => {
    const shuffled = ['idle', null, 'attention', 'working', 'done'] as const
    expect([...shuffled].sort((a, b) => statusRank(a) - statusRank(b))).toEqual(['attention', 'done', 'working', 'idle', null])
  })
})

describe('상태 순 정렬 (#98)', () => {
  it('끄면 기본 순서, 켜면 급한 상태부터 — 에이전트 없는 이슈는 기본 순서대로 뒤에', async () => {
    const user = await renderTree()
    expect(rows()).toEqual(['etc', '3', '5', '4', '2', '1'])

    const button = screen.getByRole('button', { name: '에이전트 상태 순으로 정렬' })
    expect(button).toHaveAttribute('aria-pressed', 'false')
    await user.click(button)
    expect(button).toHaveAttribute('aria-pressed', 'true')
    expect(useUiStore.getState().treeSortByStatus).toBe(true)
    await waitFor(() => expect(rows()).toEqual(['4', '1', '2', '5', 'etc', '3']))

    await user.click(button)
    await waitFor(() => expect(rows()).toEqual(['etc', '3', '5', '4', '2', '1']))
  })

  it('상태가 바뀌면 순서도 바뀐다', async () => {
    useUiStore.setState({ treeSortByStatus: true })
    await renderTree()
    expect(rows()).toEqual(['4', '1', '2', '5', 'etc', '3'])
    act(() => useAgentStore.getState().set('my-org/widgets#5::1', pane('5', { activity: 'attention' })))
    // 같은 상태 안에서는 기본 순서(#5 가 #4 보다 앞)
    await waitFor(() => expect(rows()).toEqual(['5', '4', '1', '2', 'etc', '3']))
  })

  it('"에이전트가 있는 이슈만" 과 함께 건다', async () => {
    useUiStore.setState({ treeSortByStatus: true, treeAgentsOnly: true })
    await renderTree()
    expect(rows()).toEqual(['4', '1', '2', '5'])
  })

  it('agentsOnly 와 함께: 에이전트가 없는 선택 이슈는 남고 맨 뒤에 온다', async () => {
    useUiStore.setState({ treeSortByStatus: true, treeAgentsOnly: true, selectedIssueId: 'my-org/widgets#3' })
    await renderTree()
    expect(rows()).toEqual(['4', '1', '2', '5', '3'])
  })

  it('한 이슈에 패널이 여럿이면 가장 급한 상태로, 기타 프로그램(개발 서버 등)은 세지 않는다', async () => {
    act(() => {
      useAgentStore.getState().set('my-org/widgets#5::2', { ...pane('5', { activity: 'attention' }), paneId: 'my-org/widgets#5::2' })
      useAgentStore.getState().set('my-org/widgets#3::1', pane('3', { agent: 'other', program: 'npm', activity: 'attention' }))
    })
    useUiStore.setState({ treeSortByStatus: true })
    await renderTree()
    expect(rows()).toEqual(['5', '4', '1', '2', 'etc', '3'])
  })

  it('GitHub 검색 결과는 정렬된 목록 뒤에 그대로 붙는다', async () => {
    useUiStore.setState({ treeSortByStatus: true })
    const numbers = Array.from({ length: ISSUE_SEARCH_MIN + 1 }, (_, i) => i + 1)
    const user = await renderTree(numbers, { searchIssues: vi.fn(async () => [issue(900)]) })
    await user.type(screen.getByTestId('issue-search'), 'Task')
    const rest = numbers.filter((n) => ![1, 2, 3, 4, 5].includes(n)).reverse().map(String)
    await waitFor(() => expect(rows()).toEqual(['4', '1', '2', '5', '3', ...rest, '900']))
  })
})

describe('저장', () => {
  it('켠 값은 저장되고, 다시 열면 돌아온다 — boolean 이 아닌 값은 버린다', async () => {
    act(() => useUiStore.getState().setTreeSortByStatus(true))
    expect(JSON.parse(localStorage.getItem('minmo-ui')!).state.treeSortByStatus).toBe(true)

    useUiStore.setState({ treeSortByStatus: false })
    localStorage.setItem('minmo-ui', JSON.stringify({ state: { treeSortByStatus: true }, version: 1 }))
    await useUiStore.persist.rehydrate()
    expect(useUiStore.getState().treeSortByStatus).toBe(true)

    useUiStore.setState({ treeSortByStatus: false })
    localStorage.setItem('minmo-ui', JSON.stringify({ state: { treeSortByStatus: 'true' }, version: 1 }))
    await useUiStore.persist.rehydrate()
    expect(useUiStore.getState().treeSortByStatus).toBe(false)
  })
})
