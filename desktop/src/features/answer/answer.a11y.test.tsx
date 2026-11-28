// 답변 모드(#122) 접근성 — 토글·목록 구조·줄 이름·aria-disabled·알림 영역·tabpanel/idref·포커스 자리(EC-15, Plan §7, U9b)
import { act, screen, waitFor, within } from '@testing-library/react'
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

/** 접근성 트리의 이름(aria-hidden 자식은 뺀다) */
function computeName(el: Element): string {
  const walk = (n: Node): string => {
    if (n.nodeType === Node.TEXT_NODE) return n.textContent ?? ''
    if (n instanceof Element && n.getAttribute('aria-hidden') === 'true') return ''
    return [...n.childNodes].map(walk).join('')
  }
  return (el.getAttribute('aria-label') ?? walk(el)).replace(/\s+/g, ' ').trim()
}

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

describe('답변 모드 접근성(EC-15)', () => {
  it('EC-15 토글은 aria-pressed, 목록은 nav "세션 목록" 안의 제목(h2)·그 제목이 이름인 ul·aria-current — aside 이름은 "답변 모드"', async () => {
    world({ agents: [done(A1, 65_000), attention(B1, 30_000), busy(C1)] })
    const { user } = renderApp()
    await user.click(toggle())
    expect(toggle()).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('complementary', { name: '답변 모드' })).toContainElement(list())
    const headings = within(list()).getAllByRole('heading', { level: 2 })
    expect(headings.map((h) => h.textContent)).toEqual([expect.stringMatching(/기다리는 세션 2/), expect.stringMatching(/작업 중 1/)])
    const groups = within(list()).getAllByRole('list')
    expect(groups).toHaveLength(2)
    groups.forEach((ul, i) => expect(ul).toHaveAccessibleName(headings[i].textContent ?? ''))
    expect(within(list()).getAllByRole('button', { current: true })).toHaveLength(1)
  })

  it('EC-15 줄 이름은 1초마다 바뀌지 않는다 — 지난 시간은 이름에서 뺀다(aria-hidden)', async () => {
    world({ agents: [done(A1, 58_000), attention(B1, 30_000)] })
    const { user } = renderApp()
    await user.click(toggle())
    const before = rows().map(computeName)
    expect(before[0]).toMatch(/입력 대기/)
    expect(before[0]).toMatch(/#2 문서/)
    expect(before.join(' ')).not.toMatch(/\d+초/)
    await new Promise((r) => setTimeout(r, 1500))
    expect(rows().map(computeName)).toEqual(before)
  })

  it('EC-15 다음이 없으면 [건너뛰기]는 aria-disabled 이고 그 사유를 설명으로 읽는다', async () => {
    world({ agents: [done(A1, 65_000)] })
    const { user } = renderApp()
    await user.click(toggle())
    const skip = screen.getByTestId('answer-skip')
    expect(skip).toHaveAttribute('aria-disabled', 'true')
    expect(skip).not.toHaveAccessibleDescription('')
    await user.click(skip)
    expect(useUiStore.getState().selectedIssueId).toBe(A)
  })

  it('EC-15 답변 모드에는 polite 알림 영역(status)과 오류 알림(alert)이 늘 있다', async () => {
    world({ agents: [done(A1, 65_000)] })
    const { user } = renderApp()
    await user.click(toggle())
    expect(announce()).toHaveAttribute('role', 'status')
    expect(announce()).toBeEmptyDOMElement()
    expect(screen.getAllByRole('alert', { hidden: true }).length).toBeGreaterThan(0)
  })

  it('EC-15 답변 모드에는 이름 없는 tabpanel·끊긴 idref(aria-labelledby·aria-describedby·aria-controls)가 없다', async () => {
    world({ agents: [done(A1, 65_000), attention(B1, 30_000)], started: [A] })
    const { user } = renderApp()
    await user.click(toggle())
    await waitFor(() => expect(useUiStore.getState().terminalIds[A1]).toBeDefined())
    expect(screen.queryAllByRole('tabpanel', { hidden: true })).toHaveLength(0)
    const refs = [...document.querySelectorAll('[aria-labelledby],[aria-describedby],[aria-controls]')].flatMap((el) =>
      ['aria-labelledby', 'aria-describedby', 'aria-controls'].flatMap((a) => (el.getAttribute(a) ?? '').split(' ').filter(Boolean)),
    )
    for (const id of refs) expect(document.getElementById(id), id).not.toBeNull()
  })

  it('EC-15 카드 제목·[이 세션에 답하기]·터미널 입력은 "어디" 줄(저장소·이슈)을 설명으로 함께 읽는다', async () => {
    world({ agents: [done(A1, 65_000)], started: [A] })
    const { user } = renderApp()
    await user.click(toggle())
    await waitFor(() => expect(useUiStore.getState().terminalIds[A1]).toBeDefined())
    const heading = within(summary()).getByRole('heading', { name: '세션 요약' })
    expect(heading).toHaveAttribute('tabindex', '-1')
    expect(heading).toHaveAccessibleDescription(/#1 로그인/)
    expect(screen.getByTestId('answer-focus-terminal')).toHaveAccessibleDescription(/#1 로그인/)
    expect(xterm.instances[0].textarea).toHaveAccessibleDescription(/#1 로그인/)
  })

  it('EC-15 터미널에서 Ctrl+Shift+M 은 요약 카드 제목으로 포커스를 옮긴다', async () => {
    world({ agents: [done(A1, 65_000)], started: [A] })
    const { user } = renderApp()
    await user.click(toggle())
    await waitFor(() => expect(xterm.instances[0]?.keyHandler).not.toBeNull())
    act(() => {
      xterm.instances[0].keyHandler?.(new KeyboardEvent('keydown', { key: 'M', code: 'KeyM', ctrlKey: true, shiftKey: true }))
    })
    expect(within(summary()).getByRole('heading', { name: '세션 요약' })).toHaveFocus()
  })

  it('EC-15 목록 안에 포커스가 있는 동안 기다리던 줄이 작업 중이 되어도 같은 자리·같은 묶음에 남아 포커스를 잃지 않고 아래 줄도 밀리지 않는다 — 목록을 떠나면 다시 묶는다', async () => {
    world({ agents: [done(A1, 65_000), attention(B1, 30_000), done(C1, 90_000)] })
    const { user } = renderApp()
    await user.click(toggle())
    // 기다리는 순서: 입력 대기(#2) → 끝남 중 오래 기다린 것(#3 → #1)
    const [b, c, a] = rows()
    expect(c).toHaveTextContent('#3 배포')
    act(() => c.focus())
    act(() => useAgentStore.getState().set(C1, busy(C1)))
    expect(c.isConnected).toBe(true)
    expect(c).toHaveFocus()
    expect(c).toHaveAttribute('data-status', 'working')
    const now = rows()
    expect(now).toHaveLength(3)
    ;[b, c, a].forEach((el, i) => expect(now[i]).toBe(el))
    act(() => toggle().focus())
    await waitFor(() => expect(rows().map((r) => r.getAttribute('data-status'))).toEqual(['attention', 'done', 'working']))
    expect(rows()[2]).toHaveTextContent('#3 배포')
  })

  it('EC-15 포커스된 요소가 focusout 없이 지워져도(WebKit) 카드 제목으로 간다 — 빈 곳을 눌러 body 가 된 것은 옮기지 않는다', async () => {
    world({ agents: [done(A1, 65_000)] })
    const { user } = renderApp()
    await user.click(toggle())
    const heading = within(summary()).getByRole('heading', { name: '세션 요약' })
    // Why: WebKit 은 지운 요소의 focusout 을 보내지 않을 수 있다(jsdom 도 같다) — 혹시 오더라도 document 에 닿지 않게 막는다.
    const noFocusOut = (e: Event) => e.stopImmediatePropagation()
    window.addEventListener('focusout', noFocusOut, true)
    const focusedButton = () => {
      const el = document.createElement('button')
      document.body.appendChild(el)
      act(() => el.focus())
      return el
    }
    const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)))
    try {
      const kept = focusedButton()
      act(() => kept.blur())
      await wait(400)
      act(() => kept.remove())
      await wait(400)
      expect(document.activeElement).toBe(document.body)

      const gone = focusedButton()
      act(() => gone.remove())
      expect(document.activeElement).toBe(document.body)
      await waitFor(() => expect(heading).toHaveFocus(), { timeout: 2000 })
    } finally {
      window.removeEventListener('focusout', noFocusOut, true)
    }
  })

  it('EC-15 [새 세션] 대화상자를 닫으면 포커스가 사라지지 않고 카드 제목으로 간다', async () => {
    world({ agents: [done(A1, 65_000)] })
    const { user } = renderApp()
    await user.click(toggle())
    await user.click(within(list()).getByTestId('answer-new-session'))
    await screen.findByRole('dialog', { name: '새 세션' })
    await user.keyboard('{Escape}')
    await waitFor(() => expect(within(summary()).getByRole('heading', { name: '세션 요약' })).toHaveFocus())
  })
})
