// "경로 변경됨" 배지(EC-24) — worktree 경로가 원본 기준 상대 경로(#66)여도 이슈 열기와 같은 원본(기준 저장소 폴더)으로 계산한다
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, expect, it } from 'vitest'

import type { Effective } from '@minmo/api-client'
import { DEFAULT_SETTINGS } from '@minmo/core'
import type { GitHubIssue } from '@minmo/core'

import { Workspace } from '../../app/Workspace'
import { TooltipProvider } from '../../components/ui/tooltip'
import { useHostsStore } from '../../store/hosts'
import { useSessionStore } from '../../store/session'
import { useSetupStore } from '../../store/setup'
import { useUiStore } from '../../store/ui'
import { createFakeApi, createFakeGitHub } from '../../test/fakes'
import { makeDeps, renderWithDeps } from '../../test/render'
import { WorktreeProvider } from '../issue/useWorktree'

const ORG = { login: 'my-org', kind: 'org' as const, avatarUrl: null }
const REPO = { owner: 'my-org', name: 'widgets', defaultBranch: 'main' }
const issue = (number: number): GitHubIssue => ({ number, title: `Task ${number}`, state: 'open', htmlUrl: `https://github.com/my-org/widgets/issues/${number}` })

beforeEach(() => {
  useSessionStore.setState(useSessionStore.getInitialState(), true)
  useSessionStore.setState({ token: 'tok', status: 'online', me: { id: 'usr_x', githubLogin: 'octocat', avatarUrl: null } })
  useUiStore.setState({ expanded: {}, selectedIssueId: null, tab: 'terminal', worktreePathMap: {}, terminalIds: {}, treeAgentsOnly: false })
  useSetupStore.setState({ targets: {}, open: {}, script: {}, logs: {} })
  useHostsStore.setState({ baseRepos: {}, baseDirs: {} })
})

const wrap = (ui: ReactNode) => (
  <TooltipProvider>
    <WorktreeProvider>{ui}</WorktreeProvider>
  </TooltipProvider>
)

it('기준 저장소 폴더 기준 상대 경로: 그 폴더 옆의 worktree 는 배지 없음, 다른 위치는 배지', async () => {
  useHostsStore.setState({ baseRepos: { local: { 'my-org/widgets': '/src/widgets' } } })
  useUiStore.setState({
    worktreePathMap: {
      'my-org/widgets#2': { path: '/src/widgets-wt/issue--2-task-2', branch: 'issue/2-task-2' },
      'my-org/widgets#3': { path: '/home/u/minmo-workspaces/my-org/widgets/wt/issue--3-task-3', branch: 'issue/3-task-3' },
    },
  })
  const github = createFakeGitHub({ listOwners: async () => [ORG], listRepos: async () => [REPO], listIssues: async () => [issue(2), issue(3)] })
  const api = createFakeApi({
    getEffective: async () => ({ values: { ...DEFAULT_SETTINGS, worktreePath: '../widgets-wt/{branch}' }, sources: {} }) as unknown as Effective,
  })
  renderWithDeps(wrap(<Workspace />), makeDeps({ github, api }))
  const user = userEvent.setup()
  await user.click(await screen.findByTestId('org-node-my-org'))
  await user.click(await screen.findByTestId('repo-node-my-org/widgets'))

  // effective 를 읽어 배지를 계산한 뒤에 본다 — 메인 clone(_main) 기준으로 풀었다면 #2 에도 배지가 붙는다
  await waitFor(() => expect(within(screen.getByTestId('issue-row-3')).getByText('경로 변경됨')).toBeInTheDocument())
  expect(within(screen.getByTestId('issue-row-2')).queryByText('경로 변경됨')).not.toBeInTheDocument()
})
