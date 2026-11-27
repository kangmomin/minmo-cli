import type { QueryClient } from '@tanstack/react-query'

import type { Platform } from '@minmo/api-client'
import type { GitHubClient, IssueTarget } from '@minmo/core'

import { aliasOfIssue, hostOf, probeHost } from '../../app/host'
import { queryKeys } from '../../lib/queryKeys'
import type { PtyLinkEvent, PtyLinkPhase, TauriApi } from '../../lib/tauri'
import { useHostsStore, usesTmux, workHostAliasOf } from '../../store/hosts'
import { useSessionStore } from '../../store/session'
import { useSetupStore } from '../../store/setup'
import { useUiStore } from '../../store/ui'
import { useAgentStore } from '../agents/agentStore'
import { buildCommand, oneLine, shellFor } from '../agents/launch'
import type { BuiltCommand } from '../agents/launch'
import { cancelLaunch, clearLaunchResult, launchResult, queueLaunch } from '../agents/launchQueue'
import { describeOpenError } from '../issue/useWorktree'
import type { IssueActions } from '../issue/useWorktree'
import { leafIds } from '../terminal/panes'
import { TAKER_START_TIMEOUT_MS, canWrite, isActive, nextToStart, renderPrompt, stepProgress } from './taker'
import { splitKey, useTakerStore } from './takerStore'
import type { TakerRun, TakerStatus } from './takerStore'

export type TakerEngineDeps = {
  github: GitHubClient
  tauri: Pick<TauriApi, 'notify' | 'ptyWrite' | 'onPtyLink' | 'onPtyExit' | 'sshProbe'>
  actionsFor(alias: string | null): Pick<IssueActions, 'open'>
  queryClient: Pick<QueryClient, 'invalidateQueries'>
  getPlatform(): Platform
  now(): number
}

export type NextStepResult = 'started' | 'busy' | 'notReady'

export interface TakerEngine {
  start(now: number): void
  check(now: number): Promise<void>
  tick(now: number): Promise<void> | void
  stop(id: string): void
  restart(id: string): void
  nextStep(id: string): NextStepResult
  dispose(): void
}

const NOTE_HOST_WAIT = '호스트 연결 대기'
const NOTE_ASSIGN = 'assign 하지 못함'
const NOTE_WRITING = '명령 넣는 중'
const NOTE_SEP = ' · '
const RESTARTABLE: readonly TakerStatus[] = ['failed', 'interrupted', 'manualNext', 'stopped']

type RunMem = {
  attempt: number
  probed: boolean
  assigning: boolean
  openCalled: boolean
  openDone: boolean
  openSeen: boolean
  paneAt: number | null
  remoteNoTmux: boolean
  ptyId: string | null
  ptyAt: number
  staleBefore: number | null
  inFlight: boolean
  seen: boolean
  lastSeenAt: number
  wroteAt: number | null
}

const freshMem = (attempt: number): RunMem => ({
  attempt,
  probed: false,
  assigning: false,
  openCalled: false,
  openDone: false,
  openSeen: false,
  paneAt: null,
  remoteNoTmux: false,
  ptyId: null,
  ptyAt: 0,
  staleBefore: null,
  inFlight: false,
  seen: false,
  lastSeenAt: 0,
  wroteAt: null,
})

function joinNote(prev: string | null, add: string): string {
  if (prev === null || prev === '') return add
  return prev.split(NOTE_SEP).includes(add) ? prev : `${prev}${NOTE_SEP}${add}`
}

function dropNote(prev: string | null, drop: string): string | null {
  if (prev === null) return null
  const rest = prev.split(NOTE_SEP).filter((p) => p !== drop)
  return rest.length === 0 ? null : rest.join(NOTE_SEP)
}

const aliasOfRun = (run: TakerRun): string | null => (run.issueId === null ? null : aliasOfIssue(run.issueId))

export function createTakerEngine(deps: TakerEngineDeps): TakerEngine {
  const mems = new Map<string, RunMem>()
  const links = new Map<string, { phase: PtyLinkPhase; seq: number; at: number }>()
  const exited = new Set<string>()
  const tracked = new Set<string>()
  const checking = new Set<string>()
  const dirty = new Set<string>()
  const firstDone = new Set<string>()
  const unlisteners: (() => void)[] = []
  let started = false
  let disposed = false

  const getRun = (id: string) => useTakerStore.getState().runs.find((r) => r.id === id)
  const memOf = (id: string): RunMem => {
    let m = mems.get(id)
    if (!m) mems.set(id, (m = freshMem(0)))
    return m
  }
  const renew = (id: string): RunMem => {
    const m = freshMem(memOf(id).attempt + 1)
    mems.set(id, m)
    return m
  }
  const live = (id: string, attempt: number) => !disposed && mems.get(id)?.attempt === attempt

  // Why: persist 는 값이 같아도 set 마다 저장하므로, 바뀌는 것이 없으면 store 를 부르지 않는다
  function patch(id: string, p: Partial<TakerRun>) {
    const cur = getRun(id)
    if (!cur || (Object.keys(p) as (keyof TakerRun)[]).every((k) => cur[k] === p[k])) return
    useTakerStore.getState().updateRun(id, p)
  }

  function notify(run: TakerRun, title: string, paneId: string | null) {
    if (!useUiStore.getState().agentNotify) return
    const target = run.issueId !== null && paneId !== null ? { kind: 'local' as const, issueId: run.issueId, paneId } : undefined
    void deps.tauri.notify(title, `${run.owner}/${run.repo} — ${run.title}`, target).catch(() => undefined)
  }

  function fail(run: TakerRun, error: string, extra: Partial<TakerRun> = {}) {
    renew(run.id)
    patch(run.id, { ...extra, status: 'failed', error })
    notify(run, `#${run.number} 자동 실행 실패`, extra.paneId !== undefined ? extra.paneId : run.paneId)
  }

  function stopRun(run: TakerRun, note: string | null, extra: Partial<TakerRun> = {}) {
    renew(run.id)
    if (run.paneId !== null) cancelLaunch(run.paneId)
    patch(run.id, { ...extra, status: 'stopped', ...(note === null ? {} : { note: joinNote(run.note, note) }) })
  }

  function setLastCheck(key: string, at: number, error: string | null) {
    useTakerStore.setState((s) => ({ lastCheck: { ...s.lastCheck, [key]: { at, error } } }))
  }

  function observePty(run: TakerRun, m: RunMem, now: number) {
    if (run.paneId === null) return
    const ptyId = useUiStore.getState().terminalIds[run.paneId]
    if (ptyId === undefined) return
    if (ptyId === m.ptyId) {
      m.ptyAt = now
      return
    }
    // Why: 같은 패널에 새 PTY 가 뜨면 추적기가 다시 알 때까지 옛 PTY 의 셸 확인 시각이 남는다
    if (m.ptyId !== null) m.staleBefore = m.ptyAt
    m.ptyId = ptyId
    m.ptyAt = now
  }

  function shellSinceOf(paneId: string | null, m: RunMem): number | undefined {
    if (paneId === null) return undefined
    const at = useAgentStore.getState().shellSince[paneId]
    return at !== undefined && (m.staleBefore === null || at > m.staleBefore) ? at : undefined
  }

  function paneGone(run: TakerRun, m: RunMem): 'closed' | 'exited' | null {
    if (run.paneId === null || run.issueId === null || m.ptyId === null) return null
    if (!leafIds(useUiStore.getState().panes[run.issueId]?.tree ?? null).includes(run.paneId)) return 'closed'
    return exited.has(m.ptyId) ? 'exited' : null
  }

  function writablePty(run: TakerRun, m: RunMem, now: number): string | null {
    if (run.paneId === null) return null
    const ptyId = useUiStore.getState().terminalIds[run.paneId]
    if (ptyId === undefined || exited.has(ptyId)) return null
    const alias = aliasOfRun(run)
    if (alias === null) return canWrite({ shellSince: shellSinceOf(run.paneId, m), linkChangedAt: null, now }) ? ptyId : null
    const link = links.get(ptyId)
    if (link && link.phase !== 'connected') return null
    if (m.remoteNoTmux) return ptyId
    return canWrite({ shellSince: shellSinceOf(run.paneId, m), linkChangedAt: link?.at ?? null, now }) ? ptyId : null
  }

  function commandOf(run: TakerRun, step: number): BuiltCommand {
    const s = run.steps[step]
    if (!s) return { ok: false, error: '실행할 단계가 없습니다' }
    const prompt = renderPrompt(s.prompt, run)
    if (oneLine(prompt).startsWith('-')) return { ok: false, error: '지시문이 - 로 시작해 에이전트가 옵션으로 읽을 수 있어 넣지 않았습니다' }
    return buildCommand(s.command, prompt, shellFor(aliasOfRun(run), deps.getPlatform()))
  }

  function write(run: TakerRun, m: RunMem, step: number, ptyId: string) {
    const cmd = commandOf(run, step)
    if (!cmd.ok) {
      fail(run, cmd.error)
      return
    }
    m.inFlight = true
    const a = m.attempt
    let sent: Promise<void>
    try {
      sent = deps.tauri.ptyWrite(ptyId, `${cmd.command}\r`)
    } catch (e) {
      sent = Promise.reject(e)
    }
    sent.then(
      () => {
        if (!live(run.id, a)) return
        m.inFlight = false
        m.seen = false
        m.lastSeenAt = 0
        m.wroteAt = deps.now()
        const cur = getRun(run.id)
        if (!cur) return
        const last = step >= cur.steps.length - 1
        patch(run.id, { step, status: m.remoteNoTmux ? (last ? 'done' : 'manualNext') : 'running' })
        if (m.remoteNoTmux && last) renew(run.id)
      },
      () => {
        if (!live(run.id, a)) return
        m.inFlight = false
        fail(getRun(run.id) ?? run, '명령을 넣지 못함')
      },
    )
  }

  function hostReady(run: TakerRun): boolean {
    const hosts = useHostsStore.getState()
    const alias = workHostAliasOf(hosts, run.owner, run.repo)
    if (alias === null || hosts.probes[alias]) return true
    if (hosts.errors[alias]) {
      patch(run.id, { note: joinNote(run.note, NOTE_HOST_WAIT) })
      return false
    }
    const m = memOf(run.id)
    if (!m.probed) {
      m.probed = true
      void probeHost(deps.tauri, alias).catch(() => undefined)
    }
    return false
  }

  function begin(run: TakerRun): boolean {
    const alias = workHostAliasOf(useHostsStore.getState(), run.owner, run.repo)
    const issueId = hostOf(alias).issueId(run.owner, run.repo, String(run.number))
    // Why: 사용자가 이미 그 이슈에서 일하는 중이면 그 터미널 옆에서 자동 실행하지 않는다(재시도·다음 단계는 사용자가 고른 것)
    if (!run.assigned && run.paneId === null && useUiStore.getState().startedTerminals[issueId]) {
      stopRun(run, '이미 터미널이 열려 있는 이슈', { issueId })
      return false
    }
    patch(run.id, { status: 'preparing', issueId, note: dropNote(run.note, NOTE_HOST_WAIT) })
    return true
  }

  function assign(run: TakerRun, m: RunMem) {
    m.assigning = true
    const a = m.attempt
    const login = useSessionStore.getState().me?.githubLogin ?? null
    const isMe = (x: string) => login !== null && x.toLowerCase() === login.toLowerCase()
    void (async () => {
      let detail: Awaited<ReturnType<GitHubClient['getIssue']>> | null = null
      try {
        detail = await deps.github.getIssue(run.owner, run.repo, run.number)
      } catch {
        detail = null
      }
      if (!live(run.id, a)) return
      const cur = getRun(run.id)
      if (!cur || cur.status !== 'preparing') return
      if (detail && detail.state !== 'open') return stopRun(cur, '이슈가 닫힘')
      if (detail && detail.assignees.length > 0 && !detail.assignees.some(isMe)) return stopRun(cur, '다른 사람이 담당하는 이슈')
      let ok = false
      if (login !== null) {
        try {
          const res = await deps.github.assignIssue(run.owner, run.repo, run.number, login)
          ok = res.assignees.some(isMe)
        } catch {
          ok = false
        }
      }
      if (!live(run.id, a)) return
      const after = getRun(run.id)
      if (!after) return
      patch(run.id, ok ? { assigned: true } : { assigned: true, note: joinNote(after.note, NOTE_ASSIGN) })
    })()
  }

  // Why: 열기 도중 Provider 가 다시 마운트되면 open() 이 opening 인 채 바로 끝나므로, 이번 열기의 ready·error 를 본 뒤에만 지움을 판정한다
  function seeOpen(m: RunMem, issueId: string) {
    const phase = useSetupStore.getState().open[issueId]?.phase
    if (m.openCalled && (phase === 'ready' || phase === 'error')) m.openSeen = true
  }

  function openWorktree(run: TakerRun, m: RunMem, alias: string | null, issueId: string) {
    m.openCalled = true
    const a = m.attempt
    const target: IssueTarget = { owner: run.owner, repo: run.repo, key: String(run.number), number: run.number, title: run.title }
    let opened: Promise<unknown>
    try {
      opened = deps.actionsFor(alias).open(target, { select: false })
    } catch (e) {
      opened = Promise.reject(e)
    }
    seeOpen(m, issueId)
    void opened
      .catch(() => undefined)
      .then(() => {
        if (!live(run.id, a)) return
        seeOpen(m, issueId)
        m.openDone = true
      })
  }

  function launch(run: TakerRun, m: RunMem, issueId: string, alias: string | null, now: number) {
    const ui = useUiStore.getState()
    const hasPane = leafIds(ui.panes[issueId]?.tree ?? null).length > 0
    const paneId = ui.launchPane(issueId, hasPane || alias !== null, false)
    m.paneAt = now
    m.remoteNoTmux = alias !== null && !usesTmux(useHostsStore.getState(), alias)
    const note = useSetupStore.getState().script[issueId]?.status === 'failed' ? joinNote(run.note, '생성 후 스크립트 실패') : run.note
    if (m.remoteNoTmux) {
      const cmd = commandOf(run, run.step)
      if (!cmd.ok) {
        fail(run, cmd.error, { paneId, note })
        return
      }
      queueLaunch(paneId, cmd.command, { track: true })
      tracked.add(paneId)
      patch(run.id, { paneId, status: 'running', note: joinNote(note, NOTE_WRITING) })
    } else {
      patch(run.id, { paneId, note })
    }
    notify(run, `#${run.number} 자동 실행 시작`, paneId)
  }

  function prepare(run: TakerRun, m: RunMem, issueId: string, now: number) {
    const alias = aliasOfRun(run)
    if (!run.assigned) {
      if (!m.assigning) assign(run, m)
      return
    }
    if (!m.openCalled) {
      if (alias !== null && !useHostsStore.getState().probes[alias]) {
        patch(run.id, { status: 'queued' })
        return
      }
      openWorktree(run, m, alias, issueId)
      return
    }
    if (!m.openDone) return
    if (run.paneId === null) {
      const setup = useSetupStore.getState()
      if (setup.open[issueId]?.phase !== 'ready' || setup.script[issueId]?.status === 'running') return
      launch(run, m, issueId, alias, now)
      return
    }
    if (m.inFlight) return
    const ptyId = writablePty(run, m, now)
    if (ptyId !== null) write(run, m, run.step, ptyId)
  }

  function confirmQueued(run: TakerRun) {
    if (run.paneId === null) return
    const result = launchResult(run.paneId)
    if (result === 'pending') return
    clearLaunchResult(run.paneId)
    tracked.delete(run.paneId)
    const note = dropNote(run.note, NOTE_WRITING)
    if (result !== 'written') {
      fail(run, '명령을 넣지 못함', { note })
      return
    }
    const last = run.step >= run.steps.length - 1
    if (last) renew(run.id)
    patch(run.id, { status: last ? 'done' : 'manualNext', note })
  }

  function progress(run: TakerRun, m: RunMem, now: number) {
    const present = run.paneId !== null && useAgentStore.getState().panes[run.paneId] !== undefined
    if (present) {
      m.seen = true
      m.lastSeenAt = now
    }
    if (m.inFlight) return
    const p = stepProgress({ seen: m.seen, lastSeenAt: m.lastSeenAt, shellSince: shellSinceOf(run.paneId, m), agentPresent: present, wroteAt: m.wroteAt, now })
    if (p === 'startTimeout') {
      fail(run, '에이전트가 시작되지 않음')
      return
    }
    if (p !== 'ended') return
    const next = run.step + 1
    if (next >= run.steps.length) {
      renew(run.id)
      patch(run.id, { status: 'done' })
      return
    }
    const ptyId = writablePty(run, m, now)
    if (ptyId !== null) write(run, m, next, ptyId)
  }

  function advance(id: string, now: number) {
    const run = getRun(id)
    if (!run || !isActive(run) || run.issueId === null) return
    const issueId = run.issueId
    const m = memOf(id)
    observePty(run, m, now)
    const open = useSetupStore.getState().open[issueId]
    seeOpen(m, issueId)
    if (run.status === 'preparing' && m.openDone && open?.phase === 'error') {
      fail(run, open.message)
      return
    }
    if (m.openDone && m.openSeen && (!useUiStore.getState().worktreePathMap[issueId] || !open)) {
      stopRun(run, 'worktree 삭제')
      return
    }
    const gone = paneGone(run, m)
    if (gone !== null) {
      if (run.status === 'manualNext') {
        m.ptyId = null
        m.staleBefore = null
        patch(id, { paneId: null })
      } else {
        stopRun(run, gone === 'closed' ? '패널이 닫힘' : '터미널이 끝남')
      }
      return
    }
    if (run.status === 'preparing') {
      if (m.paneAt !== null && now - m.paneAt >= TAKER_START_TIMEOUT_MS) {
        fail(run, '에이전트가 시작되지 않음')
        return
      }
      prepare(run, m, issueId, now)
      return
    }
    if (run.status === 'running') {
      if (m.remoteNoTmux) confirmQueued(run)
      else progress(run, m, now)
    }
  }

  function onLink(e: PtyLinkEvent) {
    const cur = links.get(e.id)
    if (cur && e.seq <= cur.seq) return
    links.set(e.id, { phase: e.phase, seq: e.seq, at: deps.now() })
  }

  function listen(p: Promise<() => void>) {
    void p.then(
      (unlisten) => {
        if (disposed) unlisten()
        else unlisteners.push(unlisten)
      },
      () => undefined,
    )
  }

  async function checkOnce(key: string, now: number): Promise<boolean> {
    const cfg = useTakerStore.getState().repos[key]
    if (!cfg?.enabled) return true
    const [owner, repo] = cfg.owner !== undefined && cfg.repo !== undefined ? [cfg.owner, cfg.repo] : splitKey(key)
    try {
      if (cfg.baseline === null || (!firstDone.has(key) && !cfg.catchUp)) {
        const n = await deps.github.latestNumber(owner, repo)
        if (disposed) return true
        const ok = useTakerStore.getState().setBaseline(key, n, cfg)
        if (ok) {
          firstDone.add(key)
          setLastCheck(key, now, null)
        }
        return ok
      }
      const login = useSessionStore.getState().me?.githubLogin ?? null
      if (login === null) {
        setLastCheck(key, now, '로그인한 GitHub 사용자를 알 수 없어 확인하지 못했습니다')
        return true
      }
      const issues = await deps.github.listRecentIssues(owner, repo, cfg.author === 'me' ? { creator: login } : undefined)
      if (disposed) return true
      const ok = useTakerStore.getState().addRuns(key, issues, cfg)
      if (ok) {
        firstDone.add(key)
        setLastCheck(key, now, null)
      }
      return ok
    } catch (e) {
      if (!disposed) setLastCheck(key, now, describeOpenError(e).message)
      return true
    }
  }

  async function checkRepo(key: string, now: number) {
    if (checking.has(key)) {
      dirty.add(key)
      return
    }
    checking.add(key)
    try {
      const applied = await checkOnce(key, now)
      if (!disposed && (dirty.has(key) || !applied)) {
        dirty.delete(key)
        await checkOnce(key, now)
      }
    } finally {
      checking.delete(key)
      dirty.delete(key)
    }
  }

  return {
    start(_now) {
      if (started || disposed) return
      started = true
      listen(deps.tauri.onPtyExit((id) => exited.add(id)))
      listen(deps.tauri.onPtyLink(onLink))
      for (const r of useTakerStore.getState().runs) {
        if (r.status === 'preparing' || r.status === 'running') {
          if (r.paneId !== null) cancelLaunch(r.paneId)
          patch(r.id, { status: 'interrupted' })
        } else if (r.status === 'manualNext' && r.paneId !== null) {
          cancelLaunch(r.paneId)
          patch(r.id, { paneId: null })
        }
      }
    },

    async check(now) {
      if (disposed) return
      const keys = Object.entries(useTakerStore.getState().repos)
        .filter(([, c]) => c.enabled)
        .map(([k]) => k)
      for (const key of keys) {
        if (disposed) return
        await checkRepo(key, now)
      }
    },

    tick(now) {
      if (disposed) return
      const runs = useTakerStore.getState().runs
      if (!runs.some((r) => r.status === 'queued' || isActive(r))) return
      for (const r of runs) if (isActive(r)) advance(r.id, now)
      const begun = new Map<string, TakerRun>()
      for (const r of nextToStart(useTakerStore.getState().runs, hostReady)) if (begin(r)) begun.set(r.repoKey, r)
      for (const r of begun.values()) {
        void deps.queryClient.invalidateQueries({ queryKey: queryKeys.githubIssues(r.owner, r.repo), refetchType: 'active' }).catch(() => undefined)
      }
    },

    stop(id) {
      const run = getRun(id)
      if (!run || !(run.status === 'queued' || isActive(run))) return
      stopRun(run, null)
    },

    restart(id) {
      const run = getRun(id)
      if (!run || !RESTARTABLE.includes(run.status)) return
      if (run.paneId !== null) cancelLaunch(run.paneId)
      const cfg = useTakerStore.getState().repos[run.repoKey]
      const steps = cfg && cfg.steps.length > 0 ? cfg.steps.map((s) => ({ ...s })) : run.steps
      renew(id)
      patch(id, { steps, step: Math.max(0, Math.min(run.step, steps.length - 1)), paneId: null, status: 'queued', note: null, error: null })
    },

    nextStep(id) {
      const run = getRun(id)
      if (disposed || !run || run.status !== 'manualNext') return 'busy'
      const m = memOf(id)
      if (m.inFlight) return 'busy'
      const next = run.step + 1
      if (next >= run.steps.length) return 'notReady'
      const now = deps.now()
      observePty(run, m, now)
      if (run.paneId !== null && run.issueId !== null && paneGone(run, m) === null && leafIds(useUiStore.getState().panes[run.issueId]?.tree ?? null).includes(run.paneId)) {
        if (useSetupStore.getState().open[run.issueId]?.phase !== 'ready') return 'notReady'
        const ptyId = writablePty(run, m, now)
        if (ptyId === null) return 'notReady'
        write(run, m, next, ptyId)
        return 'started'
      }
      renew(id)
      patch(id, { step: next, paneId: null, status: 'queued', error: null })
      return 'started'
    },

    dispose() {
      if (disposed) return
      disposed = true
      for (const paneId of tracked) if (launchResult(paneId) === 'pending') cancelLaunch(paneId)
      tracked.clear()
      for (const u of unlisteners.splice(0)) u()
    },
  }
}
