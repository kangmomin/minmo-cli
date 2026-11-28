// 모든 터미널의 출력을 한곳에서 받아 에이전트 현황(agentStore)을 갱신한다. 앱에 한 번만 마운트한다.
import { useEffect } from 'react'

import { useBaseDeps } from '../../app/deps'
import { aliasOfIssue, hostOf, useHostDeps } from '../../app/host'
import { isDefaultIssueId, workTabOf } from '../../lib/defaultWorkspace'
import { useHostsStore } from '../../store/hosts'
import { repoShortNameOf, useReposStore } from '../../store/repos'
import { useSetupStore } from '../../store/setup'
import { useUiStore } from '../../store/ui'
import { effectivePane, selectedTabId, tabOfPane } from '../terminal/panes'
import { readView, viewedInOtherWindow } from './windowView'
import type { View } from './windowView'
import { PROCESS_POLL_MS, STATUS_LABEL, derive, issueOfPane, shellOnly, useAgentStore } from './agentStore'
import type { PaneSignals } from './agentStore'
import { AGENT_LABEL, guessProgram, parseTitle, titleSignal } from './detect'
import { PtyStreamParser } from './ptyStream'
import { parseSubagentFiles } from './subagents'

/** 사용자가 친 글자가 되돌아 나오는 출력(에코)은 "작업 중"으로 치지 않는다 — 입력 뒤 이 시간 안의 출력은 무시 */
export const ECHO_MS = 400
/** 작업이 끝난 직후의 벨은 "끝났다"는 알림음이다 — 이 시간 안의 벨은 입력 대기로 치지 않는다 */
export const DONE_BELL_MS = 1500
const TICK_MS = 1000
/** Claude Code 의 하위 에이전트 목록을 다시 읽는 간격 */
const SUBAGENT_POLL_MS = 5000
const RESIZE_MUTE_MS = 1500

const inputAt = new Map<string, number>()
/** 패널별로 출력을 활동으로 세지 않는 끝 시각(muteTerminalActivity) */
const mutedUntil = new Map<string, number>()
const ptySizes = new Map<string, { cols: number; rows: number }>()
const resizeMutedUntil = new Map<string, number>()

/** 터미널에 사용자가 직접 입력(키·붙여넣기)했음을 알린다(TerminalTab 이 호출) */
export function noteTerminalInput(paneId: string) {
  inputAt.set(paneId, Date.now())
}

/**
 * ms 동안 그 패널의 출력을 활동으로 세지 않는다 — 원격 터미널이 다시 접속할 때의 준비 출력·구분 줄·tmux 다시 그리기가
 * "작업 중 → 끝남" 알림을 만들지 않게(TerminalTab 이 pty-link connecting·connected 에서 호출, #89)
 */
export function muteTerminalActivity(paneId: string, ms: number) {
  mutedUntil.set(paneId, Math.max(mutedUntil.get(paneId) ?? 0, Date.now() + ms))
}

type Tracked = PaneSignals & {
  ptyId: string
  parser: PtyStreamParser
  polledAt: number
  /** 프로세스 조회가 진행 중 — 겹쳐 묻지 않는다 */
  polling: boolean
  subPolledAt: number
  subPolling: boolean
  /** 이 패널에서 Claude Code 를 처음 본 시각(없으면 0) — 그 전에 끝난 세션의 기록은 보지 않는다 */
  claudeSince: number
  shellFirstAt: number
  exited: boolean
}

const fresh = (ptyId: string): Tracked => ({ ptyId, parser: new PtyStreamParser(), title: null, processes: null, lastOutputAt: 0, bell: false, polledAt: 0, polling: false, subPolledAt: 0, subPolling: false, claudeSince: 0, shellFirstAt: 0, exited: false })

/** Why: 그 패널에 사용자가 마지막으로 입력한 시각(없으면 0, #122) */
export function lastInputAt(paneId: string): number {
  return inputAt.get(paneId) ?? 0
}

/** Why: 터미널(PTY)의 지금 크기를 알린다 — 크기 변경으로 다시 그린 출력을 작업 시작으로 세지 않게(#122) */
export function notePtySize(ptyId: string, cols: number, rows: number): void {
  ptySizes.set(ptyId, { cols, rows })
}

/** Why: 대화상자가 덮고 있으면 보는 것이 아니다 */
function isViewed(issueId: string, paneId: string, view: View | null): boolean {
  if (typeof document === 'undefined') return false
  const ui = useUiStore.getState()
  const tree = ui.panes[issueId]?.tree ?? null
  // Why: 트리에 없는 패널은 탭을 모른다(null) — 지금처럼 이슈만 본다
  const paneTab = tabOfPane(tree, paneId)
  // Why: 보조 창에서 보고 있어도 본 것이다 — 알림은 주 창이 띄운다(#105)
  if (viewedInOtherWindow(issueId, paneTab, paneId, view)) return true
  if (ui.selectedIssueId !== issueId || workTabOf(issueId, ui.tab) !== 'terminal') return false
  if (paneTab !== null && paneTab !== selectedTabId(tree, ui.panes[issueId]?.tab)) return false
  // Why: 답변 모드는 패널 하나만 보이고 나머지는 가려진다 — 기본 보기는 분할된 패널이 모두 보여 이슈 단위다
  if (ui.viewMode === 'answer' && effectivePane(ui.panes[issueId]) !== paneId) return false
  return document.visibilityState === 'visible' && document.hasFocus() && document.querySelector('[role="dialog"]') === null
}

export function useAgentTracker() {
  const { tauri } = useBaseDeps()
  const hostDeps = useHostDeps()

  useEffect(() => {
    let disposed = false
    const unlisteners: (() => void)[] = []
    const keep = (un: () => void) => {
      if (disposed) un()
      else unlisteners.push(un)
    }
    const tracked = new Map<string, Tracked>()
    const paneOf = (ptyId: string) => Object.entries(useUiStore.getState().terminalIds).find(([, id]) => id === ptyId)?.[0]

    /** 패널의 추적 상태 — 같은 패널 id 라도 터미널(PTY)이 새로 만들어졌으면 처음부터 다시 본다 */
    function trackedOf(paneId: string, ptyId: string): Tracked {
      let t = tracked.get(paneId)
      if (!t || t.ptyId !== ptyId) {
        if (t) ptySizes.delete(t.ptyId)
        tracked.set(paneId, (t = fresh(ptyId)))
      }
      return t
    }

    function update(paneId: string, t: Tracked, now: number, view: View | null = readView()) {
      const store = useAgentStore.getState()
      const issueId = issueOfPane(paneId)
      const viewed = isViewed(issueId, paneId, view)
      if (viewed) t.bell = false
      const { next, event } = derive(paneId, t, store.panes[paneId] ?? null, now, viewed)
      // 새로 작업을 시작하면 그 전의 벨은 지난 일이다
      if (next?.activity === 'working') t.bell = false
      store.set(paneId, next)
      const shell = shellOnly(t)
      if (shell !== true) t.shellFirstAt = 0
      else if (t.shellFirstAt === 0) t.shellFirstAt = now
      if (shell !== null) store.setShell(paneId, shell ? Math.max(t.shellFirstAt, t.lastOutputAt, inputAt.get(paneId) ?? 0) : null)
      // 알림은 알려진 에이전트만(빌드·개발 서버 같은 기타 프로그램이 멈출 때마다 알리지 않는다)
      if (event && next && next.agent !== 'other' && useUiStore.getState().agentNotify) {
        const target = useSetupStore.getState().targets[issueId]
        const repo = target && repoShortNameOf(useReposStore.getState(), target.owner, target.repo)
        const where = isDefaultIssueId(issueId) ? '기본' : target ? `${repo} ${target.number === null ? '기타' : `#${target.number} ${target.title}`}` : issueId
        void tauri.notify(`${AGENT_LABEL[next.agent]} — ${STATUS_LABEL[event]}`, where, { kind: 'local', issueId, paneId }).catch(() => undefined)
      }
    }

    void tauri
      .onPtyData((e) => {
        if (disposed) return
        const paneId = paneOf(e.id)
        if (!paneId) return
        const t = trackedOf(paneId, e.id)
        if (t.exited) return
        const now = Date.now()
        const sig = t.parser.feed(e.data)
        for (const raw of sig.titles) {
          const { program, title } = parseTitle(raw)
          if (program !== undefined) t.tmuxProgram = program
          t.title = titleSignal(title)
        }
        if (sig.bells > 0) {
          // 작업 중의 벨, 작업이 끝난 직후의 벨(끝났다는 알림음)은 "입력 대기"가 아니다
          const cur = useAgentStore.getState().panes[paneId]
          const justFinished = cur !== undefined && cur.activity === 'idle' && cur.unseen && now - cur.since < DONE_BELL_MS
          if (cur?.activity !== 'working' && !justFinished) t.bell = true
        }
        // Why: 크기 변경 뒤 다시 그린 화면이 작업 시작으로 읽히지 않게 — 이미 작업 중이면 계속 센다
        const resizing = now < (resizeMutedUntil.get(paneId) ?? 0) && useAgentStore.getState().panes[paneId]?.activity !== 'working'
        if (sig.visible && now - (inputAt.get(paneId) ?? 0) > ECHO_MS && now >= (mutedUntil.get(paneId) ?? 0) && !resizing) t.lastOutputAt = now
        if (sig.titles.length > 0 || sig.bells > 0) update(paneId, t, now)
      })
      .then(keep)

    void tauri
      .onPtyExit((ptyId) => {
        if (disposed) return
        const paneId = paneOf(ptyId)
        if (!paneId) return
        // Why: 끝난 PTY 가 남은 제목·늦은 조회로 되살아나지 않게 — 새 객체라 진행 중이던 조회(tracked.get(paneId) !== t)도 버린다
        tracked.set(paneId, { ...fresh(ptyId), exited: true })
        useAgentStore.getState().set(paneId, null)
      })
      .then(keep)

    void tauri
      .onPtyResized((e) => {
        if (disposed) return
        const known = ptySizes.get(e.id)
        ptySizes.set(e.id, { cols: e.cols, rows: e.rows })
        const paneId = paneOf(e.id)
        if (!paneId) return
        const t = tracked.get(paneId)
        // Why: 크기를 모르면 바뀌었는지 알 수 없다 — 출력이 없던 새 터미널의 첫 출력은 그대로 세게 둔다
        const changed = known ? known.cols !== e.cols || known.rows !== e.rows : t?.ptyId === e.id && t.lastOutputAt > 0
        if (changed) resizeMutedUntil.set(paneId, Date.now() + RESIZE_MUTE_MS)
      })
      .then(keep)

    const timer = setInterval(() => {
      const now = Date.now()
      const live = useUiStore.getState().terminalIds
      const view = readView()
      // 닫힌 패널 정리
      for (const [paneId, t] of [...tracked]) {
        if (!(paneId in live)) {
          tracked.delete(paneId)
          inputAt.delete(paneId)
          mutedUntil.delete(paneId)
          resizeMutedUntil.delete(paneId)
          ptySizes.delete(t.ptyId)
          useAgentStore.getState().clearPane(paneId)
        }
      }
      for (const [paneId, ptyId] of Object.entries(live)) {
        const t = trackedOf(paneId, ptyId)
        if (t.exited) continue
        // 이 PC 의 터미널만 프로세스를 조회한다(원격은 ssh 만 보인다 — 제목으로 판단)
        if (aliasOfIssue(issueOfPane(paneId)) === null && !t.polling && now - t.polledAt >= PROCESS_POLL_MS) {
          t.polledAt = now
          t.polling = true
          void tauri
            .ptyProcesses(ptyId)
            .then((names) => {
              if (disposed || tracked.get(paneId) !== t) return
              t.processes = names
              // 셸만 남았으면 에이전트는 끝난 것이다 — 남아 있는 제목(끝난 프로그램이 정해 둔 것)은 버린다
              if (guessProgram(names) === null) t.title = null
              update(paneId, t, Date.now())
            })
            .catch(() => undefined)
            .finally(() => {
              t.polling = false
            })
        }
        update(paneId, t, now, view)
        // Claude Code 가 떠 있는 패널: 세션 기록에서 하위 에이전트를 읽는다(그 패널이 있는 호스트에서)
        const agent = useAgentStore.getState().panes[paneId]
        const alias = aliasOfIssue(issueOfPane(paneId))
        // 같은 작업 폴더에서 Claude Code 가 여러 패널에 떠 있으면 어느 세션이 어느 패널 것인지 알 수 없다 —
        // 번호가 가장 앞선 패널 하나에만 보여 같은 목록이 두 번 세어지지 않게 한다
        const firstClaude = agent?.agent === 'claude' && !Object.values(useAgentStore.getState().panes).some((p) => p.agent === 'claude' && p.issueId === agent.issueId && p.paneId < paneId)
        if (agent?.agent !== 'claude') t.claudeSince = 0
        else if (t.claudeSince === 0) t.claudeSince = now
        if (!agent || !firstClaude) {
          useAgentStore.getState().setSubagents(paneId, [])
        } else if (alias !== null && !useHostsStore.getState().probes[alias]) {
          // 원격인데 연결 정보가 없다 — 이 PC 의 파일을 대신 읽지 않는다
        } else if (!t.subPolling && now - t.subPolledAt >= SUBAGENT_POLL_MS) {
          // Why: 기본은 worktree 가 없다 — 작업 폴더(홈)는 열기 상태에만 있다
          const open = useSetupStore.getState().open[agent.issueId]
          const cwd = useUiStore.getState().worktreePathMap[agent.issueId]?.path ?? (open?.phase === 'ready' ? open.path : undefined)
          if (cwd) {
            t.subPolledAt = now
            t.subPolling = true
            // 세션 기록은 에이전트가 뜨기 조금 전에 만들어질 수 있어 여유를 둔다
            void hostDeps(hostOf(alias))
              .tauri.claudeSubagents(cwd, t.claudeSince - 60_000)
              .then((files) => {
                if (!disposed && tracked.get(paneId) === t && useAgentStore.getState().panes[paneId]?.agent === 'claude') useAgentStore.getState().setSubagents(paneId, parseSubagentFiles(files))
              })
              .catch(() => undefined)
              .finally(() => {
                t.subPolling = false
              })
          }
        }
      }
    }, TICK_MS)

    // 창을 트레이로 숨기면 웹뷰가 타이머를 늦춘다(Windows 는 설정으로 끌 수 없다) — 웹 잠금을 쥐고 있으면 늦추지 않는다
    let releaseLock: (() => void) | null = null
    if (typeof navigator !== 'undefined' && navigator.locks) {
      void navigator.locks
        .request('minmo-agent-tracker', { mode: 'shared' }, () => new Promise<void>((resolve) => (disposed ? resolve() : (releaseLock = resolve))))
        .catch(() => undefined)
    }

    return () => {
      disposed = true
      clearInterval(timer)
      for (const un of unlisteners) un()
      releaseLock?.()
      inputAt.clear()
      mutedUntil.clear()
      ptySizes.clear()
      resizeMutedUntil.clear()
      useAgentStore.getState().clear()
    }
  }, [tauri, hostDeps])
}
