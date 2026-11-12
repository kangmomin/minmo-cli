// 모든 터미널의 출력을 한곳에서 받아 에이전트 현황(agentStore)을 갱신한다. 앱에 한 번만 마운트한다.
import { useEffect } from 'react'

import { useBaseDeps } from '../../app/deps'
import { aliasOfIssue } from '../../app/host'
import { useSetupStore } from '../../store/setup'
import { useUiStore } from '../../store/ui'
import { STATUS_LABEL, derive, issueOfPane, useAgentStore } from './agentStore'
import type { PaneSignals } from './agentStore'
import { AGENT_LABEL, guessProgram, parseTitle, titleSignal } from './detect'
import { PtyStreamParser } from './ptyStream'

/** 사용자가 친 글자가 되돌아 나오는 출력(에코)은 "작업 중"으로 치지 않는다 — 입력 뒤 이 시간 안의 출력은 무시 */
export const ECHO_MS = 400
/** 작업이 끝난 직후의 벨은 "끝났다"는 알림음이다 — 이 시간 안의 벨은 입력 대기로 치지 않는다 */
export const DONE_BELL_MS = 1500
const TICK_MS = 1000
/** 이 PC 의 터미널에서 도는 프로세스를 다시 묻는 간격 */
const PROCESS_POLL_MS = 3000

const inputAt = new Map<string, number>()

/** 터미널에 사용자가 직접 입력(키·붙여넣기)했음을 알린다(TerminalTab 이 호출) */
export function noteTerminalInput(paneId: string) {
  inputAt.set(paneId, Date.now())
}

type Tracked = PaneSignals & {
  ptyId: string
  parser: PtyStreamParser
  polledAt: number
  /** 프로세스 조회가 진행 중 — 겹쳐 묻지 않는다 */
  polling: boolean
}

const fresh = (ptyId: string): Tracked => ({ ptyId, parser: new PtyStreamParser(), title: null, processes: null, lastOutputAt: 0, bell: false, polledAt: 0, polling: false })

/** 사용자가 지금 그 이슈의 터미널을 보고 있는가 — 대화상자가 덮고 있으면 보는 것이 아니다 */
function isViewed(issueId: string): boolean {
  const ui = useUiStore.getState()
  if (ui.selectedIssueId !== issueId || ui.tab !== 'terminal' || typeof document === 'undefined') return false
  return document.visibilityState === 'visible' && document.hasFocus() && document.querySelector('[role="dialog"]') === null
}

export function useAgentTracker() {
  const { tauri } = useBaseDeps()

  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | null = null
    const tracked = new Map<string, Tracked>()

    /** 패널의 추적 상태 — 같은 패널 id 라도 터미널(PTY)이 새로 만들어졌으면 처음부터 다시 본다 */
    function trackedOf(paneId: string, ptyId: string): Tracked {
      let t = tracked.get(paneId)
      if (!t || t.ptyId !== ptyId) tracked.set(paneId, (t = fresh(ptyId)))
      return t
    }

    function update(paneId: string, t: Tracked, now: number) {
      const store = useAgentStore.getState()
      const issueId = issueOfPane(paneId)
      const viewed = isViewed(issueId)
      if (viewed) t.bell = false
      const { next, event } = derive(paneId, t, store.panes[paneId] ?? null, now, viewed)
      // 새로 작업을 시작하면 그 전의 벨은 지난 일이다
      if (next?.activity === 'working') t.bell = false
      store.set(paneId, next)
      // 알림은 알려진 에이전트만(빌드·개발 서버 같은 기타 프로그램이 멈출 때마다 알리지 않는다)
      if (event && next && next.agent !== 'other' && useUiStore.getState().agentNotify) {
        const target = useSetupStore.getState().targets[issueId]
        const where = target ? `${target.repo} ${target.number === null ? '기타' : `#${target.number} ${target.title}`}` : issueId
        void tauri.notify(`${AGENT_LABEL[next.agent]} — ${STATUS_LABEL[event]}`, where).catch(() => undefined)
      }
    }

    void tauri
      .onPtyData((e) => {
        if (disposed) return
        const paneId = Object.entries(useUiStore.getState().terminalIds).find(([, id]) => id === e.id)?.[0]
        if (!paneId) return
        const t = trackedOf(paneId, e.id)
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
        if (sig.visible && now - (inputAt.get(paneId) ?? 0) > ECHO_MS) t.lastOutputAt = now
        if (sig.titles.length > 0 || sig.bells > 0) update(paneId, t, now)
      })
      .then((un) => {
        if (disposed) un()
        else unlisten = un
      })

    const timer = setInterval(() => {
      const now = Date.now()
      const live = useUiStore.getState().terminalIds
      // 닫힌 패널 정리
      for (const paneId of [...tracked.keys()]) {
        if (!(paneId in live)) {
          tracked.delete(paneId)
          inputAt.delete(paneId)
          useAgentStore.getState().set(paneId, null)
        }
      }
      for (const [paneId, ptyId] of Object.entries(live)) {
        const t = trackedOf(paneId, ptyId)
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
        update(paneId, t, now)
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
      unlisten?.()
      releaseLock?.()
      inputAt.clear()
      useAgentStore.getState().clear()
    }
  }, [tauri])
}
