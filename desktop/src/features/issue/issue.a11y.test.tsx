// 작업 탭·준비 로그 접근성 — AX-02(터미널 탈출), AX-07(tabpanel 연결), AX-08(준비 로그 live region),
// AX-19(보이지 않는 Tab 정지점), AX-20/31(live region 패턴·접기 버튼), CR-12/13(로그 key·접힘 상태)
import { act, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TooltipProvider } from '../../components/ui/tooltip'
import { worktreeId } from '../../lib/worktree'
import type { IssueTarget } from '../../lib/worktree'
import { useSessionStore } from '../../store/session'
import { MAX_LOG_LINES, useSetupStore } from '../../store/setup'
import type { SetupLogEntry } from '../../store/setup'
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
const entry = (seq: number, e: Omit<SetupLogEntry, 'issueId' | 'seq'>): SetupLogEntry => ({ issueId: ID, seq, ...e })

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

describe('AX-19 포커스 가능한 내용이 있는 패널은 Tab 정지점이 아니다', () => {
  it('터미널·메모 패널은 tabIndex=-1, 변경 패널은 준비되면 -1 (내용이 포커스 가능)', async () => {
    const user = userEvent.setup()
    renderTabs()
    expect(screen.getByTestId('terminal-tab').closest('[role="tabpanel"]')).toHaveAttribute('tabindex', '-1')
    await user.click(screen.getByRole('tab', { name: '변경' }))
    expect(screen.getByRole('tabpanel', { name: '변경' })).toHaveAttribute('tabindex', '-1')
    await user.click(screen.getByRole('tab', { name: '메모' }))
    expect(screen.getByRole('tabpanel', { name: '메모' })).toHaveAttribute('tabindex', '-1')
  })

  it('변경 패널이 안내 문구뿐이면(worktree 준비 전) tabIndex=0 을 유지하고 포커스 링 클래스를 가진다', async () => {
    const user = userEvent.setup()
    useSetupStore.setState({ open: { [ID]: { phase: 'opening' } } })
    renderWithDeps(
      <TooltipProvider>
        <WorktreeProvider>
          <WorkTabs target={T} state={useSetupStore.getState().open[ID]} />
        </WorktreeProvider>
      </TooltipProvider>,
      makeDeps({ api: createFakeApi({ getNotes: async () => ({ body: '', updatedAt: null }) }) }),
    )
    await user.click(screen.getByRole('tab', { name: '변경' }))
    const panel = screen.getByRole('tabpanel', { name: '변경' })
    expect(panel).toHaveAttribute('tabindex', '0')
    expect(panel.className).toContain('focus-visible:ring-ring')
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
    useSetupStore.setState({ open: { [ID]: { phase: 'opening' } }, logs: { [ID]: [entry(1, { step: 'clone', status: 'start' })] } })
    renderLog()
    expect(screen.getByRole('status')).toHaveTextContent('worktree 준비 중')
    const toggle = screen.getByRole('button', { name: '준비 로그' })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await user.click(toggle)
    // AX-31: 이름은 고정, 상태는 aria-expanded 로만
    expect(screen.getByRole('button', { name: '준비 로그' })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('button', { name: '접기' })).toBeNull()
    expect(screen.queryByRole('button', { name: '로그 보기' })).toBeNull()
    await user.click(screen.getByRole('button', { name: '준비 로그' }))
    expect(screen.getByRole('button', { name: '준비 로그' })).toHaveAttribute('aria-expanded', 'true')
  })

  it('준비 실패는 role=alert', () => {
    useSetupStore.setState({
      open: { [ID]: { phase: 'error', code: 'git_failed', message: 'fatal: boom' } },
      logs: { [ID]: [entry(1, { step: 'clone', status: 'error', message: 'fatal: boom' })] },
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
      logs: { [ID]: [entry(1, { step: 'script', status: 'error' })] },
    })
    renderLog()
    expect(screen.getByRole('alert')).toHaveTextContent('생성 후 스크립트 실패')
  })

  it('AX-20 요약 status 컨테이너는 role 이 바뀌지 않고, 실패하면 별도 alert 노드가 삽입된다', () => {
    useSetupStore.setState({ script: { [ID]: { status: 'running' } }, logs: { [ID]: [entry(1, { step: 'script', status: 'start' })] } })
    renderLog()
    const live = screen.getByRole('status')
    expect(live).toHaveTextContent('생성 후 스크립트 실행 중')
    expect(screen.queryByRole('alert')).toBeNull()

    act(() => {
      useSetupStore.setState({
        script: { [ID]: { status: 'failed', exitCode: 3 } },
        logs: { [ID]: [entry(1, { step: 'script', status: 'start' }), entry(2, { step: 'script', status: 'error' })] },
      })
    })
    // 같은 status 요소가 그대로 남고(role 불변) 비워지며, 실패 문구는 새 alert 노드에 있다
    expect(screen.getByRole('status')).toBe(live)
    expect(live).toBeEmptyDOMElement()
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('생성 후 스크립트 실패(종료 코드 3)')
    expect(live).not.toContainElement(alert)

    act(() => {
      useSetupStore.setState({ script: { [ID]: { status: 'running' } } })
    })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('status')).toBe(live)
    expect(live).toHaveTextContent('생성 후 스크립트 실행 중')
  })
})

describe('CR-12 로그 줄 key 는 seq — 상한 slice 후에도 기존 줄 DOM 이 유지된다', () => {
  it(`${MAX_LOG_LINES}줄이 찬 뒤 한 줄이 더 와도 남은 줄의 DOM 노드를 재사용한다(인덱스 key 였다면 내용이 밀린다)`, () => {
    useSetupStore.setState({ open: { [ID]: { phase: 'opening' } }, logs: {} })
    const log = (message: string) => useSetupStore.getState().appendLog({ issueId: ID, step: 'clone', status: 'log', message })
    for (let i = 0; i < MAX_LOG_LINES; i++) log(`line-${i}`)
    renderWithDeps(
      <WorktreeProvider>
        <WorktreeSetupLog target={T} />
      </WorktreeProvider>,
      makeDeps(),
    )
    const last = screen.getByText(`line-${MAX_LOG_LINES - 1}`)
    const second = screen.getByText('line-1')

    act(() => log('line-new'))

    expect(screen.queryByText('line-0')).toBeNull()
    expect(screen.getByText('line-new')).toBeInTheDocument()
    // 같은 노드가 같은 내용으로 남아 있다
    expect(second).toBeInTheDocument()
    expect(second).toHaveTextContent(/^line-1$/)
    expect(last).toBeInTheDocument()
    expect(last).toHaveTextContent(new RegExp(`^line-${MAX_LOG_LINES - 1}$`))
  })
})

describe('CR-13(b) 접었다 다시 펼치면 맨 아래로 스크롤', () => {
  const original = Element.prototype.scrollIntoView
  afterEach(() => {
    Element.prototype.scrollIntoView = original
  })

  it('다시 펼칠 때 로그 끝(bottom 앵커)으로 scrollIntoView, 접힌 동안에는 호출하지 않는다', async () => {
    const user = userEvent.setup()
    const scroll = vi.fn()
    Element.prototype.scrollIntoView = scroll
    useSetupStore.setState({ open: { [ID]: { phase: 'opening' } }, logs: { [ID]: [entry(1, { step: 'clone', status: 'start' })] } })
    renderWithDeps(
      <WorktreeProvider>
        <WorktreeSetupLog target={T} />
      </WorktreeProvider>,
      makeDeps(),
    )
    const mounted = scroll.mock.calls.length
    expect(mounted).toBeGreaterThan(0)

    await user.click(screen.getByRole('button', { name: '준비 로그' }))
    expect(scroll.mock.calls.length).toBe(mounted)

    await user.click(screen.getByRole('button', { name: '준비 로그' }))
    expect(scroll.mock.calls.length).toBe(mounted + 1)
    expect(scroll).toHaveBeenLastCalledWith({ block: 'end' })
    const anchor = scroll.mock.contexts.at(-1) as HTMLElement
    expect(anchor.parentElement).toHaveAttribute('id', screen.getByRole('button', { name: '준비 로그' }).getAttribute('aria-controls'))
  })
})
