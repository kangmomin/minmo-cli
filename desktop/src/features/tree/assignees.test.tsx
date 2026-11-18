// 담당자 표시와 나에게 assign · 해제 (#86)
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'

import type { GitHubClient, GitHubIssue } from '@minmo/core'

import { Workspace } from '../../app/Workspace'
import { TooltipProvider } from '../../components/ui/tooltip'
import { useSessionStore } from '../../store/session'
import { useSetupStore } from '../../store/setup'
import { useUiStore } from '../../store/ui'
import { createFakeGitHub } from '../../test/fakes'
import { makeDeps, renderWithDeps } from '../../test/render'
import { WorktreeProvider } from '../issue/useWorktree'

const ME = { login: 'octocat', kind: 'user' as const, avatarUrl: null }
const ORG = { login: 'my-org', kind: 'org' as const, avatarUrl: null }
const REPO = { owner: 'my-org', name: 'widgets', defaultBranch: 'main' }
const issue = (number: number, assignees: string[] = []): GitHubIssue => ({
  number,
  title: `Task ${number}`,
  state: 'open',
  htmlUrl: `https://github.com/my-org/widgets/issues/${number}`,
  assignees,
})

beforeEach(() => {
  useSessionStore.setState(useSessionStore.getInitialState(), true)
  useSessionStore.setState({ token: 'tok', status: 'online', me: { id: 'usr_x', githubLogin: 'octocat', avatarUrl: null } })
  useUiStore.setState({ expanded: {}, selectedIssueId: null, tab: 'terminal', worktreePathMap: {}, terminalIds: {}, treeAgentsOnly: false })
  useSetupStore.setState({ targets: {}, open: {}, script: {}, logs: {} })
})

async function renderTree(issues: GitHubIssue[], overrides: Partial<GitHubClient> = {}) {
  const github = createFakeGitHub({ listOwners: async () => [ME, ORG], listRepos: async () => [REPO], listIssues: async () => issues, ...overrides })
  renderWithDeps(
    <TooltipProvider>
      <WorktreeProvider>
        <Workspace />
      </WorktreeProvider>
    </TooltipProvider>,
    makeDeps({ github }),
  )
  const user = userEvent.setup()
  await user.click(await screen.findByTestId('org-node-my-org'))
  await user.click(await screen.findByTestId('repo-node-my-org/widgets'))
  await screen.findByTestId(`issue-row-${issues[0].number}`)
  return Object.assign(user, { github })
}

const row = (key: number | 'etc') => screen.getByTestId(`issue-row-${key}`)
const badge = (key: number | 'etc') => within(row(key)).queryByTestId('issue-assignees')

describe('담당자 배지', () => {
  it('담당자가 있는 이슈에만 @login 을 보이고, 여러 명이면 나머지 수를 붙인다 · 내가 담당자면 내 login 이 먼저다', async () => {
    await renderTree([issue(1, ['alice']), issue(2, ['alice', 'octocat']), issue(3)])

    expect(badge(1)).toHaveTextContent('@alice')
    expect(badge(1)).not.toHaveAttribute('data-mine')
    expect(badge(1)).toHaveAttribute('title', '담당자: alice')

    expect(within(badge(2)!).getByText('@octocat +1')).toBeInTheDocument()
    expect(badge(2)).toHaveAttribute('data-mine', 'true')
    // "+1" 이 누구인지 title·스크린 리더용 글에서 알 수 있다
    expect(badge(2)).toHaveAttribute('title', '담당자: octocat, alice')

    expect(badge(3)).toBeNull()
    expect(badge('etc')).toBeNull()
  })
})

describe('나에게 assign · 해제', () => {
  it('우클릭 메뉴로 assign 하면 다시 조회하지 않고 배지가 생기고, 해제하면 사라진다', async () => {
    const user = await renderTree([issue(1, ['alice']), issue(3)], {
      assignIssue: async (_o, _r, number, login) => issue(number, [login]),
      unassignIssue: async (_o, _r, number) => issue(number),
    })

    fireEvent.contextMenu(row(3))
    await user.click(await screen.findByRole('menuitem', { name: '나에게 assign' }))
    expect(user.github.assignIssue).toHaveBeenCalledWith('my-org', 'widgets', 3, 'octocat')
    await waitFor(() => expect(badge(3)).toHaveAttribute('data-mine', 'true'))

    fireEvent.contextMenu(row(3))
    await user.click(await screen.findByRole('menuitem', { name: '내 assign 해제' }))
    expect(user.github.unassignIssue).toHaveBeenCalledWith('my-org', 'widgets', 3, 'octocat')
    await waitFor(() => expect(badge(3)).toBeNull())

    expect(user.github.listIssues).toHaveBeenCalledTimes(1)
  })

  it('★기타에는 assign 메뉴가 없다', async () => {
    await renderTree([issue(3)])
    fireEvent.contextMenu(row('etc'))
    await screen.findByRole('menuitem', { name: '열기' })
    expect(screen.queryByRole('menuitem', { name: '나에게 assign' })).toBeNull()
  })

  it('GitHub 이 assign 을 무시하면(쓰기 권한 없음) 오류를 알린다', async () => {
    const user = await renderTree([issue(3)], { assignIssue: async (_o, _r, number) => issue(number) })
    fireEvent.contextMenu(row(3))
    await user.click(await screen.findByRole('menuitem', { name: '나에게 assign' }))
    const dialog = await screen.findByRole('dialog', { name: 'assign 실패' })
    expect(within(dialog).getByRole('alert')).toHaveTextContent('쓰기 권한이 필요합니다')
    expect(badge(3)).toBeNull()
  })
})
