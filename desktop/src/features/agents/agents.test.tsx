// 에이전트 현황 — 출력 해석, 종류·상태 판별, 상태 전이, 추적기, 표시(이슈 행·패널·전체 현황의 필터·정렬·그루핑), 알림
import { act, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PtyDataEvent } from '../../lib/tauri'
import { useHostsStore } from '../../store/hosts'
import { useSetupStore } from '../../store/setup'
import { DEFAULT_AGENTS_VIEW, useUiStore } from '../../store/ui'
import { createFakeTauri } from '../../test/fakes'
import { makeDeps, renderHookWithDeps, renderWithDeps } from '../../test/render'
import { TooltipProvider } from '../../components/ui/tooltip'
import { IssueAgentDot, PaneAgentStrip } from './AgentBadge'
import { AgentsButton, AgentsOverview } from './AgentsOverview'
import { QUIET_MS, derive, issueStatus, statusOf, useAgentStore } from './agentStore'
import type { PaneAgent, PaneSignals } from './agentStore'
import { guessProgram, parseTitle, titleSignal } from './detect'
import { ago, filterRows, groupRows, sortRows, toRows } from './overview'
import type { AgentRow } from './overview'
import { PtyStreamParser } from './ptyStream'
import { REMOTE_SUBAGENTS_SCRIPT, SUBAGENT_STALE_MS, claudeProjectSlug, parseRemoteSubagents, parseSubagentFiles, runningCount } from './subagents'
import type { Subagent } from './subagents'
import { DONE_BELL_MS, ECHO_MS, noteTerminalInput, useAgentTracker } from './useAgentTracker'

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

  it('아주 긴 제어 문자열(클립보드·이미지 데이터)은 끝날 때까지 건너뛴다 — 그 안의 글자·종결 BEL 을 출력·벨로 세지 않는다', () => {
    const p = new PtyStreamParser()
    expect(p.feed(`\x1b]52;c;${'A'.repeat(5000)}`)).toEqual({ titles: [], bells: 0, visible: false })
    expect(p.feed('B'.repeat(3000))).toEqual({ titles: [], bells: 0, visible: false })
    // 종결자(BEL) 뒤부터 다시 정상으로 읽는다
    expect(p.feed(`CCC\x07${osc('new')}ok`)).toEqual({ titles: ['new'], bells: 0, visible: true })
    // ESC \\ 로 끝나는 경우 — 종결자가 조각 사이에서 끊겨도 된다
    const q = new PtyStreamParser()
    q.feed(`\x1bP${'x'.repeat(5000)}`)
    expect(q.feed('yyy\x1b')).toEqual({ titles: [], bells: 0, visible: false })
    expect(q.feed('\\after')).toEqual({ titles: [], bells: 0, visible: true })
  })

  it('깨진 제어열: 끝나지 않은 OSC 는 제목으로 쓰지 않고, CSI 는 깨진 자리에서 끊으며, ESC ( B 의 B 는 글자가 아니다', () => {
    expect(new PtyStreamParser().feed('\x1b]0;half\x1b[0m').titles).toEqual([])
    expect(new PtyStreamParser().feed('\x1b[12\nhello').visible).toBe(true)
    expect(new PtyStreamParser().feed('\x1b(B\x1b)0').visible).toBe(false)
    // DEL·C1 제어 문자는 보이는 글자가 아니다
    expect(new PtyStreamParser().feed('\x7f\x85\x9b').visible).toBe(false)
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
    // 순서가 달라도 같은 이름을 고른다
    expect(guessProgram(['vite.exe', 'esbuild.exe'])).toEqual(guessProgram(['esbuild.exe', 'vite.exe']))
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
    // 보고 있는 터미널에서 일어난 일은 알리지 않는다
    expect(step(sig({ title: titleSignal('✋  Action Required') }), null, 1000, true)).toMatchObject({ next: { activity: 'attention' }, event: null })
  })

  it('이 PC: 셸만 남았으면 끝난 프로그램이 남긴 제목으로 에이전트를 살려 두지 않는다(프로세스를 아직 모르면 제목을 믿는다)', () => {
    expect(step(sig({ title: titleSignal('✳ x'), processes: ['conhost.exe'] }), null, 1000).next).toBeNull()
    expect(step(sig({ title: titleSignal('✳ x'), processes: [] }), null, 1000).next).toBeNull()
    expect(step(sig({ title: titleSignal('✳ x'), processes: null }), null, 1000).next).toMatchObject({ agent: 'claude' })
    expect(step(sig({ title: titleSignal('✳ x'), processes: ['node.exe'] }), null, 1000).next).toMatchObject({ agent: 'claude' })
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
  const row = (o: Partial<AgentRow>): AgentRow => ({ paneId: 'p', issueId: 'i', host: null, hostLabel: '이 PC', repo: 'acme/app', issue: '#1 A', agent: 'claude', agentLabel: 'Claude Code', label: '', status: 'idle', since: 0, lastOutputAt: 0, subagents: [], running: 0, ...o })
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

  it('하위 에이전트: 실행 중인 것만 필터 · 많은 순 정렬 · 하위 에이전트의 종류·설명으로도 검색', () => {
    const sub = (id: string, finished: boolean, description = ''): Subagent => ({ id, type: 'Explore', description, finished, updatedAt: 0 })
    const withSubs = [
      row({ paneId: 'a', issue: '#1 A', subagents: [sub('1', false, '로그인 코드 찾기'), sub('2', true)], running: 1 }),
      row({ paneId: 'b', issue: '#2 B', subagents: [sub('3', false), sub('4', false)], running: 2 }),
      row({ paneId: 'c', issue: '#3 C', subagents: [sub('5', true)], running: 0 }),
      row({ paneId: 'd', issue: '#4 D' }),
    ]
    expect(ids(filterRows(withSubs, { statuses: [], agents: [], query: '', subagentsOnly: true }))).toEqual(['a', 'b'])
    expect(ids(sortRows(withSubs, 'subagents'))).toEqual(['b', 'a', 'c', 'd'])
    expect(ids(filterRows(withSubs, { statuses: [], agents: [], query: '로그인 코드' }))).toEqual(['a'])
    expect(ids(filterRows(withSubs, { statuses: [], agents: [], query: 'explore' }))).toEqual(['a', 'b', 'c'])
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

describe('하위 에이전트(Claude Code 세션 기록)', () => {
  const meta = (o: Record<string, unknown>) => JSON.stringify({ agentType: 'general-purpose', isBuiltIn: true, description: '리뷰', toolUseId: 't', finished: false, ...o })

  it('claudeProjectSlug: 영문·숫자가 아닌 글자를 - 로(끝의 구분자는 뗀다)', () => {
    expect(claudeProjectSlug('C:\\workspace\\minmo-cli')).toBe('C--workspace-minmo-cli')
    expect(claudeProjectSlug('/home/u/minmo-workspaces/_local/app/issue--1-a/')).toBe('-home-u-minmo-workspaces--local-app-issue--1-a')
  })

  it('parseSubagentFiles: 종류·설명·끝났는지를 읽고 실행 중인 것 먼저(그 안에서는 최근 활동순), 깨진 파일은 건너뛴다', () => {
    const subs = parseSubagentFiles(
      [
      { id: 'agent-done', meta: meta({ finished: true, description: '끝난 일' }), updatedMs: 900 },
      { id: 'agent-old', meta: meta({ agentType: 'Explore', description: '오래된 탐색' }), updatedMs: 100 },
      { id: 'agent-new', meta: meta({ description: '새 리뷰' }), updatedMs: 500 },
      { id: 'agent-broken', meta: '{not json', updatedMs: 1 },
      { id: 'agent-array', meta: '[]', updatedMs: 1 },
      { id: 'agent-bare', meta: '{}', updatedMs: 50 },
      ],
      1000,
    )
    expect(subs.map((x) => [x.id, x.type, x.finished])).toEqual([
      ['agent-new', 'general-purpose', false],
      ['agent-old', 'Explore', false],
      ['agent-bare', 'agent', false],
      ['agent-array', 'agent', false],
      ['agent-done', 'general-purpose', true],
    ])
    expect(subs[0]).toEqual({ id: 'agent-new', type: 'general-purpose', description: '새 리뷰', finished: false, updatedAt: 500 })
    expect(runningCount(subs)).toBe(4)
    expect(runningCount(undefined)).toBe(0)
  })

  it('끝남 판정: 실행 중인 메타에는 finished 가 없다 — finished:true · 사용자가 멈춤 · 30분 넘게 조용하면 끝난 것', () => {
    const now = 10 * SUBAGENT_STALE_MS
    const f = (id: string, o: Record<string, unknown>, updatedMs: number) => ({ id, meta: JSON.stringify({ agentType: 'Explore', description: id, ...o }), updatedMs })
    const subs = parseSubagentFiles(
      [f('agent-running', {}, now - 5000), f('agent-finished', { finished: true }, now - 5000), f('agent-stopped', { stoppedByUser: true }, now - 5000), f('agent-edge', {}, now - SUBAGENT_STALE_MS), f('agent-stale', {}, now - SUBAGENT_STALE_MS - 1)],
      now,
    )
    expect(Object.fromEntries(subs.map((x) => [x.id, x.finished]))).toEqual({ 'agent-running': false, 'agent-edge': false, 'agent-finished': true, 'agent-stopped': true, 'agent-stale': true })
    expect(runningCount(subs)).toBe(2)
  })

  it('parseRemoteSubagents: 원격 스크립트의 출력(탭 구분, 시각은 초) → 메타 파일 목록', () => {
    const out = ['agent-a1\t1700000000\t1700000050\t' + meta({ description: '탭\t포함' }), 'agent-b2\t1700000100\t0\t{}', 'garbage line', 'other-x\t1\t1\t{}', ''].join('\n')
    const files = parseRemoteSubagents(out)
    expect(files.map((x) => [x.id, x.updatedMs])).toEqual([
      ['agent-a1', 1700000050000],
      ['agent-b2', 1700000100000],
    ])
    expect(parseSubagentFiles(files)[1]).toMatchObject({ id: 'agent-a1', description: '탭\t포함' })
    // 스크립트는 작업 폴더의 slug 를 인자로 받고, 설정 폴더는 CLAUDE_CONFIG_DIR 을 따른다
    expect(REMOTE_SUBAGENTS_SCRIPT).toContain('${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects')
    expect(REMOTE_SUBAGENTS_SCRIPT).toContain('[ "$n" = "$1" ]')
    // 정확한 이름의 폴더가 먼저, 이전 실행의 세션은 시각으로 거른다
    expect(REMOTE_SUBAGENTS_SCRIPT).toContain('if [ -d "$d/$1" ]')
    expect(REMOTE_SUBAGENTS_SCRIPT).toContain('-ge "${2:-0}"')
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
    useUiStore.setState({ terminalIds: { [PANE]: 'pty-1' }, selectedIssueId: null, tab: 'terminal', agentNotify: o.notify ?? true, worktreePathMap: {} })
    useHostsStore.setState({ probes: {} })
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
    const t = setup({ processes: ['claude.exe'] })
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
    const t = setup({ notify: false, processes: ['claude.exe'] })
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

  it('에이전트가 끝나 셸만 남으면 제목이 남아 있어도 현황에서 뺀다', async () => {
    let procs = ['claude.exe']
    const t = setup()
    t.tauri.ptyProcesses.mockImplementation(async () => procs)
    await t.tick(1000)
    t.out(osc('✳ 세션'))
    expect(t.pane()).toMatchObject({ agent: 'claude' })
    procs = ['conhost.exe']
    await t.tick(3000)
    expect(t.pane()).toBeUndefined()
    // 그 뒤에 다른 프로그램을 띄워도 옛 제목 때문에 Claude 로 보이지 않는다
    procs = ['node.exe']
    await t.tick(3000)
    expect(t.pane()).toMatchObject({ agent: 'other', program: 'node' })
  })

  it('벨: 대기 중에 울리면 입력 대기 + 알림, 작업 중·끝난 직후의 벨은 입력 대기가 아니다, 보고 있으면 알리지 않는다', async () => {
    const t = setup({ processes: ['claude.exe'] })
    await t.tick(1000)
    t.out(osc('◐ x'))
    t.out('\x07')
    expect(t.pane().activity).toBe('working')
    t.out(osc('✳ x'))
    t.out('\x07') // 끝났다는 알림음
    expect(statusOf(t.pane())).toBe('done')
    expect(t.tauri.notify).toHaveBeenCalledTimes(1)
    await t.tick(DONE_BELL_MS + 500)
    t.out('\x07') // 한참 뒤의 벨 = 확인 요청
    expect(statusOf(t.pane())).toBe('attention')
    expect(t.tauri.notify).toHaveBeenLastCalledWith('Claude Code — 입력 대기', 'app #1 로그인')
    // 다시 작업을 시작하면 벨은 지난 일 — 끝나면 "끝남"
    t.out(osc('◐ x'))
    t.out(osc('✳ x'))
    expect(statusOf(t.pane())).toBe('done')

    // 보고 있는 터미널: 상태는 바뀌어도 알림은 없다
    useUiStore.setState({ selectedIssueId: ISSUE, tab: 'terminal' })
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    const before = t.tauri.notify.mock.calls.length
    t.out(osc('◐ x'))
    t.out(osc('✳ x'))
    expect(statusOf(t.pane())).toBe('idle')
    expect(t.tauri.notify).toHaveBeenCalledTimes(before)
    vi.restoreAllMocks()
  })

  it('같은 패널에 터미널이 새로 만들어지면(다시 시작) 이전 터미널의 제목·벨을 이어받지 않는다', async () => {
    const t = setup({ processes: ['claude.exe'] })
    await t.tick(1000)
    t.out(osc('◐ 이전'))
    expect(t.pane().activity).toBe('working')
    useUiStore.setState({ terminalIds: { [PANE]: 'pty-2' } })
    await t.tick(1000)
    expect(t.pane()).toMatchObject({ agent: 'claude', label: '', activity: 'idle' })
  })

  it('Claude Code 가 떠 있는 패널은 그 작업 폴더의 하위 에이전트를 주기적으로 읽는다 — 끝나면 목록도 지운다', async () => {
    let procs = ['claude.exe']
    const files = [{ id: 'agent-a1', meta: JSON.stringify({ agentType: 'Explore', description: '코드 찾기' }), updatedMs: Date.parse('2026-11-12T00:00:00Z') }]
    const t = setup()
    t.tauri.ptyProcesses.mockImplementation(async () => procs)
    t.tauri.claudeSubagents.mockImplementation(async () => files)
    useUiStore.setState({ worktreePathMap: { [ISSUE]: { path: '/w/app/issue-1', branch: 'issue/1' } } })
    await t.tick(1000)
    t.out(osc('◐ 작업'))
    await t.tick(1000)
    // 에이전트가 뜬 시각(여유 1분) 이후의 세션만 본다
    const since = t.tauri.claudeSubagents.mock.calls[0][1]
    expect(t.tauri.claudeSubagents).toHaveBeenCalledWith('/w/app/issue-1', since)
    expect(Date.now() - since).toBeGreaterThanOrEqual(60_000)
    expect(Date.now() - since).toBeLessThan(70_000)
    expect(useAgentStore.getState().subagents[PANE]).toEqual([{ id: 'agent-a1', type: 'Explore', description: '코드 찾기', finished: false, updatedAt: Date.parse('2026-11-12T00:00:00Z') }])
    // 5초마다 다시 읽는다
    const calls = t.tauri.claudeSubagents.mock.calls.length
    await t.tick(4000)
    expect(t.tauri.claudeSubagents.mock.calls.length).toBe(calls)
    await t.tick(1000)
    expect(t.tauri.claudeSubagents.mock.calls.length).toBe(calls + 1)
    // Claude 가 끝나면(셸만 남음) 하위 에이전트 목록도 사라진다
    procs = ['conhost.exe']
    await t.tick(4000)
    expect(t.pane()).toBeUndefined()
    expect(useAgentStore.getState().subagents[PANE]).toBeUndefined()
  })

  it('같은 작업 폴더의 Claude 가 두 패널에 있으면 앞 패널에만 보인다 · 원격인데 연결 정보가 없으면 이 PC 의 파일을 읽지 않는다', async () => {
    const files = [{ id: 'agent-a1', meta: '{}', updatedMs: Date.parse('2026-11-12T00:00:00Z') }]
    const t = setup({ processes: ['claude.exe'] })
    t.tauri.claudeSubagents.mockImplementation(async () => files)
    const second = `${ISSUE}::2`
    useUiStore.setState({ terminalIds: { [PANE]: 'pty-1', [second]: 'pty-2' }, worktreePathMap: { [ISSUE]: { path: '/w/app/issue-1', branch: 'b' } } })
    await t.tick(8000)
    expect(useAgentStore.getState().panes[second]).toMatchObject({ agent: 'claude' })
    expect(useAgentStore.getState().subagents[PANE]).toHaveLength(1)
    expect(useAgentStore.getState().subagents[second]).toBeUndefined()
    t.unmount()

    const remote = 'ssh:srv|acme/app#1::1'
    const u = setup()
    u.tauri.claudeSubagents.mockImplementation(async () => files)
    useUiStore.setState({ terminalIds: { [remote]: 'pty-1' }, worktreePathMap: { 'ssh:srv|acme/app#1': { path: '/w/app/issue-1', branch: 'b' } } })
    await u.tick(1000)
    u.out(osc('minmo:claude:◐ x'))
    await u.tick(8000)
    expect(useAgentStore.getState().panes[remote]).toMatchObject({ agent: 'claude' })
    expect(u.tauri.claudeSubagents).not.toHaveBeenCalled()
  })

  it('Codex 처럼 Claude 가 아닌 에이전트는 하위 에이전트를 읽지 않는다 · 작업 폴더를 모르면 읽지 않는다', async () => {
    const t = setup({ processes: ['codex.exe'] })
    useUiStore.setState({ worktreePathMap: { [ISSUE]: { path: '/w/app/issue-1', branch: 'b' } } })
    await t.tick(8000)
    expect(t.tauri.claudeSubagents).not.toHaveBeenCalled()
    t.unmount()

    const u = setup({ processes: ['claude.exe'] })
    useUiStore.setState({ worktreePathMap: {} })
    await u.tick(8000)
    expect(u.tauri.claudeSubagents).not.toHaveBeenCalled()
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

  it('패널 머리줄: 에이전트 이름·상태·세션 이름(기타 프로그램은 실행 파일 이름) — 에이전트가 없어도 줄은 있다(터미널 크기가 바뀌지 않게)', () => {
    renderWithDeps(
      <>
        <PaneAgentStrip paneId="acme/app#1::1" />
        <PaneAgentStrip paneId="acme/app#1::2" />
        <PaneAgentStrip paneId="none::1" />
      </>,
      makeDeps(),
    )
    expect(screen.getAllByTestId('pane-strip')).toHaveLength(3)
    const chips = screen.getAllByTestId('pane-agent')
    expect(chips.map((c) => c.textContent)).toEqual(['Claude Code · 작업 중 — 로그인 수정', 'npm · 대기 중'])
  })

  it('하위 에이전트: 패널 머리줄에 실행 중인 수, 전체 현황에는 에이전트 줄 아래에 목록(실행 중 먼저, 많으면 접는다)', async () => {
    vi.useRealTimers()
    const sub = (i: number, finished: boolean): Subagent => ({ id: `agent-${i}`, type: i === 1 ? 'Explore' : 'general-purpose', description: `일 ${i}`, finished, updatedAt: Date.now() - 125_000 })
    useAgentStore.getState().setSubagents('acme/app#1::1', [sub(1, false), sub(2, false), ...[3, 4, 5, 6, 7, 8].map((i) => sub(i, true))])
    renderWithDeps(<PaneAgentStrip paneId="acme/app#1::1" />, makeDeps())
    expect(screen.getByTestId('pane-subagents')).toHaveTextContent('하위 에이전트 2개 실행 중')

    const user = userEvent.setup()
    renderWithDeps(<AgentsOverview open onOpenChange={() => {}} />, makeDeps())
    const list = screen.getByTestId('subagents')
    const lines = within(list).getAllByTestId('subagent-row')
    expect(lines).toHaveLength(6)
    expect(lines[0]).toHaveTextContent('실행 중')
    expect(lines[0]).toHaveTextContent('Explore')
    expect(lines[0]).toHaveTextContent('일 1')
    expect(lines[0]).toHaveTextContent('2분')
    expect(lines[2]).toHaveAttribute('data-finished', 'true')
    expect(list).toHaveTextContent('외 2개')
    // 하위 에이전트가 실행 중인 것만
    await user.click(screen.getByRole('checkbox', { name: '하위 에이전트가 실행 중인 것만' }))
    expect(within(screen.getByTestId('agents-list')).getAllByTestId('agent-row')).toHaveLength(1)
    expect(useUiStore.getState().agentsView.subagentsOnly).toBe(true)
    await user.click(screen.getByRole('button', { name: '필터 지우기' }))
    expect(within(screen.getByTestId('agents-list')).getAllByTestId('agent-row')).toHaveLength(4)
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
