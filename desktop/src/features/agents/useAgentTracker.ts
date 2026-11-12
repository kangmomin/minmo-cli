// 모든 터미널의 출력을 한곳에서 받아 에이전트 현황(agentStore)을 갱신한다. 앱에 한 번만 마운트한다.
import { useEffect } from 'react'

import { useBaseDeps } from '../../app/deps'
import { aliasOfIssue } from '../../app/host'
import { useSetupStore } from '../../store/setup'
import { useUiStore } from '../../store/ui'
import { STATUS_LABEL, derive, issueOfPane, useAgentStore } from './agentStore'
import type { PaneSignals } from './agentStore'
import { AGENT_LABEL, parseTitle, titleSignal } from './detect'
import { PtyStreamParser } from './ptyStream'

/** 사용자가 친 글자가 되돌아 나오는 출력(에코)은 "작업 중"으로 치지 않는다 — 입력 뒤 이 시간 안의 출력은 무시 */
export const ECHO_MS = 400
const TICK_MS = 1000
/** 이 PC 의 터미널에서 도는 프로세스를 다시 묻는 간격 */
const PROCESS_POLL_MS = 3000

const inputAt = new Map<string, number>()

/** 터미널에 사용자가 입력했음을 알린다(TerminalTab 이 호출) */
export function noteTerminalInput(paneId: string) {
  inputAt.set(paneId, Date.now())
}

type Tracked = PaneSignals & { parser: PtyStreamParser; polledAt: number }

const fresh = (): Tracked => ({ parser: new PtyStreamParser(), title: null, processes: null, lastOutputAt: 0, bell: false, polledAt: 0 })

/** 사용자가 지금 그 이슈의 터미널을 보고 있는가 */
function isViewed(issueId: string): boolean {
  const ui = useUiStore.getState()
  return ui.selectedIssueId === issueId && ui.tab === 'terminal' && typeof document !== 'undefined' && document.visibilityState === 'visible' && document.hasFocus()
}

export function useAgentTracker() {
  const { tauri } = useBaseDeps()

  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | null = null
    const tracked = new Map<string, Tracked>()

    /** PTY id → 패널 id */
    const paneOfPty = (ptyId: string) => Object.entries(useUiStore.getState().terminalIds).find(([, id]) => id === ptyId)?.[0]

    function update(paneId: string, t: Tracked, now: number) {
      const store = useAgentStore.getState()
      const issueId = issueOfPane(paneId)
      const viewed = isViewed(issueId)
      if (viewed) t.bell = false
      const { next, event } = derive(paneId, t, store.panes[paneId] ?? null, now, viewed)
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
        const paneId = paneOfPty(e.id)
        if (!paneId) return
        let t = tracked.get(paneId)
        if (!t) tracked.set(paneId, (t = fresh()))
        const now = Date.now()
        const sig = t.parser.feed(e.data)
        for (const raw of sig.titles) {
          const { program, title } = parseTitle(raw)
          if (program !== undefined) t.tmuxProgram = program
          t.title = titleSignal(title)
        }
        if (sig.bells > 0) t.bell = true
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
        let t = tracked.get(paneId)
        if (!t) tracked.set(paneId, (t = fresh()))
        // 이 PC 의 터미널만 프로세스를 조회한다(원격은 ssh 만 보인다 — 제목으로 판단)
        if (aliasOfIssue(issueOfPane(paneId)) === null && now - t.polledAt >= PROCESS_POLL_MS) {
          t.polledAt = now
          const cur = t
          void tauri
            .ptyProcesses(ptyId)
            .then((names) => {
              if (disposed || tracked.get(paneId) !== cur) return
              cur.processes = names
              update(paneId, cur, Date.now())
            })
            .catch(() => undefined)
        }
        update(paneId, t, now)
      }
    }, TICK_MS)

    return () => {
      disposed = true
      clearInterval(timer)
      unlisten?.()
      inputAt.clear()
      useAgentStore.getState().clear()
    }
  }, [tauri])
}
