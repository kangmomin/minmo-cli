// 이슈 머리줄의 [E2E 큐에 추가](#92) — 작업 폴더가 준비된 이슈만, 같은 이슈가 대기·실행 중이면 넣지 않고 알린다
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'

import { worktreeId } from '@minmo/core'
import type { IssueTarget } from '@minmo/core'

import { TooltipProvider } from '../../components/ui/tooltip'
import { useReposStore } from '../../store/repos'
import type { IssueOpenState } from '../../store/setup'
import { useSessionStore } from '../../store/session'
import { useUiStore } from '../../store/ui'
import { makeDeps, renderWithDeps } from '../../test/render'
import { useE2eQueueStore } from '../e2eQueue/queueStore'
import { IssueHeader } from './IssueHeader'
import { WorktreeProvider } from './useWorktree'

const T: IssueTarget = { owner: 'my-org', repo: 'widgets', key: '42', number: 42, title: 'Add login' }
const ID = worktreeId('my-org', 'widgets', '42')
const READY: IssueOpenState = { phase: 'ready', path: '/w/42', branch: 'feat/42', pathChanged: false }

beforeEach(() => {
  useSessionStore.setState(useSessionStore.getInitialState(), true)
  useSessionStore.setState({ token: 'tok', status: 'online' })
  useUiStore.setState({ launchRequest: null })
  useReposStore.setState({ added: [], local: {}, lastParent: {} })
  useE2eQueueStore.setState({ jobs: [] })
})

function renderHeader(state: IssueOpenState | undefined) {
  renderWithDeps(
    <TooltipProvider>
      <WorktreeProvider>
        <IssueHeader target={T} state={state} />
      </WorktreeProvider>
    </TooltipProvider>,
    makeDeps(),
  )
  return userEvent.setup()
}

describe('[E2E 큐에 추가]', () => {
  it('AC-01 작업 폴더가 준비된 이슈에서 누르면 큐에 대기 작업 1개를 넣는다', async () => {
    const user = renderHeader(READY)
    await user.click(screen.getByRole('button', { name: 'E2E 큐에 추가' }))
    expect(useE2eQueueStore.getState().jobs).toEqual([expect.objectContaining({ issueId: ID, title: 'my-org/widgets #42 Add login', status: 'queued' })])
    expect(screen.getByTestId('e2e-enqueue-status')).toHaveTextContent('E2E 큐에 추가했습니다')
  })

  it('EC-04 같은 이슈가 이미 대기·실행 중이면 넣지 않고 안내한다', async () => {
    const user = renderHeader(READY)
    await user.click(screen.getByRole('button', { name: 'E2E 큐에 추가' }))
    await user.click(screen.getByRole('button', { name: 'E2E 큐에 추가' }))
    expect(useE2eQueueStore.getState().jobs).toHaveLength(1)
    expect(screen.getByTestId('e2e-enqueue-status')).toHaveTextContent('이미 E2E 큐에서 대기·실행 중입니다')
    expect(screen.getByTestId('e2e-enqueue-status')).toHaveAttribute('role', 'status')
  })

  it('AC-01 작업 폴더가 준비되지 않았으면(열기 중·없음) 버튼이 없다', () => {
    renderHeader({ phase: 'opening' })
    expect(screen.queryByRole('button', { name: 'E2E 큐에 추가' })).toBeNull()
  })
})
