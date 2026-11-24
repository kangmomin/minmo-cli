// E2E 큐 실행기 — Workspace 에 한 번 마운트한다. 3초마다 맨 앞 대기 작업을 시작하고, 실행 중 단계의 결과 파일·에이전트 상태로 다음 단계를 연다.
// 큐는 화면마다 따로 있다(EC-20) — 원격 접속 화면도 자기 큐만 돌린다. 다른 화면에서 패널을 닫으면 이 화면의 작업은 EC-02 로 실패한다
import { useEffect } from 'react'

import { aliasOfIssue, hostOf, useHostDeps } from '../../app/host'
import type { AppDeps } from '../../app/deps'
import { useHostsStore } from '../../store/hosts'
import { useSetupStore } from '../../store/setup'
import { useUiStore } from '../../store/ui'
import { leafIds } from '../terminal/panes'
import { useAgentStore } from '../agents/agentStore'
import type { PaneAgent } from '../agents/agentStore'
import { defaultPrompt } from '../agents/launch'
import type { ShellKind } from '../agents/launch'
import { cancelLaunch, isLaunchPending, queueLaunch } from '../agents/launchQueue'
import { useE2eQueueStore } from './queueStore'
import type { E2eJob, JobNotice, JobStage } from './queueStore'
import { E2E_ROLES, buildRoleCommand, resultFile } from './roles'
import type { RoleKind } from './roles'

const POLL_MS = 3000
/** 명령을 맡긴 뒤 이만큼 지나도 입력 대기면 터미널이 뜨지 않은 것이다 — 대기열 TTL(120초)보다 짧게(EC-12) */
const LAUNCH_START_MS = 110_000
/** 명령을 꺼낸 뒤 이만큼 감지도 결과 파일도 없으면 "확인 필요"(EC-12b) */
const NO_SIGNAL_MS = 60_000
/** 에이전트를 감지하지 못한 단계는 결과 파일이 이만큼 그대로면 끝난 것으로 본다(AC-05 ⓒ) */
const UNDETECTED_STABLE_MS = 20_000
/** 감지됐던 에이전트가 이 횟수만큼 연속으로 없으면 종료로 본다 */
const EXIT_POLLS = 3
/** 결과 파일 읽기 오류가 이 횟수만큼 연속이면 실패(EC-10) */
const READ_ERROR_POLLS = 5

const PANE_CLOSED = '터미널 패널이 닫혔습니다'
const LAUNCH_FAILED = '터미널을 띄우지 못했습니다 — 이슈 화면을 열어 두세요'

/** 단계 하나를 지켜본 기록 — 화면 상태가 아니라 runner 안에만 둔다(재마운트하면 처음부터 다시 쌓는다) */
type Watch = {
  key: string
  paneId: string
  kind: RoleKind
  queuedAt: number
  /** 명령이 꺼내진 것을 처음 본 시각 */
  takenAt: number | null
  /** 명령이 입력 대기도 아니고 터미널 id 도 없는 상태가 시작된 시각(EC-12) */
  noPtySince: number | null
  /** 처음 본 터미널 id — 다른 값이 되면 패널이 새로 만들어진 것이다(EC-18) */
  ptyId: string | null
  /** 이 단계에서 에이전트가 감지된 적 있음 */
  detected: boolean
  missing: number
  /** 결과 파일의 version(크기 초과·바이너리는 고정 표시) · 그 값을 처음 본 시각 · 연속으로 본 횟수 */
  fileKey: string | null
  fileSince: number
  fileSeen: number
  readErrors: number
}

const watchKey = (job: E2eJob) => `${job.id}\n${job.stage}`
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))
/** 열 수는 없지만 있는 파일 — version 대신 연속 확인 횟수로 본다 */
const PRESENT_NO_VERSION = '\0present'

/** 역할의 CLI(또는 이름을 모르는 프로그램)가 그 패널에서 돌고 있는가 */
const isDetected = (p: PaneAgent | undefined, kind: RoleKind) => p !== undefined && (p.agent === kind || p.agent === 'other')

const currentJob = (id: string) => useE2eQueueStore.getState().jobs.find((j) => j.id === id)
/** await 뒤에도 그 작업이 같은 단계를 실행 중인가(EC-13·EC-21) */
const stillAt = (id: string, stage: JobStage) => {
  const j = currentJob(id)
  return j !== undefined && j.status === 'running' && j.stage === stage
}

export function useE2eQueueRunner(): void {
  const hostDeps = useHostDeps()

  useEffect(() => {
    let disposed = false
    let busy = false
    let watch: Watch | null = null

    const q = () => useE2eQueueStore.getState()

    /** 원격 이슈인데 연결 정보가 없으면 null — 그때 hostDeps 는 이 PC 를 돌려주므로 쓰면 안 된다 */
    function depsOf(issueId: string): AppDeps | null {
      const alias = aliasOfIssue(issueId)
      if (alias !== null && !useHostsStore.getState().probes[alias]) return null
      return hostDeps(hostOf(alias))
    }

    function failJob(job: E2eJob, error: string) {
      const pane = job.panes[job.stage]
      // 실패한 작업의 명령이 나중에 터미널이 떠서 실행되지 않게
      if (pane !== null) cancelLaunch(pane)
      q().fail(job.id, error)
      watch = null
    }

    function readyPath(issueId: string): string | null {
      const o = useSetupStore.getState().open[issueId]
      return o?.phase === 'ready' ? o.path : null
    }

    /** 단계 시작 — 그 이슈의 새 패널에 역할 명령을 맡긴다. 포커스는 옮기지 않는다(A-12) */
    function startStage(job: E2eJob) {
      const alias = aliasOfIssue(job.issueId)
      const deps = depsOf(job.issueId)
      if (deps === null) {
        q().setWaitingHost(job.id, job.stage, true)
        return
      }
      q().setWaitingHost(job.id, job.stage, false)
      const role = E2E_ROLES[job.stage]
      const ui = useUiStore.getState()
      const cfg = ui.e2eRoles[role]
      const target = useSetupStore.getState().targets[job.issueId]
      const ctx = {
        issue: (target && defaultPrompt(target)) || job.title,
        out: resultFile(job.id, role),
        prev: E2E_ROLES.slice(0, job.stage)
          .map((r) => resultFile(job.id, r))
          .join(' '),
      }
      // 이 PC(Windows)의 터미널은 PowerShell, 원격·macOS·Linux 는 POSIX 셸(LaunchAgentDialog 와 같다)
      const shell: ShellKind = alias === null && deps.platform === 'win32' ? 'powershell' : 'posix'
      const built = buildRoleCommand(cfg, ui.agentCommands[cfg.kind], ctx, shell)
      if (!built.ok) {
        failJob(job, built.error)
        return
      }
      // 원격의 첫 패널은 남아 있던 tmux 세션에 다시 붙는다 → 쓰지 않는다(EC-15).
      // ②·③은 항상 새 분할 패널(D-7) — 앞 단계 터미널이 아직 안 떴으면 launchPane 이 그 칸을 다시 돌려주기 때문
      const paneId = ui.launchPane(job.issueId, alias !== null || job.stage > 0, { focus: false })
      queueLaunch(paneId, built.command)
      q().setStagePane(job.id, job.stage, paneId)
      watch = newWatch(job, paneId, cfg.kind, Date.now())
    }

    function newWatch(job: E2eJob, paneId: string, kind: RoleKind, queuedAt: number): Watch {
      return {
        key: watchKey(job),
        paneId,
        kind,
        queuedAt,
        takenAt: null,
        noPtySince: null,
        ptyId: null,
        // 재마운트·단계 시작 때 지금 상태를 한 번 본다. 이후는 구독으로 기록한다
        detected: isDetected(useAgentStore.getState().panes[paneId], kind),
        missing: 0,
        fileKey: null,
        fileSince: 0,
        fileSeen: 0,
        readErrors: 0,
      }
    }

    /** 작업 시작 준비 — 작업 폴더·원격 연결 확인, 결과 폴더를 git 에서 숨긴다. 실패하면 false */
    async function prepare(job: E2eJob): Promise<boolean> {
      const path = readyPath(job.issueId)
      if (path === null) {
        failJob(job, '작업 폴더가 열려 있지 않습니다')
        return false
      }
      const deps = depsOf(job.issueId)
      if (deps === null) {
        failJob(job, '원격 호스트에 연결되지 않았습니다')
        return false
      }
      try {
        await deps.tauri.writeTextFile(path, `.minmo/e2e/${job.id}/.gitignore`, '*\n')
      } catch (e) {
        if (stillAt(job.id, 0)) failJob(job, `결과 폴더를 만들지 못했습니다: ${errText(e)}`)
        return false
      }
      return !disposed && stillAt(job.id, 0)
    }

    type FileState = { kind: 'none' } | { kind: 'present'; key: string } | { kind: 'error'; message: string }

    async function checkFile(deps: AppDeps, root: string, rel: string): Promise<FileState> {
      const sep = deps.platform === 'win32' ? '\\' : '/'
      try {
        if (!(await deps.tauri.pathExists(`${root}${sep}${rel.split('/').join(sep)}`))) return { kind: 'none' }
        const f = await deps.tauri.readTextFile(root, rel)
        // 빈 파일은 아직 결과가 아니다(ⓐ)
        return f.content.trim() === '' ? { kind: 'none' } : { kind: 'present', key: f.version }
      } catch (e) {
        const message = errText(e)
        if (/^file_(too_large|binary)\b/.test(message)) return { kind: 'present', key: PRESENT_NO_VERSION }
        return { kind: 'error', message }
      }
    }

    /** 실행 중 단계 판정(AC-05) — 끝났으면 다음 단계로 넘기고 true */
    async function poll(job: E2eJob): Promise<boolean> {
      const paneId = job.panes[job.stage]!
      // 재마운트로 기록을 잃었으면 지금 역할 설정으로 다시 지켜본다
      if (watch?.key !== watchKey(job) || watch.paneId !== paneId) watch = newWatch(job, paneId, useUiStore.getState().e2eRoles[E2E_ROLES[job.stage]].kind, Date.now())
      const w = watch
      const kind = w.kind
      const ui = useUiStore.getState()

      // 패널이 닫혔거나 이슈의 패널 구성이 사라짐(EC-02·EC-19)
      if (!leafIds(ui.panes[job.issueId]?.tree ?? null).includes(paneId)) {
        failJob(job, PANE_CLOSED)
        return true
      }
      // 같은 패널 id 에 새 터미널이 떴다(EC-18). 값 없음은 잠깐 내려간 것이라 기다린다
      const ptyId = ui.terminalIds[paneId] ?? null
      if (ptyId !== null) {
        if (w.ptyId !== null && w.ptyId !== ptyId) {
          failJob(job, PANE_CLOSED)
          return true
        }
        w.ptyId = ptyId
      }
      const now = Date.now()
      if (isLaunchPending(paneId)) {
        if (now - w.queuedAt >= LAUNCH_START_MS) {
          failJob(job, LAUNCH_FAILED)
          return true
        }
        return false
      }
      w.takenAt ??= now
      if (ptyId === null) {
        // 재마운트로 queuedAt 이 늦춰진 사이 TTL 로 명령이 버려지면 입력 대기도 터미널도 없이 멈춘다 — 같은 시간 기준으로 실패시킨다(EC-12).
        // 터미널이 한 번 뜬 뒤 내려간 것은 재접속(#89) 중일 수 있어 기다린다(AC-05)
        w.noPtySince ??= now
        if (w.ptyId === null && now - w.noPtySince >= LAUNCH_START_MS) {
          failJob(job, LAUNCH_FAILED)
          return true
        }
        return false
      }
      w.noPtySince = null

      const deps = depsOf(job.issueId)
      if (deps === null) {
        // 그 회차는 건너뛴다 — 연결 정보 없이 파일에 접근하면 이 PC 를 보게 된다(EC-14)
        q().setWaitingHost(job.id, job.stage, true)
        return false
      }
      q().setWaitingHost(job.id, job.stage, false)

      const agent = useAgentStore.getState().panes[paneId]
      const detectedNow = isDetected(agent, kind)
      if (detectedNow) {
        w.detected = true
        w.missing = 0
      } else if (w.detected) w.missing++

      const root = readyPath(job.issueId)
      const file: FileState = root === null ? { kind: 'none' } : await checkFile(deps, root, resultFile(job.id, E2E_ROLES[job.stage]))
      if (disposed || watch !== w || !stillAt(job.id, job.stage)) return false

      if (file.kind === 'error') {
        // 이번 회차에 현재 파일을 보지 못했다 — 앞 회차의 안정 판정으로 완료하지 않게 처음부터 다시 센다(AC-05 ⓑ)
        w.fileKey = null
        w.fileSeen = 0
        w.readErrors++
        if (w.readErrors >= READ_ERROR_POLLS) {
          failJob(job, `결과 파일을 확인하지 못했습니다: ${file.message}`)
          return true
        }
      } else {
        w.readErrors = 0
        if (file.kind === 'none') {
          w.fileKey = null
          w.fileSeen = 0
        } else if (file.key === w.fileKey) w.fileSeen++
        else {
          // 쓰는 중이면 version 이 바뀐다 — 처음 본 값부터 다시 센다(ⓑ)
          w.fileKey = file.key
          w.fileSince = now
          w.fileSeen = 1
        }
      }
      const hasFile = w.fileKey !== null
      const stable = w.fileSeen >= 2

      let notice: JobNotice | undefined
      let done = false
      if (detectedNow) {
        if (agent!.activity === 'attention') notice = 'attention'
        else if (agent!.activity === 'idle') done = hasFile && stable
      } else if (w.detected) {
        // 감지됐던 에이전트가 사라짐 = 종료(Ctrl+C 포함) — 미완성 결과가 넘어가지 않게 자동 완료하지 않는다
        if (w.missing >= EXIT_POLLS) notice = 'exited'
      } else if (hasFile) {
        // 한 번도 감지 못 함(원격 codex 등) — 결과 파일이 충분히 오래 그대로면 끝난 것으로 본다
        notice = 'undetected'
        done = stable && now - w.fileSince >= UNDETECTED_STABLE_MS
      } else if (now - (w.takenAt ?? now) >= NO_SIGNAL_MS) notice = 'unknown'

      if (done) {
        q().advance(job.id, job.stage)
        watch = null
        return true
      }
      q().setNotice(job.id, job.stage, notice)
      return false
    }

    /** 한 걸음 — 상태가 바뀌어 바로 다음 걸음을 할 만하면 true */
    async function step(): Promise<boolean> {
      let job = q().jobs.find((j) => j.status === 'running')
      if (!job) {
        const next = q().jobs.find((j) => j.status === 'queued')
        if (!next) return false
        q().start(next.id)
        job = currentJob(next.id)
        if (job?.status !== 'running') return false
      }
      if (job.panes[job.stage] !== null) return poll(job)
      if (job.stage === 0) {
        // 결과 폴더 준비는 ① 패널을 열기 전마다 한다(같은 내용이라 다시 써도 된다) — 준비 중 재마운트돼도 빠지지 않게
        if (!(await prepare(job))) return true
        job = currentJob(job.id)!
      } else if (readyPath(job.issueId) === null) {
        failJob(job, '작업 폴더가 열려 있지 않습니다')
        return true
      }
      startStage(job)
      return false
    }

    async function tick() {
      if (busy || disposed) return
      busy = true
      try {
        // 단계가 끝나면 같은 회차에 다음 단계(또는 다음 작업)를 연다 — 한 회차에 몇 걸음까지만
        for (let i = 0; i < 4 && !disposed; i++) if (!(await step())) break
      } catch (e) {
        // 예상 못 한 예외 — 그대로 두면 같은 작업에서 매 회차 멈춘다. 실행 중 작업을 실패로 돌려 다음 회차에 다음 작업으로 넘어간다
        const job = q().jobs.find((j) => j.status === 'running')
        if (job) failJob(job, `예상하지 못한 오류: ${errText(e)}`)
      } finally {
        busy = false
      }
    }

    // 폴링 사이에 잠깐 감지된 것도 "감지된 적 있음"으로 기록한다
    const unsubscribe = useAgentStore.subscribe((s) => {
      if (watch && isDetected(s.panes[watch.paneId], watch.kind)) watch.detected = true
    })
    const timer = setInterval(() => void tick(), POLL_MS)
    return () => {
      disposed = true
      clearInterval(timer)
      unsubscribe()
    }
  }, [hostDeps])
}
