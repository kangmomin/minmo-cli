// GitHub 이슈 등록 — 트리의 저장소에서 제목·본문으로 등록하고 목록에만 넣는다
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'

import { GitHubError } from '@minmo/core'
import type { GitHubClient } from '@minmo/core'

import { Workspace } from '../../app/Workspace'
import { TooltipProvider } from '../../components/ui/tooltip'
import { useSessionStore } from '../../store/session'
import { useSetupStore } from '../../store/setup'
import { useUiStore } from '../../store/ui'
import { createFakeGitHub } from '../../test/fakes'
import { makeDeps, renderWithDeps } from '../../test/render'
import { WorktreeProvider } from '../issue/useWorktree'

const ORG = { login: 'my-org', kind: 'org' as const, avatarUrl: null }
const REPO = { owner: 'my-org', name: 'widgets', defaultBranch: 'main' }

beforeEach(() => {
  useSessionStore.setState(useSessionStore.getInitialState(), true)
  useSessionStore.setState({ token: 'tok', status: 'online', me: { id: 'usr_x', githubLogin: 'octocat', avatarUrl: null } })
  useUiStore.setState({ expanded: {}, selectedIssueId: null, tab: 'terminal', worktreePathMap: {}, terminalIds: {} })
  useSetupStore.setState({ targets: {}, open: {}, script: {}, logs: {} })
})

const wrap = (ui: ReactNode) => (
  <TooltipProvider>
    <WorktreeProvider>{ui}</WorktreeProvider>
  </TooltipProvider>
)

function renderWorkspace(overrides: Partial<GitHubClient> = {}) {
  const github = createFakeGitHub({
    listOwners: async () => [ORG],
    listRepos: async () => [REPO],
    listIssues: async () => [{ number: 42, title: 'Add login', state: 'open', htmlUrl: 'https://github.com/my-org/widgets/issues/42' }],
    createIssue: async (_o, _r, title) => ({ number: 43, title, state: 'open', htmlUrl: 'https://github.com/my-org/widgets/issues/43' }),
    ...overrides,
  })
  return { github, ...renderWithDeps(wrap(<Workspace />), makeDeps({ github })) }
}

async function expandRepo(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByTestId('org-node-my-org'))
  await user.click(await screen.findByTestId('repo-node-my-org/widgets'))
  await screen.findByTestId('issue-row-42')
}

describe('이슈 등록', () => {
  it('제목·본문으로 등록 → 다시 조회하지 않고 목록에 추가, 선택은 그대로', async () => {
    const user = userEvent.setup()
    const { github } = renderWorkspace()
    await expandRepo(user)
    await user.click(screen.getByTestId('add-issue'))
    const dialog = await screen.findByRole('dialog')
    const submit = within(dialog).getByRole('button', { name: '등록' })
    expect(submit).toBeDisabled() // 빈 제목
    await user.type(within(dialog).getByLabelText('제목'), '  새 기능  ')
    await user.type(within(dialog).getByLabelText('본문(선택)'), '설명{Enter}둘째 줄')
    await user.click(submit)

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(github.createIssue).toHaveBeenCalledWith('my-org', 'widgets', '새 기능', '설명\n둘째 줄')
    expect(await screen.findByTestId('issue-row-43')).toHaveTextContent('새 기능')
    // 번호 내림차순: ★기타 → #43 → #42
    expect([...document.querySelectorAll('[data-testid^="issue-row-"]')].map((e) => e.getAttribute('data-testid'))).toEqual([
      'issue-row-etc',
      'issue-row-43',
      'issue-row-42',
    ])
    expect(github.listIssues).toHaveBeenCalledTimes(1)
    expect(useUiStore.getState().selectedIssueId).toBeNull()
  })

  it('실패하면 오류를 보여 주고 입력을 남긴다 — 다시 누르면 등록된다', async () => {
    const user = userEvent.setup()
    let calls = 0
    const { github } = renderWorkspace({
      createIssue: async (_o, _r, title) => {
        if (calls++ === 0) throw new GitHubError('forbidden', { message: 'Resource not accessible' })
        return { number: 43, title, state: 'open', htmlUrl: '' }
      },
    })
    await expandRepo(user)
    await user.click(screen.getByTestId('add-issue'))
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText('제목'), '새 기능')
    await user.click(within(dialog).getByRole('button', { name: '등록' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('GitHub 접근 거부 — Resource not accessible')
    expect(within(dialog).getByLabelText('제목')).toHaveValue('새 기능')
    expect(screen.queryByTestId('issue-row-43')).toBeNull()

    await user.click(within(dialog).getByRole('button', { name: '등록' }))
    expect(await screen.findByTestId('issue-row-43')).toBeInTheDocument()
    expect(github.createIssue).toHaveBeenCalledTimes(2)
  })

  it('접힌 저장소에서도 버튼으로 등록할 수 있다(이름에 저장소가 들어간다) — 펼칠 때 목록을 조회한다', async () => {
    const user = userEvent.setup()
    const { github } = renderWorkspace()
    await user.click(await screen.findByTestId('org-node-my-org'))
    await user.click(await screen.findByRole('button', { name: 'widgets 이슈 등록' }))
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText('제목'), '새 기능')
    await user.click(within(dialog).getByRole('button', { name: '등록' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(github.createIssue).toHaveBeenCalledWith('my-org', 'widgets', '새 기능', '')
    expect(github.listIssues).not.toHaveBeenCalled()
  })
})
