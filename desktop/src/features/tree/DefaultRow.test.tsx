// 트리 맨 위의 "⌂ 기본" 행 (#120) — 저장소와 관계없는 작업 공간, 그 호스트의 홈 폴더
import { cleanup, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { TooltipProvider } from '../../components/ui/tooltip'
import { DEFAULT_CORE_ID, DEFAULT_TARGET } from '../../lib/defaultWorkspace'
import { encodeScope } from '../../lib/windowScope'
import { useReposStore } from '../../store/repos'
import { useSessionStore } from '../../store/session'
import { useSetupStore } from '../../store/setup'
import { useUiStore } from '../../store/ui'
import { createFakeApi, createFakeGitHub, createFakeTauri } from '../../test/fakes'
import { makeDeps, renderWithDeps } from '../../test/render'
import { useAgentStore } from '../agents/agentStore'
import { WorktreeProvider } from '../issue/useWorktree'
import { DefaultRow } from './DefaultRow'
import { Sidebar } from './Sidebar'
import type { SidebarProps } from './Sidebar'

const ACME = { login: 'Acme', kind: 'org' as const, avatarUrl: null }

beforeEach(() => {
  useSessionStore.setState(useSessionStore.getInitialState(), true)
  useSessionStore.setState({ token: 'tok', status: 'online' })
  useUiStore.setState({ expanded: { 'org:Acme': true }, worktreePathMap: {}, selectedIssueId: null, tab: 'notes', panes: {}, startedTerminals: {} })
  useReposStore.setState({ added: [], local: {}, nicknames: {}, groups: { g1: { name: 'grp', repos: ['Acme/api'] } } })
  useSetupStore.setState({ open: {}, targets: {}, logs: {} })
  useAgentStore.getState().clear()
})

afterEach(() => {
  window.history.replaceState(null, '', '/')
})

function renderSidebar(connection?: SidebarProps['connection']) {
  const api = createFakeApi({ getVisibleRepos: async () => ({ repos: null, updatedAt: null }) })
  const github = createFakeGitHub({ listOwners: async () => [ACME], listRepos: async () => [{ owner: 'Acme', name: 'api', defaultBranch: 'main' }] })
  return renderWithDeps(
    <TooltipProvider>
      {/* Why: 범위 창은 그 저장소의 ★기타 행(IssueRow → useIssueActions)을 그리므로 Provider 가 필요하다(windows.test.tsx 와 같다) */}
      <WorktreeProvider>
        <Sidebar connection={connection} onOpenSettings={() => {}} />
      </WorktreeProvider>
    </TooltipProvider>,
    makeDeps({ api, github }),
  )
}

describe('기본 행', () => {
  it('AC-01 범위 없는 창의 트리에는 그룹·로컬 저장소 위에 "기본" 행이 1개 있다', async () => {
    renderSidebar()
    const group = await screen.findByTestId('group-node-g1')
    const rows = screen.getAllByTestId('default-row')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toHaveTextContent('기본')
    expect(rows[0].compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('EC-02 범위 창(조직·저장소·그룹 창)에는 기본 행이 없다', async () => {
    renderSidebar()
    expect(await screen.findByTestId('default-row')).toBeInTheDocument()
    cleanup()
    window.history.replaceState(null, '', `/?window=ws&scope=${encodeScope({ kind: 'repo', owner: 'Acme', repo: 'api' })}`)
    renderSidebar()
    expect(await screen.findByTestId('repo-node-Acme/api')).toBeInTheDocument()
    expect(screen.queryByTestId('default-row')).toBeNull()
  })

  it('EC-01 고른 SSH 호스트에 아직 연결되지 않았으면 트리와 함께 기본 행도 감춘다(연결 상태 안내만 보인다)', async () => {
    renderSidebar({ selected: 'srv', ready: false, connecting: true, error: null, connect: async () => {} })
    const row = await screen.findByTestId('default-row')
    expect(row.closest('.hidden')).not.toBeNull()
  })

  it('AC-02 누르면 worktree 를 만들지 않고 그 호스트의 홈으로 기본을 연다 — 고른 행으로 표시된다', async () => {
    const user = userEvent.setup()
    const fake = createFakeTauri()
    renderWithDeps(<DefaultRow />, makeDeps({ tauri: fake.tauri, home: '/home/u' }))
    const row = screen.getByTestId('default-row')
    await user.click(row)
    expect(useUiStore.getState()).toMatchObject({ selectedIssueId: DEFAULT_CORE_ID, tab: 'terminal' })
    expect(useSetupStore.getState().targets[DEFAULT_CORE_ID]).toEqual(DEFAULT_TARGET)
    expect(useSetupStore.getState().open[DEFAULT_CORE_ID]).toEqual({ phase: 'ready', path: '/home/u', branch: '', pathChanged: false })
    expect(fake.tauri.gitRun).not.toHaveBeenCalled()
    expect(fake.tauri.pathExists).not.toHaveBeenCalled()
    expect(screen.getByTestId('default-row')).toHaveAttribute('aria-current', 'true')
  })

  it('AC-19 기본에서 에이전트가 돌면 기본 행에 에이전트 상태 점이 보인다', () => {
    useAgentStore.getState().set(`${DEFAULT_CORE_ID}::1`, {
      paneId: `${DEFAULT_CORE_ID}::1`,
      issueId: DEFAULT_CORE_ID,
      agent: 'claude',
      program: 'claude',
      label: '',
      activity: 'working',
      unseen: false,
      lastOutputAt: 0,
      since: Date.now(),
      waitingSince: null,
    })
    renderWithDeps(<DefaultRow />, makeDeps())
    expect(within(screen.getByTestId('default-row')).getByRole('img', { name: '에이전트 작업 중' })).toBeInTheDocument()
  })
})
