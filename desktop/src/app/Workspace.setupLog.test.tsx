// 준비 로그 패널의 접힘 상태는 이슈마다 독립이다 (CR-13a) — key={이슈 id} 로 이슈 전환 시 새로 마운트
import { act, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { TooltipProvider } from '../components/ui/tooltip'
import { WorktreeProvider } from '../features/issue/useWorktree'
import { worktreeId } from '../lib/worktree'
import type { IssueTarget } from '../lib/worktree'
import { useSessionStore } from '../store/session'
import { useSetupStore } from '../store/setup'
import { useUiStore } from '../store/ui'
import { createFakeApi, createFakeGitHub } from '../test/fakes'
import { makeDeps, renderWithDeps } from '../test/render'
import { Workspace } from './Workspace'

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    loadAddon() {}
    open() {}
    write() {}
    onData() {
      return { dispose() {} }
    }
    attachCustomKeyEventHandler() {}
    dispose() {}
  },
}))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}))

const A: IssueTarget = { owner: 'o', repo: 'r', key: '1', number: 1, title: 'First' }
const B: IssueTarget = { owner: 'o', repo: 'r', key: '2', number: 2, title: 'Second' }
const idA = worktreeId(A.owner, A.repo, A.key)
const idB = worktreeId(B.owner, B.repo, B.key)

beforeEach(() => {
  useSessionStore.setState(useSessionStore.getInitialState(), true)
  useSessionStore.setState({ token: 'tok', status: 'online', me: { id: 'usr_x', githubLogin: 'octocat', avatarUrl: null } })
  useUiStore.setState({ expanded: {}, selectedIssueId: idA, tab: 'terminal', worktreePathMap: {}, terminalIds: {} })
  useSetupStore.setState({
    targets: { [idA]: A, [idB]: B },
    open: { [idA]: { phase: 'opening' }, [idB]: { phase: 'opening' } },
    script: {},
    logs: {
      [idA]: [{ issueId: idA, seq: 1, step: 'clone', status: 'start' }],
      [idB]: [{ issueId: idB, seq: 2, step: 'clone', status: 'start' }],
    },
  })
})

describe('CR-13(a) 준비 로그 접힘 상태는 이슈 간에 이어지지 않는다', () => {
  it('A 에서 접고 B 로 전환하면 B 는 펼쳐져 있고, 다시 A 로 돌아와도 펼쳐진 상태로 시작한다', async () => {
    const user = userEvent.setup()
    renderWithDeps(
      <TooltipProvider>
        <WorktreeProvider>
          <Workspace />
        </WorktreeProvider>
      </TooltipProvider>,
      makeDeps({
        api: createFakeApi({ getNotes: async () => ({ body: '', updatedAt: null }) }),
        github: createFakeGitHub({ listOwners: async () => [] }),
      }),
    )
    const toggle = () => screen.getByRole('button', { name: '준비 로그' })

    expect(toggle()).toHaveAttribute('aria-expanded', 'true')
    await user.click(toggle())
    expect(toggle()).toHaveAttribute('aria-expanded', 'false')

    act(() => useUiStore.setState({ selectedIssueId: idB }))
    expect(toggle()).toHaveAttribute('aria-expanded', 'true')

    act(() => useUiStore.setState({ selectedIssueId: idA }))
    expect(toggle()).toHaveAttribute('aria-expanded', 'true')
  })
})
