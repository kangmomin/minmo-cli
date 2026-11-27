// 배경 실행용 터미널 고정 마운트 — 고른 이슈가 없어도 주 창은 터미널을 숨겨 두고(포커스·선택 불변), 보조 창·원격 화면은 지금과 같다
import { act, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { worktreeId } from '@minmo/core'
import type { IssueTarget } from '@minmo/core'

import { TooltipProvider } from '../components/ui/tooltip'
import { TAKER_STORAGE_KEY, useTakerStore } from '../features/taker/takerStore'
import { WorktreeProvider } from '../features/issue/useWorktree'
import type { RuntimeKind } from '../lib/tauri'
import { useSessionStore } from '../store/session'
import { useSetupStore } from '../store/setup'
import { useUiStore } from '../store/ui'
import { createFakeApi, createFakeGitHub, createFakeTauri } from '../test/fakes'
import { makeDeps, renderWithDeps } from '../test/render'
import { Workspace } from './Workspace'

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    static strings = { promptLabel: 'Terminal input', tooMuchOutput: '' }
    cols = 80
    rows = 24
    options: Record<string, unknown>
    focus = vi.fn()
    textarea: HTMLTextAreaElement | undefined
    unicode = { activeVersion: '6' }
    parser = { registerOscHandler: () => ({ dispose() {} }) }
    constructor(options: Record<string, unknown>) {
      this.options = options
    }
    loadAddon(addon: { activate?: (t: unknown) => void }) {
      addon.activate?.(this)
    }
    open(el: HTMLElement) {
      this.textarea = document.createElement('textarea')
      el.appendChild(this.textarea)
    }
    write(_d: string, done?: () => void) {
      done?.()
    }
    resize(cols: number, rows: number) {
      this.cols = cols
      this.rows = rows
    }
    onData() {
      return { dispose() {} }
    }
    attachCustomKeyEventHandler() {}
    getSelection() {
      return ''
    }
    hasSelection() {
      return false
    }
    clearSelection() {}
    dispose() {}
  },
}))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}))
vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class {},
}))
vi.mock('@xterm/addon-unicode11', () => ({
  Unicode11Addon: class {},
}))
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    onContextLoss() {
      return { dispose() {} }
    }
    dispose() {}
  },
}))

const A: IssueTarget = { owner: 'o', repo: 'r', key: '1', number: 1, title: 'First' }
const idA = worktreeId(A.owner, A.repo, A.key)
const READY = { phase: 'ready' as const, path: '/w/o/r/issue--1-first', branch: 'issue/1-first', pathChanged: false }

function renderWorkspace(o: { runtime?: RuntimeKind } = {}) {
  const { tauri } = createFakeTauri(o.runtime ? { runtime: o.runtime } : {})
  const github = createFakeGitHub({ listOwners: async () => [] })
  renderWithDeps(
    <TooltipProvider>
      <WorktreeProvider>
        <Workspace />
      </WorktreeProvider>
    </TooltipProvider>,
    makeDeps({ tauri, github, api: createFakeApi({ getNotes: async () => ({ body: '', updatedAt: null }) }) }),
  )
  return { tauri, github }
}

const main = () => screen.getByRole('main')

beforeEach(() => {
  window.history.replaceState(null, '', '/')
  localStorage.removeItem(TAKER_STORAGE_KEY)
  useTakerStore.setState({ repos: {}, taken: {}, runs: [], lastCheck: {} })
  useSessionStore.setState(useSessionStore.getInitialState(), true)
  useSessionStore.setState({ token: 'tok', status: 'online', me: { id: 'usr_x', githubLogin: 'octocat', avatarUrl: null } })
  useUiStore.setState({
    expanded: {},
    selectedIssueId: null,
    tab: 'terminal',
    worktreePathMap: {},
    terminalIds: {},
    panes: {},
    startedTerminals: {},
    focusRequest: null,
  })
  useSetupStore.setState({ targets: { [idA]: A }, open: { [idA]: READY }, script: {}, logs: {} })
})
afterEach(() => {
  window.history.replaceState(null, '', '/')
  useTakerStore.setState({ repos: {}, taken: {}, runs: [], lastCheck: {} })
  localStorage.removeItem(TAKER_STORAGE_KEY)
})

describe('Workspace — 고른 이슈 없이 배경 터미널', () => {
  it('AC-05 고른 이슈가 없어도 준비된 이슈에 포커스 없이 패널을 마련하면 PTY 를 띄우고, 선택·탭·포커스는 그대로다', async () => {
    const { tauri } = renderWorkspace()
    const settings = screen.getByRole('button', { name: '전역 설정' })
    act(() => settings.focus())
    act(() => void useUiStore.getState().launchPane(idA, false, false))
    await waitFor(() => expect(tauri.ptySpawn).toHaveBeenCalledTimes(1))
    expect(tauri.ptySpawn).toHaveBeenCalledWith(expect.objectContaining({ cwd: READY.path }))
    expect(useUiStore.getState()).toMatchObject({ selectedIssueId: null, tab: 'terminal', focusRequest: null })
    expect(document.activeElement).toBe(settings)
  })

  it('AC-05 이슈를 골랐다가 선택을 풀어도 터미널 영역은 같은 노드로 남는다(다시 마운트하지 않음)', () => {
    useUiStore.setState({ selectedIssueId: idA })
    renderWorkspace()
    const before = screen.getByTestId('terminal-tab')
    act(() => useUiStore.setState({ selectedIssueId: null }))
    expect(screen.getByTestId('terminal-tab')).toBe(before)
    act(() => useUiStore.setState({ selectedIssueId: idA }))
    expect(screen.getByTestId('terminal-tab')).toBe(before)
  })

  it('AC-05 고른 이슈가 없을 때 터미널은 숨김 — 탭 목록·변경·파일·메모 패널이 없고, 터미널 패널은 tabIndex -1 이며 접근성 트리에 없다', () => {
    renderWorkspace()
    expect(within(main()).getByText('왼쪽 트리에서 이슈(또는 ★기타)를 선택하세요')).toBeInTheDocument()
    const terminal = within(main()).getByTestId('terminal-tab')
    expect(terminal.closest('[role="tabpanel"]')).toHaveAttribute('tabindex', '-1')
    expect(within(main()).queryByRole('tablist')).toBeNull()
    expect(within(main()).queryAllByRole('tab', { hidden: true })).toHaveLength(0)
    expect(within(main()).queryAllByRole('tabpanel', { hidden: true })).toHaveLength(1)
    expect(within(main()).queryByRole('tabpanel')).toBeNull()
    expect(within(main()).queryByRole('region', { name: '터미널' })).toBeNull()
  })

  it.each<[string, () => void, RuntimeKind | undefined]>([
    ['보조 창(?window=ws)', () => window.history.replaceState(null, '', '/?window=ws'), undefined],
    ['원격 화면(runtime remote)', () => {}, 'remote'],
  ])('EC-16 %s 에서 고른 이슈가 없으면 터미널을 두지 않는다', (_case, arrange, runtime) => {
    arrange()
    renderWorkspace({ runtime })
    expect(within(main()).getByText('왼쪽 트리에서 이슈(또는 ★기타)를 선택하세요')).toBeInTheDocument()
    expect(screen.queryByTestId('terminal-tab')).toBeNull()
  })

  it('A-23 켜진 저장소와 실행이 없으면 테이커는 store 에 쓰지 않고 테이커용 GitHub 조회를 하지 않는다', async () => {
    let writes = 0
    const unsub = useTakerStore.subscribe(() => {
      writes++
    })
    const { github } = renderWorkspace()
    await waitFor(() => expect(github.listOwners).toHaveBeenCalled())
    await act(() => new Promise((r) => setTimeout(r, 1_200)))
    unsub()
    expect(writes).toBe(0)
    for (const fn of [github.listRecentIssues, github.latestNumber, github.getIssue, github.assignIssue]) expect(fn).not.toHaveBeenCalled()
    expect(localStorage.getItem(TAKER_STORAGE_KEY)).toBeNull()
  })
})
