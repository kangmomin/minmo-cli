// 에이전트 현황 — 출력 해석, 종류·상태 판별, 상태 전이, 추적기, 표시(이슈 행·패널·전체 현황의 필터·정렬·그루핑), 알림
import { act, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PtyDataEvent } from '../../lib/tauri'
import { useSetupStore } from '../../store/setup'
import { DEFAULT_AGENTS_VIEW, useUiStore } from '../../store/ui'
import { createFakeTauri } from '../../test/fakes'
import { makeDeps, renderHookWithDeps, renderWithDeps } from '../../test/render'
import { TooltipProvider } from '../../components/ui/tooltip'
import { IssueAgentDot, PaneAgentChip } from './AgentBadge'
import { AgentsButton, AgentsOverview } from './AgentsOverview'
import { QUIET_MS, derive, issueStatus, statusOf, useAgentStore } from './agentStore'
import type { PaneAgent, PaneSignals } from './agentStore'
import { guessProgram, parseTitle, titleSignal } from './detect'
import { ago, filterRows, groupRows, sortRows, toRows } from './overview'
import type { AgentRow } from './overview'
import { PtyStreamParser } from './ptyStream'
import { ECHO_MS, noteTerminalInput, useAgentTracker } from './useAgentTracker'

const osc = (title: string, end = '\x07') => `\x1b]0;${title}${end}`

describe('PtyStreamParser', () => {
  it('창 제목(OSC 0·2, BEL 또는 ESC \\ 로 끝남)을 순서대로 읽는다 — 다른 OSC(링크 등)는 무시', () => {
    const p = new PtyStreamParser()
    const out = p.feed(`${osc('✳ Claude Code')}\x1b]8;;https://x\x07link\x1b]8;;\x07\x1b]2;◐ ok 응답\x1b\\`)
    expect(out.titles).toEqual(['✳ Claude Code', '◐ ok 응답'])
    expect(out.bells).toBe(0)
    expect(out.visible).toBe(true)
  })

  it('조각나서 온 제목도 이어서 읽는다(제어 문자열 중간·ESC 바로 뒤에서 끊김)', () => {
    const p = new PtyStreamParser()
    expect(p.feed('\x1b]0;◐ 작').titles).toEqual([])
    expect(p.feed('업 중').titles).toEqual([])
    expect(p.feed('\x07').titles).toEqual(['◐ 작업 중'])
    expect(p.feed('\x1b').titles).toEqual([])
    expect(p.feed(']2;✳ 끝\x1b').titles).toEqual([])
    expect(p.feed('\\').titles).toEqual(['✳ 끝'])
  })

  it('벨은 제목을 끝내는 BEL 과 구분해 센다', () => {
    const p = new PtyStreamParser()
    expect(p.feed(`\x07${osc('t')}\x07\x07`).bells).toBe(3)
    expect(new PtyStreamParser().feed(osc('t')).bells).toBe(0)
  })

  it('보이는 출력: 색·커서 이동 같은 제어 문자열과 공백·줄바꿈만 있으면 아니다', () => {
    const p = new PtyStreamParser()
    expect(p.feed('\x1b[2J\x1b[1;1H\x1b[?25l \r\n\t').visible).toBe(false)
    expect(p.feed('\x1b[32mok\x1b[0m').visible).toBe(true)
    // 끊긴 CSI 의 매개변수를 글자로 세지 않는다
    const q = new PtyStreamParser()
    expect(q.feed('\x1b[38;5;1').visible).toBe(false)
    expect(q.feed('2m').visible).toBe(false)
    // DCS 본문도 글자가 아니다
    expect(new PtyStreamParser().feed('\x1bPq#0;2;0;0;0\x1b\\').visible).toBe(false)
  })

  it('끝나지 않는 제어 문자열은 4KB 까지만 들고 있다가 버린다', () => {
    const p = new PtyStreamParser()
    p.feed(`\x1b]0;${'x'.repeat(5000)}`)
    // 버린 뒤에는 새 제목을 정상으로 읽는다
    expect(p.feed(osc('new')).titles).toEqual(['new'])
  })
})

describe('종류·상태 판별', () => {
  it('titleSignal: Claude Code(✳ 대기 · ◐◑ 작업 중), Gemini CLI(◇ 대기 · ✦ 작업 중 · ✋ 확인 필요)', () => {
    expect(titleSignal('✳ Claude Code')).toEqual({ agent: 'claude', activity: 'idle', label: 'Claude Code' })
    expect(titleSignal('◐ ok 응답')).toEqual({ agent: 'claude', activity: 'working', label: 'ok 응답' })
    expect(titleSignal('◑ ok 응답')?.activity).toBe('working')
    expect(titleSignal('◇  Ready (work)     ')).toEqual({ agent: 'gemini', activity: 'idle', label: 'Ready (work)' })
    expect(titleSignal('✦  Working…')?.activity).toBe('working')
    expect(titleSignal('✋  Action Required')).toMatchObject({ agent: 'gemini', activity: 'attention' })
    // 상태 글자가 없는 제목(셸 경로·폴더 이름)은 신호가 아니다
    expect(titleSignal('C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')).toBeNull()
    expect(titleSignal('work')).toBeNull()
    expect(titleSignal('')).toBeNull()
  })

  it('parseTitle: 원격 tmux 형식 "minmo:<프로그램>:<제목>"', () => {
    expect(parseTitle('minmo:claude:✳ fix: login')).toEqual({ program: 'claude', title: '✳ fix: login' })
    expect(parseTitle('minmo:bash:')).toEqual({ program: 'bash', title: '' })
    expect(parseTitle('✳ x')).toEqual({ title: '✳ x' })
  })

  it('guessProgram: 셸뿐이면 없음, 알려진 에이전트가 있으면 그것, 아니면 기타(첫 프로그램)', () => {
    expect(guessProgram(['conhost.exe', 'PowerShell.exe'])).toBeNull()
    expect(guessProgram([])).toBeNull()
    expect(guessProgram(['node.exe', 'codex.exe'])).toEqual({ agent: 'codex', program: 'codex' })
    expect(guessProgram(['claude.exe', 'node.exe'])).toEqual({ agent: 'claude', program: 'claude' })
    expect(guessProgram(['codex-x86_64-pc-windows-msvc.exe'])).toEqual({ agent: 'codex', program: 'codex' })
    expect(guessProgram(['bash', 'node'])).toEqual({ agent: 'other', program: 'node' })
    // 로그인 셸은 이름 앞에 - 가 붙는다
    expect(guessProgram(['-zsh'])).toBeNull()
  })
})

describe('derive: 신호 → 현황', () => {
  const PANE = 'acme/app#1::1'
  const sig = (o: Partial<PaneSignals> = {}): PaneSignals => ({ title: null, processes: null, lastOutputAt: 0, bell: false, ...o })
  const step = (s: PaneSignals, prev: PaneAgent | null, now: number, viewed = false) => derive(PANE, s, prev, now, viewed)

  it('에이전트가 없으면(셸만) null', () => {
    expect(step(sig({ processes: ['conhost.exe'] }), null, 1000).next).toBeNull()
    expect(step(sig(), null, 1000).next).toBeNull()
  })

  it('제목이 상태를 알려 주는 에이전트: 작업 중 → 끝나면 안 본 동안 "끝남", 보면 "대기 중"', () => {
    const working = step(sig({ title: titleSignal('◐ 작업') }), null, 1000)
    expect(working.next).toMatchObject({ agent: 'claude', activity: 'working', label: '작업', issueId: 'acme/app#1', since: 1000 })
    expect(working.event).toBeNull()
    const done = step(sig({ title: titleSignal('✳ 작업') }), working.next, 5000)
    expect(statusOf(done.next!)).toBe('done')
    expect(done.event).toBe('done')
    expect(done.next!.since).toBe(5000)
    // 같은 상태가 이어지면 알림은 한 번만, 시각도 그대로
    const still = step(sig({ title: titleSignal('✳ 작업') }), done.next, 9000)
    expect([statusOf(still.next!), still.event, still.next!.since]).toEqual(['done', null, 5000])
    const seen = step(sig({ title: titleSignal('✳ 작업') }), still.next, 9500, true)
    expect(statusOf(seen.next!)).toBe('idle')
  })

  it('보고 있는 패널에서 끝나면 "끝남"·알림 없이 바로 "대기 중"', () => {
    const working = step(sig({ title: titleSignal('◐ x') }), null, 1000, true)
    const done = step(sig({ title: titleSignal('✳ x') }), working.next, 2000, true)
    expect([statusOf(done.next!), done.event]).toEqual(['idle', null])
  })

  it('제목으로 알 수 없는 프로그램(Codex 등): 출력이 이어지는 동안 작업 중, 4초 끊기면 끝남', () => {
    const procs = ['node.exe', 'codex.exe']
    const a = step(sig({ processes: procs, lastOutputAt: 10_000 }), null, 10_500)
    expect(a.next).toMatchObject({ agent: 'codex', activity: 'working' })
    const b = step(sig({ processes: procs, lastOutputAt: 10_000 }), a.next, 10_000 + QUIET_MS)
    expect(b.next!.activity).toBe('working')
    const c = step(sig({ processes: procs, lastOutputAt: 10_000 }), b.next, 10_001 + QUIET_MS)
    expect([statusOf(c.next!), c.event]).toEqual(['done', 'done'])
    // 다시 출력이 나오면 작업 중으로 돌아가고 "안 봄" 표시는 지워진다
    const d = step(sig({ processes: procs, lastOutputAt: 20_000 }), c.next, 20_100)
    expect([d.next!.activity, d.next!.unseen]).toEqual(['working', false])
  })

  it('벨이 울리면 "입력 대기"(작업 중이 아닐 때) — 보면 풀린다. Gemini 의 ✋ 도 입력 대기', () => {
    const idle = step(sig({ title: titleSignal('✳ x') }), null, 1000)
    const bell = step(sig({ title: titleSignal('✳ x'), bell: true }), idle.next, 2000)
    expect([statusOf(bell.next!), bell.event]).toEqual(['attention', 'attention'])
    expect(statusOf(step(sig({ title: titleSignal('✳ x'), bell: true }), bell.next, 3000, true).next!)).toBe('idle')
    expect(statusOf(step(sig({ title: titleSignal('◐ x'), bell: true }), bell.next, 3000).next!)).toBe('working')
    expect(step(sig({ title: titleSignal('✋  Action Required') }), null, 1000)).toMatchObject({ next: { agent: 'gemini', activity: 'attention' }, event: 'attention' })
  })

  it('원격 tmux: 앞에서 도는 것이 셸이면 남아 있는 제목은 무시한다 · 프로그램 이름으로 종류를 안다', () => {
    expect(step(sig({ title: titleSignal('✳ 예전 세션'), tmuxProgram: 'bash' }), null, 1000).next).toBeNull()
    expect(step(sig({ tmuxProgram: 'codex', lastOutputAt: 900 }), null, 1000).next).toMatchObject({ agent: 'codex', activity: 'working' })
    expect(step(sig({ title: titleSignal('◐ x'), tmuxProgram: 'node' }), null, 1000).next).toMatchObject({ agent: 'claude', activity: 'working' })
  })

  it('다른 프로그램으로 바뀌면 이전 것의 "안 봄"·시각을 이어받지 않는다', () => {
    const a = step(sig({ processes: ['codex.exe'], lastOutputAt: 0 }), null, 10_000)
    const b = step(sig({ processes: ['claude.exe'], lastOutputAt: 0 }), { ...a.next!, unseen: true }, 20_000)
    expect(b.next).toMatchObject({ agent: 'claude', unseen: false, since: 20_000 })
  })

  it('issueStatus: 이슈의 패널 중 가장 급한 상태(입력 대기 > 끝남 > 작업 중 > 대기 중), 기타 프로그램은 세지 않는다', () => {
    const pane = (id: string, o: Partial<PaneAgent>): PaneAgent => ({ paneId: id, issueId: 'a/b#1', agent: 'claude', program: 'claude', label: '', activity: 'idle', unseen: false, lastOutputAt: 0, since: 0, ...o })
    const panes = { p1: pane('p1', { activity: 'working' }), p2: pane('p2', { unseen: true }), p3: pane('p3', { issueId: 'a/b#2', activity: 'attention' }) }
    expect(issueStatus(panes, 'a/b#1')).toBe('done')
    expect(issueStatus(panes, 'a/b#2')).toBe('attention')
    expect(issueStatus(panes, 'a/b#3')).toBeNull()
    expect(issueStatus({ p: pane('p', { agent: 'other', program: 'node', activity: 'working' }) }, 'a/b#1')).toBeNull()
  })
})

describe('전체 현황: 줄·필터·정렬·그루핑', () => {
  const row = (o: Partial<AgentRow>): AgentRow => ({ paneId: 'p', issueId: 'i', host: null, hostLabel: '이 PC', repo: 'acme/app', issue: '#1 A', agent: 'claude', agentLabel: 'Claude Code', label: '', status: 'idle', since: 0, lastOutputAt: 0, ...o })
  const rows = [
    row({ paneId: 'p1', repo: 'acme/app', issue: '#10 Login', status: 'working', since: 300, lastOutputAt: 900 }),
    row({ paneId: 'p2', repo: 'acme/app', issue: '#2 Docs', agent: 'codex', agentLabel: 'Codex', status: 'done', since: 500 }),
    row({ paneId: 'p3', repo: 'zeta/lib', issue: '기타', agent: 'gemini', agentLabel: 'Gemini CLI', status: 'attention', since: 400, host: 'srv', hostLabel: 'srv' }),
    row({ paneId: 'p4', repo: 'my-app', issue: '#1 Task', agent: 'other', agentLabel: '기타(node)', status: 'idle', since: 100 }),
    row({ paneId: 'p5', repo: 'acme/app', issue: '#3 Old', status: 'done', since: 200 }),
  ]
  const ids = (rs: AgentRow[]) => rs.map((r) => r.paneId)

  it('toRows: 이슈 정보·호스트·저장소 표시 이름을 붙인다(로컬 저장소는 폴더명)', () => {
    const pane: PaneAgent = { paneId: 'ssh:srv|_local/app-1a2b#3::2', issueId: 'ssh:srv|_local/app-1a2b#3', agent: 'other', program: 'npm', label: 'x', activity: 'working', unseen: false, lastOutputAt: 5, since: 4 }
    const [r] = toRows(
      { [pane.paneId]: pane },
      { targets: { [pane.issueId]: { owner: '_local', repo: 'app-1a2b', key: '3', number: 3, title: '로그인' } }, hostOf: () => 'srv', repoLabel: () => 'my-app' },
    )
    expect(r).toMatchObject({ host: 'srv', hostLabel: 'srv', repo: 'my-app', issue: '#3 로그인', agentLabel: '기타(npm)', status: 'working' })
  })

  it('필터: 상태·에이전트(빈 목록 = 전부)·검색어를 모두 만족하는 줄', () => {
    expect(ids(filterRows(rows, { statuses: [], agents: [], query: '' }))).toEqual(['p1', 'p2', 'p3', 'p4', 'p5'])
    expect(ids(filterRows(rows, { statuses: ['done', 'attention'], agents: [], query: '' }))).toEqual(['p2', 'p3', 'p5'])
    expect(ids(filterRows(rows, { statuses: ['done'], agents: ['codex'], query: '' }))).toEqual(['p2'])
    expect(ids(filterRows(rows, { statuses: [], agents: [], query: ' ZETA ' }))).toEqual(['p3'])
    expect(ids(filterRows(rows, { statuses: [], agents: [], query: 'login' }))).toEqual(['p1'])
    expect(ids(filterRows(rows, { statuses: [], agents: [], query: 'srv' }))).toEqual(['p3'])
  })

  it('정렬: 상태(급한 순, 같은 상태는 오래 기다린 것부터) · 최근 활동 · 이름(번호는 숫자로)', () => {
    expect(ids(sortRows(rows, 'status'))).toEqual(['p3', 'p5', 'p2', 'p1', 'p4'])
    expect(ids(sortRows(rows, 'recent'))).toEqual(['p1', 'p2', 'p3', 'p5', 'p4'])
    expect(ids(sortRows(rows, 'name'))).toEqual(['p2', 'p5', 'p1', 'p4', 'p3'])
    // 원본은 바꾸지 않는다
    expect(ids(rows)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5'])
  })

  it('그루핑: 저장소·상태·에이전트·호스트 — 묶음 안의 순서는 정렬을 따른다', () => {
    const sorted = sortRows(rows, 'status')
    expect(groupRows(sorted, 'none')).toEqual([{ key: '', title: '', rows: sorted }])
    expect(groupRows(sorted, 'repo').map((g) => [g.title, ids(g.rows)])).toEqual([
      ['acme/app', ['p5', 'p2', 'p1']],
      ['my-app', ['p4']],
      ['zeta/lib', ['p3']],
    ])
    expect(groupRows(sorted, 'status').map((g) => [g.title, g.rows.length])).toEqual([
      ['입력 대기', 1],
      ['끝남', 2],
      ['작업 중', 1],
      ['대기 중', 1],
    ])
    expect(groupRows(sorted, 'agent').map((g) => g.title)).toEqual(['Claude Code', 'Codex', 'Gemini CLI', '기타'])
    expect(groupRows(sorted, 'host').map((g) => [g.title, g.rows.length])).toEqual([
      ['이 PC', 4],
      ['srv', 1],
    ])
  })

  it('ago', () => {
    expect([ago(0), ago(59_400), ago(60_000), ago(3_599_000), ago(7_200_000), ago(-5)]).toEqual(['0초', '59초', '1분', '59분', '2시간', '0초'])
  })
})

describe('추적기(useAgentTracker)', () => {
  const ISSUE = 'acme/app#1'
  const PANE = `${ISSUE}::1`

  function setup(o: { processes?: string[]; notify?: boolean } = {}) {
    let emit!: (e: PtyDataEvent) => void
    const fake = createFakeTauri({
      onPtyData: async (cb) => {
        emit = cb
        return () => {}
      },
      ptyProcesses: async () => o.processes ?? [],
    })
    useUiStore.setState({ terminalIds: { [PANE]: 'pty-1' }, selectedIssueId: null, tab: 'terminal', agentNotify: o.notify ?? true })
    useSetupStore.setState({ targets: { [ISSUE]: { owner: 'acme', repo: 'app', key: '1', number: 1, title: '로그인' } } })
    const r = renderHookWithDeps(() => useAgentTracker(), makeDeps({ tauri: fake.tauri }))
    const out = (data: string, id = 'pty-1') => act(() => emit({ id, data }))
    const tick = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms))
    return { ...r, tauri: fake.tauri, out, tick, pane: () => useAgentStore.getState().panes[PANE] }
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-12T00:00:00Z'))
    useAgentStore.getState().clear()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('제목으로 Claude Code 의 작업 중 → 끝남을 따라가고, 끝나면 알림을 띄운다(이슈 이름 포함)', async () => {
    const t = setup()
    await t.tick(0)
    t.out(osc('◐ 로그인 수정'))
    expect(t.pane()).toMatchObject({ agent: 'claude', activity: 'working', label: '로그인 수정', issueId: ISSUE })
    expect(t.tauri.notify).not.toHaveBeenCalled()
    t.out(osc('✳ 로그인 수정'))
    expect(statusOf(t.pane())).toBe('done')
    expect(t.tauri.notify).toHaveBeenCalledWith('Claude Code — 끝남', 'app #1 로그인')
    // 그 터미널을 보면 "대기 중"으로
    useUiStore.setState({ selectedIssueId: ISSUE, tab: 'terminal' })
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    await t.tick(1000)
    expect(statusOf(t.pane())).toBe('idle')
    expect(t.tauri.notify).toHaveBeenCalledTimes(1)
  })

  it('알림을 꺼 두면 띄우지 않는다 · 다른 터미널의 출력은 섞이지 않는다', async () => {
    const t = setup({ notify: false })
    await t.tick(0)
    t.out(osc('◐ x'))
    t.out(osc('✳ x'))
    expect(statusOf(t.pane())).toBe('done')
    expect(t.tauri.notify).not.toHaveBeenCalled()
    t.out(osc('◐ other'), 'pty-unknown')
    expect(t.pane().activity).toBe('idle')
  })

  it('프로세스 이름으로 Codex 를 알아보고, 출력 흐름으로 작업 중·끝남을 추정한다 — 입력의 에코는 세지 않는다', async () => {
    const t = setup({ processes: ['node.exe', 'codex.exe'] })
    await t.tick(1000)
    expect(t.tauri.ptyProcesses).toHaveBeenCalledWith('pty-1')
    expect(t.pane()).toMatchObject({ agent: 'codex', activity: 'idle', unseen: false })
    // 사용자가 친 글자가 되돌아 나오는 것
    noteTerminalInput(PANE)
    t.out('h')
    await t.tick(1000)
    expect(t.pane().activity).toBe('idle')
    // 에이전트의 출력
    await t.tick(ECHO_MS)
    t.out('Thinking…')
    await t.tick(1000)
    expect(t.pane().activity).toBe('working')
    await t.tick(QUIET_MS + 1000)
    expect(statusOf(t.pane())).toBe('done')
    expect(t.tauri.notify).toHaveBeenCalledWith('Codex — 끝남', 'app #1 로그인')
  })

  it('기타 프로그램은 현황에는 나오지만 알림은 띄우지 않는다 · 셸만 남으면 사라진다', async () => {
    let procs = ['node.exe']
    const t = setup()
    t.tauri.ptyProcesses.mockImplementation(async () => procs)
    await t.tick(1000)
    t.out('building')
    await t.tick(1000)
    expect(t.pane()).toMatchObject({ agent: 'other', program: 'node', activity: 'working' })
    await t.tick(QUIET_MS + 1000)
    expect(statusOf(t.pane())).toBe('done')
    expect(t.tauri.notify).not.toHaveBeenCalled()
    procs = ['conhost.exe']
    await t.tick(4000)
    expect(t.pane()).toBeUndefined()
  })

  it('원격(ssh) 터미널은 프로세스를 묻지 않고 tmux 제목으로 판단한다 · 패널이 닫히면 현황에서 뺀다', async () => {
    const remote = 'ssh:srv|acme/app#1::1'
    const t = setup()
    useUiStore.setState({ terminalIds: { [remote]: 'pty-1' } })
    await t.tick(3000)
    expect(t.tauri.ptyProcesses).not.toHaveBeenCalledWith('pty-1')
    t.out(osc('minmo:codex:work'))
    await t.tick(1000)
    expect(useAgentStore.getState().panes[remote]).toMatchObject({ agent: 'codex', issueId: 'ssh:srv|acme/app#1' })
    t.out(osc('minmo:bash:work'))
    expect(useAgentStore.getState().panes[remote]).toBeUndefined()
    t.out(osc('minmo:claude:◐ x'))
    expect(useAgentStore.getState().panes[remote]).toMatchObject({ agent: 'claude', activity: 'working' })
    useUiStore.setState({ terminalIds: {} })
    await t.tick(1000)
    expect(useAgentStore.getState().panes).toEqual({})
  })
})

describe('표시', () => {
  const pane = (id: string, issueId: string, o: Partial<PaneAgent> = {}): PaneAgent => ({ paneId: id, issueId, agent: 'claude', program: 'claude', label: '', activity: 'idle', unseen: false, lastOutputAt: 0, since: Date.now() - 65_000, ...o })

  beforeEach(() => {
    localStorage.clear()
    useAgentStore.getState().clear()
    useUiStore.setState({ agentsView: DEFAULT_AGENTS_VIEW, selectedIssueId: null, tab: 'notes', panes: {} })
    useSetupStore.setState({
      targets: {
        'acme/app#1': { owner: 'acme', repo: 'app', key: '1', number: 1, title: 'Login' },
        'acme/app#2': { owner: 'acme', repo: 'app', key: '2', number: 2, title: 'Docs' },
        'ssh:srv|zeta/lib#etc': { owner: 'zeta', repo: 'lib', key: 'etc', number: null, title: '' },
      },
    })
    for (const p of [
      pane('acme/app#1::1', 'acme/app#1', { activity: 'working', label: '로그인 수정' }),
      pane('acme/app#2::1', 'acme/app#2', { agent: 'codex', program: 'codex', unseen: true }),
      pane('ssh:srv|zeta/lib#etc::1', 'ssh:srv|zeta/lib#etc', { agent: 'gemini', program: 'gemini', activity: 'attention' }),
      pane('acme/app#1::2', 'acme/app#1', { agent: 'other', program: 'npm' }),
    ]) {
      useAgentStore.getState().set(p.paneId, p)
    }
  })

  it('이슈 행의 점: 상태를 이름으로도 읽힌다, 에이전트가 없으면 아무것도 없다', () => {
    const { container } = renderWithDeps(
      <>
        <IssueAgentDot issueId="acme/app#1" />
        <IssueAgentDot issueId="acme/app#2" />
        <IssueAgentDot issueId="acme/app#9" />
      </>,
      makeDeps(),
    )
    expect(screen.getByRole('img', { name: '에이전트 작업 중' })).toHaveAttribute('data-status', 'working')
    expect(screen.getByRole('img', { name: '에이전트 끝남' })).toBeInTheDocument()
    expect(container.querySelectorAll('[data-testid="issue-agent"]')).toHaveLength(2)
  })

  it('패널 머리: 에이전트 이름과 상태(기타 프로그램은 실행 파일 이름)', () => {
    renderWithDeps(
      <>
        <PaneAgentChip paneId="acme/app#1::1" />
        <PaneAgentChip paneId="acme/app#1::2" />
        <PaneAgentChip paneId="none::1" />
      </>,
      makeDeps(),
    )
    const chips = screen.getAllByTestId('pane-agent')
    expect(chips.map((c) => c.textContent)).toEqual(['Claude Code · 작업 중', 'npm · 대기 중'])
  })

  it('상단 버튼: 작업 중·확인 필요 수를 알린다(기타 프로그램 제외)', () => {
    renderWithDeps(
      <TooltipProvider>
        <AgentsButton onClick={() => {}} />
      </TooltipProvider>,
      makeDeps(),
    )
    expect(screen.getByRole('button', { name: '에이전트 현황 — 작업 중 1 · 확인 필요 2' })).toHaveTextContent('2')
  })

  it('전체 현황: 기본은 급한 순 — 필터·정렬·묶기를 바꾸면 목록이 바뀌고 옵션은 저장된다', async () => {
    vi.useRealTimers()
    const user = userEvent.setup()
    renderWithDeps(<AgentsOverview open onOpenChange={() => {}} />, makeDeps())
    const list = screen.getByTestId('agents-list')
    const texts = () => within(list).getAllByTestId('agent-row').map((r) => r.textContent ?? '')
    expect(texts().map((t) => t.slice(0, 5))).toEqual(['입력 대기', '끝남Cod', '작업 중C', '대기 중기'])
    expect(texts()[0]).toContain('zeta/lib 기타')
    expect(texts()[0]).toContain('srv')
    expect(texts()[2]).toContain('acme/app #1 Login — 로그인 수정')
    expect(texts()[2]).toContain('1분')

    // 필터: 상태
    await user.click(within(screen.getByRole('group', { name: '상태' })).getByRole('button', { name: '작업 중' }))
    expect(texts()).toHaveLength(1)
    expect(screen.getByRole('status')).toHaveTextContent('1개 표시 (전체 4개)')
    await user.click(screen.getByRole('button', { name: '필터 지우기' }))
    // 필터: 에이전트 + 검색
    await user.click(within(screen.getByRole('group', { name: '에이전트' })).getByRole('button', { name: '기타' }))
    expect(texts()).toHaveLength(1)
    await user.click(within(screen.getByRole('group', { name: '에이전트' })).getByRole('button', { name: '기타' }))
    await user.type(screen.getByRole('textbox', { name: '검색' }), 'docs')
    expect(texts()).toHaveLength(1)
    await user.clear(screen.getByRole('textbox', { name: '검색' }))

    // 정렬·묶기
    await user.selectOptions(screen.getByLabelText('정렬'), 'name')
    expect(texts().map((t) => /#\d|기타$|lib 기타/.exec(t)?.[0])).toEqual(['#1', '#1', '#2', 'lib 기타'])
    await user.selectOptions(screen.getByLabelText('묶기'), 'repo')
    expect(within(list).getAllByTestId('agents-group').map((g) => g.textContent)).toEqual(['acme/app (3)', 'zeta/lib (1)'])
    expect(useUiStore.getState().agentsView).toMatchObject({ sort: 'name', group: 'repo', statuses: [], agents: [], query: '' })
    expect(JSON.parse(localStorage.getItem('minmo-ui') ?? '{}').state.agentsView).toMatchObject({ sort: 'name', group: 'repo' })
  })

  it('줄을 누르면 그 이슈의 터미널(그 패널)로 가고 현황을 닫는다 · 에이전트가 없으면 안내', async () => {
    vi.useRealTimers()
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    useUiStore.getState().ensurePanes('acme/app#2')
    const { unmount } = renderWithDeps(<AgentsOverview open onOpenChange={onOpenChange} />, makeDeps())
    await user.click(within(screen.getByTestId('agents-list')).getAllByTestId('agent-row')[1])
    expect(useUiStore.getState()).toMatchObject({ selectedIssueId: 'acme/app#2', tab: 'terminal' })
    expect(useUiStore.getState().panes['acme/app#2'].focused).toBe('acme/app#2::1')
    expect(onOpenChange).toHaveBeenCalledWith(false)
    unmount()

    useAgentStore.getState().clear()
    renderWithDeps(<AgentsOverview open onOpenChange={() => {}} />, makeDeps())
    expect(screen.getByRole('status')).toHaveTextContent('터미널에서 도는 에이전트가 없습니다')
  })
})
