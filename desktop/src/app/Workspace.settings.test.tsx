// 설정 화면(#115) 진입점 — 상단 바 ⚙ 하나(AC-01), 사이드바 원격 호스트 관리(AC-12), 작업 공간 범위 문맥(EC-04·16·25·26)
// Workspace 를 그대로 그린다(tree.a11y.test 와 같은 방식). 미리보기는 data-testid "preview-branch"
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'

import { worktreeId } from '@minmo/core'
import type { IssueTarget } from '@minmo/core'

import { TooltipProvider } from '../components/ui/tooltip'
import { WorktreeProvider } from '../features/issue/useWorktree'
import type { TauriApi } from '../lib/tauri'
import { useHostsStore } from '../store/hosts'
import { useReposStore } from '../store/repos'
import { useSessionStore } from '../store/session'
import { useSettingsPageStore } from '../store/settingsPage'
import { useSetupStore } from '../store/setup'
import { useUiStore } from '../store/ui'
import { createFakeApi, createFakeGitHub, createFakeTauri } from '../test/fakes'
import { makeDeps, renderWithDeps } from '../test/render'
import { Workspace } from './Workspace'

const ORG = { login: 'my-org', kind: 'org' as const, avatarUrl: null }
const REPO = { owner: 'my-org', name: 'widgets', defaultBranch: 'main' }
const SCOPE_EMPTY = {
  branchTemplate: null,
  etcBranchName: null,
  worktreePath: null,
  mainClonePath: null,
  postCreateScript: null,
  sparsePaths: null,
  postCreateScriptPosix: null,
  ignoredCopyExclude: null,
  updatedAt: null,
}
const GLOBAL = {
  branchTemplate: 'issue/{number}-{slug}',
  etcBranchName: 'etc',
  worktreePath: '~/minmo-workspaces/{owner}/{repo}/{branch}',
  mainClonePath: '~/minmo-workspaces/{owner}/{repo}/_main',
  postCreateScript: '',
  sparsePaths: '',
  postCreateScriptPosix: '',
  ignoredCopyExclude: 'node_modules',
  updatedAt: '2026-11-09T00:00:00.000Z',
}

const SAME_REPO_ID = worktreeId('my-org', 'widgets', '7')
const SAME_REPO_ISSUE: IssueTarget = { owner: 'my-org', repo: 'widgets', key: '7', number: 7, title: 'Fix bug' }
const OTHER_REPO_ID = worktreeId('my-org', 'gadgets', '9')
const OTHER_REPO_ISSUE: IssueTarget = { owner: 'my-org', repo: 'gadgets', key: '9', number: 9, title: 'Other' }

beforeEach(() => {
  localStorage.clear()
  useSettingsPageStore.setState(useSettingsPageStore.getInitialState(), true)
  useSessionStore.setState(useSessionStore.getInitialState(), true)
  useSessionStore.setState({ token: 'tok', status: 'online', me: { id: 'usr_x', githubLogin: 'octocat', avatarUrl: null } })
  useUiStore.setState({ expanded: {}, selectedIssueId: null, tab: 'terminal', worktreePathMap: {}, terminalIds: {} })
  useSetupStore.setState({ targets: {}, open: {}, script: {}, logs: {} })
  useHostsStore.setState({ aliases: ['srv'], selected: null, probes: {}, connecting: {}, errors: {}, baseRepos: {}, baseDirs: {}, repoHosts: {} })
  useReposStore.setState({ added: [], local: {}, lastParent: {}, nicknames: {}, groups: {} })
})

/** 오른쪽 패널에서 고른 이슈 — Workspace 는 setup store 의 target 으로 그 이슈의 저장소를 안다 */
function selectIssue(id: string, target: IssueTarget) {
  useSetupStore.setState({ targets: { [id]: target } })
  useUiStore.setState({ selectedIssueId: id })
}

const wrap = (ui: ReactNode) => (
  <TooltipProvider>
    <WorktreeProvider>{ui}</WorktreeProvider>
  </TooltipProvider>
)

function renderWorkspace(o: { sshProbe?: TauriApi['sshProbe'] } = {}) {
  const api = createFakeApi({ getSettings: async (s) => (s.kind === 'global' ? GLOBAL : SCOPE_EMPTY) })
  const github = createFakeGitHub({
    listOwners: async () => [ORG],
    listRepos: async () => [REPO],
    listIssues: async () => [{ number: 42, title: 'Add login', state: 'open', htmlUrl: 'https://github.com/my-org/widgets/issues/42', assignees: [] }],
  })
  const { tauri } = createFakeTauri(o.sshProbe ? { sshProbe: o.sshProbe } : {})
  renderWithDeps(wrap(<Workspace />), makeDeps({ api, github, tauri }))
  return userEvent.setup()
}

const settingsDialog = () => screen.findByRole('dialog', { name: '설정' })

/** 상단 ⚙ 로 설정을 열고 작업 공간 분류로 간다 */
async function openWorkspaceSection(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: '설정' }))
  const dialog = await settingsDialog()
  await user.click(within(dialog).getByRole('tab', { name: '작업 공간' }))
  return dialog
}

/** 범위 후보가 전역 하나면 radiogroup 대신 "범위: 전역" 텍스트(EC-27) */
async function expectGlobalOnly(dialog: HTMLElement) {
  await waitFor(() => expect(within(dialog).getByRole('tabpanel')).toHaveTextContent(/범위:\s*전역/))
  expect(within(dialog).queryByRole('radiogroup', { name: '범위' })).toBeNull()
}

describe('상단 바', () => {
  it('AC-01 설정 버튼은 "설정"(⚙) 1개 — 원격 접속·원격 CLI 접속·서버 설정·테마 버튼은 없다', async () => {
    renderWorkspace()
    expect(await screen.findAllByRole('button', { name: '설정' })).toHaveLength(1)
    expect(screen.queryByRole('button', { name: '전역 설정' })).toBeNull()
    expect(screen.queryByRole('button', { name: '원격 접속' })).toBeNull()
    expect(screen.queryByRole('button', { name: '원격 CLI 접속' })).toBeNull()
    expect(screen.queryByRole('button', { name: '서버 설정' })).toBeNull()
    expect(screen.queryByRole('button', { name: /^테마:/ })).toBeNull()
  })
})

describe('사이드바 원격 호스트 관리', () => {
  it('AC-12 "원격 호스트 관리" → dialog "설정" 이 원격 호스트 분류로 열린다', async () => {
    const user = renderWorkspace()
    await user.click(await screen.findByRole('button', { name: '원격 호스트 관리' }))
    const dialog = await settingsDialog()
    expect(within(dialog).getByRole('tab', { name: '원격 호스트' })).toHaveAttribute('aria-selected', 'true')
  })

  it('EC-26 원격 호스트 관리로 연 뒤 작업 공간 분류 → 고른 이슈가 있어도 범위 문맥이 없어 "범위: 전역"', async () => {
    selectIssue(SAME_REPO_ID, SAME_REPO_ISSUE)
    const user = renderWorkspace()
    await user.click(await screen.findByRole('button', { name: '원격 호스트 관리' }))
    const dialog = await settingsDialog()
    await user.click(within(dialog).getByRole('tab', { name: '작업 공간' }))
    await expectGlobalOnly(dialog)
  })
})

describe('상단 ⚙ — 작업 공간 범위 후보', () => {
  it('EC-04 고른 이슈 없이 ⚙ 로 열면 범위 후보는 전역 하나 → "범위: 전역" 텍스트', async () => {
    const user = renderWorkspace()
    const dialog = await openWorkspaceSection(user)
    await expectGlobalOnly(dialog)
  })

  it('EC-25 고른 이슈의 호스트(srv) ≠ 프로젝트 범위가 쓸 호스트(이 PC) → 프로젝트 후보 없음(전역·조직), 전역 preview 는 고른 이슈', async () => {
    // 연결 호스트를 정하지 않은 저장소 → 프로젝트 범위는 사이드바 호스트(이 PC)를 쓴다
    selectIssue('ssh:srv|my-org/widgets#1', { owner: 'my-org', repo: 'widgets', key: '1', number: 1, title: 'Bound' })
    const user = renderWorkspace()
    const dialog = await openWorkspaceSection(user)
    const group = await within(dialog).findByRole('radiogroup', { name: '범위' })
    expect(within(group).getByRole('radio', { name: '전역' })).toBeChecked()
    expect(within(group).getByRole('radio', { name: '조직: my-org' })).toBeInTheDocument()
    expect(within(group).queryByRole('radio', { name: /^프로젝트:/ })).toBeNull()
    await waitFor(() => expect(within(dialog).getByTestId('preview-branch')).toHaveTextContent('issue/1-bound'))
  })
})

describe('트리 ⚙ — 미리보기 기준 이슈', () => {
  it.each([
    ['같은 저장소면 그 이슈', SAME_REPO_ID, SAME_REPO_ISSUE, 'issue/7-fix-bug'],
    ['다른 저장소면 트리가 준 이슈(#42)', OTHER_REPO_ID, OTHER_REPO_ISSUE, 'issue/42-add-login'],
  ])('EC-16 저장소 ⚙: 고른 이슈가 %s — 범위를 조직으로 바꿔도 같은 preview', async (_case, id, target, branch) => {
    selectIssue(id, target)
    const user = renderWorkspace()
    // 트리 조작은 설정을 열기 전에 한다(열린 뒤에는 바깥이 가려진다). 펼친 저장소는 첫 이슈(#42)를 preview 로 준다
    await user.click(await screen.findByTestId('org-node-my-org'))
    await user.click(await screen.findByTestId('repo-node-my-org/widgets'))
    await screen.findByTestId('issue-row-42')
    await user.click(screen.getByRole('button', { name: 'widgets 프로젝트 설정' }))
    const dialog = await settingsDialog()
    await waitFor(() => expect(within(dialog).getByTestId('preview-branch')).toHaveTextContent(branch))

    await user.click(await within(dialog).findByRole('radio', { name: '조직: my-org' }))
    expect(within(dialog).getByRole('radio', { name: '조직: my-org' })).toBeChecked()
    await waitFor(() => expect(within(dialog).getByTestId('preview-branch')).toHaveTextContent(branch))
  })

  it('EC-16 연결 대기 저장소 ⚙: 트리가 준 ★기타 preview 를 범위를 조직으로 바꿔도 쓴다', async () => {
    useHostsStore.getState().setRepoHost('my-org', 'widgets', 'ssh:srv')
    // 연결 확인이 끝나지 않는다 — 연결 대기 행(PendingRepoNode)의 ⚙
    const user = renderWorkspace({ sshProbe: () => new Promise(() => {}) })
    await user.click(await screen.findByTestId('org-node-my-org'))
    await screen.findByTestId('repo-pending-my-org/widgets')
    await user.click(screen.getByRole('button', { name: 'widgets 프로젝트 설정' }))
    const dialog = await settingsDialog()

    await user.click(await within(dialog).findByRole('radio', { name: '조직: my-org' }))
    expect(within(dialog).getByRole('radio', { name: '조직: my-org' })).toBeChecked()
    await waitFor(() => expect(within(dialog).getByTestId('preview-branch')).toHaveTextContent(/^etc$/))
  })
})
