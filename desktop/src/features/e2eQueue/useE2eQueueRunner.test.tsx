// E2E 큐 실행기 — 작업 시작·단계 진행(결과 파일 + 에이전트 상태)·실패·확인 필요 표시. 가짜 타이머로 3초 폴링을 돌린다
import { act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { IssueTarget } from '@minmo/core'

import { hostOf } from '../../app/host'
import { useHostsStore } from '../../store/hosts'
import { useSetupStore } from '../../store/setup'
import { useUiStore } from '../../store/ui'
import { createFakeTauri, deferred, fail, ok } from '../../test/fakes'
import { makeDeps, renderHookWithDeps } from '../../test/render'
import { issueOfPane, useAgentStore } from '../agents/agentStore'
import type { AgentKind, Activity } from '../agents/detect'
import { DEFAULT_AGENT_COMMANDS } from '../agents/launch'
import { takeLaunch } from '../agents/launchQueue'
import { leafIds } from '../terminal/panes'
import { useE2eQueueStore } from './queueStore'
import type { E2eJob } from './queueStore'
import type { E2eRoles } from './roles'
import { useE2eQueueRunner } from './useE2eQueueRunner'

const A = 'acme/app#1'
const B = 'acme/app#2'
const PATH_A = '/w/app-1'
const PATH_B = '/w/app-2'
const R_PATH = '/home/r/w/app-1'
const RID = hostOf('srv').issueId('acme', 'app', '1')
const PROBE = { platform: 'linux' as const, home: '/home/r', git: 'git version 2.43.0', tmux: false }

const ROLES: E2eRoles = {
  run: { kind: 'claude', model: '', prompt: 'run {issue} -> {out}' },
  edge: { kind: 'claude', model: '', prompt: 'edge {prev} -> {out}' },
  verify: { kind: 'claude', model: '', prompt: 'verify {prev} -> {out}' },
}
const OUT = ['1-run.md', '2-edge-cases.md', '3-verify.md'] as const
const outRel = (jobId: string, stage: 0 | 1 | 2) => `.minmo/e2e/${jobId}/${OUT[stage]}`

const target = (n: number): IssueTarget => ({ owner: 'acme', repo: 'app', key: String(n), number: n, title: `로그인 ${n}` })

/** 작업 폴더가 열림(ready) */
function ready(id: string, path: string, n = 1) {
  useSetupStore.setState((s) => ({
    open: { ...s.open, [id]: { phase: 'ready', path, branch: `b${n}`, pathChanged: false } },
    targets: { ...s.targets, [id]: target(n) },
  }))
  useUiStore.setState((s) => ({ worktreePathMap: { ...s.worktreePathMap, [id]: { path, branch: `b${n}` } } }))
}

/** 결과 파일(상대 경로) → version 또는 읽기 오류 */
let files: Map<string, string | Error>
const hasFile = (abs: string) => [...files.keys()].some((rel) => abs.replace(/\\/g, '/').endsWith(`/${rel}`))

function mount(overrides: Parameters<typeof createFakeTauri>[0] = {}) {
  const { tauri } = createFakeTauri({
    pathExists: async (p) => hasFile(p),
    readTextFile: async (_root, rel) => {
      const v = files.get(rel)
      if (v === undefined) throw new Error('파일이 아닙니다')
      if (v instanceof Error) throw v
      return { content: 'result', version: v }
    },
    // 원격: test -e(있음/없음), sh -s READ_TEXT(첫 줄 version), 그 밖(쓰기 등)은 성공
    sshExec: async (_h, argv) => {
      if (argv[0] === 'test') return hasFile(argv[2]) ? ok() : fail('', 1)
      if (argv[0] === 'sh' && argv[1] === '-s' && argv.length === 5) {
        const v = files.get(argv[4])
        return typeof v === 'string' ? ok(`${v}\nresult`) : fail('파일이 아닙니다', 1)
      }
      return ok('v0')
    },
    ...overrides,
  })
  renderHookWithDeps(() => useE2eQueueRunner(), makeDeps({ tauri }))
  return tauri
}

const q = () => useE2eQueueStore.getState()
/** 그 이슈의 가장 최근 작업 */
const jobOf = (issueId: string): E2eJob =>
  q()
    .jobs.filter((j) => j.issueId === issueId)
    .at(-1)!
const paneOf = (issueId: string, stage: 0 | 1 | 2): string => {
  const p = jobOf(issueId).panes[stage]
  if (p === null) throw new Error(`stage ${stage} 패널 없음`)
  return p
}

/** 폴링 간격(3초)만큼(또는 ms 만큼) 시간을 보낸다 */
const tick = (ms = 3000) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })

/** 패널의 터미널이 떠서(TerminalTab) 맡긴 명령을 꺼냈다 */
function terminalUp(paneId: string, ptyId = `pty-${paneId}`): string | undefined {
  const cmd = takeLaunch(paneId)
  useUiStore.setState((s) => ({ terminalIds: { ...s.terminalIds, [paneId]: ptyId } }))
  return cmd
}

function terminalDown(paneId: string) {
  useUiStore.setState((s) => {
    const terminalIds = { ...s.terminalIds }
    delete terminalIds[paneId]
    return { terminalIds }
  })
}

/** 에이전트 추적기(useAgentTracker)가 그 패널의 에이전트를 감지했다 */
function agent(paneId: string, activity: Activity, kind: AgentKind = 'claude') {
  useAgentStore
    .getState()
    .set(paneId, {
      paneId,
      issueId: issueOfPane(paneId),
      agent: kind,
      program: kind,
      label: '',
      activity,
      unseen: false,
      lastOutputAt: 0,
      since: 0,
    })
}

const noAgent = (paneId: string) => useAgentStore.getState().set(paneId, null)

function useRemote(probe = true) {
  useHostsStore.setState({ probes: probe ? { srv: PROBE } : {} })
  ready(RID, R_PATH)
}

beforeEach(() => {
  vi.useFakeTimers()
  files = new Map()
  localStorage.clear()
  useE2eQueueStore.setState({ jobs: [] })
  useUiStore.setState({
    panes: {},
    terminalIds: {},
    startedTerminals: {},
    focusRequest: null,
    worktreePathMap: {},
    e2eRoles: ROLES,
    agentCommands: DEFAULT_AGENT_COMMANDS,
  })
  useSetupStore.setState({ open: {}, targets: {} })
  useAgentStore.setState({ panes: {}, subagents: {} })
  useHostsStore.setState({ probes: {} })
})

afterEach(() => {
  // 다음 테스트에 맡긴 명령이 남지 않게
  for (const id of [A, B, RID]) for (let i = 1; i <= 8; i++) takeLaunch(`${id}::${i}`)
  vi.useRealTimers()
})

describe('작업 시작', () => {
  // AC-02
  it('AC-02 실행 중인 작업이 없으면 맨 앞 대기 작업이 시작되고, 한 번에 하나만 실행한다', async () => {
    ready(A, PATH_A, 1)
    ready(B, PATH_B, 2)
    mount()
    q().enqueue(A, '#1')
    q().enqueue(B, '#2')
    await tick()
    expect(jobOf(A).status).toBe('running')
    expect(jobOf(B).status).toBe('queued')
    expect(useUiStore.getState().panes[B]).toBeUndefined()
    q().fail(jobOf(A).id, '테스트')
    await tick()
    expect(jobOf(B).status).toBe('running')
  })

  // AC-03
  it('AC-03 시작 전 .minmo/e2e/<jobId>/.gitignore(*)를 만들고, 그 이슈의 새 패널에 역할 명령을 맡긴다', async () => {
    ready(A, PATH_A)
    const tauri = mount()
    q().enqueue(A, '#1')
    await tick()
    const job = jobOf(A)
    expect(job).toMatchObject({ status: 'running', stage: 0 })
    expect(
      tauri.writeTextFile.mock.calls.some(
        ([root, rel, content]) => root === PATH_A && rel === `.minmo/e2e/${job.id}/.gitignore` && /^\*\s*$/.test(content),
      ),
    ).toBe(true)
    const pane = paneOf(A, 0)
    expect(leafIds(useUiStore.getState().panes[A]?.tree ?? null)).toContain(pane)
    const cmd = takeLaunch(pane)
    expect(cmd).toMatch(/^claude '/)
    expect(cmd).toContain('#1 로그인 1')
    expect(cmd).toContain(`.minmo/e2e/${job.id}/1-run.md`)
  })

  // EC-01
  it('EC-01 작업 폴더가 열려 있지 않으면 실패 "작업 폴더가 열려 있지 않습니다" 후 다음 작업으로', async () => {
    useSetupStore.setState({ open: { [A]: { phase: 'opening' } }, targets: { [A]: target(1) } })
    ready(B, PATH_B, 2)
    mount()
    q().enqueue(A, '#1')
    q().enqueue(B, '#2')
    await tick(6000)
    expect(jobOf(A).status).toBe('failed')
    expect(jobOf(A).error).toContain('작업 폴더가 열려 있지 않습니다')
    expect(jobOf(B).status).toBe('running')
  })

  // EC-09
  it('EC-09 .gitignore 를 만들지 못하면 작업 실패(사유 표시) — 패널을 만들지 않는다', async () => {
    ready(A, PATH_A)
    mount({
      writeTextFile: async () => {
        throw new Error('permission denied')
      },
    })
    q().enqueue(A, '#1')
    await tick()
    expect(jobOf(A).status).toBe('failed')
    expect(jobOf(A).error).toContain('permission denied')
    expect(jobOf(A).panes[0]).toBeNull()
    expect(useUiStore.getState().panes[A]).toBeUndefined()
  })

  // EC-21
  it('EC-21 비동기 시작 중에 취소하면 패널·명령을 만들지 않는다', async () => {
    ready(A, PATH_A)
    const write = deferred<string>()
    mount({ writeTextFile: () => write.promise })
    q().enqueue(A, '#1')
    await tick()
    q().cancel(jobOf(A).id)
    write.resolve('v1')
    await tick()
    expect(jobOf(A).status).toBe('cancelled')
    expect(leafIds(useUiStore.getState().panes[A]?.tree ?? null)).toEqual([])
  })

  // EC-14 — 시작 시
  it('EC-14 원격 호스트 작업인데 연결 정보(probe)가 없으면 실패 "원격 호스트에 연결되지 않았습니다"', async () => {
    useRemote(false)
    mount()
    q().enqueue(RID, '#1')
    await tick()
    expect(jobOf(RID).status).toBe('failed')
    expect(jobOf(RID).error).toContain('원격 호스트에 연결되지 않았습니다')
  })

  // EC-15
  it('EC-15 원격 호스트 이슈는 첫 패널(기존 tmux 세션)을 쓰지 않는다', async () => {
    useRemote()
    mount()
    q().enqueue(RID, '#1')
    await tick()
    expect(jobOf(RID).status).toBe('running')
    const first = useUiStore.getState().panes[RID]?.first
    expect(first).toBeDefined()
    expect(paneOf(RID, 0)).not.toBe(first)
  })
})

describe('단계 완료 판정 (AC-05)', () => {
  // AC-05 — 감지됨 + idle + 결과 파일 안정 → 다음 단계
  it('AC-05 결과 파일이 있고 version 이 그대로이며 에이전트가 idle 이면 다음 단계를 새 패널로 시작한다', async () => {
    ready(A, PATH_A)
    mount()
    q().enqueue(A, '#1')
    await tick()
    const p0 = paneOf(A, 0)
    terminalUp(p0)
    agent(p0, 'idle')
    files.set(outRel(jobOf(A).id, 0), 'v1')
    await tick(15_000)
    expect(jobOf(A)).toMatchObject({ status: 'running', stage: 1 })
    expect(paneOf(A, 1)).not.toBe(p0)
  })

  // AC-05 — ③ 완료 → 작업 완료, 다음 작업 시작
  it('AC-05 ③까지 끝나면 작업 완료, 다음 작업 시작 — 다음 단계 지시문에는 앞 단계 결과 파일이 들어간다', async () => {
    ready(A, PATH_A, 1)
    ready(B, PATH_B, 2)
    mount()
    q().enqueue(A, '#1')
    q().enqueue(B, '#2')
    await tick()
    const id = jobOf(A).id
    const cmds: (string | undefined)[] = []
    for (const stage of [0, 1, 2] as const) {
      const pane = paneOf(A, stage)
      cmds.push(terminalUp(pane))
      agent(pane, 'idle')
      files.set(outRel(id, stage), 'v1')
      await tick(15_000)
    }
    expect(cmds[1]).toContain(`.minmo/e2e/${id}/2-edge-cases.md`)
    expect(cmds[1]).toContain(`.minmo/e2e/${id}/1-run.md`)
    expect(jobOf(A).status).toBe('done')
    expect(jobOf(B).status).toBe('running')
  })

  // AC-05 — 한 번도 감지 안 됨(원격 + codex): 결과 파일 version 이 20초 이상 그대로면 완료
  it('AC-05 원격 codex 처럼 상태를 감지하지 못하면 결과 파일 version 이 20초 이상 그대로일 때 완료("상태 감지 불가")', async () => {
    useRemote()
    useUiStore.setState({ e2eRoles: { ...ROLES, run: { kind: 'codex', model: '', prompt: 'run {out}' } } })
    mount()
    q().enqueue(RID, '#1')
    await tick()
    terminalUp(paneOf(RID, 0))
    files.set(outRel(jobOf(RID).id, 0), 'v1')
    await tick(9000)
    expect(jobOf(RID)).toMatchObject({ status: 'running', stage: 0, notice: 'undetected' })
    await tick(30_000)
    expect(jobOf(RID)).toMatchObject({ status: 'running', stage: 1 })
  })

  // AC-05 — 터미널이 잠깐 내려감: 판정하지 않고 기다림(실패·조기 완료 없음)
  it('AC-05 터미널이 잠깐 내려간(terminalIds 없음) 동안은 실패도 완료도 하지 않고, 다시 뜨면 판정한다', async () => {
    ready(A, PATH_A)
    mount()
    q().enqueue(A, '#1')
    await tick()
    const p0 = paneOf(A, 0)
    terminalUp(p0, 'pty-1')
    agent(p0, 'idle')
    await tick()
    terminalDown(p0)
    files.set(outRel(jobOf(A).id, 0), 'v1')
    await tick(15_000)
    expect(jobOf(A)).toMatchObject({ status: 'running', stage: 0 })
    useUiStore.setState((s) => ({ terminalIds: { ...s.terminalIds, [p0]: 'pty-1' } }))
    await tick(15_000)
    expect(jobOf(A)).toMatchObject({ status: 'running', stage: 1 })
  })

  // AC-05 — 감지된 적 있는데 사라짐 = 에이전트 종료 → 자동 완료하지 않음
  it('AC-05 감지됐던 에이전트가 폴링 3회 연속 없으면 종료로 보고 자동 완료하지 않는다("에이전트가 종료됨")', async () => {
    ready(A, PATH_A)
    mount()
    q().enqueue(A, '#1')
    await tick()
    const p0 = paneOf(A, 0)
    terminalUp(p0)
    agent(p0, 'working')
    await tick()
    noAgent(p0)
    files.set(outRel(jobOf(A).id, 0), 'v1')
    await tick(30_000)
    expect(jobOf(A)).toMatchObject({ status: 'running', stage: 0, notice: 'exited' })
  })

  // EC-03
  it('EC-03 결과 파일이 생겼어도 에이전트가 아직 working 이면 기다린다', async () => {
    ready(A, PATH_A)
    mount()
    q().enqueue(A, '#1')
    await tick()
    const p0 = paneOf(A, 0)
    terminalUp(p0)
    agent(p0, 'working')
    files.set(outRel(jobOf(A).id, 0), 'v1')
    await tick(30_000)
    expect(jobOf(A)).toMatchObject({ status: 'running', stage: 0 })
  })
})

describe('결과 파일 확인 (EC-10)', () => {
  // EC-10 — 없음
  it('EC-10 결과 파일이 없으면(pathExists false) 실패하지 않고 계속 폴링한다', async () => {
    ready(A, PATH_A)
    const tauri = mount()
    q().enqueue(A, '#1')
    await tick()
    const p0 = paneOf(A, 0)
    terminalUp(p0)
    agent(p0, 'idle')
    tauri.pathExists.mockClear()
    await tick(30_000)
    expect(jobOf(A)).toMatchObject({ status: 'running', stage: 0 })
    expect(tauri.pathExists.mock.calls.length).toBeGreaterThanOrEqual(5)
  })

  // EC-10 — file_too_large·file_binary 는 있는 것으로
  it.each([['file_too_large: 2MB 보다 큰 파일은 열 수 없습니다'], ['file_binary: UTF-8 텍스트 파일이 아닙니다']])(
    'EC-10 읽기 오류 %s 는 결과 파일이 있는 것으로 본다(연속 확인 2회)',
    async (err) => {
      ready(A, PATH_A)
      mount()
      q().enqueue(A, '#1')
      await tick()
      const p0 = paneOf(A, 0)
      terminalUp(p0)
      agent(p0, 'idle')
      files.set(outRel(jobOf(A).id, 0), new Error(err))
      await tick(15_000)
      expect(jobOf(A)).toMatchObject({ status: 'running', stage: 1 })
    },
  )

  // EC-10 — 그 밖의 오류 5회 연속
  it('EC-10 그 밖의 읽기 오류가 5회 연속이면 실패 "결과 파일을 확인하지 못했습니다: …"', async () => {
    ready(A, PATH_A)
    mount()
    q().enqueue(A, '#1')
    await tick()
    const p0 = paneOf(A, 0)
    terminalUp(p0)
    agent(p0, 'idle')
    files.set(outRel(jobOf(A).id, 0), new Error('EACCES: permission denied'))
    await tick(9000)
    expect(jobOf(A).status).toBe('running')
    await tick(12_000)
    expect(jobOf(A).status).toBe('failed')
    expect(jobOf(A).error).toContain('결과 파일을 확인하지 못했습니다')
    expect(jobOf(A).error).toContain('EACCES: permission denied')
  })
})

describe('실행 중 실패·확인 필요', () => {
  // EC-02
  it('EC-02 실행 중 단계 패널이 닫히면 실패 "터미널 패널이 닫혔습니다"', async () => {
    ready(A, PATH_A)
    mount()
    q().enqueue(A, '#1')
    await tick()
    const p0 = paneOf(A, 0)
    terminalUp(p0)
    await tick()
    useUiStore.getState().closePane(A, p0)
    await tick()
    expect(jobOf(A).status).toBe('failed')
    expect(jobOf(A).error).toContain('터미널 패널이 닫혔습니다')
  })

  // EC-18
  it('EC-18 단계 패널의 터미널(ptyId)이 처음 본 값과 다른 값이 되면 실패 "터미널 패널이 닫혔습니다"', async () => {
    ready(A, PATH_A)
    mount()
    q().enqueue(A, '#1')
    await tick()
    const p0 = paneOf(A, 0)
    terminalUp(p0, 'pty-1')
    await tick()
    useUiStore.setState((s) => ({ terminalIds: { ...s.terminalIds, [p0]: 'pty-9' } }))
    await tick()
    expect(jobOf(A).status).toBe('failed')
    expect(jobOf(A).error).toContain('터미널 패널이 닫혔습니다')
  })

  // EC-19
  it('EC-19 작업 폴더 삭제·이슈 키 변경으로 그 이슈의 패널 구성이 사라지면 실패 "터미널 패널이 닫혔습니다"', async () => {
    ready(A, PATH_A)
    mount()
    q().enqueue(A, '#1')
    await tick()
    terminalUp(paneOf(A, 0))
    await tick()
    useUiStore.setState((s) => {
      const panes = { ...s.panes }
      delete panes[A]
      return { panes }
    })
    await tick()
    expect(jobOf(A).status).toBe('failed')
    expect(jobOf(A).error).toContain('터미널 패널이 닫혔습니다')
  })

  // EC-12
  it('EC-12 명령을 맡긴 뒤 110초가 지나도 입력 대기면(터미널이 안 뜸) 실패 "터미널을 띄우지 못했습니다"', async () => {
    ready(A, PATH_A)
    mount()
    q().enqueue(A, '#1')
    await tick()
    await tick(100_000)
    expect(jobOf(A).status).toBe('running')
    await tick(16_000)
    expect(jobOf(A).status).toBe('failed')
    expect(jobOf(A).error).toContain('터미널을 띄우지 못했습니다')
  })

  // EC-12b
  it('EC-12b 명령은 꺼냈지만 60초 동안 감지도 결과 파일도 없으면 실패시키지 않고 "확인 필요"(unknown)', async () => {
    ready(A, PATH_A)
    mount()
    q().enqueue(A, '#1')
    await tick()
    terminalUp(paneOf(A, 0))
    await tick(65_000)
    expect(jobOf(A)).toMatchObject({ status: 'running', stage: 0, notice: 'unknown' })
  })

  // EC-14 — 실행 중
  it('EC-14 실행 중 원격 연결 정보가 없어지면 그 회차 확인을 건너뛰고(파일 접근 없음) 연결 대기로 표시한다', async () => {
    useRemote()
    const tauri = mount()
    q().enqueue(RID, '#1')
    await tick()
    terminalUp(paneOf(RID, 0))
    files.set(outRel(jobOf(RID).id, 0), 'v1')
    useHostsStore.setState({ probes: {} })
    tauri.sshExec.mockClear()
    tauri.pathExists.mockClear()
    await tick(9000)
    expect(jobOf(RID)).toMatchObject({ status: 'running', stage: 0, waitingHost: true })
    expect(tauri.sshExec).not.toHaveBeenCalled()
    expect(tauri.pathExists).not.toHaveBeenCalled()
  })

  // EC-23
  it('EC-23 확인 필요 표시는 매 폴링 다시 계산한다 — attention 이면 설정, 풀리면 해제', async () => {
    ready(A, PATH_A)
    mount()
    q().enqueue(A, '#1')
    await tick()
    const p0 = paneOf(A, 0)
    terminalUp(p0)
    agent(p0, 'attention')
    await tick()
    expect(jobOf(A).notice).toBe('attention')
    agent(p0, 'working')
    await tick()
    expect(jobOf(A).notice).toBeUndefined()
  })
})

describe('scope 결함 회귀(M-1·L-2·L-3)', () => {
  // M-1 (D-7·AC-02)
  it('M-1 ① 터미널이 뜨기 전에 [다음 단계]를 누르면 ① 명령은 지워지고 ②는 새 분할 패널에서 시작한다', async () => {
    ready(A, PATH_A)
    mount()
    q().enqueue(A, '#1')
    await tick()
    const p0 = paneOf(A, 0)
    q().advance(jobOf(A).id, 0)
    await tick()
    const p1 = paneOf(A, 1)
    expect(p1).not.toBe(p0)
    expect(leafIds(useUiStore.getState().panes[A]?.tree ?? null)).toEqual(expect.arrayContaining([p0, p1]))
    // ① 패널이 나중에 떠도 ① 명령은 실행되지 않는다
    expect(takeLaunch(p0)).toBeUndefined()
    expect(takeLaunch(p1)).toMatch(/^claude '/)
  })

  // L-2 (AC-05 ⓑ)
  it('L-2 결과 파일 읽기 오류가 난 회차에는 앞 회차의 안정 판정으로 완료하지 않고, 다시 2회 연속 확인해야 완료한다', async () => {
    ready(A, PATH_A)
    mount()
    q().enqueue(A, '#1')
    await tick()
    const p0 = paneOf(A, 0)
    terminalUp(p0)
    agent(p0, 'working')
    files.set(outRel(jobOf(A).id, 0), 'v1')
    await tick(9000)
    expect(jobOf(A)).toMatchObject({ status: 'running', stage: 0 })
    files.set(outRel(jobOf(A).id, 0), new Error('EACCES: permission denied'))
    agent(p0, 'idle')
    await tick()
    expect(jobOf(A)).toMatchObject({ status: 'running', stage: 0 })
    files.set(outRel(jobOf(A).id, 0), 'v1')
    await tick()
    expect(jobOf(A)).toMatchObject({ status: 'running', stage: 0 })
    await tick()
    expect(jobOf(A)).toMatchObject({ status: 'running', stage: 1 })
  })

  // L-3 (EC-12)
  it('L-3 재마운트 사이 TTL 로 명령이 버려져 입력 대기도 터미널도 없으면 110초 뒤 실패 "터미널을 띄우지 못했습니다"', async () => {
    ready(A, PATH_A)
    const deps = () => makeDeps({ tauri: createFakeTauri().tauri })
    const first = renderHookWithDeps(() => useE2eQueueRunner(), deps())
    q().enqueue(A, '#1')
    await tick()
    expect(jobOf(A).panes[0]).not.toBeNull()
    await tick(57_000)
    first.unmount()
    renderHookWithDeps(() => useE2eQueueRunner(), deps())
    // 맡긴 지 120초가 지나 명령이 버려진 뒤에도 실패 없이 멈춰 있으면 안 된다
    await tick(100_000)
    expect(jobOf(A).status).toBe('running')
    await tick(140_000)
    expect(jobOf(A).status).toBe('failed')
    expect(jobOf(A).error).toContain('터미널을 띄우지 못했습니다')
  })
})
