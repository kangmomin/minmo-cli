// 이슈 테이커 엔진 — 새 이슈 확인(check), 실행 전이(tick T1~T11), 버튼(stop·restart·nextStep), 다시 켬(start)·정리(dispose)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { GitHubError, worktreeId } from '@minmo/core'
import type { GitHubClient, GitHubIssueDetail, IssueTarget, RecentIssue } from '@minmo/core'

import { hostOf } from '../../app/host'
import { queryKeys } from '../../lib/queryKeys'
import type { PtyLinkEvent, PtyLinkPhase, SshProbe, TauriApi } from '../../lib/tauri'
import { useHostsStore } from '../../store/hosts'
import { useSessionStore } from '../../store/session'
import { useSetupStore } from '../../store/setup'
import { useUiStore } from '../../store/ui'
import { createFakeGitHub, createFakeTauri, deferred, flush } from '../../test/fakes'
import { makeQueryClient } from '../../test/render'
import { useAgentStore } from '../agents/agentStore'
import type { PaneAgent } from '../agents/agentStore'
import type { Activity } from '../agents/detect'
import { LAUNCH_TTL_MS, dropLaunch, isLaunchCancelled, launchResult, markLaunched, queueLaunch, resetLaunchQueue, takeLaunch } from '../agents/launchQueue'
import type { IssueActions } from '../issue/useWorktree'
import { leaf } from '../terminal/panes'
import { createTakerEngine } from './engine'
import { TAKER_STORAGE_KEY, useTakerStore } from './takerStore'
import type { TakerRepoConfig, TakerRun, TakerStep } from './takerStore'

const OWNER = 'acme'
const REPO = 'app'
const KEY = 'acme/app'
const WEB = 'acme/web'
const ID = worktreeId(OWNER, REPO, '11')
const RID = hostOf('srv').issueId(OWNER, REPO, '11')

const STEPS: TakerStep[] = [
  { kind: 'claude', command: 'claude {prompt}', prompt: '/ready {number}' },
  { kind: 'claude', command: 'claude --continue {prompt}', prompt: '/impl {number}' },
]
const CMD1 = "claude '/ready 11'"
const CMD2 = "claude --continue '/impl 11'"

const cfg = (o: Partial<TakerRepoConfig> = {}): TakerRepoConfig => ({ enabled: true, author: 'me', catchUp: false, steps: STEPS, baseline: 10, ...o })

const runOf = (n: number, o: Partial<TakerRun> = {}): TakerRun => ({
  id: `r${n}`,
  repoKey: KEY,
  owner: OWNER,
  repo: REPO,
  number: n,
  title: `Issue ${n}`,
  url: `https://github.com/acme/app/issues/${n}`,
  issueId: null,
  steps: STEPS,
  step: 0,
  status: 'queued',
  paneId: null,
  assigned: false,
  note: null,
  error: null,
  foundAt: n,
  updatedAt: 0,
  ...o,
})

const issue = (n: number, o: Partial<RecentIssue> = {}): RecentIssue => ({
  number: n,
  title: `Issue ${n}`,
  state: 'open',
  htmlUrl: `https://github.com/acme/app/issues/${n}`,
  assignees: [],
  author: 'me',
  authorAssociation: 'OWNER',
  ...o,
})

const detail = (n: number, o: Partial<GitHubIssueDetail> = {}): GitHubIssueDetail => ({ number: n, title: `Issue ${n}`, state: 'open', htmlUrl: '', assignees: [], body: '', ...o })

const PROBE = (tmux: boolean): SshProbe => ({ platform: 'linux', home: '/home/r', git: 'git version 2.43.0', tmux })

/** 저장소를 원격 호스트 srv 에 연결한다 */
function remote(tmux: boolean, probed = true) {
  useHostsStore.setState({ aliases: ['srv'], repoHosts: { [KEY]: 'ssh:srv' }, useTmux: true, probes: probed ? { srv: PROBE(tmux) } : {} })
}

function seed(runs: TakerRun[], repos: Record<string, TakerRepoConfig> = { [KEY]: cfg() }) {
  useTakerStore.setState({ repos, runs, taken: {} })
}

const run = (id = 'r11') => {
  const r = useTakerStore.getState().runs.find((x) => x.id === id)
  if (!r) throw new Error(`no run ${id}`)
  return r
}
const reason = (r: TakerRun) => `${r.note ?? ''} ${r.error ?? ''}`

type OpenImpl = (alias: string | null, t: IssueTarget, opts?: { select?: boolean }) => Promise<void>

/** 실제 open 처럼 worktree 기록·열기 상태를 남긴다 */
function markReady(alias: string | null, t: IssueTarget): string {
  const id = hostOf(alias).issueId(t.owner, t.repo, t.key)
  const path = `/w/${t.key}`
  useSetupStore.getState().setTarget(id, t)
  useUiStore.getState().setWorktree(id, { path, branch: `issue/${t.key}` })
  useSetupStore.getState().setOpen(id, { phase: 'ready', path, branch: `issue/${t.key}`, pathChanged: false })
  return id
}
const readyOpen: OpenImpl = async (alias, t) => {
  markReady(alias, t)
}
const never = () => new Promise<never>(() => {})

let clock = 1_000_000

function harness(o: { github?: Partial<GitHubClient>; tauri?: Partial<TauriApi>; open?: OpenImpl } = {}) {
  const exits = new Set<(id: string) => void>()
  const links = new Set<(e: PtyLinkEvent) => void>()
  const unlistenExit = vi.fn()
  const unlistenLink = vi.fn()
  const { tauri } = createFakeTauri({
    onPtyExit: async (cb) => {
      exits.add(cb)
      return () => {
        exits.delete(cb)
        unlistenExit()
      }
    },
    onPtyLink: async (cb) => {
      links.add(cb)
      return () => {
        links.delete(cb)
        unlistenLink()
      }
    },
    ...o.tauri,
  })
  const github = createFakeGitHub(o.github)
  const open = vi.fn<OpenImpl>(o.open ?? readyOpen)
  const actionsFor = vi.fn((alias: string | null): Pick<IssueActions, 'open'> => ({ open: (t: IssueTarget, opts?: { select?: boolean }) => open(alias, t, opts) }))
  const queryClient = makeQueryClient()
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
  const engine = createTakerEngine({ github, tauri, actionsFor, queryClient, getPlatform: () => 'linux', now: () => clock })
  const tick = async (ms = 1000) => {
    clock += ms
    await engine.tick(clock)
    await flush()
  }
  const until = async (pred: () => boolean, max = 30) => {
    for (let i = 0; i < max && !pred(); i++) await tick()
    expect(pred(), 'until').toBe(true)
  }
  const start = async () => {
    engine.start(clock)
    await flush()
  }
  const check = async () => {
    await engine.check(clock)
    await flush()
  }
  const emitExit = (id: string) => {
    for (const l of [...exits]) l(id)
  }
  const emitLink = (id: string, phase: PtyLinkPhase, seq: number) => {
    for (const l of [...links]) l({ id, phase, attempt: 1, max: 5, seq, reason: null, at: null })
  }
  const writes = () => tauri.ptyWrite.mock.calls.map((c) => c[1])
  const notified = () => tauri.notify.mock.calls.map((c) => `${c[0]} ${c[1]}`)
  return { engine, tauri, github, open, actionsFor, invalidate, tick, until, start, check, emitExit, emitLink, writes, notified, unlistenExit, unlistenLink }
}
type Harness = ReturnType<typeof harness>

/** launchPane 호출을 기록한다(실제 동작은 그대로) */
function spyLaunchPane() {
  const launchPane = vi.fn(useUiStore.getState().launchPane)
  useUiStore.setState({ launchPane })
  return launchPane
}

/** 터미널이 떠 terminalIds 에 오른 것처럼 */
function ptyUp(paneId: string, ptyId = 'pty-1') {
  useUiStore.setState((s) => ({ terminalIds: { ...s.terminalIds, [paneId]: ptyId } }))
}
/** 추적기가 "셸만 있음(출력·입력 없음)" 을 at 부터로 본 것처럼 */
function shellAt(paneId: string, at = clock) {
  useAgentStore.setState((s) => ({ shellSince: { ...s.shellSince, [paneId]: at } }))
}
function agentOn(paneId: string, activity: Activity = 'working') {
  const agent: PaneAgent = { paneId, issueId: paneId.slice(0, paneId.lastIndexOf('::')), agent: 'claude', program: 'claude', label: '', activity, unseen: false, lastOutputAt: clock, since: clock }
  useAgentStore.setState((s) => {
    const shellSince = { ...s.shellSince }
    delete shellSince[paneId]
    return { panes: { ...s.panes, [paneId]: agent }, shellSince }
  })
}
function agentOff(paneId: string, at = clock) {
  useAgentStore.setState((s) => {
    const panes = { ...s.panes }
    delete panes[paneId]
    return { panes, shellSince: { ...s.shellSince, [paneId]: at } }
  })
}
function deleteWorktree(issueId: string) {
  useUiStore.getState().removeWorktree(issueId)
  useSetupStore.setState((s) => {
    const open = { ...s.open }
    delete open[issueId]
    return { open }
  })
}

async function toPane(h: Harness, id = 'r11'): Promise<string> {
  await h.until(() => run(id).paneId !== null)
  return run(id).paneId!
}
/** 이 PC·tmux 원격: 패널 마련 → 터미널 뜸 → 셸 확인 → 1단계 명령 */
async function toRunning(h: Harness, id = 'r11', ptyId = 'pty-1'): Promise<string> {
  const p = await toPane(h, id)
  ptyUp(p, ptyId)
  shellAt(p)
  const before = h.writes().length
  await h.until(() => h.writes().length > before)
  return p
}
/** 단계의 프로그램이 보였다가 끝나 셸만 남는다 */
async function stepEnds(h: Harness, p: string, activity: Activity = 'working') {
  agentOn(p, activity)
  await h.tick()
  agentOff(p)
}

beforeEach(() => {
  clock = 1_000_000
  localStorage.removeItem(TAKER_STORAGE_KEY)
  localStorage.clear()
  useTakerStore.setState({ repos: {}, taken: {}, runs: [], lastCheck: {} })
  useUiStore.setState(useUiStore.getInitialState(), true)
  useSetupStore.setState({ targets: {}, open: {}, script: {}, logs: {} })
  useAgentStore.setState({ panes: {}, subagents: {}, shellSince: {} })
  useHostsStore.setState(useHostsStore.getInitialState(), true)
  useSessionStore.setState(useSessionStore.getInitialState(), true)
  useSessionStore.setState({ token: 'tok', me: { id: 'usr_x', githubLogin: 'me', avatarUrl: null } })
  resetLaunchQueue()
})
afterEach(() => {
  vi.useRealTimers()
  resetLaunchQueue()
  useTakerStore.setState({ repos: {}, taken: {}, runs: [], lastCheck: {} })
  localStorage.removeItem(TAKER_STORAGE_KEY)
})

describe('check — 새 이슈 확인', () => {
  it('AC-03 기준 번호가 없으면 latestNumber 로 기준 번호만 잡고 그 확인에서는 실행하지 않는다(로그인 없어도)', async () => {
    useSessionStore.setState({ me: null })
    seed([], { [KEY]: cfg({ baseline: null }) })
    const h = harness({ github: { latestNumber: async () => 20, listRecentIssues: async () => [issue(21)] } })
    await h.start()
    await h.check()
    expect(h.github.latestNumber).toHaveBeenCalledWith(OWNER, REPO)
    expect(h.github.listRecentIssues).not.toHaveBeenCalled()
    expect(useTakerStore.getState().repos[KEY].baseline).toBe(20)
    expect(useTakerStore.getState().runs).toEqual([])
  })

  it('AC-12 꺼진 동안 열린 이슈를 실행하지 않으면 앱 시작 뒤 첫 성공한 확인에서 기준 번호를 다시 잡는다', async () => {
    seed([], { [KEY]: cfg({ baseline: 10, catchUp: false }) })
    let calls = 0
    const h = harness({
      github: {
        latestNumber: async () => {
          if (++calls === 1) throw new GitHubError('network')
          return 30
        },
        listRecentIssues: async () => [issue(25)],
      },
    })
    await h.start()
    await h.check()
    await h.check()
    expect(h.github.latestNumber).toHaveBeenCalledTimes(2)
    expect(h.github.listRecentIssues).not.toHaveBeenCalled()
    expect(useTakerStore.getState().repos[KEY].baseline).toBe(30)
    expect(useTakerStore.getState().runs).toEqual([])
    await h.check()
    expect(h.github.listRecentIssues).toHaveBeenCalledTimes(1)
    expect(h.github.latestNumber).toHaveBeenCalledTimes(2)
  })

  it('AC-12 꺼진 동안 열린 이슈도 실행하면 앱 시작 뒤 첫 확인부터 그 이슈가 대상이 된다', async () => {
    seed([], { [KEY]: cfg({ baseline: 10, catchUp: true }) })
    const h = harness({ github: { listRecentIssues: async () => [issue(11)] } })
    await h.start()
    await h.check()
    expect(h.github.latestNumber).not.toHaveBeenCalled()
    expect(useTakerStore.getState().runs.map((r) => [r.number, r.status])).toEqual([[11, 'queued']])
  })

  it('EC-11 로그인 사용자를 모르면 목록 조회를 건너뛰고 마지막 확인에 오류를 남긴다', async () => {
    useSessionStore.setState({ me: null })
    seed([], { [KEY]: cfg({ baseline: 10, catchUp: true }) })
    const h = harness({ github: { listRecentIssues: async () => [issue(11)] } })
    await h.start()
    await h.check()
    expect(h.github.listRecentIssues).not.toHaveBeenCalled()
    expect(useTakerStore.getState().lastCheck[KEY]?.error).toEqual(expect.any(String))
    expect(useTakerStore.getState().runs).toEqual([])
  })

  it('EC-11 GitHub 조회가 실패하면 마지막 확인에 오류를 남기고 다음 확인에서 다시 조회한다', async () => {
    seed([], { [KEY]: cfg({ baseline: 10, catchUp: true }) })
    let calls = 0
    const h = harness({
      github: {
        listRecentIssues: async () => {
          if (++calls === 1) throw new GitHubError('rate_limited')
          return []
        },
      },
    })
    await h.start()
    await h.check()
    expect(useTakerStore.getState().lastCheck[KEY]).toEqual({ at: clock, error: expect.any(String) })
    clock += 300_000
    await h.check()
    expect(h.github.listRecentIssues).toHaveBeenCalledTimes(2)
    expect(useTakerStore.getState().lastCheck[KEY]).toEqual({ at: clock, error: null })
  })

  it.each<[TakerRepoConfig['author'], string | undefined]>([
    ['me', 'me'],
    ['writers', undefined],
    ['anyone', undefined],
  ])('AC-11 작성자 %s 로 확인하면 목록 조회의 creator 는 %s', async (author, creator) => {
    seed([], { [KEY]: cfg({ author, catchUp: true }) })
    const h = harness()
    await h.start()
    await h.check()
    expect(h.github.listRecentIssues).toHaveBeenCalledTimes(1)
    const [o, r, opts] = h.github.listRecentIssues.mock.calls[0]
    expect([o, r, opts?.creator]).toEqual([OWNER, REPO, creator])
  })

  it('AC-04 켜진 저장소를 차례로 확인한다(앞 저장소가 끝난 뒤 다음 저장소, 꺼진 저장소는 건너뜀)', async () => {
    seed([], { [KEY]: cfg({ catchUp: true }), [WEB]: cfg({ catchUp: true }), 'acme/off': cfg({ enabled: false, catchUp: true }) })
    const gates: Record<string, ReturnType<typeof deferred<RecentIssue[]>>> = {}
    const h = harness({
      github: {
        listRecentIssues: (_o, r) => {
          gates[r] = deferred<RecentIssue[]>()
          return gates[r].promise
        },
      },
    })
    await h.start()
    const done = h.engine.check(clock)
    await flush()
    expect(h.github.listRecentIssues.mock.calls.map((c) => c[1])).toEqual(['app'])
    gates.app.resolve([])
    await flush()
    expect(h.github.listRecentIssues.mock.calls.map((c) => c[1])).toEqual(['app', 'web'])
    gates.web.resolve([])
    await done
    expect(h.github.listRecentIssues).toHaveBeenCalledTimes(2)
  })

  it('AC-04 확인 중인 저장소를 다시 확인하면 겹쳐 부르지 않고 끝난 뒤 한 번 더 확인한다', async () => {
    seed([], { [KEY]: cfg({ catchUp: true }) })
    const gates: ReturnType<typeof deferred<RecentIssue[]>>[] = []
    const h = harness({
      github: {
        listRecentIssues: () => {
          const d = deferred<RecentIssue[]>()
          gates.push(d)
          return d.promise
        },
      },
    })
    await h.start()
    void h.engine.check(clock)
    await flush()
    void h.engine.check(clock)
    await flush()
    expect(h.github.listRecentIssues).toHaveBeenCalledTimes(1)
    gates[0].resolve([])
    await flush()
    expect(h.github.listRecentIssues).toHaveBeenCalledTimes(2)
    gates[1].resolve([])
    await flush()
    expect(h.github.listRecentIssues).toHaveBeenCalledTimes(2)
  })

  it('EC-31 확인 중에 설정이 바뀌면 그 결과는 버리고 지금 설정으로 1회 다시 확인한다', async () => {
    seed([], { [KEY]: cfg({ author: 'me', catchUp: true }) })
    const first = deferred<RecentIssue[]>()
    const h = harness({
      github: {
        listRecentIssues: vi.fn<GitHubClient['listRecentIssues']>().mockReturnValueOnce(first.promise).mockResolvedValue([issue(12, { author: 'other' })]),
      },
    })
    await h.start()
    const done = h.engine.check(clock)
    await flush()
    useTakerStore.setState((s) => ({ repos: { ...s.repos, [KEY]: cfg({ author: 'anyone', catchUp: true }) } }))
    first.resolve([issue(11, { author: 'other' })])
    await done
    await flush()
    expect(h.github.listRecentIssues).toHaveBeenCalledTimes(2)
    expect(h.github.listRecentIssues.mock.calls[1][2]?.creator).toBeUndefined()
    expect(useTakerStore.getState().runs.map((r) => r.number)).toEqual([12])
  })

  it('EC-31 껐다 켜는 동안 늦게 온 기준 번호 응답은 버리고 새 설정으로 기준 번호를 다시 잡는다', async () => {
    seed([], { [KEY]: cfg({ baseline: null }) })
    const first = deferred<number>()
    const h = harness({ github: { latestNumber: vi.fn<GitHubClient['latestNumber']>().mockReturnValueOnce(first.promise).mockResolvedValue(40) } })
    await h.start()
    const done = h.engine.check(clock)
    await flush()
    useTakerStore.setState((s) => ({ repos: { ...s.repos, [KEY]: cfg({ baseline: null }) } }))
    first.resolve(20)
    await done
    await flush()
    expect(h.github.latestNumber).toHaveBeenCalledTimes(2)
    expect(useTakerStore.getState().repos[KEY].baseline).toBe(40)
  })
})

describe('알림 · 트리 이슈 목록', () => {
  it('AC-04 실행을 시작하면 그 저장소의 트리 이슈 목록을 tick 한 번에 한 번만 다시 읽는다', async () => {
    seed([runOf(11), runOf(12)])
    const h = harness({ open: never })
    await h.start()
    await h.tick()
    expect([run('r11').status, run('r12').status]).toEqual(['preparing', 'preparing'])
    expect(h.invalidate).toHaveBeenCalledTimes(1)
    expect(h.invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.githubIssues(OWNER, REPO), refetchType: 'active' })
    await h.tick()
    await h.tick()
    expect(h.invalidate).toHaveBeenCalledTimes(1)
  })

  it('AC-04 에이전트 알림이 켜져 있으면 "#n 자동 실행 시작" 알림을 이 PC 의 그 패널로 보낸다', async () => {
    seed([runOf(11)])
    const h = harness()
    await h.start()
    const p = await toRunning(h)
    const call = h.tauri.notify.mock.calls.find((c) => `${c[0]} ${c[1]}`.includes('#11'))
    expect(call && `${call[0]} ${call[1]}`).toContain('자동 실행 시작')
    expect(call?.[2]).toEqual({ kind: 'local', issueId: ID, paneId: p })
  })

  it('AC-04 에이전트 알림이 꺼져 있으면 시작·실패 알림을 보내지 않는다', async () => {
    useUiStore.setState({ agentNotify: false })
    seed([runOf(11), runOf(12)])
    const h = harness({
      open: async (alias, t) => {
        if (t.key === '11') return readyOpen(alias, t)
        useSetupStore.getState().setOpen(hostOf(alias).issueId(t.owner, t.repo, t.key), { phase: 'error', code: 'x', message: '경로 충돌' })
      },
    })
    await h.start()
    await toRunning(h)
    await h.until(() => run('r12').status === 'failed')
    expect(h.tauri.notify).not.toHaveBeenCalled()
  })
})

describe('T1 호스트 준비', () => {
  it('EC-13 아직 연결하지 않은 원격 호스트의 실행은 대기로 두고 연결을 한 번만 확인한 뒤 시작한다', async () => {
    remote(true, false)
    seed([runOf(11)])
    const probe = deferred<SshProbe>()
    const h = harness({ tauri: { sshProbe: () => probe.promise } })
    await h.start()
    await h.tick()
    await h.tick()
    await h.tick()
    expect(h.tauri.sshProbe).toHaveBeenCalledTimes(1)
    expect(h.tauri.sshProbe.mock.calls[0][0]).toBe('srv')
    expect(run().status).toBe('queued')
    expect(h.open).not.toHaveBeenCalled()
    probe.resolve(PROBE(true))
    await h.until(() => run().status === 'preparing')
    expect(run().issueId).toBe(RID)
  })

  it('EC-13 원격 호스트 연결에 오류가 있으면 "호스트 연결 대기" 로 대기하고 이 PC 에서 대신 열지 않는다', async () => {
    remote(true, false)
    useHostsStore.setState({ errors: { srv: { kind: 'unreachable', message: 'down' } } })
    seed([runOf(11)])
    const h = harness()
    await h.start()
    await h.until(() => reason(run()).includes('호스트 연결 대기'))
    await h.tick()
    await h.tick()
    expect(run().status).toBe('queued')
    expect(h.tauri.sshProbe).not.toHaveBeenCalled()
    expect(h.open).not.toHaveBeenCalled()
  })
})

describe('T2 시작', () => {
  it('AC-09 준비 중·실행 중·다음 단계 대기가 3개면 새 실행은 대기로 두고, 하나가 멈추면 먼저 찾은 순서로 시작한다', async () => {
    seed([runOf(9, { status: 'manualNext', step: 0, issueId: worktreeId(OWNER, REPO, '9'), assigned: true }), runOf(11), runOf(12), runOf(13), runOf(14)])
    const h = harness({ open: never })
    await h.start()
    await h.tick()
    await h.tick()
    await h.tick()
    expect(['r11', 'r12', 'r13', 'r14'].map((id) => run(id).status)).toEqual(['preparing', 'preparing', 'queued', 'queued'])
    h.engine.stop('r11')
    await h.tick()
    await h.tick()
    expect(['r11', 'r12', 'r13', 'r14'].map((id) => run(id).status)).toEqual(['stopped', 'preparing', 'preparing', 'queued'])
  })

  it('EC-26 처음 시작할 때 그 이슈의 터미널이 이미 열려 있으면 "이미 터미널이 열려 있는 이슈" 로 멈춘다', async () => {
    useUiStore.setState({ startedTerminals: { [ID]: true } })
    seed([runOf(11)])
    const h = harness()
    await h.start()
    await h.until(() => run().status !== 'queued')
    expect(run().status).toBe('stopped')
    expect(reason(run())).toContain('이미 터미널이 열려 있는 이슈')
    await h.tick()
    expect(h.github.assignIssue).not.toHaveBeenCalled()
    expect(h.open).not.toHaveBeenCalled()
  })

  it('EC-26 이미 열린 터미널 때문에 멈춘 실행을 이 단계부터 다시 하면 다시 멈추지 않는다', async () => {
    useUiStore.setState({ startedTerminals: { [ID]: true } })
    seed([runOf(11)])
    const h = harness()
    await h.start()
    await h.until(() => run().status !== 'queued')
    expect(run().status).toBe('stopped')
    h.engine.restart('r11')
    expect(run().status).toBe('queued')
    await h.until(() => run().status !== 'queued')
    expect(run().status).toBe('preparing')
    expect(reason(run())).not.toContain('이미 터미널이 열려 있는 이슈')
    await h.until(() => h.open.mock.calls.length > 0)
    expect(h.github.assignIssue).toHaveBeenCalled()
    expect(run().status).not.toBe('stopped')
  })

  it('EC-26 assign 한 뒤 대기로 돌아간 실행은 그 사이 터미널이 열려도 다시 시작할 때 멈추지 않는다', async () => {
    remote(true)
    seed([runOf(11)])
    const assign = deferred<{ number: number; title: string; state: 'open'; htmlUrl: string; assignees: string[] }>()
    const h = harness({ github: { assignIssue: () => assign.promise }, tauri: { sshProbe: never } })
    await h.start()
    await h.until(() => h.github.assignIssue.mock.calls.length > 0)
    useHostsStore.setState({ probes: {} })
    assign.resolve({ number: 11, title: 'Issue 11', state: 'open', htmlUrl: '', assignees: ['me'] })
    await flush()
    await h.tick()
    expect(run()).toMatchObject({ status: 'queued', assigned: true })
    useUiStore.setState({ startedTerminals: { [RID]: true } })
    remote(true)
    await h.until(() => run().status !== 'queued')
    expect(run().status).toBe('preparing')
    expect(reason(run())).not.toContain('이미 터미널이 열려 있는 이슈')
    await h.until(() => h.open.mock.calls.length > 0)
    expect(h.github.assignIssue).toHaveBeenCalledTimes(1)
  })
})

describe('T3 assign', () => {
  it('AC-04 worktree 를 열기 전에 이슈를 확인하고 나에게 assign 하며, assign 응답 전에는 열지 않는다', async () => {
    seed([runOf(11)])
    const assign = deferred<{ number: number; title: string; state: 'open'; htmlUrl: string; assignees: string[] }>()
    const h = harness({ github: { assignIssue: () => assign.promise } })
    await h.start()
    await h.until(() => h.github.assignIssue.mock.calls.length > 0)
    await h.tick()
    await h.tick()
    expect(h.github.getIssue).toHaveBeenCalledWith(OWNER, REPO, 11)
    expect(h.github.assignIssue).toHaveBeenCalledWith(OWNER, REPO, 11, 'me')
    expect(h.open).not.toHaveBeenCalled()
    assign.resolve({ number: 11, title: 'Issue 11', state: 'open', htmlUrl: '', assignees: ['me'] })
    await h.until(() => h.open.mock.calls.length > 0)
    expect(h.github.getIssue.mock.invocationCallOrder[0]).toBeLessThan(h.github.assignIssue.mock.invocationCallOrder[0])
    expect(run().assigned).toBe(true)
    expect(run().note ?? '').not.toContain('assign 하지 못함')
  })

  it.each<[string, Partial<GitHubIssueDetail>]>([
    ['닫힘', { state: 'closed' }],
    ['다른 사람만 담당', { assignees: ['other'] }],
  ])('EC-25 시작 직전 이슈가 %s 이면 assign 하지 않고 멈춘다', async (_case, patch) => {
    seed([runOf(11)])
    const h = harness({ github: { getIssue: async (_o, _r, n) => detail(n, patch) } })
    await h.start()
    await h.until(() => run().status === 'stopped')
    expect(h.github.getIssue).toHaveBeenCalledWith(OWNER, REPO, 11)
    expect(reason(run()).trim()).not.toBe('')
    await h.tick()
    expect(h.github.assignIssue).not.toHaveBeenCalled()
    expect(h.open).not.toHaveBeenCalled()
  })

  it('EC-25 이슈 확인(getIssue)이 실패하면 확인을 건너뛰고 assign 한 뒤 연다', async () => {
    seed([runOf(11)])
    const h = harness({
      github: {
        getIssue: async () => {
          throw new GitHubError('network')
        },
      },
    })
    await h.start()
    await h.until(() => h.open.mock.calls.length > 0)
    expect(h.github.assignIssue).toHaveBeenCalledWith(OWNER, REPO, 11, 'me')
    expect(run().status).toBe('preparing')
  })

  it('EC-12 assign 이 실패하면 "assign 하지 못함" 을 남기고 다시 시도하지 않고 실행을 이어 간다', async () => {
    seed([runOf(11)])
    const h = harness({
      github: {
        assignIssue: async () => {
          throw new GitHubError('forbidden')
        },
      },
    })
    await h.start()
    await toRunning(h)
    expect(h.writes()).toEqual([`${CMD1}\r`])
    expect(run().note).toContain('assign 하지 못함')
    expect(h.github.assignIssue).toHaveBeenCalledTimes(1)
  })

  it('EC-12 assign 이 무시되면(응답의 담당자에 내가 없음) "assign 하지 못함" 을 남기고 이어 간다', async () => {
    seed([runOf(11)])
    const h = harness({ github: { assignIssue: async (_o, _r, n) => ({ number: n, title: 'Issue 11', state: 'open', htmlUrl: '', assignees: [] }) } })
    await h.start()
    await h.until(() => h.open.mock.calls.length > 0)
    expect(run().note).toContain('assign 하지 못함')
    expect(run().status).toBe('preparing')
  })
})

describe('T4 · T6 배경 열기 · 패널 마련', () => {
  it('AC-04 worktree 를 열고 생성 후 스크립트가 끝난 뒤 새 패널을 마련해 셸 확인 뒤 1단계 명령을 넣는다', async () => {
    const launchPane = spyLaunchPane()
    seed([runOf(11)])
    const h = harness({
      open: async (alias, t) => {
        const id = markReady(alias, t)
        useSetupStore.getState().setScript(id, { status: 'running' })
      },
    })
    await h.start()
    await h.until(() => h.open.mock.calls.length > 0)
    await h.tick()
    await h.tick()
    await h.tick()
    expect(launchPane).not.toHaveBeenCalled()
    expect(run().paneId).toBeNull()
    useSetupStore.getState().setScript(ID, { status: 'succeeded', exitCode: 0 })
    const p = await toPane(h)
    expect(launchPane).toHaveBeenCalledWith(ID, false, false)
    expect(p.startsWith(`${ID}::`)).toBe(true)
    ptyUp(p)
    shellAt(p)
    await h.until(() => h.writes().length > 0)
    expect(h.tauri.ptyWrite).toHaveBeenCalledWith('pty-1', `${CMD1}\r`)
    expect(run()).toMatchObject({ status: 'running', step: 0, paneId: p, issueId: ID })
  })

  it('AC-05 고른 이슈·탭을 바꾸지 않고(select:false) 포커스를 요청하지 않는 패널에서 실행한다', async () => {
    const OTHER = worktreeId(OWNER, REPO, '5')
    useUiStore.setState({ selectedIssueId: OTHER, tab: 'changes' })
    const selectIssue = vi.fn(useUiStore.getState().selectIssue)
    const setTab = vi.fn(useUiStore.getState().setTab)
    useUiStore.setState({ selectIssue, setTab })
    const launchPane = spyLaunchPane()
    seed([runOf(11)])
    const h = harness()
    await h.start()
    await toRunning(h)
    expect(h.actionsFor).toHaveBeenCalledWith(null)
    expect(h.open).toHaveBeenCalledWith(null, expect.objectContaining({ owner: OWNER, repo: REPO, key: '11', number: 11 }), { select: false })
    expect(launchPane).toHaveBeenCalledWith(ID, false, false)
    expect(selectIssue).not.toHaveBeenCalled()
    expect(setTab).not.toHaveBeenCalled()
    expect(useUiStore.getState().selectedIssueId).toBe(OTHER)
    expect(useUiStore.getState().tab).toBe('changes')
  })

  it('AC-04 사용자가 여는 중인 이슈(ready, 스크립트 시작 전)는 그 열기가 끝날 때까지 패널을 만들지 않는다', async () => {
    const launchPane = spyLaunchPane()
    seed([runOf(11)])
    const opening = deferred<void>()
    const h = harness({
      open: async (alias, t) => {
        markReady(alias, t)
        await opening.promise
      },
    })
    await h.start()
    await h.until(() => h.open.mock.calls.length > 0)
    await h.tick()
    await h.tick()
    expect(launchPane).not.toHaveBeenCalled()
    useSetupStore.getState().setScript(ID, { status: 'running' })
    opening.resolve()
    await h.tick()
    await h.tick()
    expect(launchPane).not.toHaveBeenCalled()
    useSetupStore.getState().setScript(ID, { status: 'succeeded', exitCode: 0 })
    await toPane(h)
    expect(launchPane).toHaveBeenCalledTimes(1)
  })

  it('EC-13 assign 뒤 열기 전에 원격 연결 기록이 없어지면 대기로 돌아가고 이 PC 에서 열지 않는다', async () => {
    remote(true)
    seed([runOf(11)])
    const assign = deferred<{ number: number; title: string; state: 'open'; htmlUrl: string; assignees: string[] }>()
    const h = harness({ github: { assignIssue: () => assign.promise }, tauri: { sshProbe: never } })
    await h.start()
    await h.until(() => h.github.assignIssue.mock.calls.length > 0)
    expect(run().status).toBe('preparing')
    useHostsStore.setState({ probes: {} })
    assign.resolve({ number: 11, title: 'Issue 11', state: 'open', htmlUrl: '', assignees: ['me'] })
    await flush()
    await h.tick()
    expect(run().status).toBe('queued')
    expect(h.open).not.toHaveBeenCalled()
  })
})

describe('T5 열기 실패', () => {
  it('EC-04 worktree 준비가 실패하면 사유와 함께 실패로 두고 알리며 다시 열지 않는다', async () => {
    const launchPane = spyLaunchPane()
    seed([runOf(11)])
    const h = harness({
      open: async (alias, t) => {
        useSetupStore.getState().setOpen(hostOf(alias).issueId(t.owner, t.repo, t.key), { phase: 'error', code: 'path_exists_unregistered', message: '경로가 이미 있지만 git worktree 가 아닙니다' })
      },
    })
    await h.start()
    await h.until(() => run().status === 'failed')
    expect(run().error).toContain('경로가 이미 있지만')
    expect(h.notified().some((s) => s.includes('#11'))).toBe(true)
    for (let i = 0; i < 5; i++) await h.tick()
    expect(h.open).toHaveBeenCalledTimes(1)
    expect(launchPane).not.toHaveBeenCalled()
    expect(run().status).toBe('failed')
  })
})

describe('T6 · T7 tmux 를 쓰지 않는 원격 호스트', () => {
  it('EC-07 패널을 마련하면 같은 흐름에서 1단계 명령을 대기열에 맡기고 "명령 넣는 중" 으로 실행 중이 된다', async () => {
    remote(false)
    const launchPane = spyLaunchPane()
    seed([runOf(11)])
    const h = harness()
    await h.start()
    const p = await toPane(h)
    expect(launchPane).toHaveBeenCalledWith(RID, true, false)
    expect(h.actionsFor).toHaveBeenCalledWith('srv')
    expect(run()).toMatchObject({ status: 'running', issueId: RID, paneId: p })
    expect(run().note).toContain('명령 넣는 중')
    expect(launchResult(p)).toBe('pending')
    expect(takeLaunch(p)).toBe(CMD1)
    expect(h.tauri.ptyWrite).not.toHaveBeenCalled()
  })

  it('EC-07 명령이 들어가면 다음 단계 대기가 되고, 시작 확인(120초)을 하지 않는다', async () => {
    remote(false)
    seed([runOf(11)])
    const h = harness()
    await h.start()
    const p = await toPane(h)
    expect(takeLaunch(p)).toBe(CMD1)
    markLaunched(p)
    await h.until(() => run().status !== 'running')
    expect(run()).toMatchObject({ status: 'manualNext', step: 0, paneId: p })
    expect(launchResult(p)).toBeNull()
    await h.tick(130_000)
    await h.tick()
    expect(run().status).toBe('manualNext')
  })

  it('EC-07 단계가 하나뿐이면 명령이 들어간 뒤 끝남이 된다', async () => {
    remote(false)
    seed([runOf(11, { steps: [STEPS[0]] })], { [KEY]: cfg({ steps: [STEPS[0]] }) })
    const h = harness()
    await h.start()
    const p = await toPane(h)
    takeLaunch(p)
    markLaunched(p)
    await h.until(() => run().status === 'done')
  })

  it.each<[string, (p: string) => void]>([
    ['dropped', (p) => {
      takeLaunch(p)
      dropLaunch(p)
    }],
    ['expired', (p) => {
      vi.setSystemTime(Date.now() + LAUNCH_TTL_MS + 1)
      takeLaunch(p)
    }],
  ])('EC-07 명령을 넣지 못하면(%s) "명령을 넣지 못함" 으로 실패하고 알린다', async (_case, fail) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    remote(false)
    seed([runOf(11)])
    const h = harness()
    await h.start()
    const p = await toPane(h)
    expect(launchResult(p)).toBe('pending')
    fail(p)
    await h.until(() => run().status !== 'running')
    expect(run().status).toBe('failed')
    expect(run().error).toContain('명령을 넣지 못함')
    expect(h.notified().some((s) => s.includes('#11'))).toBe(true)
    expect(launchResult(p)).toBeNull()
  })

  it('EC-07 터미널이 명령을 꺼냈지만 아직 넣지 않았으면(비밀번호 물음 등) 120초가 지나도 실패로 두지 않는다', async () => {
    remote(false)
    seed([runOf(11)])
    const h = harness()
    await h.start()
    const p = await toPane(h)
    expect(takeLaunch(p)).toBe(CMD1)
    await h.tick(130_000)
    await h.tick()
    expect(run().status).toBe('running')
    expect(launchResult(p)).toBe('pending')
    expect(h.tauri.ptyWrite).not.toHaveBeenCalled()
  })

  it('A-19 명령을 넣지 못해 실패한 실행을 다시 시도하면 같은 패널 id 라도 옛 결과에 막히지 않고 다시 맡긴다', async () => {
    remote(false)
    seed([runOf(11)])
    const h = harness()
    await h.start()
    const p = await toPane(h)
    takeLaunch(p)
    dropLaunch(p)
    await h.until(() => run().status === 'failed')
    useUiStore.setState({ panes: {} })
    h.engine.restart('r11')
    expect(run()).toMatchObject({ status: 'queued', paneId: null })
    const again = await toPane(h)
    expect(again).toBe(p)
    expect(launchResult(again)).toBe('pending')
    await h.tick()
    await h.tick()
    expect(run().status).toBe('running')
    expect(takeLaunch(again)).toBe(CMD1)
  })
})

describe('T8 명령 넣기 — 셸 확인', () => {
  it('EC-29 셸만 남고 출력·입력이 6초 동안 없을 때에만 명령을 넣는다', async () => {
    seed([runOf(11)])
    const h = harness()
    await h.start()
    const p = await toPane(h)
    ptyUp(p)
    const since = clock
    shellAt(p, since)
    await h.tick(5_999)
    expect(h.tauri.ptyWrite).not.toHaveBeenCalled()
    await h.tick(1)
    await h.tick(0)
    expect(h.tauri.ptyWrite).toHaveBeenCalledTimes(1)
    expect(h.tauri.ptyWrite).toHaveBeenCalledWith('pty-1', `${CMD1}\r`)
  })

  it.each<[string, (p: string) => void]>([
    ['옛 에이전트가 도는 패널', (p) => agentOn(p)],
    ['사용자가 쓰는 셸(셸 확인 신호 없음)', () => {}],
  ])('EC-29 %s 에는 명령을 넣지 않는다', async (_case, arrange) => {
    seed([runOf(11)])
    const h = harness()
    await h.start()
    const p = await toPane(h)
    ptyUp(p)
    arrange(p)
    for (let i = 0; i < 10; i++) await h.tick(2_000)
    expect(run().status).toBe('preparing')
    expect(h.tauri.ptyWrite).not.toHaveBeenCalled()
  })

  it('EC-29 tmux 원격은 연결 이벤트가 없어도(처음부터 연결됨) 셸 확인 뒤 명령을 넣는다', async () => {
    remote(true)
    const launchPane = spyLaunchPane()
    seed([runOf(11)])
    const h = harness()
    await h.start()
    await toRunning(h)
    expect(launchPane).toHaveBeenCalledWith(RID, true, false)
    expect(h.tauri.ptyWrite).toHaveBeenCalledWith('pty-1', `${CMD1}\r`)
    expect(run()).toMatchObject({ status: 'running', step: 0 })
  })

  it('EC-29 tmux 원격이 다시 연결되면 연결된 뒤 6초가 지나야 명령을 넣는다', async () => {
    remote(true)
    seed([runOf(11)])
    const h = harness()
    await h.start()
    const p = await toPane(h)
    ptyUp(p)
    shellAt(p, clock - 60_000)
    h.emitLink('pty-1', 'connecting', 2)
    for (let i = 0; i < 5; i++) await h.tick(2_000)
    expect(h.tauri.ptyWrite).not.toHaveBeenCalled()
    h.emitLink('pty-1', 'connected', 3)
    await h.tick(5_000)
    expect(h.tauri.ptyWrite).not.toHaveBeenCalled()
    await h.tick(1_000)
    await h.tick(0)
    expect(h.tauri.ptyWrite).toHaveBeenCalledTimes(1)
  })

  it('EC-27 치환한 지시문이 - 로 시작하면 명령을 넣지 않고 실패로 둔다', async () => {
    const steps: TakerStep[] = [{ kind: 'claude', command: 'claude {prompt}', prompt: '{title}' }]
    seed([runOf(11, { title: '--yolo', steps })], { [KEY]: cfg({ steps }) })
    const h = harness()
    await h.start()
    await h.until(() => {
      const r = run()
      if (r.paneId !== null && !(r.paneId in useUiStore.getState().terminalIds)) {
        ptyUp(r.paneId)
        shellAt(r.paneId, clock - 10_000)
      }
      return r.status === 'failed'
    })
    expect(run().error).toEqual(expect.any(String))
    expect(h.tauri.ptyWrite).not.toHaveBeenCalled()
  })
})

describe('T9 패널 마련 뒤 시간 초과', () => {
  it('EC-30 패널을 마련하고 120초 안에 명령을 넣지 못하면 "에이전트가 시작되지 않음" 으로 실패하고 알린다', async () => {
    seed([runOf(11)])
    const h = harness()
    await h.start()
    const p = await toPane(h)
    ptyUp(p)
    await h.tick(119_000)
    expect(run().status).toBe('preparing')
    await h.tick(1_001)
    expect(run().status).toBe('failed')
    expect(run().error).toContain('에이전트가 시작되지 않음')
    expect(h.notified().some((s) => s.includes('#11'))).toBe(true)
  })

  it('EC-30 명령을 쓰는 중에 시간이 넘어 실패하면 늦게 온 쓰기 성공이 실패를 덮어쓰지 않는다', async () => {
    seed([runOf(11)])
    const write = deferred<void>()
    const h = harness({ tauri: { ptyWrite: () => write.promise } })
    await h.start()
    const p = await toPane(h)
    const paneAt = clock
    ptyUp(p)
    shellAt(p, paneAt + 113_000)
    await h.tick(119_500)
    expect(h.tauri.ptyWrite).toHaveBeenCalledTimes(1)
    await h.tick(1_000)
    expect(run().status).toBe('failed')
    write.resolve()
    await flush()
    await h.tick()
    expect(run()).toMatchObject({ status: 'failed', step: 0 })
  })
})

describe('T10 단계 진행', () => {
  it('AC-07 프로그램이 끝나면 같은 패널에 다음 단계 명령을 넣고, 마지막 단계가 끝나면 끝남이 된다', async () => {
    seed([runOf(11)])
    const h = harness()
    await h.start()
    const p = await toRunning(h)
    await stepEnds(h, p)
    await h.until(() => h.writes().length === 2)
    expect(h.tauri.ptyWrite).toHaveBeenLastCalledWith('pty-1', `${CMD2}\r`)
    expect(run()).toMatchObject({ status: 'running', step: 1, paneId: p })
    await stepEnds(h, p)
    await h.until(() => run().status === 'done')
    expect(h.writes()).toHaveLength(2)
  })

  it('EC-14 사용자가 입력 대기 중인 에이전트를 /exit 로 끝내도 다음 단계를 시작한다', async () => {
    seed([runOf(11)])
    const h = harness()
    await h.start()
    const p = await toRunning(h)
    await stepEnds(h, p, 'attention')
    await h.until(() => h.writes().length === 2)
    expect(h.writes()[1]).toBe(`${CMD2}\r`)
    expect(run().step).toBe(1)
  })

  it('EC-05 명령을 넣은 뒤 120초 안에 프로그램이 보이지 않으면 "에이전트가 시작되지 않음" 으로 실패하고 알린다', async () => {
    seed([runOf(11)])
    const h = harness()
    await h.start()
    await toRunning(h)
    const before = h.notified().length
    await h.tick(119_000)
    expect(run().status).toBe('running')
    await h.tick(1_001)
    expect(run().status).toBe('failed')
    expect(run().error).toContain('에이전트가 시작되지 않음')
    expect(h.notified().slice(before).some((s) => s.includes('#11'))).toBe(true)
  })

  it('AC-07 다음 단계 명령을 쓰는 동안 끝남이 이어져도 명령은 한 번, 단계는 하나만 오른다', async () => {
    seed([runOf(11)])
    const second = deferred<void>()
    let n = 0
    const h = harness({ tauri: { ptyWrite: async () => (++n >= 2 ? second.promise : undefined) } })
    await h.start()
    const p = await toRunning(h)
    await stepEnds(h, p)
    await h.until(() => h.writes().length === 2)
    for (let i = 0; i < 8; i++) await h.tick()
    expect(h.writes()).toHaveLength(2)
    expect(run().step).toBe(0)
    second.resolve()
    await flush()
    await h.tick()
    expect(run().step).toBe(1)
    for (let i = 0; i < 8; i++) await h.tick()
    expect(h.writes()).toHaveLength(2)
    expect(run().step).toBe(1)
  })
})

describe('T11 worktree · 패널', () => {
  it('EC-15 실행 중에 그 이슈의 worktree 를 지우면 "worktree 삭제" 로 멈춘다', async () => {
    seed([runOf(11)])
    const h = harness()
    await h.start()
    const p = await toRunning(h)
    deleteWorktree(ID)
    await h.tick()
    expect(run().status).toBe('stopped')
    expect(reason(run())).toContain('worktree 삭제')
    await stepEnds(h, p)
    for (let i = 0; i < 8; i++) await h.tick()
    expect(h.writes()).toHaveLength(1)
  })

  it('EC-15 열기가 늦게 끝나도 그 사이 worktree 를 지웠으면 멈추고 패널을 만들지 않는다', async () => {
    const launchPane = spyLaunchPane()
    seed([runOf(11)])
    const opening = deferred<void>()
    const h = harness({
      open: async (alias, t) => {
        markReady(alias, t)
        await opening.promise
      },
    })
    await h.start()
    await h.until(() => h.open.mock.calls.length > 0)
    deleteWorktree(ID)
    opening.resolve()
    await flush()
    await h.until(() => run().status === 'stopped')
    expect(reason(run())).toContain('worktree 삭제')
    await h.tick()
    expect(launchPane).not.toHaveBeenCalled()
    expect(run().paneId).toBeNull()
  })

  it('EC-15 열기가 opening 인 채 바로 끝나도 ready 가 되기 전에는 worktree 삭제로 멈추지 않는다', async () => {
    seed([runOf(11)])
    const h = harness({
      open: async (alias, t) => {
        useSetupStore.getState().setOpen(hostOf(alias).issueId(t.owner, t.repo, t.key), { phase: 'opening' })
      },
    })
    await h.start()
    await h.until(() => h.open.mock.calls.length > 0)
    for (let i = 0; i < 5; i++) await h.tick()
    expect(run().status).toBe('preparing')
    expect(reason(run())).not.toContain('worktree 삭제')
    expect(run().paneId).toBeNull()
    const [alias, target] = h.open.mock.calls[0]!
    markReady(alias, target)
    await toPane(h)
    expect(run().status).toBe('preparing')
  })

  it('EC-28 자동 실행 패널을 닫으면 멈추고 다음 단계를 넣지 않는다', async () => {
    seed([runOf(11)])
    const h = harness()
    await h.start()
    const p = await toRunning(h)
    useUiStore.getState().closePane(ID, p)
    await h.tick()
    expect(run().status).toBe('stopped')
    expect(reason(run())).toMatch(/패널이 닫힘|터미널이 끝남/)
    await stepEnds(h, p)
    for (let i = 0; i < 8; i++) await h.tick()
    expect(h.writes()).toHaveLength(1)
  })

  it('EC-28 패널이 남아 있어도 그 터미널이 끝나면(onPtyExit) 멈춘다', async () => {
    seed([runOf(11)])
    const h = harness()
    await h.start()
    await toRunning(h)
    h.emitExit('pty-1')
    await h.tick()
    expect(run().status).toBe('stopped')
    expect(reason(run())).toMatch(/패널이 닫힘|터미널이 끝남/)
  })

  it('EC-28 터미널이 terminalIds 에 오르기 전에 끝나도 멈춘다', async () => {
    seed([runOf(11)])
    const h = harness()
    await h.start()
    const p = await toPane(h)
    expect(run().status).toBe('preparing')
    h.emitExit('pty-1')
    ptyUp(p, 'pty-1')
    await h.tick()
    await h.tick()
    expect(run().status).toBe('stopped')
  })

  it('EC-28 다음 단계 대기의 패널이 닫히면 상태는 그대로 두고 패널만 비운다', async () => {
    remote(false)
    seed([runOf(11)])
    const h = harness()
    await h.start()
    const p = await toPane(h)
    ptyUp(p)
    takeLaunch(p)
    markLaunched(p)
    await h.until(() => run().status === 'manualNext')
    useUiStore.getState().closePane(RID, p)
    await h.tick()
    expect(run()).toMatchObject({ status: 'manualNext', paneId: null })
  })
})

describe('start — 앱을 다시 켬', () => {
  it('EC-06 다시 켜면 준비 중·실행 중은 중단됨, 다음 단계 대기는 패널만 비우고, 대기는 그대로 두며 맡겨 둔 명령을 거둔다', async () => {
    const PA = `${ID}::1`
    queueLaunch(PA, CMD1, { track: true })
    seed([
      runOf(11, { status: 'preparing', issueId: ID, paneId: PA, assigned: true }),
      runOf(12, { status: 'running', issueId: worktreeId(OWNER, REPO, '12'), paneId: `${worktreeId(OWNER, REPO, '12')}::1`, assigned: true }),
      runOf(13, { status: 'manualNext', issueId: worktreeId(OWNER, REPO, '13'), paneId: `${worktreeId(OWNER, REPO, '13')}::2`, assigned: true }),
      runOf(14),
    ])
    const h = harness({ open: never })
    await h.start()
    expect(['r11', 'r12', 'r13', 'r14'].map((id) => run(id).status)).toEqual(['interrupted', 'interrupted', 'manualNext', 'queued'])
    expect(run('r13').paneId).toBeNull()
    expect(takeLaunch(PA)).toBeUndefined()
    await h.tick()
    await h.tick()
    expect([run('r11').status, run('r12').status]).toEqual(['interrupted', 'interrupted'])
  })

  it('EC-06 [이 단계부터 다시] 를 누르면 지금 설정으로 대기열에 돌아가 새 패널에서 그 단계부터 실행한다', async () => {
    const P1 = `${ID}::1`
    useUiStore.setState({ panes: { [ID]: { tree: leaf(P1), focused: P1, seq: 1, first: P1 } }, terminalIds: { [P1]: 'pty-old' }, startedTerminals: { [ID]: true } })
    const old: TakerStep[] = [STEPS[0], { kind: 'claude', command: 'claude --continue {prompt}', prompt: '/old {number}' }]
    seed([runOf(11, { status: 'interrupted', step: 1, steps: old, issueId: ID, assigned: true })])
    const launchPane = spyLaunchPane()
    const h = harness()
    await h.start()
    h.engine.restart('r11')
    expect(run()).toMatchObject({ status: 'queued', step: 1, paneId: null, steps: STEPS })
    const p = await toPane(h)
    expect(launchPane.mock.calls[0]?.[2]).toBe(false)
    expect(p).not.toBe(P1)
    ptyUp(p, 'pty-2')
    shellAt(p)
    await h.until(() => h.writes().length > 0)
    expect(h.tauri.ptyWrite.mock.calls).toEqual([['pty-2', `${CMD2}\r`]])
    expect(run()).toMatchObject({ status: 'running', step: 1 })
  })

  it('A-19 [다시 시도] 할 때 지금 설정의 단계 수가 줄었으면 마지막 단계로 맞춘다', async () => {
    seed([runOf(11, { status: 'failed', step: 1, issueId: ID, assigned: true })], { [KEY]: cfg({ steps: [STEPS[0]] }) })
    const h = harness()
    await h.start()
    h.engine.restart('r11')
    expect(run()).toMatchObject({ status: 'queued', step: 0, steps: [STEPS[0]], paneId: null })
  })

  it('A-22 다시 켠 뒤 다음 단계 대기에서 [다음 단계] 를 누르면 새 패널에서 다음 단계를 실행한다', async () => {
    remote(false)
    seed([runOf(11, { status: 'manualNext', step: 0, issueId: RID, paneId: `${RID}::2`, assigned: true })])
    const h = harness()
    await h.start()
    expect(run().paneId).toBeNull()
    expect(h.engine.nextStep('r11')).toBe('started')
    expect(run()).toMatchObject({ status: 'queued', step: 1, paneId: null })
    const p = await toPane(h)
    expect(takeLaunch(p)).toBe(CMD2)
  })
})

describe('버튼 — 멈춤 · 다음 단계', () => {
  it('A-19 다음 단계 대기에서 [이 단계부터 다시] 를 누르면 지금 단계를 대기열에서 다시 시작한다', async () => {
    remote(false)
    seed([runOf(11)])
    const h = harness()
    await h.start()
    const p = await toPane(h)
    takeLaunch(p)
    markLaunched(p)
    await h.until(() => run().status === 'manualNext')
    h.engine.restart('r11')
    expect(run()).toMatchObject({ status: 'queued', step: 0, paneId: null })
    const again = await toPane(h)
    expect(takeLaunch(again)).toBe(CMD1)
  })

  it('AC-08 [멈춤] 을 누르면 멈춤이 되고 프로그램이 끝나도 다음 단계를 넣지 않으며 에이전트를 끄지 않는다', async () => {
    seed([runOf(11)])
    const h = harness()
    await h.start()
    const p = await toRunning(h)
    agentOn(p)
    await h.tick()
    h.engine.stop('r11')
    expect(run().status).toBe('stopped')
    agentOff(p)
    for (let i = 0; i < 10; i++) await h.tick()
    expect(h.writes()).toEqual([`${CMD1}\r`])
    expect(h.tauri.ptyKill).not.toHaveBeenCalled()
    expect(run().status).toBe('stopped')
  })

  it('AC-08 패널을 마련하기 전 준비 중인 실행도 [멈춤] 으로 풀리고 그 뒤 패널을 만들지 않는다', async () => {
    const launchPane = spyLaunchPane()
    seed([runOf(11)])
    const h = harness({
      open: async (alias, t) => {
        const id = markReady(alias, t)
        useSetupStore.getState().setScript(id, { status: 'running' })
      },
    })
    await h.start()
    await h.until(() => h.open.mock.calls.length > 0)
    expect(run().status).toBe('preparing')
    h.engine.stop('r11')
    expect(run().status).toBe('stopped')
    useSetupStore.getState().setScript(ID, { status: 'succeeded', exitCode: 0 })
    for (let i = 0; i < 3; i++) await h.tick()
    expect(launchPane).not.toHaveBeenCalled()
  })

  it('AC-08 맡겨 둔 명령을 꺼내기 전에 [멈춤] 하면 대기열에서 거둔다', async () => {
    remote(false)
    seed([runOf(11)])
    const h = harness()
    await h.start()
    const p = await toPane(h)
    expect(run().status).toBe('running')
    h.engine.stop('r11')
    expect(run().status).toBe('stopped')
    expect(launchResult(p)).toBe('cancelled')
    expect(takeLaunch(p)).toBeUndefined()
  })

  it('AC-08 터미널이 명령을 꺼낸 뒤 [멈춤] 하면 그 명령은 들어가지 않게 취소로 표시한다', async () => {
    remote(false)
    seed([runOf(11)])
    const h = harness()
    await h.start()
    const p = await toPane(h)
    expect(takeLaunch(p)).toBe(CMD1)
    h.engine.stop('r11')
    expect(run().status).toBe('stopped')
    expect(isLaunchCancelled(p)).toBe(true)
    expect(h.tauri.ptyWrite).not.toHaveBeenCalled()
  })

  it('EC-07 [다음 단계] 를 두 번 눌러도 명령은 한 번만 들어가고, 마지막 단계면 끝남이 된다', async () => {
    remote(false)
    seed([runOf(11)])
    const write = deferred<void>()
    const h = harness({ tauri: { ptyWrite: () => write.promise } })
    await h.start()
    const p = await toPane(h)
    ptyUp(p)
    takeLaunch(p)
    markLaunched(p)
    await h.until(() => run().status === 'manualNext')
    expect(h.engine.nextStep('r11')).toBe('started')
    expect(h.engine.nextStep('r11')).toBe('busy')
    await flush()
    expect(h.tauri.ptyWrite.mock.calls).toEqual([['pty-1', `${CMD2}\r`]])
    write.resolve()
    await flush()
    await h.tick()
    expect(run()).toMatchObject({ status: 'done', step: 1 })
  })

  it('EC-07 터미널이 아직 뜨지 않았으면 [다음 단계] 는 notReady 이고, 뜬 뒤에 다시 누를 수 있다', async () => {
    remote(false)
    seed([runOf(11)])
    const h = harness()
    await h.start()
    const p = await toPane(h)
    takeLaunch(p)
    markLaunched(p)
    await h.until(() => run().status === 'manualNext')
    expect(h.engine.nextStep('r11')).toBe('notReady')
    await flush()
    expect(h.tauri.ptyWrite).not.toHaveBeenCalled()
    ptyUp(p)
    expect(h.engine.nextStep('r11')).toBe('started')
    await flush()
    expect(h.tauri.ptyWrite).toHaveBeenCalledWith('pty-1', `${CMD2}\r`)
  })

  it('EC-07 패널이 없으면 [다음 단계] 는 다음 단계를 대기열로 돌려 새 패널에서 실행하게 한다', async () => {
    remote(false)
    seed([runOf(11, { status: 'manualNext', step: 0, issueId: RID, assigned: true })])
    const h = harness()
    await h.start()
    expect(h.engine.nextStep('r11')).toBe('started')
    expect(run()).toMatchObject({ status: 'queued', step: 1, paneId: null })
  })

  it('EC-07 마지막 단계 뒤에 [다음 단계] 를 누르면 notReady 이고 실행은 그대로다', async () => {
    remote(false)
    seed([runOf(11, { status: 'manualNext', step: 1, issueId: RID, assigned: true })])
    const h = harness()
    await h.start()
    expect(h.engine.nextStep('r11')).toBe('notReady')
    expect(run()).toMatchObject({ status: 'manualNext', step: 1, paneId: null })
  })
})

describe('AC-13 끈 저장소', () => {
  it('AC-13 꺼진 저장소는 새 이슈를 확인하지 않는다', async () => {
    seed([], { [KEY]: cfg({ enabled: false, catchUp: true }), [WEB]: cfg({ catchUp: true }) })
    const h = harness()
    await h.start()
    await h.check()
    expect(h.github.listRecentIssues.mock.calls.map((c) => c[1])).toEqual(['web'])
    expect(h.github.latestNumber).not.toHaveBeenCalled()
  })

  it('AC-13 꺼진 저장소라도 이미 시작한 실행은 마지막 단계까지 이어 간다', async () => {
    seed([runOf(11)])
    const h = harness()
    await h.start()
    const p = await toRunning(h)
    useTakerStore.setState((s) => ({ repos: { ...s.repos, [KEY]: cfg({ enabled: false }) } }))
    await stepEnds(h, p)
    await h.until(() => h.writes().length === 2)
    expect(h.writes()[1]).toBe(`${CMD2}\r`)
  })
})

describe('dispose', () => {
  it('A-26 dispose 뒤에 늦게 온 쓰기 응답은 store 를 바꾸지 않는다', async () => {
    seed([runOf(11)])
    const write = deferred<void>()
    const h = harness({ tauri: { ptyWrite: () => write.promise } })
    await h.start()
    const p = await toPane(h)
    ptyUp(p)
    shellAt(p)
    await h.until(() => h.tauri.ptyWrite.mock.calls.length > 0)
    const snap = structuredClone(run())
    h.engine.dispose()
    write.resolve()
    await flush()
    expect(run()).toEqual(snap)
  })

  it('A-26 맡겨 둔 명령은 dispose 뒤 새 엔진이 시작해도 들어가지 않는다', async () => {
    remote(false)
    seed([runOf(11)])
    const h = harness()
    await h.start()
    const p = await toPane(h)
    expect(run().status).toBe('running')
    h.engine.dispose()
    const h2 = harness()
    await h2.start()
    expect(takeLaunch(p)).toBeUndefined()
    expect(run().status).toBe('interrupted')
  })
})
