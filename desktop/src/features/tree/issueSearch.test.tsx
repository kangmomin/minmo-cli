// 이슈 목록 — 작업 중인(worktree 가 있는) 이슈를 위로, 이슈가 많은 저장소에서 번호·제목 검색
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Effective } from '@minmo/api-client'
import { DEFAULT_SETTINGS } from '@minmo/core'
import { GitHubError } from '@minmo/core'
import type { GitHubClient, GitHubIssue } from '@minmo/core'

import { Workspace } from '../../app/Workspace'
import { TooltipProvider } from '../../components/ui/tooltip'
import { useSessionStore } from '../../store/session'
import { useSetupStore } from '../../store/setup'
import { useUiStore } from '../../store/ui'
import { createFakeApi, createFakeGitHub, deferred } from '../../test/fakes'
import { makeDeps, renderWithDeps } from '../../test/render'
import { WorktreeProvider } from '../issue/useWorktree'
import { ISSUE_SEARCH_MIN, matchesIssue } from './issueSearch'
import { ISSUE_SEARCH_DEBOUNCE_MS } from './useTree'

const ORG = { login: 'my-org', kind: 'org' as const, avatarUrl: null }
const REPO = { owner: 'my-org', name: 'widgets', defaultBranch: 'main' }
const issue = (number: number, title: string, state: 'open' | 'closed' = 'open'): GitHubIssue => ({ number, title, state, htmlUrl: `https://github.com/my-org/widgets/issues/${number}`, assignees: [] })
/** #1 … #n — 제목은 "Task <번호>" */
const many = (n: number) => Array.from({ length: n }, (_, i) => issue(i + 1, `Task ${i + 1}`))

beforeEach(() => {
  useSessionStore.setState(useSessionStore.getInitialState(), true)
  useSessionStore.setState({ token: 'tok', status: 'online', me: { id: 'usr_x', githubLogin: 'octocat', avatarUrl: null } })
  useUiStore.setState({ expanded: {}, selectedIssueId: null, tab: 'terminal', worktreePathMap: {}, terminalIds: {}, treeAgentsOnly: false })
  useSetupStore.setState({ targets: {}, open: {}, script: {}, logs: {} })
})

const wrap = (ui: ReactNode) => (
  <TooltipProvider>
    <WorktreeProvider>{ui}</WorktreeProvider>
  </TooltipProvider>
)

async function renderTree(issues: GitHubIssue[], overrides: Partial<GitHubClient> = {}) {
  const github = createFakeGitHub({ listOwners: async () => [ORG], listRepos: async () => [REPO], listIssues: async () => issues, ...overrides })
  // worktree 가 있으면 "경로 변경됨" 배지 계산에 effective 를 읽는다
  const api = createFakeApi({ getEffective: async () => ({ values: { ...DEFAULT_SETTINGS }, sources: {} }) as unknown as Effective })
  renderWithDeps(wrap(<Workspace />), makeDeps({ github, api }))
  const user = userEvent.setup()
  await user.click(await screen.findByTestId('org-node-my-org'))
  await user.click(await screen.findByTestId('repo-node-my-org/widgets'))
  await screen.findByTestId(`issue-row-${issues[0].number}`)
  return Object.assign(user, { github })
}

const rows = () => [...document.querySelectorAll('[data-testid^="issue-row-"]')].map((e) => e.getAttribute('data-testid')!.replace('issue-row-', ''))

describe('matchesIssue', () => {
  const i = { number: 42, title: 'Add Login page' }
  it('제목(대소문자 무시)·번호(42, #42)로 찾고, 여러 단어는 모두 맞아야 한다', () => {
    for (const q of ['', '   ', 'login', 'ADD', '42', '#42', '4', 'add page', 'login 42', '  #42   add ']) expect(matchesIssue(i, q)).toBe(true)
    for (const q of ['logout', '43', '#43', 'add logout', '#', '#login']) expect(matchesIssue(i, q)).toBe(false)
  })

  it('제목 속의 숫자도 찾는다 · 번호가 없는 줄(★기타)은 제목만 본다', () => {
    expect(matchesIssue({ number: 7, title: 'Upgrade to v42' }, '42')).toBe(true)
    expect(matchesIssue({ number: null, title: '기타' }, '기타')).toBe(true)
    expect(matchesIssue({ number: null, title: '기타' }, '1')).toBe(false)
    // 조합형(NFD)으로 붙여 넣은 한글 제목도 완성형 검색어로 찾는다
    expect(matchesIssue({ number: 1, title: '로그인'.normalize('NFD') }, '로그인')).toBe(true)
    expect(matchesIssue({ number: 1, title: '로그인' }, '로그인'.normalize('NFD'))).toBe(true)
  })
})

describe('작업 중인 이슈를 위로', () => {
  it('★기타 → worktree 가 있는 이슈(번호 내림차순, 닫힌 이슈 포함) → 나머지(번호 내림차순)', async () => {
    useUiStore.setState({
      worktreePathMap: {
        'my-org/widgets#2': { path: '/w/2', branch: 'issue/2' },
        'my-org/widgets#4': { path: '/w/4', branch: 'issue/4' },
        // 다른 호스트의 worktree 는 이 PC 의 순서에 넣지 않는다
        'ssh:srv|my-org/widgets#1': { path: '/w/1', branch: 'issue/1' },
      },
    })
    await renderTree([issue(5, 'five'), issue(4, 'four', 'closed'), issue(3, 'three'), issue(2, 'two'), issue(1, 'one')])
    expect(rows()).toEqual(['etc', '4', '2', '5', '3', '1'])
    expect(screen.getByTestId('issue-row-4')).toHaveAttribute('data-worktree', 'true')
    expect(screen.getByTestId('issue-row-1')).not.toHaveAttribute('data-worktree', 'true')
  })
})

describe('이슈 검색', () => {
  it(`이슈가 ${ISSUE_SEARCH_MIN}개 이하면 검색 칸이 없다`, async () => {
    await renderTree(many(ISSUE_SEARCH_MIN))
    expect(screen.queryByTestId('issue-search')).not.toBeInTheDocument()
  })

  it('이슈가 많으면 검색 칸이 보이고, 번호·제목으로 거른다 — 지우면 전체가 돌아온다', async () => {
    const user = await renderTree([...many(ISSUE_SEARCH_MIN), issue(42, 'Add login')])
    const box = screen.getByRole('searchbox', { name: 'widgets 이슈 검색' })
    await user.type(box, 'LOGIN')
    expect(rows()).toEqual(['42'])
    // 결과 수는 GitHub 조회가 끝난 뒤에 알린다
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('검색 결과 1개'))
    await user.clear(box)
    await user.type(box, '#1')
    // 번호에 1 이 들어간 이슈(#10, #1) — ★기타와 #42 는 빠진다
    expect(rows()).toEqual(['10', '1'])
    await user.clear(box)
    expect(rows()).toHaveLength(ISSUE_SEARCH_MIN + 2)
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
  })

  it('결과가 없으면 알리고 [이슈 등록] 은 남긴다 · Esc 로 검색어를 지운다', async () => {
    const user = await renderTree(many(ISSUE_SEARCH_MIN + 1))
    const box = screen.getByTestId('issue-search')
    await user.type(box, 'nope')
    expect(rows()).toEqual([])
    expect(await screen.findByText('검색 결과 없음')).toBeInTheDocument()
    expect(screen.getByTestId('add-issue')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(box).toHaveValue('')
    expect(rows()).toHaveLength(ISSUE_SEARCH_MIN + 2)
  })

  it('찾은 결과에서도 작업 중인 이슈가 위에 온다 · "에이전트가 있는 이슈만" 과 함께 건다', async () => {
    useUiStore.setState({ worktreePathMap: { 'my-org/widgets#3': { path: '/w/3', branch: 'issue/3' } } })
    const user = await renderTree([...many(ISSUE_SEARCH_MIN), issue(13, 'Task 13'), issue(30, 'Task 30')])
    await user.type(screen.getByTestId('issue-search'), '3')
    expect(rows()).toEqual(['3', '30', '13'])
    // 에이전트가 도는 이슈가 없으면 검색 결과도 없다
    useUiStore.setState({ treeAgentsOnly: true })
    await waitFor(() => expect(rows()).toEqual([]))
    // 무엇이 가렸는지 알린다(검색어가 아니라 에이전트 필터)
    expect(screen.getByText('에이전트가 도는 이슈 중 검색 결과 없음')).toBeInTheDocument()
  })
})

describe('목록에 없는 이슈를 GitHub 에서 찾는다 (#83)', () => {
  // 불러온 목록(상한 안)에는 #1…#11 만 있고, #900·#901 은 GitHub 에만 있다
  const loaded = many(ISSUE_SEARCH_MIN + 1)
  const far = [issue(900, 'Far login'), issue(901, 'Far logout')]

  it('입력이 멈춘 뒤 한 번만 묻고, 목록 결과 아래에 번호 내림차순으로 붙인다 — 목록에 이미 있는 이슈는 한 번만', async () => {
    const searchIssues = vi.fn(async () => [far[0], far[1], loaded[2]])
    const user = await renderTree(loaded, { searchIssues })
    await user.type(screen.getByTestId('issue-search'), '  Far  ')
    // GitHub 이 찾은 #3 은 제목이 검색어와 맞지 않아도 남긴다(목록 쪽 줄로 한 번만)
    await waitFor(() => expect(rows()).toEqual(['3', '901', '900']))
    expect(searchIssues).toHaveBeenCalledTimes(1)
    expect(searchIssues).toHaveBeenCalledWith('my-org', 'widgets', 'Far')
    expect(screen.getByRole('status')).toHaveTextContent('검색 결과 3개')
    expect(screen.queryByText('GitHub 에서 찾는 중…')).not.toBeInTheDocument()
  })

  it('찾는 동안 알리고, 끝나기 전에는 "검색 결과 없음" 을 보이지 않는다', async () => {
    const pending = deferred<GitHubIssue[]>()
    const user = await renderTree(loaded, { searchIssues: () => pending.promise })
    await user.type(screen.getByTestId('issue-search'), 'far')
    expect(screen.getByText('GitHub 에서 찾는 중…')).toBeInTheDocument()
    expect(screen.queryByText('검색 결과 없음')).not.toBeInTheDocument()
    await waitFor(() => expect(user.github.searchIssues).toHaveBeenCalled())
    expect(screen.queryByText('검색 결과 없음')).not.toBeInTheDocument()
    pending.resolve([])
    expect(await screen.findByText('검색 결과 없음')).toBeInTheDocument()
  })

  it('누른 줄은 검색어를 지워도 남는다(목록 캐시에 넣는다)', async () => {
    const user = await renderTree(loaded, { searchIssues: async () => far })
    const box = screen.getByTestId('issue-search')
    await user.type(box, 'far')
    await user.click(await screen.findByTestId('issue-row-900'))
    // 목록 쪽으로 옮겨 가도 같은 줄이다 — 키보드 포커스를 잃지 않는다
    expect(screen.getByTestId('issue-row-900')).toHaveFocus()
    await user.clear(box)
    expect(rows()).toContain('900')
    expect(rows()).not.toContain('901')
  })

  it('실패하면 목록 결과는 그대로 두고 알린다 — [재시도] 로만 다시 묻는다', async () => {
    let fail = true
    const searchIssues = vi.fn(async () => {
      if (fail) throw new GitHubError('rate_limited', { retryAt: null })
      return far
    })
    const user = await renderTree(loaded, { searchIssues })
    await user.type(screen.getByTestId('issue-search'), 'task 11')
    expect(await screen.findByText('GitHub 검색 실패 — GitHub 사용량 제한 — 잠시 후 재시도')).toBeInTheDocument()
    expect(rows()).toEqual(['11'])
    expect(searchIssues).toHaveBeenCalledTimes(1)
    fail = false
    await user.click(screen.getByRole('button', { name: '재시도' }))
    await waitFor(() => expect(rows()).toEqual(['11', '901', '900']))
  })

  it('"에이전트가 있는 이슈만" 이 켜져 있으면 GitHub 에 묻지 않는다', async () => {
    useUiStore.setState({ treeAgentsOnly: true, selectedIssueId: 'my-org/widgets#1' })
    const user = await renderTree(loaded, { searchIssues: async () => far })
    await user.type(screen.getByTestId('issue-search'), 'far')
    expect(await screen.findByText('에이전트가 도는 이슈 중 검색 결과 없음')).toBeInTheDocument()
    await new Promise((r) => setTimeout(r, ISSUE_SEARCH_DEBOUNCE_MS + 100))
    expect(user.github.searchIssues).not.toHaveBeenCalled()
  })
})
