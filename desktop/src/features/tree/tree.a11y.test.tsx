// 트리 접근성(AX-01·03·04~06) + 삭제 확인의 "개수 불명" 표시(F-4/EC-15)
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'

import { Workspace } from '../../app/Workspace'
import { TooltipProvider } from '../../components/ui/tooltip'
import type { TauriApi } from '../../lib/tauri'
import { worktreeId } from '../../lib/worktree'
import { useSessionStore } from '../../store/session'
import { useSetupStore } from '../../store/setup'
import { useUiStore } from '../../store/ui'
import { createFakeApi, createFakeGitHub, createFakeTauri, fail, ok } from '../../test/fakes'
import { makeDeps, renderWithDeps } from '../../test/render'
import { WorktreeProvider } from '../issue/useWorktree'
import { IssueRow } from './IssueRow'
import type { TreeIssue } from './useTree'

const ORG = { login: 'my-org', kind: 'org' as const, avatarUrl: null }
const REPO = { owner: 'my-org', name: 'widgets', defaultBranch: 'main' }
const SCOPE_EMPTY = {
  branchTemplate: null,
  etcBranchName: null,
  worktreePath: null,
  mainClonePath: null,
  postCreateScript: null,
  updatedAt: null,
}
const GLOBAL = {
  branchTemplate: 'issue/{number}-{slug}',
  etcBranchName: 'etc',
  worktreePath: '~/minmo-workspaces/{owner}/{repo}/{branch}',
  mainClonePath: '~/minmo-workspaces/{owner}/{repo}/_main',
  postCreateScript: '',
  updatedAt: '2026-11-09T00:00:00.000Z',
}

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

function renderWorkspace() {
  const api = createFakeApi({ getSettings: async (s) => (s.kind === 'global' ? GLOBAL : SCOPE_EMPTY) })
  const github = createFakeGitHub({
    listOwners: async () => [ORG],
    listRepos: async () => [REPO],
    listIssues: async () => [{ number: 42, title: 'Add login', state: 'open', htmlUrl: 'https://github.com/my-org/widgets/issues/42' }],
  })
  return renderWithDeps(wrap(<Workspace />), makeDeps({ api, github }))
}

describe('AX-01 조직·프로젝트 설정을 키보드로 연다(⚙ 버튼)', () => {
  it('"조직 설정" 버튼에 포커스 + Enter → 설정 다이얼로그', async () => {
    const user = userEvent.setup()
    renderWorkspace()
    const btn = await screen.findByRole('button', { name: '조직 설정' })
    btn.focus()
    await user.keyboard('{Enter}')
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/조직 설정|my-org/)).toBeInTheDocument()
    expect(await within(dialog).findByLabelText('브랜치 템플릿')).toBeInTheDocument()
  })

  it('"프로젝트 설정" 버튼에 포커스 + Enter → 설정 다이얼로그', async () => {
    const user = userEvent.setup()
    renderWorkspace()
    await user.click(await screen.findByTestId('org-node-my-org'))
    const btn = await screen.findByRole('button', { name: '프로젝트 설정' })
    btn.focus()
    await user.keyboard('{Enter}')
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByLabelText('브랜치 템플릿')).toBeInTheDocument()
  })
})

describe('AX-03 disclosure 토글 aria-controls', () => {
  it('조직·저장소 토글 버튼의 aria-controls 가 펼친 자식 목록 id 를 가리킨다', async () => {
    const user = userEvent.setup()
    renderWorkspace()
    const org = await screen.findByTestId('org-node-my-org')
    const orgControls = org.getAttribute('aria-controls')
    expect(orgControls).toBeTruthy()
    await user.click(org)
    await waitFor(() => expect(document.getElementById(orgControls!)).not.toBeNull())
    const repo = await screen.findByTestId('repo-node-my-org/widgets')
    const repoControls = repo.getAttribute('aria-controls')
    expect(repoControls).toBeTruthy()
    await user.click(repo)
    await waitFor(() => expect(document.getElementById(repoControls!)).not.toBeNull())
    expect(document.getElementById(repoControls!)).toContainElement(await screen.findByTestId('issue-row-42'))
  })
})

const ISSUE: TreeIssue = { key: '42', number: 42, title: 'Add login', state: 'open' } as TreeIssue
const ETC: TreeIssue = { key: 'etc', number: null, title: '기타', state: 'open' } as TreeIssue

function renderRow(issue: TreeIssue, o: { hasWorktree?: boolean; pathChanged?: boolean; gitRun?: TauriApi['gitRun'] } = {}) {
  const fake = createFakeTauri(o.gitRun ? { gitRun: o.gitRun } : {})
  return renderWithDeps(
    wrap(
      <IssueRow
        owner="my-org"
        repo="widgets"
        issue={issue}
        hasWorktree={o.hasWorktree ?? false}
        pathChanged={o.pathChanged ?? false}
        selected={false}
      />,
    ),
    makeDeps({ tauri: fake.tauri }),
  )
}

describe('AX-05 ● 인디케이터 · 경로 변경 배지 설명', () => {
  it('● 는 role=img + 이름 "worktree 있음"(시각 기호는 이름에 섞이지 않는다)', () => {
    renderRow(ISSUE, { hasWorktree: true })
    const row = screen.getByTestId('issue-row-42')
    expect(within(row).getByRole('img', { name: 'worktree 있음' })).toBeInTheDocument()
  })

  it('"경로 변경됨" 설명을 스크린 리더도 받는다(aria-describedby)', () => {
    renderRow(ISSUE, { hasWorktree: true, pathChanged: true })
    expect(screen.getByTestId('issue-row-42')).toHaveAccessibleDescription(/worktree 경로가 바뀌었습니다/)
  })
})

describe('AX-04 비활성 "worktree 삭제" 의 사유를 항목에서 읽을 수 있다 (EC-16)', () => {
  it('★기타: 비활성 항목 + 사유 "고정 이슈는 삭제할 수 없음"', async () => {
    renderRow(ETC, { hasWorktree: true })
    fireEvent.contextMenu(screen.getByTestId('issue-row-etc'))
    const item = await screen.findByRole('menuitem', { name: 'worktree 삭제' })
    expect(item).toHaveAttribute('aria-disabled', 'true')
    expect(item).toHaveAccessibleDescription('고정 이슈는 삭제할 수 없음')
  })

  it('worktree 없는 이슈: 비활성 항목 + 사유', async () => {
    renderRow(ISSUE, { hasWorktree: false })
    fireEvent.contextMenu(screen.getByTestId('issue-row-42'))
    const item = await screen.findByRole('menuitem', { name: 'worktree 삭제' })
    expect(item).toHaveAttribute('aria-disabled', 'true')
    expect(item).toHaveAccessibleDescription(/worktree 가 없습니다/)
  })
})

describe('F-4 삭제 전 검사 실패 → 확인 대화상자에 "개수 확인 불가" 표시', () => {
  it('git status 실패 → 미커밋 개수 불명 문구 + 삭제 버튼(확인 필요)', async () => {
    const id = worktreeId('my-org', 'widgets', '42')
    useUiStore.setState({ worktreePathMap: { [id]: { path: '/w/42', branch: 'issue/42-add-login' } } })
    renderRow(ISSUE, {
      hasWorktree: true,
      gitRun: async (args) => (args.includes('status') ? fail('fatal: index locked', 128) : args.includes('rev-list') ? ok('0\n') : ok()),
    })
    fireEvent.contextMenu(screen.getByTestId('issue-row-42'))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'worktree 삭제' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent(/미커밋 변경 확인 불가/)
    expect(within(dialog).getByRole('button', { name: '삭제' })).toBeInTheDocument()
  })
})
