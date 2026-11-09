// 작업 탭·준비 로그 접근성 — AX-02(터미널 탈출), AX-07(tabpanel 연결), AX-08(준비 로그 live region)
import { act, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { TooltipProvider } from '../../components/ui/tooltip'
import { worktreeId } from '../../lib/worktree'
import type { IssueTarget } from '../../lib/worktree'
import { useSessionStore } from '../../store/session'
import { useSetupStore } from '../../store/setup'
import { useUiStore } from '../../store/ui'
import { createFakeApi } from '../../test/fakes'
import { makeDeps, renderWithDeps } from '../../test/render'
import { WorkTabs } from './WorkTabs'
import { WorktreeSetupLog } from './WorktreeSetupLog'
import { WorktreeProvider } from './useWorktree'

const xterm = vi.hoisted(() => ({ handlers: [] as ((e: KeyboardEvent) => boolean)[] }))
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    loadAddon() {}
    open() {}
    write() {}
    focus() {}
    onData() {
      return { dispose() {} }
    }
    attachCustomKeyEventHandler(h: (e: KeyboardEvent) => boolean) {
      xterm.handlers.push(h)
    }
    dispose() {}
  },
}))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}))

const T: IssueTarget = { owner: 'o', repo: 'r', key: '42', number: 42, title: 'X' }
const ID = worktreeId('o', 'r', '42')

beforeEach(() => {
  xterm.handlers.length = 0
  useSessionStore.setState(useSessionStore.getInitialState(), true)
  useSessionStore.setState({ token: 'tok', status: 'online' })
  useUiStore.setState({ tab: 'terminal', terminalIds: {} })
  useSetupStore.setState({
    targets: {},
    open: { [ID]: { phase: 'ready', path: '/w/42', branch: 'b', pathChanged: false } },
    script: {},
    logs: {},
  })
})

function renderTabs() {
  const api = createFakeApi({ getNotes: async () => ({ body: '', updatedAt: null }) })
  return renderWithDeps(
    <TooltipProvider>
      <WorktreeProvider>
        <WorkTabs target={T} state={useSetupStore.getState().open[ID]} />
      </WorktreeProvider>
    </TooltipProvider>,
    makeDeps({ api }),
  )
}

describe('AX-07 WorkTabs 패널은 tabpanel 로 탭과 연결된다', () => {
  it('터미널 탭 → tabpanel 이름 "터미널", 메모 탭으로 바꾸면 tabpanel "메모" + 터미널 패널은 숨김(마운트 유지)', async () => {
    const user = userEvent.setup()
    renderTabs()
    const term = screen.getByRole('tabpanel', { name: '터미널' })
    expect(within(term).getByTestId('terminal-tab')).toBeInTheDocument()
    const notesTab = screen.getByRole('tab', { name: '메모' })
    await user.click(notesTab)
    const notesPanel = screen.getByRole('tabpanel', { name: '메모' })
    expect(notesTab.getAttribute('aria-controls')).toBe(notesPanel.id)
    expect(within(notesPanel).getByLabelText('메모')).toBeInTheDocument()
    // 터미널 세션 유지: DOM 에 남아 있고 hidden
    expect(screen.getByTestId('terminal-tab').closest('[role="tabpanel"]')).toHaveAttribute('hidden')
  })
})

describe('AX-02 터미널에서 Ctrl+Shift+M → 탭 목록으로 포커스 이동', () => {
  it('xterm 키 핸들러 → 현재 "터미널" 탭 버튼에 포커스', async () => {
    renderTabs()
    await vi.waitFor(() => expect(xterm.handlers.length).toBeGreaterThan(0))
    act(() => {
      xterm.handlers[0](new KeyboardEvent('keydown', { key: 'M', code: 'KeyM', ctrlKey: true, shiftKey: true }))
    })
    expect(screen.getByRole('tab', { name: '터미널' })).toHaveFocus()
  })
})

describe('AX-08 WorktreeSetupLog live region', () => {
  function renderLog() {
    return renderWithDeps(
      <WorktreeProvider>
        <WorktreeSetupLog target={T} />
      </WorktreeProvider>,
      makeDeps(),
    )
  }

  it('진행 요약은 role=status, 접기 버튼은 aria-expanded', async () => {
    const user = userEvent.setup()
    useSetupStore.setState({ open: { [ID]: { phase: 'opening' } }, logs: { [ID]: [{ issueId: ID, step: 'clone', status: 'start' }] } })
    renderLog()
    expect(screen.getByRole('status')).toHaveTextContent('worktree 준비 중')
    const toggle = screen.getByRole('button', { name: '접기' })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await user.click(toggle)
    expect(screen.getByRole('button', { name: '로그 보기' })).toHaveAttribute('aria-expanded', 'false')
  })

  it('준비 실패는 role=alert', () => {
    useSetupStore.setState({
      open: { [ID]: { phase: 'error', code: 'git_failed', message: 'fatal: boom' } },
      logs: { [ID]: [{ issueId: ID, step: 'clone', status: 'error', message: 'fatal: boom' }] },
    })
    renderLog()
    expect(screen.getByRole('alert')).toHaveTextContent('준비 실패')
  })

  it('로그 없이 실패만 있어도 role=alert', () => {
    useSetupStore.setState({ open: { [ID]: { phase: 'error', code: 'git_failed', message: 'fatal: boom' } }, logs: {} })
    renderLog()
    expect(screen.getByRole('alert')).toHaveTextContent('fatal: boom')
  })

  it('스크립트 실패 요약은 role=alert', () => {
    useSetupStore.setState({
      script: { [ID]: { status: 'failed', exitCode: 3 } },
      logs: { [ID]: [{ issueId: ID, step: 'script', status: 'error' }] },
    })
    renderLog()
    expect(screen.getByRole('alert')).toHaveTextContent('생성 후 스크립트 실패')
  })
})
