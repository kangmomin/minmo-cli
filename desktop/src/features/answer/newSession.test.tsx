// [새 세션](#122) — 프로젝트·이슈 트리 대화상자 → 이슈를 고르면 열고 [에이전트 실행]을 요청한다(Plan §8, U5)
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Effective } from '@minmo/api-client'
import { DEFAULT_SETTINGS } from '@minmo/core'
import type { GitHubIssue } from '@minmo/core'

import { TooltipProvider } from '../../components/ui/tooltip'
import { useSessionStore } from '../../store/session'
import { useSetupStore } from '../../store/setup'
import { useUiStore } from '../../store/ui'
import { createFakeApi, createFakeGitHub } from '../../test/fakes'
import { makeDeps, renderWithDeps } from '../../test/render'
import { WorktreeProvider } from '../issue/useWorktree'
import { NewSessionDialog } from './NewSessionDialog'

const ORG = { login: 'my-org', kind: 'org' as const, avatarUrl: null }
const REPO = { owner: 'my-org', name: 'widgets', defaultBranch: 'main' }
const issue = (number: number): GitHubIssue => ({ number, title: `Task ${number}`, state: 'open', htmlUrl: `https://github.com/my-org/widgets/issues/${number}`, assignees: [] })
const ISSUE_7 = 'my-org/widgets#7'

beforeEach(() => {
  localStorage.clear()
  useSessionStore.setState(useSessionStore.getInitialState(), true)
  useSessionStore.setState({ token: 'tok', status: 'online', me: { id: 'usr_x', githubLogin: 'octocat', avatarUrl: null } })
  useUiStore.setState({ expanded: {}, selectedIssueId: null, tab: 'terminal', launchRequest: null, worktreePathMap: {}, terminalIds: {}, viewMode: 'answer' })
  useSetupStore.setState({ targets: {}, open: {}, script: {}, logs: {} })
})

/** Workspace 처럼 열림 상태를 가진다 — 닫힐 때의 포커스 처리(onCloseAutoFocus)는 실제로 닫혀야 돈다 */
function Harness(p: { onOpenChange(o: boolean): void; onOpenSettings: () => void; onCloseFocus(): void }) {
  const [open, setOpen] = useState(true)
  return (
    <NewSessionDialog
      open={open}
      onOpenChange={(o) => {
        p.onOpenChange(o)
        setOpen(o)
      }}
      onOpenSettings={p.onOpenSettings}
      onCloseFocus={p.onCloseFocus}
    />
  )
}

function setup(o: { effective?: () => Promise<Effective> } = {}) {
  const onOpenChange = vi.fn()
  const onCloseFocus = vi.fn()
  const onOpenSettings = vi.fn()
  const github = createFakeGitHub({ listOwners: async () => [ORG], listRepos: async () => [REPO], listIssues: async () => [issue(7), issue(8)] })
  const api = createFakeApi({ getEffective: o.effective ?? (async () => ({ values: { ...DEFAULT_SETTINGS }, sources: {} }) as unknown as Effective) })
  renderWithDeps(
    <TooltipProvider>
      <WorktreeProvider>
        <Harness onOpenChange={onOpenChange} onOpenSettings={onOpenSettings} onCloseFocus={onCloseFocus} />
      </WorktreeProvider>
    </TooltipProvider>,
    makeDeps({ github, api }),
  )
  return { onOpenChange, onCloseFocus, onOpenSettings, user: userEvent.setup() }
}

/** 대화상자 안의 트리에서 이슈 행까지 펼친다 */
async function expandTo(user: ReturnType<typeof userEvent.setup>) {
  const dialog = await screen.findByRole('dialog', { name: '새 세션' })
  await user.click(await within(dialog).findByTestId('org-node-my-org'))
  await user.click(await within(dialog).findByTestId('repo-node-my-org/widgets'))
  return { dialog, row: await within(dialog).findByTestId('issue-row-7') }
}

describe('NewSessionDialog', () => {
  it('AC-12 [새 세션] 대화상자: 이름 "새 세션"과 안내, 그 안에 프로젝트·이슈 트리를 보인다', async () => {
    const { user } = setup()
    const { dialog, row } = await expandTo(user)
    expect(dialog).toHaveAccessibleDescription('이슈를 고르면 작업 폴더를 준비하고 에이전트 실행 창을 엽니다')
    expect(row).toBeInTheDocument()
  })

  it('AC-12 이슈를 누르면 대화상자를 닫고 그 이슈를 열며, 준비되면 [에이전트 실행]을 열도록 요청한다', async () => {
    const { user, onOpenChange } = setup()
    const { row } = await expandTo(user)
    await user.click(row)
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(useUiStore.getState().launchRequest).toBe(ISSUE_7)
    await waitFor(() => expect(useUiStore.getState().selectedIssueId).toBe(ISSUE_7))
    expect(useSetupStore.getState().targets[ISSUE_7]).toMatchObject({ owner: 'my-org', repo: 'widgets', number: 7 })
  })

  it('AC-13 대화상자 트리의 펼침은 기본 보기의 트리와 같이 쓴다', async () => {
    const { user } = setup()
    await expandTo(user)
    expect(useUiStore.getState().expanded).toMatchObject({ 'org:my-org': true, 'repo:my-org/widgets': true })
  })

  it('AC-12 대화상자를 닫으면 포커스를 카드 제목(없으면 [새 세션])으로 옮긴다 — 열기 전 자리로 자동 복귀하지 않는다', async () => {
    const { user, onCloseFocus, onOpenChange } = setup()
    await screen.findByRole('dialog', { name: '새 세션' })
    await user.keyboard('{Escape}')
    expect(onOpenChange).toHaveBeenCalledWith(false)
    await waitFor(() => expect(onCloseFocus).toHaveBeenCalled())
  })

  it('EC-14 고른 이슈의 준비가 실패해도 그 이슈에 머문다(머리줄의 오류·[다시 열기]로 다룬다)', async () => {
    const { user } = setup({
      effective: async () => {
        throw new Error('설정을 받아 오지 못했습니다')
      },
    })
    const { row } = await expandTo(user)
    await user.click(row)
    await waitFor(() => expect(useSetupStore.getState().open[ISSUE_7]?.phase).toBe('error'))
    expect(useUiStore.getState().selectedIssueId).toBe(ISSUE_7)
  })
})
