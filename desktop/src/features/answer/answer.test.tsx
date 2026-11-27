// 답변 모드(#122) 화면 — 상단 바 토글, 세션 목록, 요약 카드, [이 세션에 답하기]·[건너뛰기]·[보기]·[새 세션], Claude 답변, Jev 판정(Plan §7·§9·§10, U9b)
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Mock } from 'vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Effective } from '@minmo/api-client'
import { DEFAULT_SETTINGS } from '@minmo/core'

import { Workspace } from '../../app/Workspace'
import { TooltipProvider } from '../../components/ui/tooltip'
import type { TauriApi } from '../../lib/tauri'
import { useHostsStore } from '../../store/hosts'
import { useSessionStore } from '../../store/session'
import { useSetupStore } from '../../store/setup'
import { useUiStore } from '../../store/ui'
import type { WorkTab } from '../../store/ui'
import { createFakeApi, createFakeGitHub, createFakeTauri } from '../../test/fakes'
import { makeDeps, renderWithDeps } from '../../test/render'
import { useAgentStore } from '../agents/agentStore'
import type { PaneAgent } from '../agents/agentStore'
import { openPaneTarget } from '../agents/navigate'
import { WorktreeProvider } from '../issue/useWorktree'
import { readTerminalText } from '../terminal/terminalText'

const xterm = vi.hoisted(() => ({ instances: [] as { focus: Mock; keyHandler: ((e: KeyboardEvent) => boolean) | null; textarea?: HTMLTextAreaElement }[] }))
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    static strings = { promptLabel: '', tooMuchOutput: '' }
    options: Record<string, unknown> = {}
    cols = 80
    rows = 24
    unicode = { activeVersion: '6' }
    parser = { registerOscHandler: () => ({ dispose() {} }) }
    keyHandler: ((e: KeyboardEvent) => boolean) | null = null
    textarea: HTMLTextAreaElement | undefined
    focus = vi.fn(() => this.textarea?.focus())
    constructor() {
      xterm.instances.push(this)
    }
    loadAddon() {}
    open(el: HTMLElement) {
      this.textarea = document.createElement('textarea')
      this.textarea.addEventListener('keydown', (e) => void this.keyHandler?.(e), { capture: true })
      el.appendChild(this.textarea)
    }
    write(_d: string, done?: () => void) {
      done?.()
    }
    resize() {}
    input() {}
    onData() {
      return { dispose() {} }
    }
    attachCustomKeyEventHandler(h: (e: KeyboardEvent) => boolean) {
      this.keyHandler = h
    }
    hasSelection() {
      return false
    }
    getSelection() {
      return ''
    }
    clearSelection() {}
    dispose() {}
  },
}))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }))
// 열기·기다림·시간 제한은 navigate.test.tsx 가 본다 — 여기서는 열지 않은 이슈로 가는 이동이 끝나지 않게 둔다
vi.mock('../agents/navigate', async (importOriginal) => ({ ...(await importOriginal<typeof import('../agents/navigate')>()), openPaneTarget: vi.fn() }))
// 터미널 화면 글자는 xterm 버퍼에서 읽는다(TerminalTab.test.tsx 가 본다) — Jev 판정이 보낼 글자만 정한다
vi.mock('../terminal/terminalText', () => ({ registerTerminalText: () => () => {}, readTerminalText: vi.fn(() => '$ claude\n권한을 허용할까요? (y/n)') }))
const openMock = vi.mocked(openPaneTarget)
const textMock = vi.mocked(readTerminalText)

const A = 'acme/app#1'
const B = 'acme/app#2'
const C = 'acme/app#3'
const A1 = `${A}::1`
const A2 = `${A}::2`
const B1 = `${B}::1`
const C1 = `${C}::1`
const target = (n: number, title: string) => ({ owner: 'acme', repo: 'app', key: String(n), number: n, title })
const READY = (n: number) => ({ phase: 'ready' as const, path: `/w/${n}`, branch: `issue/${n}`, pathChanged: false })

const agent = (paneId: string, o: Partial<PaneAgent>): PaneAgent => ({
  paneId,
  issueId: paneId.slice(0, paneId.lastIndexOf('::')),
  agent: 'claude',
  program: 'claude',
  label: '',
  activity: 'idle',
  unseen: false,
  lastOutputAt: 0,
  since: 0,
  waitingSince: 0,
  ...o,
})
const ago = (ms: number) => Date.now() - ms
const done = (paneId: string, waited: number, o: Partial<PaneAgent> = {}) => agent(paneId, { activity: 'idle', unseen: true, since: ago(waited), waitingSince: ago(waited), ...o })
const attention = (paneId: string, waited: number, o: Partial<PaneAgent> = {}) => agent(paneId, { activity: 'attention', since: ago(waited), waitingSince: ago(waited), ...o })
const busy = (paneId: string, o: Partial<PaneAgent> = {}) => agent(paneId, { activity: 'working', since: ago(30_000), waitingSince: null, ...o })

/** 세 이슈(A 로그인 · B 문서 · C 배포)가 이 창에서 열려 있고, 각자 패널 하나가 있다 */
function world(o: { agents?: PaneAgent[]; started?: string[]; tab?: WorkTab; ready?: string[]; selected?: string } = {}) {
  useSessionStore.setState(useSessionStore.getInitialState(), true)
  useSessionStore.setState({ token: 'tok', status: 'online', me: { id: 'usr_x', githubLogin: 'octocat', avatarUrl: null } })
  useHostsStore.setState({ probes: {}, connecting: {}, errors: {} })
  const ids = [A, B, C]
  useSetupStore.setState({
    targets: { [A]: target(1, '로그인'), [B]: target(2, '문서'), [C]: target(3, '배포') },
    open: Object.fromEntries((o.ready ?? ids).map((id) => [id, READY(ids.indexOf(id) + 1)])),
    script: {},
    logs: {},
  })
  useUiStore.setState({
    selectedIssueId: o.selected ?? A,
    tab: o.tab ?? 'notes',
    viewMode: 'normal',
    tabBeforeAnswer: 'terminal',
    expanded: {},
    focusRequest: null,
    terminalIds: {},
    startedTerminals: Object.fromEntries((o.started ?? []).map((id) => [id, true as const])),
    panes: Object.fromEntries(ids.map((id) => [id, { tree: { kind: 'leaf' as const, id: `${id}::1` }, focused: `${id}::1`, seq: 1 }])),
    worktreePathMap: Object.fromEntries(ids.map((id, i) => [id, { path: `/w/${i + 1}`, branch: `issue/${i + 1}` }])),
    summaryClaudeReply: true,
    summaryJev: false,
    launchRequest: null,
  })
  useAgentStore.setState({ panes: Object.fromEntries((o.agents ?? []).map((p) => [p.paneId, p])), subagents: {} })
}

function renderApp(overrides: Partial<TauriApi> = {}) {
  // 터미널을 연 이슈의 에이전트가 추적기에서 사라지지 않게 Claude 가 도는 것으로 답한다
  const fake = createFakeTauri({ ptySpawn: async (req) => `pty-${req.key}`, ptyProcesses: async () => ['claude.exe'], ...overrides })
  const github = createFakeGitHub()
  const api = createFakeApi({ getEffective: async () => ({ values: { ...DEFAULT_SETTINGS }, sources: {} }) as unknown as Effective, getNotes: async () => ({ body: '', updatedAt: null }) })
  const r = renderWithDeps(
    <TooltipProvider>
      <WorktreeProvider>
        <Workspace />
      </WorktreeProvider>
    </TooltipProvider>,
    makeDeps({ tauri: fake.tauri, github, api }),
  )
  return { ...r, tauri: fake.tauri, user: userEvent.setup() }
}

const toggle = () => screen.getByRole('button', { name: '답변 모드' })
const list = () => screen.getByRole('navigation', { name: '세션 목록' })
const rows = () => within(list()).getAllByTestId('answer-row')
const summary = () => screen.getByTestId('answer-summary')
const announce = () => screen.getByTestId('answer-announce')

beforeEach(() => {
  xterm.instances.length = 0
  openMock.mockReset()
  openMock.mockImplementation(() => new Promise(() => {}))
  textMock.mockReturnValue('$ claude\n권한을 허용할까요? (y/n)')
  localStorage.clear()
})
afterEach(() => {
  window.history.replaceState(null, '', '/')
  useUiStore.setState({ viewMode: 'normal' })
})

describe('상단 바 토글(AC-01)', () => {
  it('AC-01 [답변 모드]를 누르면 답변 모드(aria-pressed=true), 다시 누르면 기본 보기', async () => {
    world({ agents: [done(A1, 65_000)] })
    const { user } = renderApp()
    expect(toggle()).toHaveAttribute('aria-pressed', 'false')
    await user.click(toggle())
    expect(toggle()).toHaveAttribute('aria-pressed', 'true')
    expect(useUiStore.getState().viewMode).toBe('answer')
    await user.click(toggle())
    expect(toggle()).toHaveAttribute('aria-pressed', 'false')
    expect(useUiStore.getState().viewMode).toBe('normal')
  })

  it('AC-01 범위 창(#105)에서는 [답변 모드] 버튼이 없다', () => {
    world()
    const first = renderApp()
    expect(toggle()).toBeInTheDocument()
    first.unmount()
    window.history.replaceState(null, '', '/?window=ws&scope=org%3Aacme')
    renderApp()
    expect(screen.queryByRole('button', { name: '답변 모드' })).toBeNull()
  })
})

describe('화면(AC-02 · AC-03 · AC-04 · AC-08)', () => {
  it('AC-02 답변 모드: 왼쪽은 세션 목록(트리 숨김), 오른쪽은 이슈 머리줄 + 요약 카드 + 터미널 — 탭 목록이 없다', async () => {
    world({ agents: [done(A1, 65_000)] })
    const { user } = renderApp()
    await user.click(toggle())
    expect(screen.getByRole('complementary', { name: '답변 모드' })).toContainElement(list())
    expect(screen.queryByRole('complementary', { name: '이슈 트리' })).toBeNull()
    expect(screen.getByRole('region', { name: '세션 요약' })).toBe(summary())
    expect(screen.getByTestId('terminal-tab')).toBeInTheDocument()
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(useUiStore.getState().tab).toBe('terminal')
  })

  it('AC-02 켜고 꺼도 터미널을 다시 만들지 않는다', async () => {
    world({ agents: [done(A1, 65_000)], started: [A], tab: 'terminal' })
    const { user, tauri } = renderApp()
    await waitFor(() => expect(useUiStore.getState().terminalIds[A1]).toBe(`pty-${A1}`))
    await user.click(toggle())
    await user.click(toggle())
    await user.click(toggle())
    expect(xterm.instances).toHaveLength(1)
    expect(tauri.ptySpawn).toHaveBeenCalledTimes(1)
  })

  it('AC-03 세션 목록: 프로젝트 구분 없이 기다리는 세션(입력 대기 → 끝남 → 대기 중) 뒤에 작업 중 — 지금 세션은 aria-current', async () => {
    world({ agents: [done(A1, 65_000), attention(B1, 30_000), busy(C1)] })
    const { user } = renderApp()
    await user.click(toggle())
    expect(rows().map((r) => r.getAttribute('data-status'))).toEqual(['attention', 'done', 'working'])
    expect(rows()[0]).toHaveTextContent('#2 문서')
    expect(rows()[1]).toHaveTextContent('#1 로그인')
    expect(rows()[1]).toHaveTextContent('acme/app')
    expect(rows()[1]).toHaveAttribute('aria-current', 'true')
    expect(rows()[0]).not.toHaveAttribute('aria-current')
    expect(within(list()).getByRole('heading', { name: /기다리는 세션 2/ })).toBeInTheDocument()
    expect(within(list()).getByRole('heading', { name: /작업 중 1/ })).toBeInTheDocument()
  })

  it('AC-03 줄을 누르면 그 세션을 보이고 그 터미널이 키 입력을 받는다', async () => {
    world({ agents: [done(A1, 65_000), attention(B1, 30_000)] })
    const { user } = renderApp()
    await user.click(toggle())
    await user.click(rows()[0])
    expect(useUiStore.getState().selectedIssueId).toBe(B)
    expect(useUiStore.getState().focusRequest).toMatchObject({ paneId: B1 })
    await waitFor(() => expect(rows()[0]).toHaveAttribute('aria-current', 'true'))
  })

  it('AC-04 에이전트 세션이 없으면 목록에 빈 안내와 [새 세션], 카드에 "에이전트가 아직 없습니다"', async () => {
    world()
    const { user } = renderApp()
    await user.click(toggle())
    expect(list()).toHaveTextContent('에이전트 세션이 없습니다. [새 세션]으로 시작하세요.')
    expect(within(list()).getByTestId('answer-new-session')).toBeInTheDocument()
    expect(summary()).toHaveTextContent('에이전트가 아직 없습니다')
  })

  it('AC-08 요약 카드: 상태 + 기다린 시간(1초마다 갱신), 무엇·어디·에이전트(하위 에이전트 수), 기다리는 세션 수, 자동 이동 안내', async () => {
    world({ agents: [done(A1, 58_000, { label: '로그인 버그 수정' }), attention(B1, 30_000)] })
    useAgentStore.setState({
      subagents: { [A1]: [1, 2].map((i) => ({ id: `agent-${i}`, type: 'Explore', description: `일 ${i}`, finished: false, updatedAt: Date.now() })) },
    })
    const { user } = renderApp()
    await user.click(toggle())
    const card = summary()
    expect(within(card).getByRole('heading', { name: '세션 요약' })).toBeInTheDocument()
    expect(card).toHaveTextContent('끝남')
    expect(card).toHaveTextContent(/초 기다림/)
    expect(card).toHaveTextContent('로그인 버그 수정')
    expect(card).toHaveTextContent('#1 로그인')
    expect(card).toHaveTextContent('Claude Code')
    expect(card).toHaveTextContent(/하위 에이전트 2/)
    expect(card).toHaveTextContent(/기다리는 세션 \d+개/)
    expect(card).toHaveTextContent('답을 보내면 2초 뒤 다음 세션으로 넘어갑니다.')
    const before = card.textContent
    await waitFor(() => expect(summary().textContent).not.toBe(before), { timeout: 2500 })
  })
})

describe('[이 세션에 답하기](AC-05 · EC-25)', () => {
  it('AC-05 [이 세션에 답하기]를 누르면 그 터미널이 키 입력을 받는다', async () => {
    world({ agents: [done(A1, 65_000), attention(B1, 30_000)], started: [A] })
    const { user } = renderApp()
    await user.click(toggle())
    await waitFor(() => expect(useUiStore.getState().terminalIds[A1]).toBeDefined())
    const button = screen.getByTestId('answer-focus-terminal')
    expect(button).toHaveAccessibleName('이 세션에 답하기')
    expect(button).not.toHaveAttribute('aria-disabled', 'true')
    await user.click(button)
    await waitFor(() => expect(xterm.instances[0].focus).toHaveBeenCalled())
  })

  it('AC-05 Enter·Space 는 keydown 이 아니라 keyup 에서만 누른다 — 버튼이 받지 않은 keydown·누른 채 반복은 무시한다', async () => {
    world({ agents: [done(A1, 65_000)], started: [A] })
    const { user } = renderApp()
    await user.click(toggle())
    await waitFor(() => expect(useUiStore.getState().terminalIds[A1]).toBeDefined())
    const button = screen.getByTestId('answer-focus-terminal')
    act(() => button.focus())
    const focused = () => xterm.instances[0].focus.mock.calls.length
    for (const key of ['Enter', ' ']) {
      // 다른 곳에서 누른 채 넘어온 키 — 이 버튼이 받은 keydown 이 없다
      fireEvent.keyUp(button, { key })
      // 누른 채 둔 키의 반복
      expect(fireEvent.keyDown(button, { key, repeat: true })).toBe(false)
      fireEvent.keyUp(button, { key })
      expect(focused()).toBe(0)
    }
    expect(fireEvent.keyDown(button, { key: 'Enter' })).toBe(false)
    expect(focused()).toBe(0)
    fireEvent.keyUp(button, { key: 'Enter' })
    await waitFor(() => expect(focused()).toBeGreaterThan(0))
  })

  it('EC-25 그 터미널이 아직 열리지 않았으면 aria-disabled + 사유, 눌러도 포커스 요청을 남기지 않는다', async () => {
    world({ agents: [done(A1, 65_000)] })
    const { user } = renderApp()
    await user.click(toggle())
    const button = screen.getByTestId('answer-focus-terminal')
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(button).toHaveAccessibleDescription(/터미널이 아직 열리지 않았습니다/)
    await user.click(button)
    expect(useUiStore.getState().focusRequest).toBeNull()
  })

  it('EC-25 다른 세션으로 이동하는 중에 [이 세션에 답하기]를 누르면 그 이동을 취소한다(사용자 선택)', async () => {
    world({ agents: [done(A1, 65_000), attention(C1, 30_000)], started: [A], ready: [A, B] })
    const { user } = renderApp()
    await user.click(toggle())
    await waitFor(() => expect(useUiStore.getState().terminalIds[A1]).toBeDefined())
    await user.click(rows()[0])
    await waitFor(() => expect(openMock).toHaveBeenCalledTimes(1))
    const o = openMock.mock.calls[0][0]
    expect(o.isStale()).toBe(false)
    await user.click(screen.getByTestId('answer-focus-terminal'))
    expect(o.isStale()).toBe(true)
  })
})

describe('[건너뛰기]·[보기]·[새 세션]·기본 보기로(AC-07 · AC-12 · AC-13 · EC-04)', () => {
  it('AC-07 [건너뛰기]: 지금 세션을 대기열 뒤로 보내고 다음 기다리는 세션을 보인다 — 포커스는 그대로, "다음 세션: …"을 알린다', async () => {
    world({ agents: [done(A1, 65_000), done(B1, 30_000)] })
    const { user } = renderApp()
    await user.click(toggle())
    const skip = screen.getByTestId('answer-skip')
    await user.click(skip)
    expect(useUiStore.getState().selectedIssueId).toBe(B)
    expect(skip).toHaveFocus()
    await waitFor(() => expect(announce()).toHaveTextContent(/다음 세션: .*#2 문서/))
    expect(rows().map((r) => r.textContent?.includes('#2 문서'))).toEqual([true, false])
  })

  it('EC-04 지금 세션이 기다리는 상태면 더 급한 세션 수와 [보기] — [보기]는 세어진 첫 줄로 가고 알린다', async () => {
    world({ agents: [done(A1, 65_000), attention(B1, 30_000), done(C1, 90_000)] })
    const { user } = renderApp()
    await user.click(toggle())
    expect(useUiStore.getState().selectedIssueId).toBe(A)
    expect(summary()).toHaveTextContent('더 급한 세션 1개')
    await user.click(within(summary()).getByRole('button', { name: '보기' }))
    expect(useUiStore.getState().selectedIssueId).toBe(B)
    await waitFor(() => expect(announce()).toHaveTextContent(/다음 세션: .*#2 문서/))
  })

  it('EC-25 [보기]도 Enter·Space 는 keydown 이 아니라 keyup 에서만 누른다 — 버튼이 받지 않은 keydown·누른 채 반복은 무시한다', async () => {
    world({ agents: [done(A1, 65_000), attention(B1, 30_000), done(C1, 90_000)] })
    const { user } = renderApp()
    await user.click(toggle())
    const see = within(summary()).getByRole('button', { name: '보기' })
    act(() => see.focus())
    for (const key of ['Enter', ' ']) {
      // 다른 곳에서 누른 채 넘어온 키 — 이 버튼이 받은 keydown 이 없다
      fireEvent.keyUp(see, { key })
      // 누른 채 둔 키의 반복
      expect(fireEvent.keyDown(see, { key, repeat: true })).toBe(false)
      fireEvent.keyUp(see, { key })
      expect(useUiStore.getState().selectedIssueId).toBe(A)
    }
    expect(fireEvent.keyDown(see, { key: 'Enter' })).toBe(false)
    expect(useUiStore.getState().selectedIssueId).toBe(A)
    fireEvent.keyUp(see, { key: 'Enter' })
    expect(useUiStore.getState().selectedIssueId).toBe(B)
  })

  it('EC-25 [건너뛰기]에서 Enter 를 누른 채 두면 한 번만 건너뛴다 — 떼고 다시 누르면 또 건너뛴다', async () => {
    // 기다리는 순서: 오래 기다린 것부터 #3 → #1 → #2
    world({ agents: [done(A1, 65_000), done(B1, 30_000), done(C1, 90_000)] })
    const { user } = renderApp()
    await user.click(toggle())
    const skip = screen.getByTestId('answer-skip')
    act(() => skip.focus())
    await user.keyboard('{Enter>3/}')
    expect(useUiStore.getState().selectedIssueId).toBe(C)
    await user.keyboard('{Enter}')
    expect(useUiStore.getState().selectedIssueId).toBe(B)
    expect(skip).toHaveFocus()
  })

  it('AC-12 [새 세션]은 프로젝트·이슈 트리 대화상자를 연다(목록·카드 어디서든)', async () => {
    world({ agents: [done(A1, 65_000)] })
    const { user } = renderApp()
    await user.click(toggle())
    await user.click(within(list()).getByTestId('answer-new-session'))
    expect(await screen.findByRole('dialog', { name: '새 세션' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '새 세션' })).toBeNull())
    await user.click(within(summary()).getByRole('button', { name: '새 세션' }))
    expect(await screen.findByRole('dialog', { name: '새 세션' })).toBeInTheDocument()
  })

  it('AC-13 기본 보기로 돌아가면 트리와 들어가기 전 탭이 그대로이고, 마지막으로 본 세션의 이슈가 선택돼 있다', async () => {
    world({ agents: [done(A1, 65_000), attention(B1, 30_000)], tab: 'notes' })
    const { user } = renderApp()
    await user.click(toggle())
    await user.click(rows()[0])
    await user.click(toggle())
    expect(useUiStore.getState()).toMatchObject({ viewMode: 'normal', tab: 'notes', selectedIssueId: B })
    expect(screen.getByRole('complementary', { name: '이슈 트리' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: '메모' })).toHaveAttribute('aria-selected', 'true')
  })
})

describe('좁은 화면·원격 호스트(EC-13 · EC-19)', () => {
  it('EC-13 좁은 화면의 전환 버튼은 답변 모드에서 "세션 목록 보기"/"작업 화면 보기"', async () => {
    world({ agents: [done(A1, 65_000)] })
    const { user } = renderApp()
    expect(screen.getByRole('button', { name: '이슈 목록 보기' })).toBeInTheDocument()
    await user.click(toggle())
    const btn = screen.getByRole('button', { name: '세션 목록 보기' })
    await user.click(btn)
    expect(screen.getByRole('button', { name: '작업 화면 보기' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('EC-19 원격 호스트가 연결 전이면 머리줄 자리에 연결 상태를 보이고, 카드·목록·[건너뛰기]는 동작한다', async () => {
    const R = 'ssh:srv|acme/app#5'
    world({ agents: [done(`${R}::1`, 65_000), done(A1, 30_000)], selected: R })
    useSetupStore.setState((s) => ({ targets: { ...s.targets, [R]: target(5, '원격') }, open: { ...s.open, [R]: READY(5) } }))
    useUiStore.setState((s) => ({ panes: { ...s.panes, [R]: { tree: { kind: 'leaf', id: `${R}::1` }, focused: `${R}::1`, seq: 1 } } }))
    const { user } = renderApp({ sshProbe: () => new Promise(() => {}) })
    await user.click(toggle())
    expect(screen.getByTestId('issue-host-status')).toBeInTheDocument()
    expect(summary()).toHaveTextContent('#5 원격')
    expect(rows()).toHaveLength(2)
    await user.click(screen.getByTestId('answer-skip'))
    expect(useUiStore.getState().selectedIssueId).toBe(A)
  })
})

describe('Claude 마지막 답변(AC-09 · EC-10)', () => {
  const reply = (text: string) => JSON.stringify({ type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text }] } })

  it('AC-09 설정 켜짐 + Claude Code 세션: 기록의 마지막 답변 앞 3줄과 "N분 전 기록" — 다시 기다리는 상태가 되면 1.5초 뒤 다시 읽는다', async () => {
    // 기록(2분 전)은 기다리기 시작한 때(5분 전)보다 나중이다 — "늦게 쓰임" 재조회가 섞이지 않게
    world({ agents: [done(A1, 300_000)] })
    const claudeLastReply = vi.fn(async () => ({ tail: `${reply('로그인을 고쳤습니다.\n테스트를 돌렸습니다.\n커밋했습니다.\n넷째 줄')}\n`, updatedMs: Date.now() - 120_000 }))
    const { user } = renderApp({ claudeLastReply })
    await user.click(toggle())
    const box = await screen.findByTestId('claude-reply')
    await waitFor(() => expect(box).toHaveTextContent('로그인을 고쳤습니다.'))
    expect(box).toHaveTextContent('커밋했습니다.')
    expect(box).not.toHaveTextContent('넷째 줄')
    expect(box).toHaveTextContent('2분 전 기록')
    expect(claudeLastReply).toHaveBeenCalledWith('/w/1')
    // 다시 기다리는 상태가 되었다(새 waitingSince) — 기록이 쓰일 틈(1.5초)을 두고 다시 읽는다
    act(() => useAgentStore.getState().set(A1, done(A1, 0)))
    await new Promise((r) => setTimeout(r, 500))
    expect(claudeLastReply).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(claudeLastReply).toHaveBeenCalledTimes(2), { timeout: 3000 })
  })

  it('AC-09 다시 작업 중이 되면 앞 작업 구간에 읽은 답이 아니라 기록을 다시 읽어 보인다', async () => {
    world({ agents: [busy(A1)] })
    let text = '첫 작업 중의 답'
    const claudeLastReply = vi.fn(async () => ({ tail: `${reply(text)}\n`, updatedMs: Date.now() }))
    const { user } = renderApp({ claudeLastReply })
    await user.click(toggle())
    const box = await screen.findByTestId('claude-reply')
    await waitFor(() => expect(box).toHaveTextContent('첫 작업 중의 답'))
    // 기다리는 상태가 되었다 — 1.5초 뒤 다시 읽는다
    text = '기다릴 때의 답'
    act(() => useAgentStore.getState().set(A1, done(A1, 0)))
    await waitFor(() => expect(box).toHaveTextContent('기다릴 때의 답'), { timeout: 3000 })
    // 다시 작업 중이 되었다(새 작업 구간)
    text = '다시 작업 중의 답'
    act(() => useAgentStore.getState().set(A1, busy(A1, { since: Date.now() })))
    await waitFor(() => expect(box).toHaveTextContent('다시 작업 중의 답'))
    expect(box).not.toHaveTextContent('첫 작업 중의 답')
    expect(claudeLastReply).toHaveBeenCalledTimes(3)
  })

  it.each([
    ['기록이 없다', async () => null, '최근 기록에 답변이 없습니다'],
    ['기록에 답이 없다', async () => ({ tail: '{"type":"user"}\n', updatedMs: Date.now() }), '최근 기록에 답변이 없습니다'],
    [
      '읽지 못했다',
      async () => {
        throw new Error('io')
      },
      '답변 기록을 읽지 못했습니다',
    ],
  ])('EC-10 %s — 문구', async (_kind, claudeLastReply, text) => {
    world({ agents: [done(A1, 65_000)] })
    const { user } = renderApp({ claudeLastReply: vi.fn(claudeLastReply) })
    await user.click(toggle())
    await waitFor(() => expect(screen.getByTestId('claude-reply')).toHaveTextContent(text))
  })

  it('EC-10 같은 이슈(같은 폴더)에 Claude Code 가 둘 이상이면 고를 수 없다고 알리고 읽지 않는다', async () => {
    world({ agents: [done(A1, 65_000), done(A2, 30_000)] })
    useUiStore.setState((s) => ({ panes: { ...s.panes, [A]: { tree: { kind: 'split', dir: 'row', a: { kind: 'leaf', id: A1 }, b: { kind: 'leaf', id: A2 } }, focused: A1, seq: 2 } } }))
    const claudeLastReply = vi.fn(async () => null)
    const { user } = renderApp({ claudeLastReply })
    await user.click(toggle())
    await waitFor(() => expect(screen.getByTestId('claude-reply')).toHaveTextContent('같은 폴더에 Claude Code 가 여럿이라 고를 수 없습니다'))
    expect(claudeLastReply).not.toHaveBeenCalled()
  })

  it('EC-10 원격 호스트는 연결 전에는 읽지 않는다 · 설정을 끄면 보이지 않는다', async () => {
    const R = 'ssh:srv|acme/app#5'
    world({ agents: [done(`${R}::1`, 65_000), done(A1, 30_000)], selected: R })
    useSetupStore.setState((s) => ({ targets: { ...s.targets, [R]: target(5, '원격') }, open: { ...s.open, [R]: READY(5) } }))
    useUiStore.setState((s) => ({ panes: { ...s.panes, [R]: { tree: { kind: 'leaf', id: `${R}::1` }, focused: `${R}::1`, seq: 1 } }, worktreePathMap: { ...s.worktreePathMap, [R]: { path: '/home/r/w/5', branch: 'b' } } }))
    const claudeLastReply = vi.fn(async () => null)
    const { user, tauri } = renderApp({ claudeLastReply, sshProbe: () => new Promise(() => {}) })
    await user.click(toggle())
    expect(summary()).toHaveTextContent('#5 원격')
    await new Promise((r) => setTimeout(r, 300))
    expect(claudeLastReply).not.toHaveBeenCalled()
    expect(tauri.sshExec).not.toHaveBeenCalled()
    // 이 PC 의 세션은 읽는다 — 설정을 끄면 보이지 않는다
    await user.click(screen.getByTestId('answer-skip'))
    await waitFor(() => expect(claudeLastReply).toHaveBeenCalledWith('/w/1'))
    act(() => useUiStore.getState().setSummaryClaudeReply(false))
    expect(screen.queryByTestId('claude-reply')).toBeNull()
  })

  it('EC-10 세션이 바뀌면 이전 세션의 답을 보이지 않고, 기록이 기다림보다 먼저 쓰였으면(늦게 쓰임) 한 번 더 읽는다', async () => {
    world({ agents: [done(A1, 65_000), attention(B1, 30_000)] })
    const claudeLastReply = vi.fn(async (cwd: string) => (cwd === '/w/1' ? { tail: `${reply('A 의 답')}\n`, updatedMs: Date.now() } : { tail: `${reply('B 의 옛 답')}\n`, updatedMs: Date.now() - 600_000 }))
    const { user } = renderApp({ claudeLastReply })
    await user.click(toggle())
    await waitFor(() => expect(screen.getByTestId('claude-reply')).toHaveTextContent('A 의 답'))
    await user.click(rows()[0])
    expect(screen.queryByText('A 의 답')).toBeNull()
    await waitFor(() => expect(claudeLastReply).toHaveBeenCalledWith('/w/2'))
    await waitFor(() => expect(claudeLastReply.mock.calls.filter(([c]) => c === '/w/2')).toHaveLength(2), { timeout: 3000 })
  })
})

describe('Jev 판정(AC-10 · EC-11)', () => {
  const RESPONSE = JSON.stringify({
    model: 'jev-latest',
    usage: { input_tokens: 10, output_tokens: 3 },
    answers: {
      need: { type: 'choice', choice: 'permission', confidence: 0.8, probabilities: { permission: 0.9, question: 0.05, next_task: 0.03, error: 0.01, none: 0.01 } },
      outcome: { type: 'choice', choice: 'partial', confidence: 0.6, probabilities: { success: 0.2, partial: 0.7, failed: 0.05, unknown: 0.05 } },
      urgency: { type: 'score', score: 1.6, confidence: 0.7, legend: { 0: 'low', 1: 'medium', 2: 'high' }, probabilities: { 0: 0.1, 1: 0.3, 2: 0.6 } },
    },
  })
  const jevOn = () => useUiStore.setState({ summaryJev: true })

  it('AC-10 설정 켜짐 + 키 저장됨 → [Jev 판정]. 누르면 그 패널의 마지막 글자를 보내 칩 3개(필요한 것·결과·급함 + 확률)를 보이고, 다시 기다리는 상태가 되면 지운다', async () => {
    world({ agents: [done(A1, 65_000)] })
    jevOn()
    const jevDecide = vi.fn(async (_body: string) => RESPONSE)
    const { user } = renderApp({ jevKeyStatus: async () => true, jevDecide })
    await user.click(toggle())
    const box = screen.getByTestId('jev-verdict')
    await user.click(await within(box).findByRole('button', { name: 'Jev 판정' }))
    expect(textMock).toHaveBeenCalledWith(A1, 200)
    await waitFor(() => expect(jevDecide).toHaveBeenCalledTimes(1))
    expect((JSON.parse(jevDecide.mock.calls[0][0]) as { state: string }).state).toBe('$ claude\n권한을 허용할까요? (y/n)')
    await waitFor(() => expect(box).toHaveTextContent('필요한 것:'))
    expect(box).toHaveTextContent('결과:')
    expect(box).toHaveTextContent('급함:')
    expect(box).toHaveTextContent(/90/)
    act(() => useAgentStore.getState().set(A1, done(A1, 0)))
    await waitFor(() => expect(box).not.toHaveTextContent('필요한 것:'))
  })

  it('EC-11 키가 없으면 [Jev 판정] 대신 키 안내를 보인다', async () => {
    world({ agents: [done(A1, 65_000)] })
    jevOn()
    const { user } = renderApp({ jevKeyStatus: async () => false })
    await user.click(toggle())
    const box = screen.getByTestId('jev-verdict')
    await waitFor(() => expect(box).toHaveTextContent(/API 키/))
    expect(within(box).queryByRole('button', { name: 'Jev 판정' })).toBeNull()
  })

  it.each(['jev_http_401', 'jev_http_429', 'jev_network', 'jev_keychain'])('EC-11 판정 실패(%s)는 오류 문구(alert)를 보이고 다시 누를 수 있다', async (code) => {
    world({ agents: [done(A1, 65_000)] })
    jevOn()
    const jevDecide = vi.fn(async () => {
      throw new Error(code)
    })
    const { user } = renderApp({ jevKeyStatus: async () => true, jevDecide })
    await user.click(toggle())
    const box = screen.getByTestId('jev-verdict')
    const button = await within(box).findByRole('button', { name: 'Jev 판정' })
    await user.click(button)
    const alert = await within(box).findByRole('alert')
    expect(alert.textContent?.trim()).not.toBe('')
    await user.click(button)
    await waitFor(() => expect(jevDecide).toHaveBeenCalledTimes(2))
  })

  it('EC-11 보낼 글자가 없으면 보내지 않고 "보낼 글자가 없습니다" · 모르는 답 형식은 "판정 없음"', async () => {
    world({ agents: [done(A1, 65_000)] })
    jevOn()
    textMock.mockReturnValue('')
    const jevDecide = vi.fn(async () => JSON.stringify({ model: 'jev-latest', usage: { input_tokens: 1, output_tokens: 1 }, answers: { need: { type: 'ranking' }, outcome: { type: 'x' }, urgency: { type: 'y' } } }))
    const { user } = renderApp({ jevKeyStatus: async () => true, jevDecide })
    await user.click(toggle())
    const box = screen.getByTestId('jev-verdict')
    await user.click(await within(box).findByRole('button', { name: 'Jev 판정' }))
    await waitFor(() => expect(box).toHaveTextContent('보낼 글자가 없습니다'))
    expect(jevDecide).not.toHaveBeenCalled()
    textMock.mockReturnValue('$ ls')
    await user.click(within(box).getByRole('button', { name: 'Jev 판정' }))
    await waitFor(() => expect(box).toHaveTextContent('판정 없음'))
  })

  it('EC-11 응답 전에 세션이 바뀌면 그 판정은 버린다', async () => {
    world({ agents: [done(A1, 65_000), attention(B1, 30_000)] })
    jevOn()
    let finish!: (v: string) => void
    const jevDecide = vi.fn(() => new Promise<string>((res) => (finish = res)))
    const { user } = renderApp({ jevKeyStatus: async () => true, jevDecide })
    await user.click(toggle())
    await user.click(await within(screen.getByTestId('jev-verdict')).findByRole('button', { name: 'Jev 판정' }))
    await waitFor(() => expect(jevDecide).toHaveBeenCalledTimes(1))
    await user.click(rows()[0])
    await act(async () => finish(RESPONSE))
    expect(screen.getByTestId('jev-verdict')).not.toHaveTextContent('필요한 것:')
  })

  it('EC-11 원격 화면(브라우저·휴대폰)에는 Jev 판정이 없다', async () => {
    world({ agents: [done(A1, 65_000)] })
    jevOn()
    const first = renderApp({ jevKeyStatus: async () => true })
    await first.user.click(toggle())
    expect(screen.getByTestId('jev-verdict')).toBeInTheDocument()
    first.unmount()
    // 보기 상태는 store 에 남는다 — 기본 보기로 되돌려야 아래 토글이 답변 모드를 켠다
    useUiStore.setState({ viewMode: 'normal' })
    const remote = renderApp({ runtime: 'remote', jevKeyStatus: async () => true })
    await remote.user.click(toggle())
    expect(summary()).toBeInTheDocument()
    expect(screen.queryByTestId('jev-verdict')).toBeNull()
  })
})
