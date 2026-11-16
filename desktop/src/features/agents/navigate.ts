// 에이전트가 있는 터미널 패널로 가기 — 전체 현황의 줄과 OS 알림을 눌렀을 때 쓴다.
import { useEffect } from 'react'

import { useBaseDeps } from '../../app/deps'
import type { NotifyTarget, TauriApi } from '../../lib/tauri'
import { useUiStore } from '../../store/ui'
import { leafIds } from '../terminal/panes'

/**
 * 그 이슈의 터미널 탭을 열고 패널을 고른다. keyboard 면 그 터미널이 키 입력도 받게 한다
 * (사용자가 그 패널을 직접 가리킨 경우만 — 자동 포커스 금지 AX-02).
 */
export function goToPane(issueId: string, paneId: string, keyboard = false) {
  const ui = useUiStore.getState()
  ui.selectIssue(issueId)
  ui.setTab('terminal')
  // 그 사이 닫힌 패널이면 이슈의 터미널 탭까지만 간다
  if (!leafIds(ui.panes[issueId]?.tree ?? null).includes(paneId)) return
  ui.focusPane(issueId, paneId)
  if (keyboard) useUiStore.setState((s) => ({ focusRequest: { paneId, token: (s.focusRequest?.token ?? 0) + 1 } }))
}

/** 알림을 눌렀을 때: 이 PC 의 것이면 창을 앞으로 가져와 그 패널로, 다른 PC 의 것이면 그 PC 의 화면을 연다 */
export function openNotifyTarget(tauri: TauriApi, target: NotifyTarget) {
  if (target.kind === 'peer') {
    void tauri.peerOpen(target.peerId, target.target ? { target: target.target, paneId: target.paneId } : undefined).catch(() => undefined)
    return
  }
  void tauri.appShow().catch(() => undefined)
  goToPane(target.issueId, target.paneId, true)
}

/** 알림 클릭을 듣는다. 앱에 한 번만 마운트한다 */
export function useNotifyClick() {
  const { tauri } = useBaseDeps()
  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | null = null
    void tauri
      .onNotifyClick((target) => {
        if (!disposed) openNotifyTarget(tauri, target)
      })
      .then((un) => {
        if (disposed) un()
        else unlisten = un
      })
      .catch(() => undefined)
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [tauri])
}
